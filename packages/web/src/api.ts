import type { PatchOp, Pecas, Transcricao } from '@dmixer/core'
import { useEditor } from './store'

/**
 * The socket is the only way project state arrives. Whether a change came from this
 * window, the CLI, or an agent rewriting the YAML, it reaches the UI the same way.
 */
export function connect(): () => void {
  let socket: WebSocket | null = null
  let retry: ReturnType<typeof setTimeout> | undefined
  let closed = false
  const open = () => {
    if (closed) return
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    socket = new WebSocket(`${protocol}://${location.host}/ws`)
    socket.onopen = () => {
      useEditor.getState().setConnected(true)
      const c = currentId()
      if (c) void loadState(c)
    }
    socket.onclose = () => {
      useEditor.getState().setConnected(false)
      if (!closed) retry = setTimeout(open, 1200)
    }
    socket.onerror = () => socket?.close()
    socket.onmessage = (event) => {
      const m = JSON.parse(event.data)
      const s = useEditor.getState()
      if (m.type === 'projects') {
        s.setProjects(m.projects)
        return
      }
      if (m.c && m.c !== s.projectName) return
      if (m.type === 'project') s.setState({ project: m.project, yaml: m.yaml, diagnostics: m.diagnostics, dirty: m.dirty, savedAt: m.savedAt })
      else if (m.type === 'history') s.setState({ canUndo: m.canUndo, canRedo: m.canRedo, history: m.history })
      else if (m.type === 'conflict') s.setState({ conflict: m.yaml })
      else if (m.type === 'render') s.setState({ render: m })
    }
  }
  open()
  return () => {
    closed = true
    clearTimeout(retry)
    socket?.close()
  }
}

/** The mix in the address bar: /c/<id>. */
export function currentId(): string | null {
  return /^\/c\/([^/]+)/.exec(location.pathname)?.[1] ?? null
}

const q = () => {
  const n = useEditor.getState().projectName
  return n ? `?c=${encodeURIComponent(n)}` : ''
}

export async function loadState(id: string) {
  const res = await fetch(`/api/state?c=${encodeURIComponent(id)}`)
  if (!res.ok) {
    useEditor.getState().setState({ projectName: id, project: null, resolved: null, loadError: (await res.json().catch(() => ({}))).error ?? res.statusText })
    return
  }
  const s = await res.json()
  useEditor.getState().setState({
    loadError: null, file: s.file,
    projectName: s.c, project: s.project, yaml: s.yaml, diagnostics: s.diagnostics, dirty: s.dirty,
    savedAt: s.savedAt, conflict: s.conflict, canUndo: s.canUndo, canRedo: s.canRedo, history: s.history,
  })
}

async function post(path: string, body: unknown = {}) {
  const res = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ c: useEditor.getState().projectName, ...(body as object) }),
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.ok === false) throw new Error(j.error ?? res.statusText)
  return j
}

export async function patch(ops: PatchOp[], label: string) {
  if (!ops.length) return
  try {
    await post('patch', { ops, label })
  } catch (e) {
    console.warn('patch refused:', (e as Error).message)
    alert(`Alteração recusada: ${(e as Error).message}`)
  }
}

/**
 * An audio file from this computer onto a track: the server copies it into audio/,
 * then one patch declares the asset and puts a clip at `start`.
 */
