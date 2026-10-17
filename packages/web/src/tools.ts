import { juntarTrechos, round, subidasNasPausas, type Project, type ResolvedClip, type ResolvedProject } from '@dmixer/core'
import { analisesProntas, gradeDaMusica, loadSpeech, P, patch } from './api'
import { isLibraryPiece } from './components/Library'
import { useEditor } from './store'

type Op = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }

const MIN = 0.02

/** Library pieces are fixed blocks (their body is what joins the next one): they are not split or crossfaded. */
export const editable = (c: ResolvedClip) => !isLibraryPiece(c.asset)

const set = (path: string, raw: object, key: string, value: unknown): Op =>
  ({ op: (raw as Record<string, unknown>)[key] === undefined ? 'add' : 'replace', path: `${path}/${key}`, value })

/** A clip id not in `taken` (which holds every clip id of the mix), and now taken. */
function freshId(taken: Set<string>, base: string) {
  const b = base.replace(/-\d+$/, '')
  let n = 2
  while (taken.has(`${b}-${n}`)) n++
  taken.add(`${b}-${n}`)
  return `${b}-${n}`
}

/**
 * One clip becomes two at `at` (timeline seconds): the left keeps its id and ends there,
 * the right is a copy that starts there and reads on from the same point of the file.
 */
function splitOps(project: Project, trackId: string, c: ResolvedClip, at: number, taken: Set<string>): Op[] | null {
  if (!editable(c) || at < c.start + MIN || at > c.end - MIN) return null
  const cut = round(c.in + (at - c.start))
  const path = P.clip(trackId, c.id)
  const id = freshId(taken, c.id)
  const idx = (project.tracks.find((t) => t.id === trackId)?.clips ?? []).findIndex((x) => x.id === c.id)
  const { fade_in: _fi, ...rest } = c.raw
  const right = { ...rest, id, start: round(at), in: cut }
  const ops: Op[] = [set(path, c.raw, 'out', cut)]
  // the seam is a hard cut: the left loses its fade-out, the right starts without the left's fade-in
  if (c.raw.fade_out !== undefined) ops.push({ op: 'remove', path: `${path}/fade_out` })
  ops.push({ op: 'add', path: `${P.track(trackId)}/clips/${idx + 1}`, value: right })
  return ops
}

/** Clips under `at`: in the selected clip, else in the selected track, else in every audio track. */
function targets(r: ResolvedProject, at: number) {
  const sel = useEditor.getState().selection
  const under = (c: ResolvedClip) => editable(c) && at > c.start + MIN && at < c.end - MIN
  if (sel?.kind === 'clip') return r.tracks.filter((t) => t.id === sel.trackId).flatMap((t) => t.clips.filter((c) => c.id === sel.clipId && under(c)))
  if (sel?.kind === 'track') return r.tracks.filter((t) => t.id === sel.trackId).flatMap((t) => t.clips.filter(under))
  return r.tracks.filter((t) => t.type !== 'bus').flatMap((t) => t.clips.filter(under))
}

export async function splitAt(at: number, only?: { trackId: string; clipId: string }) {
  const { project, resolved } = useEditor.getState()
  if (!project || !resolved) return
  const clips = only
    ? resolved.tracks.filter((t) => t.id === only.trackId).flatMap((t) => t.clips.filter((c) => c.id === only.clipId))
    : targets(resolved, at)
  const taken = new Set(project.tracks.flatMap((t) => (t.clips ?? []).map((c) => c.id)))
  // later clips first, so the array indexes of the earlier ones still hold
  // com o SNAP ligado, uma música analisada é dividida no compasso (ou tempo) DELA mais perto do playhead
  const grid = useEditor.getState().snapGrid
  const naGrade = (c: ResolvedClip) => {
    const g = grid === 'off' ? [] : gradeDaMusica(c, grid === 'bar' ? 'bar' : 'beat').filter((x) => x > c.start + MIN && x < c.end - MIN)
    return g.length ? g.reduce((b, x) => (Math.abs(x - at) < Math.abs(b - at) ? x : b), g[0]) : at
  }
  const ops = clips
    .map((c) => ({ c, idx: (project.tracks.find((t) => t.id === c.trackId)?.clips ?? []).findIndex((x) => x.id === c.id) }))
    .sort((a, b) => b.idx - a.idx)
    .flatMap(({ c }) => splitOps(project, c.trackId, c, naGrade(c), taken) ?? [])
  if (!ops.length) {
    alert('Não há clipe para dividir aqui: ponha o playhead (ou o clique) dentro de um clipe de áudio. Peças da biblioteca não se dividem.')
    return
  }
  await patch(ops as never, clips.length === 1 ? `Dividir ${clips[0].id}` : `Dividir ${clips.length} clipes`)
}

