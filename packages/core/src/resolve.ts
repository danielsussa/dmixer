import type { Clip, Effect, Point, Project, Region, Track } from './schema.js'
import { buildTimeContext, resolveTime, type TimeContext } from './time.js'
import { round } from './util.js'

/** A clip with every time turned into a number. */
export interface ResolvedClip {
  id: string
  trackId: string
  asset: string
  src: string
  start: number
  in: number
  out: number
  end: number
  /** where the next piece should start: the end of the body for a library piece, else `end` */
  bodyEnd: number
  duration: number
  gain: number
  fadeIn: number
  fadeOut: number
  muted: boolean
  label?: string
  raw: Clip
}

export interface ResolvedPoint {
  at: number
  db: number
  curve: 'linear' | 'hold'
  /** position of the point in the file's list (points are sorted here, not there) */
  index: number
}

export interface ResolvedRegion {
  id: string
  start: number
  end: number
  label: string
  color: string
  lane: string
  raw: Region
}

export interface ResolvedTrack {
  id: string
  type: 'audio' | 'bus' | 'video'
  /** holds library pieces only (`samplers: true`, or the older `lib-*` / `compl-*` tracks) */
  samplers: boolean
  name: string
  color: string
  volume: number
  pan: number
  muted: boolean
  solo: boolean
  output: string | null
  effects: Effect[]
  envelope: ResolvedPoint[]
  clips: ResolvedClip[]
  raw: Track
}

export interface ResolvedProject {
  name: string
  sampleRate: number
  bpm?: number
  meter: number
  gridOffset: number
  duration: number
  video: { width: number; height: number; fps: number }
  markers: { id: string; at: number; label?: string; color?: string }[]
  lanes: { id: string; name: string; color?: string }[]
  regions: ResolvedRegion[]
  tracks: ResolvedTrack[]
  master: { volume: number; effects: Effect[]; envelope: ResolvedPoint[]; loudness?: { target: number; true_peak?: number } }
  diagnostics: string[]
  ctx: TimeContext
}

const REGION_PALETTE = ['#6a9bcc', '#7b74b8', '#b47c62', '#6aa784', '#b8a05a', '#a8678f']
const PALETTE = ['#5b8def', '#e0915b', '#5bbf8a', '#c75b9b', '#b9a44c', '#5bb3c7', '#9b7be0', '#d0625f']

export function resolveEnvelope(points: Point[] | undefined, ctx: TimeContext, diagnostics: string[]): ResolvedPoint[] {
  return (points ?? [])
    .map((p, index) => ({ at: resolveTime(p.at, ctx, 0, diagnostics), db: p.db, curve: p.curve ?? 'linear', index }))
    .sort((a, b) => a.at - b.at)
}

export function resolveProject(project: Project): ResolvedProject {
  const diagnostics: string[] = []
  const ctx = buildTimeContext(project, diagnostics)
  let end = 0
  const tracks: ResolvedTrack[] = project.tracks.map((t, i) => {
    const clips: ResolvedClip[] = (t.clips ?? []).map((c) => {
      const asset = project.assets[c.asset]
      if (!asset) diagnostics.push(`Clip "${c.id}" on track "${t.id}": unknown asset "${c.asset}"`)
      const start = resolveTime(c.start, ctx, 0, diagnostics)
      const inPoint = c.in ?? 0
      const fileDur = asset?.meta?.duration
      const out = c.out ?? fileDur ?? inPoint
      const duration = Math.max(0, out - inPoint)
      end = Math.max(end, start + duration)
      return {
        id: c.id, trackId: t.id, asset: c.asset, src: asset?.src ?? '', start: round(start), in: inPoint, out,
        end: round(start + duration), duration: round(duration), gain: c.gain ?? 0,
        bodyEnd: round(start + ((c.body ?? asset?.body) !== undefined ? Math.max(0, Math.min(duration, (c.body ?? asset!.body!) - inPoint)) : duration)),
        fadeIn: c.fade_in ?? 0.005, fadeOut: c.fade_out ?? 0.005, muted: !!c.muted, label: c.label, raw: c,
      }
    })
    return {
      id: t.id, type: t.type ?? 'audio', samplers: isSamplerTrack(t), name: t.name ?? t.id, color: t.color ?? PALETTE[i % PALETTE.length],
      volume: t.volume ?? 0, pan: t.pan ?? 0, muted: !!t.muted, solo: !!t.solo, output: t.output ?? null,
      effects: t.effects ?? [], envelope: resolveEnvelope(t.automation?.volume, ctx, diagnostics), clips, raw: t,
    }
  })
  const markers = (project.markers ?? []).map((m) => ({ id: m.id, at: ctx.refs[m.id], label: m.label, color: m.color }))
  for (const m of markers) end = Math.max(end, m.at)
  const lanes = (project.lanes ?? []).map((l) => ({ id: l.id, name: l.name ?? l.id, color: l.color }))
  const firstLane = lanes[0]?.id ?? 'tags'
  const regions: ResolvedRegion[] = (project.regions ?? []).map((g, i) => {
    const lane = g.lane ?? firstLane
    if (!lanes.some((l) => l.id === lane)) lanes.push({ id: lane, name: lane, color: undefined })
    return {
      id: g.id, start: ctx.refs[g.id], end: ctx.refs[`${g.id}.end`], label: g.label ?? g.id,
      color: g.color ?? lanes.find((l) => l.id === lane)?.color ?? REGION_PALETTE[i % REGION_PALETTE.length], lane, raw: g,
    }
  })
  for (const g of regions) end = Math.max(end, g.end)
  const m = project.master ?? {}
  return {
    name: project.project.name, sampleRate: project.project.sample_rate, bpm: project.project.bpm,
    meter: project.project.meter ?? 4, gridOffset: project.project.grid_offset ?? 0,
    duration: round(project.project.duration ?? end), markers, lanes, regions, tracks,
    video: { width: project.project.video?.width ?? 1920, height: project.project.video?.height ?? 1080, fps: project.project.video?.fps ?? 30 },
    master: { volume: m.volume ?? 0, effects: m.effects ?? [], envelope: resolveEnvelope(m.automation?.volume, ctx, diagnostics), loudness: m.loudness },
    diagnostics, ctx,
  }
}