export async function importAudio(file: File, trackId: string, start: number) {
  const s = useEditor.getState()
  try {
    const res = await fetch(`/api/import?c=${encodeURIComponent(s.projectName ?? '')}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file })
    const j = await res.json().catch(() => ({}))
    if (!res.ok || !j.ok) throw new Error(j.error ?? (res.status === 404 ? 'o servidor não conhece /api/import (reinicie o servidor)' : res.status === 413 ? 'arquivo grande demais para o servidor ou proxy' : `HTTP ${res.status}`))
    const project = useEditor.getState().project
    if (!project) return
    const base = file.name.replace(/\.[^.]+$/, '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'audio'
    const fresh = (taken: Set<string>, b: string) => { if (!taken.has(b)) return b; let n = 2; while (taken.has(`${b}-${n}`)) n++; return `${b}-${n}` }
    const asset = fresh(new Set(Object.keys(project.assets)), base)
    const track = project.tracks.find((t) => t.id === trackId)
    if (!track) return
    const clip = fresh(new Set(project.tracks.flatMap((t) => (t.clips ?? []).map((c) => c.id))), base)
    // uma foto não tem duração: entra com 4 s (o resto se acerta arrastando a borda ou no Inspetor)
    const still = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)$/i.test(file.name)
    const value = () => ({ id: clip, asset, start: Math.round(start * 1000) / 1000, ...(still ? { duration: 4 } : {}), label: file.name })
    await post('patch', {
      ops: [
        { op: 'add', path: `/assets/${asset}`, value: { src: j.src } },
        track.clips ? { op: 'add', path: `${P.track(trackId)}/clips/-`, value: value() } : { op: 'add', path: `${P.track(trackId)}/clips`, value: [value()] },
      ],
      label: `Importar ${file.name}`,
    })
    useEditor.getState().select({ kind: 'clip', trackId, clipId: clip })
  } catch (e) {
    alert(`Não foi possível importar ${file.name}: ${(e as Error).message}`)
  }
}

export const undo = () => post('undo')
export const redo = () => post('redo')
export const save = () => post('save')
export const reload = () => post('reload')
export const applyYaml = (yaml: string) => post('yaml', { yaml })
export const startRender = (format: 'mp3' | 'wav' = 'mp3') => post('render', { format })

/** The file's fingerprint (size + mtime), so a regenerated file is fetched again instead of served from cache. */
function version(src: string) {
  const assets = useEditor.getState().project?.assets ?? {}
  const a = Object.values(assets).find((x) => x.src === src)
  return a?.meta?.hash ? `&v=${a.meta.hash}` : ''
}

/** Uma página de clipe html, por caminho: os links relativos dela (css, fontes) caem na mesma pasta. */
export function pageUrl(src: string, query: string) {
  const c = encodeURIComponent(useEditor.getState().projectName || '_')
  return `/api/page/${c}/${src.split('/').map(encodeURIComponent).join('/')}?${query}`
}

export function mediaUrl(src: string) {
  return `/api/media${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}${version(src)}`
}

const peakCache = new Map<string, Promise<{ rate: number; duration: number; data: number[] }>>()
export function loadPeaks(src: string) {
  const key = src + version(src)
  let p = peakCache.get(key)
  if (!p) {
    p = fetch(`/api/peaks${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}${version(src)}`).then((r) => r.json())
    peakCache.set(key, p)
  }
  return p
}

export interface Analysis {
  duration: number
  bpm: number
  confidence?: number
  meter?: number
  beats?: number[]
  bars?: number[]
  /** take out [from, to) of the file and the rest joins: score 1 is a perfect repeat */
  jumps?: { from: number; to: number; removes: number; bars: number; phrase: boolean; score: number; xfade?: number }[]
  /** "incerta": no steady beat (free orchestral, ambient): no bars, long crossfades */
  pulse?: 'firme' | 'incerta'
  error?: string
}

const analysisCache = new Map<string, Promise<Analysis>>()
/** Legado (analisador antigo, analyze.py): grade e pontos de corte de um arquivo. Não roda mais sozinho na timeline; as músicas do acervo usam loadAcervo. */
export function loadAnalysis(src: string): Promise<Analysis> {
  const key = src + version(src)
  let p = analysisCache.get(key)
  if (!p) {
    p = fetch(`/api/analysis${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}${version(src)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      analisesProntas.set(src, j as Analysis)
      useEditor.getState().setState({ analysisTick: useEditor.getState().analysisTick + 1 })
      return j as Analysis
    })
    p.catch(() => analysisCache.delete(key))
    analysisCache.set(key, p)
  }
  return p
}
export type PecasResposta = Pecas & { profunda_disponivel?: boolean }
/**
 * A música em peças (para remontar). A primeira vez leva segundos (Essentia) ou minutos (`profunda`, All-In-One): o
 * servidor trabalha em segundo plano e aqui se pergunta de novo até ficar pronto; `progresso` recebe os segundos.
 */