/** The clip right after `c` on its track: the one whose start is nearest to where `c` ends. */
function nextOf(r: ResolvedProject, c: ResolvedClip) {
  const t = r.tracks.find((x) => x.id === c.trackId)
  return t?.clips
    .filter((x) => x.id !== c.id && x.start > c.start + MIN)
    .sort((a, b) => Math.abs(a.start - c.end) - Math.abs(b.start - c.end))[0]
}

/**
 * Crossfade the selected clip into the next one on its track, `len` seconds long.
 * Clips that already overlap fade over the overlap. Clips that touch (or nearly) grow
 * into each other around the seam, using the file material past their edges; when a
 * side has none (a song's own end or start), the next clip comes in earlier instead.
 */
export async function crossfade(len: number) {
  const { project, resolved, selection } = useEditor.getState()
  if (!project || !resolved) return
  if (selection?.kind !== 'clip') return alert('Selecione o primeiro dos dois clipes: o crossfade vai dele para o próximo da mesma trilha.')
  const a = resolved.tracks.find((t) => t.id === selection.trackId)?.clips.find((c) => c.id === selection.clipId)
  if (!a) return
  const b = nextOf(resolved, a)
  if (!b) return alert('Não há um próximo clipe nesta trilha para fazer o crossfade.')
  if (!editable(a) || !editable(b)) return alert('Peças da biblioteca já emendam sozinhas (pela cauda): o crossfade é para clipes de áudio comuns.')
  const gap = b.start - a.end
  if (gap > len) return alert(`Os clipes estão ${gap.toFixed(2)} s afastados, mais que o crossfade (${len} s). Aproxime-os ou aumente a duração.`)

  const pa = P.clip(a.trackId, a.id)
  const pb = P.clip(b.trackId, b.id)
  const ops: Op[] = []
  let x: number
  let note = ''
  if (gap < -MIN) {
    x = Math.min(-gap, a.duration, b.duration)
  } else {
    const seam = (a.end + b.start) / 2
    const fileA = project.assets[a.asset]?.meta?.duration ?? a.out
    let growA = Math.max(0, Math.min(seam + len / 2 - a.end, fileA - a.out))
    let growB = Math.max(0, Math.min(b.start - (seam - len / 2), b.in))
    // what one side could not give, the other gives (or the next clip is pulled earlier)
    let short = len - (a.end + growA - (b.start - growB))
    if (short > 0) { const more = Math.max(0, Math.min(short, fileA - a.out - growA)); growA += more; short -= more }
    if (short > 0) { const more = Math.max(0, Math.min(short, b.in - growB)); growB += more; short -= more }
    const pull = Math.max(0, short)
    if (growA > 0) ops.push(set(pa, a.raw, 'out', round(a.out + growA)))
    if (growB + pull > 0) ops.push(set(pb, b.raw, 'start', round(b.start - growB - pull)))
    if (growB > 0) ops.push(set(pb, b.raw, 'in', round(b.in - growB)))
    if (pull > 0.001) note = ` (${b.id} entra ${pull.toFixed(2)} s antes)`
    x = a.end + growA - (b.start - growB - pull)
  }
  x = round(Math.max(MIN, x))
  ops.push(set(pa, a.raw, 'fade_out', x), set(pb, b.raw, 'fade_in', x))
  await patch(ops as never, `Crossfade ${a.id} → ${b.id} ${x}s${note}`)
}

export async function fade(which: 'in' | 'out', len: number) {
  const { resolved, selection } = useEditor.getState()
  if (selection?.kind !== 'clip') return alert('Selecione um clipe.')
  const c = resolved?.tracks.find((t) => t.id === selection.trackId)?.clips.find((x) => x.id === selection.clipId)
  if (!c) return
  const v = round(Math.min(len, c.duration))
  await patch([set(P.clip(c.trackId, c.id), c.raw, `fade_${which}`, v)] as never, `Fade ${which} ${c.id} ${v}s`)
}

/**
 * Take [from, to) (seconds of the file) out of a clip: it becomes two clips that meet where
 * `from` was, joined by a short crossfade (cut points sit on beats, so a long one would smear the hit).
 */
