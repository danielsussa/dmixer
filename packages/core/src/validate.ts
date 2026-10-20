import type { Project } from './schema.js'
import { resolveProject } from './resolve.js'
import { isStill, pictureKind } from './visual.js'

export interface Diagnostic {
  severity: 'error' | 'warning'
  message: string
}

/** Checks the schema cannot express: references between things, and things that will sound wrong. */
export function validateProject(project: Project): Diagnostic[] {
  const out: Diagnostic[] = []
  const r = resolveProject(project)
  for (const d of r.diagnostics) out.push({ severity: 'error', message: d })
  const ids = new Set<string>()
  for (const t of project.tracks) {
    if (ids.has(t.id)) out.push({ severity: 'error', message: `Duplicate track id "${t.id}"` })
    ids.add(t.id)
  }
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  for (const t of project.tracks) {
    if (t.output) {
      const bus = tracks.get(t.output)
      if (!bus) out.push({ severity: 'error', message: `Track "${t.id}": output "${t.output}" is not a track` })
      else if ((bus.type ?? 'audio') !== 'bus') out.push({ severity: 'error', message: `Track "${t.id}": output "${t.output}" is not a bus` })
      let cur = bus
      const seen = new Set([t.id])
      while (cur?.output) {
        if (seen.has(cur.id)) {
          out.push({ severity: 'error', message: `Track "${t.id}": routing loop through "${cur.id}"` })
          break
        }
        seen.add(cur.id)
        cur = tracks.get(cur.output)
      }
    }
    if (t.type === 'bus' && t.clips?.length) out.push({ severity: 'warning', message: `Bus "${t.id}" has clips; they are ignored` })
    if (t.type === 'video') {
      for (const c of t.clips ?? []) {
        if (!c.asset) {
          if (!c.type) out.push({ severity: 'error', message: `Clip "${c.id}" on video track "${t.id}": no asset (only \`type: color\` and \`type: adjustment\` need none)` })
          if (c.out === undefined && c.duration === undefined) out.push({ severity: 'error', message: `Clip "${c.id}" on video track "${t.id}": a ${c.type ?? 'clip'} needs a \`duration\`` })
          continue
        }
        const a = project.assets[c.asset]
        const kind = pictureKind(c.type, a?.src ?? '')
        if (kind === 'video' && a?.meta && a.meta.duration !== undefined && !a.meta.width) out.push({ severity: 'error', message: `Clip "${c.id}" on video track "${t.id}": "${c.asset}" has no picture` })
        if (isStill(kind) && c.out === undefined && c.duration === undefined) out.push({ severity: 'error', message: `Clip "${c.id}" on video track "${t.id}": a still (${kind}) needs a \`duration\`` })
      }
      if (t.output) out.push({ severity: 'warning', message: `Video track "${t.id}": output is ignored (it makes no sound)` })
    }
    const clipIds = new Set<string>()
    for (const c of t.clips ?? []) {
      if (clipIds.has(c.id)) out.push({ severity: 'error', message: `Track "${t.id}": duplicate clip id "${c.id}"` })
      clipIds.add(c.id)
      const src = c.asset ? project.assets[c.asset]?.src ?? '' : ''
      const dur = c.asset && (t.type !== 'video' || pictureKind(c.type, src) === 'video') ? project.assets[c.asset]?.meta?.duration : undefined
      if (dur !== undefined && (c.out ?? 0) > dur + 0.01) {
        out.push({ severity: 'warning', message: `Clip "${c.id}": out ${c.out} is past the end of the file (${dur})` })
      }
      if (c.out !== undefined && (c.in ?? 0) >= c.out) out.push({ severity: 'error', message: `Clip "${c.id}": in must be before out` })
    }
    for (const e of t.effects ?? []) {
      if (e.type === 'duck' && !tracks.has(e.source)) out.push({ severity: 'error', message: `Track "${t.id}": duck source "${e.source}" is not a track` })
      if (e.type === 'espectral' && !tracks.has(e.source)) out.push({ severity: 'error', message: `Track "${t.id}": espectral source "${e.source}" is not a track` })
    }
  }
  const regionIds = new Set<string>()
  for (const g of r.regions) {
    if (regionIds.has(g.id)) out.push({ severity: 'error', message: `Duplicate tag id "${g.id}"` })
    regionIds.add(g.id)
    if (g.end <= g.start) out.push({ severity: 'error', message: `Tag "${g.id}": end must be after start` })
  }
  const markerIds = new Set<string>()
  for (const m of project.markers ?? []) {
    if (markerIds.has(m.id)) out.push({ severity: 'error', message: `Duplicate marker id "${m.id}"` })
    markerIds.add(m.id)
  }
  return out
}