/** Envelope value (dB) at time t: linear in dB between points, flat before the first and after the last. */
export function envelopeAt(points: ResolvedPoint[], t: number): number {
  if (points.length === 0) return 0
  if (t <= points[0].at) return points[0].db
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (t < b.at) {
      if (a.curve === 'hold' || b.at === a.at) return a.db
      return a.db + ((b.db - a.db) * (t - a.at)) / (b.at - a.at)
    }
  }
  return points[points.length - 1].db
}

/** Which tracks are heard, after mute and solo. A soloed track keeps its bus chain audible. */
export function audibleTracks(tracks: ResolvedTrack[]): Set<string> {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const anySolo = tracks.some((t) => t.solo && t.type !== 'video')
  const heard = new Set<string>()
  for (const t of tracks) {
    if (t.muted || t.type === 'video') continue
    if (anySolo) {
      // soloed itself, or a bus that a soloed track feeds into
      const feedsSolo = tracks.some((o) => o.solo && chainOf(o, byId).includes(t.id))
      if (!t.solo && !feedsSolo) continue
    }
    heard.add(t.id)
  }
  return heard
}

function chainOf(t: ResolvedTrack, byId: Map<string, ResolvedTrack>): string[] {
  const out: string[] = []
  let cur = t.output ? byId.get(t.output) : undefined
  while (cur && !out.includes(cur.id)) {
    out.push(cur.id)
    cur = cur.output ? byId.get(cur.output) : undefined
  }
  return out
}

/**
 * The duck envelope as on/off regions: the source track's clips, widened by attack
 * and release, with gaps shorter than `hold` filled in.
 */
export function duckRegions(project: ResolvedProject, effect: Extract<Effect, { type: 'duck' }>): [number, number][] {
  const src = project.tracks.find((t) => t.id === effect.source)
  if (!src) return []
  const attack = effect.attack ?? 0.08
  const release = effect.release ?? 0.4
  const hold = effect.hold ?? 0.6
  const spans = src.clips.filter((c) => !c.muted).map((c) => [c.start, c.end] as [number, number]).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1]
    if (last && a - last[1] < hold) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged.map(([a, b]) => [Math.max(0, a - attack), b + release])
}

/** Processing order: every track before the bus it feeds. */
export function processingOrder(tracks: ResolvedTrack[]): ResolvedTrack[] {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const depth = (t: ResolvedTrack): number => {
    let d = 0
    let cur = t.output ? byId.get(t.output) : undefined
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      d++
      cur = cur.output ? byId.get(cur.output) : undefined
    }
    return d
  }
  return [...tracks].sort((a, b) => depth(b) - depth(a))
}

/** Duck offset (dB, ≤ 0) at time t: ramps down over `attack` into a region and back up over `release` out of it. */
export function duckDbAt(regions: [number, number][], depth: number, attack: number, release: number, t: number): number {
  let amount = 0
  for (const [a, b] of regions) {
    if (t < a || t > b) continue
    const down = attack > 0 ? Math.min(1, (t - a) / attack) : 1
    const up = release > 0 ? Math.min(1, (b - t) / release) : 1
    amount = Math.max(amount, Math.min(down, up))
  }
  return -depth * amount
}

/** The picture at time t: the clip of the first visible video track that covers it. */
export function videoAt(tracks: ResolvedTrack[], t: number): ResolvedClip | null {
  for (const tr of tracks) {
    if (tr.type !== 'video' || tr.muted) continue
    const c = tr.clips.find((x) => !x.muted && t >= x.start && t < x.end)
    if (c) return c
  }
  return null
}

/** A samplers track: flagged, or one of the older tracks the library made per category (`lib-*`, `compl-*`). */
export function isSamplerTrack(t: { id: string; type?: string; samplers?: boolean }): boolean {
  return (t.type ?? 'audio') === 'audio' && (!!t.samplers || /^(lib|compl)-/.test(t.id))
}