export async function removeStretch(trackId: string, clipId: string, from: number, to: number, xfade = 0.06) {
  const { project, resolved } = useEditor.getState()
  const c = resolved?.tracks.find((t) => t.id === trackId)?.clips.find((x) => x.id === clipId)
  if (!project || !c) return
  const h = xfade / 2
  if (from - h <= c.in + MIN || to + h >= c.out - MIN) return alert('Esse trecho não está inteiro dentro do clipe.')
  const path = P.clip(trackId, c.id)
  const seam = c.start + (from - c.in)
  const taken = new Set(project.tracks.flatMap((t) => (t.clips ?? []).map((x) => x.id)))
  const id = freshId(taken, c.id)
  const idx = (project.tracks.find((t) => t.id === trackId)?.clips ?? []).findIndex((x) => x.id === c.id)
  const { fade_in: _fi, ...rest } = c.raw
  const ops: Op[] = [
    set(path, c.raw, 'out', round(from + h)),
    set(path, c.raw, 'fade_out', round(xfade)),
    { op: 'add', path: `${P.track(trackId)}/clips/${idx + 1}`, value: { ...rest, id, start: round(seam - h), in: round(to - h), fade_in: round(xfade) } },
  ]
  await patch(ops as never, `Tirar ${(to - from).toFixed(1)} s de ${c.id}`)
}

/**
 * Play a stretch twice: the clip reaches `to` (seconds of the file), jumps back to `from` and goes on from there, so
 * [from, to) sounds again (the same jump as removeStretch, taken backwards). The clip becomes two that meet where `to`
 * was, joined by a short crossfade on the beat; what comes after on the track moves later by the added length.
 */
export async function repeatStretch(trackId: string, clipId: string, from: number, to: number, xfade = 0.06) {
  const { project, resolved } = useEditor.getState()
  const t = resolved?.tracks.find((x) => x.id === trackId)
  const c = t?.clips.find((x) => x.id === clipId)
  if (!project || !t || !c) return
  const h = xfade / 2
  if (from - h < 0 || to - h <= c.in + MIN || to + h >= c.out - MIN) return alert('Esse trecho não está inteiro dentro do clipe.')
  const path = P.clip(trackId, c.id)
  const seam = c.start + (to - c.in)
  const add = round(to - from)
  const taken = new Set(project.tracks.flatMap((tr) => (tr.clips ?? []).map((x) => x.id)))
  const id = freshId(taken, c.id)
  const idx = (project.tracks.find((tr) => tr.id === trackId)?.clips ?? []).findIndex((x) => x.id === c.id)
  const { fade_in: _fi, ...rest } = c.raw
  const ops: Op[] = [
    set(path, c.raw, 'out', round(to + h)),
    set(path, c.raw, 'fade_out', round(xfade)),
  ]
  // o que vem depois nesta trilha anda junto, para não ficar por baixo da repetição (ids, não índices: o add abaixo muda os índices)
  for (const o of t.clips) {
    if (o.id !== c.id && o.start >= c.end - MIN && typeof o.raw.start === 'number') ops.push({ op: 'replace', path: `${P.clip(trackId, o.id)}/start`, value: round(o.raw.start + add) })
  }
  ops.push({ op: 'add', path: `${P.track(trackId)}/clips/${idx + 1}`, value: { ...rest, id, start: round(seam - h), in: round(from - h), fade_in: round(xfade) } })
  await patch(ops as never, `Repetir ${add.toFixed(1)} s de ${c.id}`)
}

/**
 * Put the joins between pieces of the same song on the song's own grid (cuts made by hand, or before the analysis,
 * land between beats and the beat jumps phase at the join). For each pair of clips of the song that touch on the track,
 * left to right: the left one leaves at the song's bar nearest to where it left, the right one comes in at the bar nearest
 * to where it came in, butted with a short crossfade on the beat; everything after on the track moves by what changed.
 * Returns how many joins were fixed.
 */