export async function loadPieces(src: string, profunda: boolean, progresso?: (s: number) => void): Promise<PecasResposta> {
  for (;;) {
    const r = await fetch(`/api/pieces${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}&profunda=${profunda ? 1 : 0}${version(src)}`)
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
    if (!j.running) return j as PecasResposta
    progresso?.(j.seconds ?? 0)
    await new Promise((ok) => setTimeout(ok, 2500))
  }
}
/** Onde há fala num arquivo de voz: trechos [início, fim] em segundos do arquivo (o servidor guarda em cache). */
export async function loadSpeech(src: string): Promise<[number, number][]> {
  const r = await fetch(`/api/speech${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}${version(src)}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.spans ?? []
}
/** A análise do acervo para uma música que veio de lá: as peças com função (abertura, base, pico…), energia e humor. */
export interface AcervoPiece { start: number; end: number; role: string; energy: number; mood: string; moods: Record<string, number> }
export interface AcervoAnalysis { id: string; bpm?: number; key?: string; pieces: AcervoPiece[] }
const acervoCache = new Map<string, Promise<AcervoAnalysis | null>>()
/** análises do acervo já aqui, por src (null = o arquivo não é do acervo ou não foi analisado lá) */
export const acervoProntas = new Map<string, AcervoAnalysis | null>()
export function loadAcervo(src: string): Promise<AcervoAnalysis | null> {
  const key = src + version(src)
  let p = acervoCache.get(key)
  if (!p) {
    p = fetch(`/api/acervo${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}${version(src)}`).then(async (r) => {
      const j = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      acervoProntas.set(src, j.analysis ?? null)
      if (j.analysis) useEditor.getState().setState({ analysisTick: useEditor.getState().analysisTick + 1 })
      return j.analysis ?? null
    })
    p.catch(() => acervoCache.delete(key))
    acervoCache.set(key, p)
  }
  return p
}
/** As músicas do acervo com análise profunda, com as peças (aba Músicas da Biblioteca). `src` é relativo a `root`. */
export interface AcervoSong extends AcervoAnalysis { titulo: string; artista?: string; fonte?: string; duracao?: number; src: string; root: string }
export async function loadAcervoSongs(): Promise<AcervoSong[]> {
  const r = await fetch(`/api/acervo/musicas${q()}`)
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
  return j.songs ?? []
}
export const acervoTrechoUrl = (src: string, ini: number, fim: number) =>
  `/api/acervo/trecho${q()}${q() ? '&' : '?'}src=${encodeURIComponent(src)}&ini=${ini.toFixed(3)}&fim=${fim.toFixed(3)}`
const transcricoes = new Map<string, Transcricao | null>()
/** O texto de cada fala (o `palavras.json` ao lado do áudio), por src; null quando não há. Pede só os que faltam. */
export async function loadTranscricoes(srcs: string[]): Promise<Record<string, Transcricao | null>> {
  const faltam = [...new Set(srcs)].filter((s) => !transcricoes.has(s + version(s)))
  if (faltam.length) {
    const j = await post('palavras', { srcs: faltam }) as Record<string, Transcricao | null>
    for (const s of faltam) transcricoes.set(s + version(s), j[s] ?? null)
  }
  return Object.fromEntries(srcs.map((s) => [s, transcricoes.get(s + version(s)) ?? null]))
}
export const hasAnalysis =(src: string) => analysisCache.has(src + version(src))
/** analyses already here, by src: what the timeline uses synchronously (beat grid, SNAP) */
export const analisesProntas = new Map<string, Analysis>()

/**
 * The nearest point of the song's own grid (bars or beats, as the SNAP says) to timeline time `t`, for a clip of that
 * song — the whole song, not just the part the clip plays, so an edge can be pulled out (lengthen) as well as in.
 * null when the song has no analysis yet or SNAP is off.
 */
export function pontoDaMusica(c: { src: string; start: number; in: number }, t: number, grade: 'bar' | 'beat' | 'off'): number | null {
  const a = analisesProntas.get(c.src)
  const pts = grade === 'off' ? undefined : grade === 'bar' ? a?.bars : a?.beats
  if (!pts?.length) return null
  const alvo = c.in + (t - c.start)   // em segundos do arquivo
  const b = pts.reduce((m, x) => (Math.abs(x - alvo) < Math.abs(m - alvo) ? x : m), pts[0])
  return c.start + (b - c.in)
}

/**
 * The song's own grid inside a clip, in timeline seconds: its bars (or beats) from the analysis. A song does not follow
 * the mix's BPM, so cutting it must snap to where ITS beats are.
 */
export function gradeDaMusica(c: { src: string; start: number; in: number; out: number }, modo: 'bar' | 'beat'): number[] {
  const a = analisesProntas.get(c.src)
  const pts = modo === 'bar' ? a?.bars : a?.beats
  if (!pts) return []
  return pts.filter((b) => b >= c.in && b <= c.out).map((b) => c.start + (b - c.in))
}

/** id-addressed JSON pointer pieces */
export const P = {
  track: (id: string) => `/tracks/[id=${id}]`,
  clip: (t: string, c: string) => `/tracks/[id=${t}]/clips/[id=${c}]`,
  marker: (id: string) => `/markers/[id=${id}]`,
  region: (id: string) => `/regions/[id=${id}]`,
  lane: (id: string) => `/lanes/[id=${id}]`,
}

export async function linkPath(path: string): Promise<{ id: string }> {
  const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) })
  const j = await res.json()
  if (!res.ok || !j.ok) throw new Error(j.error ?? res.statusText)
  return j
}

export async function unlinkMix(id: string) {
  await fetch(`/api/projects/${id}`, { method: 'DELETE' })
}

export async function fetchProjects() {
  const j = await (await fetch('/api/projects')).json()
  useEditor.getState().setProjects(j.projects)
}

/** In-app navigation: /c/<id> opens a mix, / is the list. */
export function go(path: string) {
  history.pushState(null, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}