export async function encaixarEmendas(trackId: string, src: string, xfade = 0.06): Promise<number> {
  const { project, resolved } = useEditor.getState()
  const bars = analisesProntas.get(src)?.bars
  const t = resolved?.tracks.find((x) => x.id === trackId)
  if (!project || !t || !bars?.length) return 0
  const near = (v: number) => bars.reduce((m, x) => (Math.abs(x - v) < Math.abs(m - v) ? x : m), bars[0])
  const h = xfade / 2
  // o estado simulado de cada clipe da trilha (todos andam com as emendas; só os da música são encaixados)
  const cs = [...t.clips].sort((a, b) => a.start - b.start).map((c) => ({ c, start: c.start, in: c.in, out: c.out, fi: c.raw.fade_in, fo: c.raw.fade_out }))
  let feitas = 0
  for (let i = 0; i + 1 < cs.length; i++) {
    const a = cs[i]
    const b = cs[i + 1]
    if (a.c.src !== src || b.c.src !== src) continue
    const fimA = a.start + (a.out - a.in)
    if (Math.abs(b.start - fimA) > 0.15) continue   // só as que se tocam (ou quase)
    const L = near(a.out)
    const R = near(b.in)
    if (L <= a.in + 0.1 || R >= b.out - 0.1) continue
    const emenda = a.start + (L - a.in)
    const fimBantes = b.start + (b.out - b.in)
    a.out = L + h
    a.fo = xfade
    b.start = emenda - h
    b.in = R - h
    b.fi = xfade
    const anda = b.start + (b.out - b.in) - fimBantes
    for (const o of cs.slice(i + 2)) o.start += anda
    feitas++
  }
  if (!feitas) return 0
  const ops: Op[] = []
  for (const s of cs) {
    const p = P.clip(trackId, s.c.id)
    if (Math.abs(s.start - s.c.start) > 0.0005 && typeof s.c.raw.start === 'number') ops.push({ op: 'replace', path: `${p}/start`, value: round(s.start) })
    if (Math.abs(s.in - s.c.in) > 0.0005) ops.push(set(p, s.c.raw, 'in', round(s.in)))
    if (Math.abs(s.out - s.c.out) > 0.0005) ops.push(set(p, s.c.raw, 'out', round(s.out)))
    if (s.fi !== s.c.raw.fade_in && s.fi !== undefined) ops.push(set(p, s.c.raw, 'fade_in', round(s.fi)))
    if (s.fo !== s.c.raw.fade_out && s.fo !== undefined) ops.push(set(p, s.c.raw, 'fade_out', round(s.fo)))
  }
  await patch(ops as never, `Encaixar ${feitas} emenda(s) na grade da música`)
  return feitas
}

/**
 * Copy and paste a clip (Ctrl/⌘+C, Ctrl/⌘+V). The copy keeps the clip as written (in, out, fades, gain, cut body…) and
 * the asset it plays, so it can be pasted in another mix too. It pastes at the playhead, on the selected track (or the one
 * it came from), and the playhead jumps to its end: pasting again lays the copies end to end.
 * Samplers rules hold: a library piece only goes on a samplers track (never over another piece), other audio never does.
 */
type Copia = { clip: Record<string, unknown>; len: number; asset: string; assetDef?: unknown; media?: [string, string]; trackId: string; samplers: boolean; type: string }
const CLIP_KEY = 'dmixer.clipboard'

export function copiar(): string {
  const { project, resolved, selection } = useEditor.getState()
  if (selection?.kind !== 'clip' || !project || !resolved) return 'selecione um clipe para copiar'
  const t = resolved.tracks.find((x) => x.id === selection.trackId)
  const c = t?.clips.find((x) => x.id === selection.clipId)
  if (!t || !c) return 'selecione um clipe para copiar'
  const assetDef = project.assets[c.asset]
  const alias = typeof assetDef?.src === 'string' ? /^@([^/]+)\//.exec(assetDef.src)?.[1] : undefined
  const { id: _id, start: _s, ...resto } = c.raw as Record<string, unknown>
  const copia: Copia = { clip: resto, len: c.bodyEnd - c.start, asset: c.asset, assetDef, media: alias && project.media?.[alias] ? [alias, project.media[alias]] : undefined,
    trackId: t.id, samplers: t.samplers, type: t.type }
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(copia)) } catch { /* sem storage */ }
  ;(window as unknown as { __dmixerCopia?: Copia }).__dmixerCopia = copia
  return `copiado: ${c.label ?? c.id}`
}

export async function colar(): Promise<string> {
  const { project, resolved, selection, playhead } = useEditor.getState()
  if (!project || !resolved) return ''
  let copia = (window as unknown as { __dmixerCopia?: Copia }).__dmixerCopia
  if (!copia) { try { copia = JSON.parse(localStorage.getItem(CLIP_KEY) ?? 'null') ?? undefined } catch { /* nada */ } }
  if (!copia) return 'nada copiado ainda (Ctrl/⌘+C num clipe)'
  const serve = (t: { id: string; type: string; samplers: boolean }) => t.type === copia!.type && t.samplers === copia!.samplers
  const selTrack = selection && 'trackId' in selection ? resolved.tracks.find((t) => t.id === selection.trackId) : undefined
  const alvo = (selTrack && serve(selTrack) ? selTrack : undefined) ?? resolved.tracks.find((t) => t.id === copia!.trackId && serve(t)) ?? resolved.tracks.find(serve)
  if (!alvo) return copia.samplers ? 'não há trilha de samplers para colar a peça' : 'não há trilha de áudio compatível para colar'
  let start = round(Math.max(0, playhead))
  if (alvo.samplers) {
    // lego: a peça não se sobrepõe; se a agulha cair em cima de outra, vai para o encaixe livre mais próximo
    const { freeStart } = await import('./components/Library')
    start = round(freeStart(alvo.clips.map((x) => ({ start: x.start, end: x.bodyEnd })), start, copia.len))
  }
  const ops: Op[] = []
  if (copia.media && !project.media?.[copia.media[0]]) {
    ops.push(project.media ? { op: 'add', path: `/media/${copia.media[0]}`, value: copia.media[1] } : { op: 'add', path: '/media', value: { [copia.media[0]]: copia.media[1] } })
  }
  if (!project.assets[copia.asset]) {
    if (!copia.assetDef) return 'o arquivo do clipe copiado não está nesta mixagem'
    ops.push({ op: 'add', path: `/assets/${copia.asset}`, value: copia.assetDef })
  }
  const taken = new Set(project.tracks.flatMap((t) => (t.clips ?? []).map((c) => c.id)))
  const id = freshId(taken, copia.asset)
  const raw = project.tracks.find((t) => t.id === alvo.id)!
  ops.push({ op: 'add', path: raw.clips ? `${P.track(alvo.id)}/clips/-` : `${P.track(alvo.id)}/clips`, value: raw.clips ? { ...copia.clip, id, start } : [{ ...copia.clip, id, start }] })
  await patch(ops as never, `Colar ${id}`)
  const s = useEditor.getState()
  s.select({ kind: 'clip', trackId: alvo.id, clipId: id })
  s.setPlayhead(start + copia.len)   // colar de novo emenda a próxima cópia no fim desta
  return `colado em ${alvo.name ?? alvo.id}`
}

/**
 * Mixagem automática (o botão "Mixar"). Por enquanto, um passo: as subidas nas pausas da locução. Toda trilha com um
 * duck ganha um envelope de volume tirado da fala de verdade da trilha-fonte (medida no áudio, frase por frase, e não
 * pelos clipes inteiros): embaixo da voz fica na profundidade do duck, nas pausas sobe, e desce de novo um pouco antes
 * da próxima palavra. O envelope substitui o duck, que fica desligado (bypass), e aparece na timeline para ajuste à mão.
 * Os próximos passos (EQ dinâmico, nivelar os clipes, conferir no alto-falante) entram nesta mesma função.
 */
export async function mixarAutomatico(): Promise<string> {
  const r = useEditor.getState().resolved
  if (!r) return 'mixagem ainda carregando'
  const ops: Op[] = []
  const feitos: string[] = []
  const falaPorTrilha = new Map<string, [number, number][]>()
  const falaDe = async (id: string) => {
    if (falaPorTrilha.has(id)) return falaPorTrilha.get(id)!
    const src = r.tracks.find((t) => t.id === id)
    const spans: [number, number][] = []
    for (const c of src?.clips.filter((c) => !c.muted) ?? []) {
      for (const [a, b] of await loadSpeech(c.src)) {
        const s = Math.max(a, c.in)
        const e = Math.min(b, c.in + (c.end - c.start))
        if (e > s) spans.push([round(c.start + s - c.in), round(c.start + e - c.in)])
      }
    }
    const j = juntarTrechos(spans)
    falaPorTrilha.set(id, j)
    return j
  }
  for (const t of r.tracks) {
    const raw = t.raw.effects ?? []
    const i = raw.findIndex((e) => e.type === 'duck')
    if (i < 0) continue
    const duck = raw[i] as Extract<(typeof raw)[number], { type: 'duck' }>
    const fala = await falaDe(duck.source)
    if (!fala.length) continue
    const pts = subidasNasPausas(fala, { depth: duck.depth })
    const path = P.track(t.id)
    ops.push({ op: t.raw.automation ? 'replace' : 'add', path: `${path}/automation`, value: { ...(t.raw.automation ?? {}), volume: pts } })
    if (!duck.bypass) ops.push({ op: 'add', path: `${path}/effects/${i}/bypass`, value: true })
    const pausas = pts.filter((p) => p.db > -duck.depth).length / 2
    feitos.push(`${t.name}: ${Math.round(pausas)} subidas em ${fala.length} frases`)
  }
  if (!ops.length) return 'nenhuma trilha com duck (o duck diz qual trilha é a voz)'
  await patch(ops as never, 'Mixar: subidas nas pausas da locução')
  return feitos.join(' · ')
}
