import { useEffect, useMemo, useRef, useState } from 'react'
import { CORES_FUNCAO, formatTime, isSamplerTrack, resolveProject, round, type Project, type ResolvedClip } from '@dmixer/core'
import { acervoProntas, acervoTrechoUrl, loadAcervoSongs, patch, type AcervoPiece, type AcervoSong } from '../api'
import { engine, type Preview } from '../audio'
import { useEditor } from '../store'
import { cx, Icon, IconButton } from './ui'
import { anchorPiece, edgeOf, EdgeGlyph, familyOf, fitsAfter, seam, textura } from './Connectors'

export interface LibraryItem {
  id: string
  src: string
  category: string
  layer?: string
  recipe?: string
  chord?: string
  intensity?: number
  bars?: number
  body?: number
  tail?: number
  loop?: boolean
  description?: string
  family?: string
  source?: string
  /** what it makes you feel (tensão, mistério…), one or two per recipe */
  mood?: string[]
  /** instrument families it plays (cordas, metais, madeiras, teclas, laminas, harpa, percussao) */
  instruments?: string[]
  /** fits under narration: no melody and no sharp attacks in the speech band */
  under_voice?: boolean
  /** measured texture of the first/last beat of the body: 8 spectrum-shape bands (dB) + movement */
  edges?: { in: number[][]; out: number[][]; tail?: number[][]; pulse?: { rin: number; rout: number; first: number; drop?: number } }
  /** coberturas: where the hit lands, in seconds from the start (it goes on the downbeat of the new piece) */
  hit?: number
  /** measured cut points: bar lines where the piece can end early and another start (seconds from the body start) */
  cuts?: { bar: number; at: number; out: number[][]; tail: number[][] }[]
  /** calços: length in beats (their `bars` is a fraction) */
  beats?: number
  role?: 'base' | 'complemento' | 'cobertura'
  in?: string
  out?: string
  harmonic?: boolean
  chords?: string[]
  min_bars?: number
  /** a slice of a longer composition: it plays bars [bar, bar + bars) of `sequence` (1-based), which has `sequence_bars`
   * bars and, when `loops`, goes back to its bar 1 after the last one — the next slice is the music itself going on.
   * Bar 0 is the composition's entrance: one bar that leads into bar 1 */
  sequence?: string
  sequence_bars?: number
  loops?: boolean
  bar?: number
  /** arrangement level of a composition slice (1 = bed … 3 = full); every level plays the same score */
  level?: number
  /** composition section: A, B, A2 (A varied) or E (the entrance) */
  section?: string
}
export interface Library {
  alias: string
  root: string
  name: string
  declared: boolean
  grid?: { bpm: number; meter: number }
  categories: string[]
  moods?: string[]
  items: LibraryItem[]
  generator?: { cmd: string[]; recipes: Record<string, { role: string; harmonic: boolean; min_bars: number; description?: string; layer?: string }>; intensities?: Record<string, number[]> }
}

const CATEGORY: Record<string, { label: string; color: string }> = {
  abertura: { label: 'Abertura', color: '#c0603f' },
  melodico: { label: 'Melódico', color: '#5b8def' },
  acao: { label: 'Ação', color: '#e0915b' },
  suspense: { label: 'Suspense', color: '#7b74b8' },
  impacto: { label: 'Impacto', color: '#c75b9b' },
  transicao: { label: 'Transição', color: '#4fb3a9' },
  calco: { label: 'Calço', color: '#a3a7b3' },
  cobertura: { label: 'Transição por cima', color: '#38bdf8' },
  fechamento: { label: 'Fechamento', color: '#5bbf8a' },
  base: { label: 'Base', color: '#8a8f9c' },
  complemento: { label: 'Complemento', color: '#d0a85b' },
}
export const categoryOf = (c: string) => CATEGORY[c] ?? { label: c, color: '#9a9aa2' }

export const INSTRUMENTS: Record<string, string> = {
  cordas: 'Cordas', harpa: 'Harpa', metais: 'Metais', madeiras: 'Madeiras', teclas: 'Teclas', laminas: 'Lâminas', percussao: 'Percussão',
}
const MOODS = ['tensão', 'mistério', 'curiosidade', 'emoção', 'triunfo', 'maravilha', 'leveza', 'humor', 'peso', 'nostalgia']

/** The moods and instrument families present in these items, in the library's order. */
export function axes(libs: Library[], items: LibraryItem[]) {
  const order = libs.find((l) => l.moods?.length)?.moods ?? MOODS
  const moods = new Set(items.flatMap((it) => it.mood ?? []))
  const insts = new Set(items.flatMap((it) => it.instruments ?? []))
  return {
    moods: [...order.filter((m) => moods.has(m)), ...[...moods].filter((m) => !order.includes(m))],
    instruments: Object.keys(INSTRUMENTS).filter((k) => insts.has(k)),
    voice: items.some((it) => it.under_voice),
  }
}

/** The cross filters (mood, instrument, under the voice) for one item. */
export function passa(it: LibraryItem, f: { mood?: string | null; inst?: string | null; voz?: boolean }) {
  return (!f.mood || (it.mood ?? []).includes(f.mood)) && (!f.inst || (it.instruments ?? []).includes(f.inst)) && (!f.voz || !!it.under_voice)
}

export const DRAG_TYPE = 'application/x-dmixer-piece'

let cache: { c: string; libs: Library[] } | null = null
export async function loadLibraries(force = false): Promise<Library[]> {
  const c = useEditor.getState().projectName ?? ''
  if (!c) return []   // a mixagem ainda não chegou
  if (!force && cache?.c === c) return cache.libs
  const j = await (await fetch(`/api/libraries?c=${c}`)).json()
  cache = { c, libs: j.libraries ?? [] }
  return cache.libs
}

/**
 * Lego rule on samplers tracks: pieces never overlap. If `want` lands on another piece, the piece goes to the nearest
 * free slot butted against a neighbour (right after it, or right before it).
 */
export function freeStart(others: { start: number; end: number }[], want: number, len: number): number {
  const eps = 0.01
  const free = (s: number) => s >= -eps && others.every((o) => s + len <= o.start + eps || s >= o.end - eps)
  if (free(want)) return want
  const cands = others.flatMap((o) => [o.end, o.start - len]).filter(free)
  return cands.length ? cands.sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0] : Math.max(want, ...others.map((o) => o.end))
}

/** Where a piece came from: `lote-N` (the batches), another score (the Arquimedes), or `originais` (the first recipes). */
export function origemOf(it: LibraryItem): string {
  return it.source ?? 'originais'
}

/** newest batch first, then the scores, then the first recipes */
export function ordemOrigem(a: string, b: string): number {
  const n = (x: string) => { const m = /^lote-(\d+)$/.exec(x); return m ? -Number(m[1]) : x === 'originais' ? 1e6 : 1e5 }
  return n(a) - n(b) || a.localeCompare(b)
}

export function rotuloOrigem(x: string): string {
  const m = /^lote-(\d+)$/.exec(x)
  return m ? `lote ${m[1]}` : x === 'originais' ? 'originais' : x === 'espelhos-arquimedes-v2' ? 'Arquimedes' : x
}

/** The batch badge: the newest batch in amber, the others muted. */
export function OrigemTag({ it, newest }: { it: LibraryItem; newest?: string }) {
  const o = origemOf(it)
  const lote = /^lote-\d+$/.test(o)
  const novo = lote && (!newest || o === newest)
  return (
    <span title={lote ? `receita nova, do ${rotuloOrigem(o)}` : 'de onde a ideia veio'}
      className={cx('rounded px-1.5 py-[1px] text-[10px] uppercase tracking-wider', novo ? 'bg-amber-300/15 text-amber-200' : 'bg-white/[0.05] text-ink-400')}>
      {rotuloOrigem(o)}
    </span>
  )
}

/** Pieces of every library this mix can use: filter, listen, drag onto the timeline. */
export function LibraryPanel() {
  const c = useEditor((s) => s.projectName)
  const [libs, setLibs] = useState<Library[]>([])
  const [cat, setCat] = useState<string | null>(null)
  const [chord, setChord] = useState<string>('')
  const [intensity, setIntensity] = useState<number | null>(null)
  const [q, setQ] = useState('')
  const [family, setFamily] = useState('')
  const [lote, setLote] = useState('')
  const [mood, setMood] = useState('')
  const [inst, setInst] = useState('')
  const [voz, setVoz] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [mode, setMode] = useState<'pecas' | 'base' | 'complemento' | 'musicas'>(() => (localStorage.getItem('dmixer.libmode') as 'base') ?? 'pecas')
  const [conector, setConector] = useState(() => localStorage.getItem('dmixer.conector') === '1')
  const project = useEditor((s) => s.project)
  const resolved = useEditor((s) => s.resolved)
  const selection = useEditor((s) => s.selection)
  const pickMode = (m: typeof mode) => { setMode(m); setCat(null); localStorage.setItem('dmixer.libmode', m) }
  const audio = useRef<Preview | null>(null)

  useEffect(() => { void loadLibraries(true).then(setLibs) }, [c])
  useEffect(() => () => audio.current?.pause(), [])

  const everything = libs.flatMap((l) => l.items.map((it) => ({ lib: l, it })))
  // modo conector: só o que encaixa depois da peça de referência (a selecionada, ou a última da sequência)
  const ancora = conector && project && resolved ? anchorPiece(project, resolved, new Map(everything.map(({ it }) => [it.id, it])), selection as never) : null
  const all = everything.filter(({ it }) => (mode === 'pecas' ? !it.role : it.role === 'base' && mode === 'base'))
    .filter(({ it }) => !ancora || fitsAfter(ancora.item, it))
  const chords = [...new Set(all.map((x) => x.it.chord).filter(Boolean))] as string[]
  const families = [...new Set(all.map((x) => x.it.family).filter(Boolean))] as string[]
  const lotes = [...new Set(all.map((x) => origemOf(x.it)))].sort(ordemOrigem)
  const eixos = axes(libs, all.map((x) => x.it))
  const shown = all.filter(({ it }) =>
    (!cat || it.category === cat) && (!chord || it.chord === chord) && (!intensity || it.intensity === intensity) && (!family || it.family === family) && (!lote || origemOf(it) === lote) && passa(it, { mood, inst, voz }) &&
    (!q || `${it.id} ${it.description ?? ''} ${it.layer ?? ''} ${it.source ?? ''}`.toLowerCase().includes(q.toLowerCase())))
  const groups = useMemo(() => {
    const m = new Map<string, typeof shown>()
    for (const x of shown) {
      const key = `${x.lib.alias}/${x.it.recipe ?? x.it.id}`
      m.set(key, [...(m.get(key) ?? []), x])
    }
    return [...m.entries()]
  }, [shown])

  const play = (lib: Library, it: LibraryItem) => {
    audio.current?.pause()
    if (playing === it.id) {
      setPlaying(null)
      return
    }
    const a = engine.preview(`/api/libraries/audio?c=${c}&lib=${encodeURIComponent(lib.alias)}&src=${encodeURIComponent(it.src)}`)
    a.onended = () => setPlaying((x) => (x === it.id ? null : x))
    audio.current = a
    setPlaying(it.id)
  }

  if (!libs.length && mode !== 'musicas') {
    return (
      <div className="p-4 text-ink-400 leading-relaxed text-[12.5px]">
        Nenhuma biblioteca. Uma biblioteca é uma pasta com um <code>index.json</code> de peças; declare-a em
        <code> media:</code> da mixagem ou em <code>~/.dmixer/config.json</code>.
      </div>
    )
  }
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="p-3 space-y-2 border-b border-white/[0.05]">
        <div className="flex gap-1 p-0.5 rounded-lg bg-ink-950 w-fit">
          {(['pecas', 'base', 'complemento', 'musicas'] as const).map((m) => (
            <button key={m} type="button" onClick={() => pickMode(m)}
              className={cx('h-6 px-2.5 rounded-md text-[11.5px]', mode === m ? 'bg-white/[0.10] text-ink-100' : 'text-ink-400 hover:text-ink-100')}>
              {m === 'pecas' ? 'Peças' : m === 'base' ? 'Bases' : m === 'complemento' ? 'Complementos' : 'Músicas'}
            </button>
          ))}
        </div>
        {mode === 'musicas' && (
          <div className="text-[11px] text-ink-500 leading-snug">Músicas do acervo com análise profunda, em trechos. Arraste um trecho para uma trilha de áudio
            (ou para o vazio: cria a trilha “Música (acervo)”); solto perto do fim de outro clipe da trilha, ele cola ali.</div>
        )}
        {mode !== 'complemento' && mode !== 'musicas' && (
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => { const v = !conector; setConector(v); localStorage.setItem('dmixer.conector', v ? '1' : '0') }}
              title="mostra só as peças que encaixam depois da peça selecionada (ou da última da sequência)"
              className={cx('h-6 px-2 rounded-md text-[11.5px] flex items-center gap-1.5', conector ? 'bg-ink-100 text-black' : 'bg-white/[0.05] text-ink-300 hover:text-ink-100')}>
              <span className="text-[13px] leading-none">◗</span> modo conector
            </button>
            {conector && <span className="text-[11px] text-ink-400 truncate">{ancora ? <>depois de <b className="text-ink-200">{ancora.clip.label ?? ancora.item.id}</b></> : 'coloque a primeira peça'}</span>}
          </div>
        )}
        {mode === 'complemento' || mode === 'musicas' ? null : (<>
        <div className="flex flex-wrap gap-1">
          <Chip on={!cat} onClick={() => setCat(null)}>Todas</Chip>
          {Object.keys(CATEGORY).filter((k) => all.some((x) => x.it.category === k)).map((k) => (
            <Chip key={k} on={cat === k} color={CATEGORY[k].color} onClick={() => setCat(cat === k ? null : k)}>{CATEGORY[k].label}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <select className="field !w-auto" value={chord} onChange={(e) => setChord(e.target.value)} title="acorde">
            <option value="">acorde</option>
            {chords.map((x) => <option key={x}>{x}</option>)}
          </select>
          <select className="field !w-auto" value={intensity ?? ''} onChange={(e) => setIntensity(e.target.value ? Number(e.target.value) : null)} title="intensidade">
            <option value="">intensidade</option>
            {[1, 2, 3, 4, 5].map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
          <select className="field !w-auto" value={family} onChange={(e) => setFamily(e.target.value)} title="família de tom">
            <option value="">família</option>
            {families.map((x) => <option key={x}>{x}</option>)}
          </select>
          <select className="field !w-auto" value={lote} onChange={(e) => setLote(e.target.value)} title="de onde veio: os lotes novos, o Arquimedes ou as originais">
            <option value="">todos os lotes</option>
            {lotes.map((x) => <option key={x} value={x}>{rotuloOrigem(x)}</option>)}
          </select>
          {eixos.moods.length > 0 && (
            <select className="field !w-auto" value={mood} onChange={(e) => setMood(e.target.value)} title="clima: o que a peça faz sentir">
              <option value="">clima</option>
              {eixos.moods.map((x) => <option key={x}>{x}</option>)}
            </select>
          )}
          {eixos.instruments.length > 0 && (
            <select className="field !w-auto" value={inst} onChange={(e) => setInst(e.target.value)} title="tem esta família de instrumentos">
              <option value="">instrumentos</option>
              {eixos.instruments.map((x) => <option key={x} value={x}>{INSTRUMENTS[x]}</option>)}
            </select>
          )}
          {eixos.voice && (
            <button type="button" onClick={() => setVoz(!voz)} title="só as que cabem embaixo da narração: sem melodia e sem ataques bruscos na faixa da fala"
              className={cx('field !w-auto flex items-center gap-1', voz && '!bg-ink-100 !text-black')}><Icon.Mic size={12} /> sob a voz</button>
          )}
          <input className="field flex-1 min-w-[140px]" placeholder="buscar…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <div className="text-[11px] text-ink-500">{shown.length} {mode === 'base' ? 'bases' : 'peças'} · arraste para a timeline ou use + para colar no fim da sequência</div>
        </>)}
        {mode === 'complemento' && (
          <div className="text-[11px] text-ink-500 leading-snug">Solte em cima das bases: o complemento cola na borda da base embaixo e, se for harmônico,
            é gerado nos acordes delas (leva uns 2 s). Escolha a intensidade: ele ocupa a base onde cair, e as bordas esticam (ou encolhem) em compassos inteiros — a camada é gerada de novo no tamanho novo.</div>
        )}
      </div>
      {mode === 'complemento' && <Complements libs={libs} play={play} playing={playing} />}
      {mode === 'musicas' && <AcervoMusicas />}
      <div className={cx('flex-1 min-h-0 overflow-y-auto p-2 space-y-2', (mode === 'complemento' || mode === 'musicas') && 'hidden')}>
        {groups.map(([key, items]) => {
          const first = items[0].it
          const cc = categoryOf(first.category)
          return (
            <div key={key} className="rounded-lg bg-ink-850 border border-white/[0.05] p-2">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: cc.color }} />
                <span className="text-[12px] text-ink-100 truncate flex-1">{first.recipe ?? first.id}</span>
                <span className="text-[10px] uppercase tracking-wider text-ink-500">{first.layer}</span>
              </div>
              {first.description && <div className="text-[11px] text-ink-400 mb-1 leading-snug">{first.description}</div>}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1.5 text-[10px] text-ink-500">
                {first.family && <span title="família de tom: peças da mesma família combinam entre si">♮ {first.family}</span>}
                <OrigemTag it={first} />
                {(first.mood ?? []).map((m) => <span key={m} className="text-ink-400">{m}</span>)}
                {first.instruments && <span title="instrumentos">{first.instruments.filter((x) => x !== 'cordas').map((x) => INSTRUMENTS[x]).join(' · ')}</span>}
              </div>
              <div className="flex flex-wrap gap-1">
                {items.map(({ lib, it }) => (
                  <div key={it.id} draggable title={`${it.id}\n${it.bars} compasso(s)${it.loop ? ' · faz laço' : ''}`}
                    onDragStart={(e) => {
                      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ lib: { alias: lib.alias, root: lib.root, declared: lib.declared }, item: it }))
                      e.dataTransfer.effectAllowed = 'copy'
                    }}
                    className="flex items-center gap-1 h-7 pl-1 pr-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] cursor-grab active:cursor-grabbing">
                    <IconButton className="h-6 min-w-6 !px-0" title="ouvir" onClick={() => play(lib, it)}>
                      {playing === it.id ? <Icon.Pause size={11} /> : <Icon.Play size={11} />}
                    </IconButton>
                    {edgeOf(it) && <span className="-ml-0.5"><EdgeGlyph side="in" edge={edgeOf(it)!} color={cc.color} size={12} bg="#151516" /></span>}
                    <span className="font-mono text-[10.5px] text-ink-200">{it.chord}</span>
                    <span className="flex gap-[2px]" title={`intensidade ${it.intensity}`}>
                      {[1, 2, 3, 4, 5].map((i) => <span key={i} className="w-[3px] h-2 rounded-sm" style={{ background: i <= (it.intensity ?? 0) ? cc.color : '#333337' }} />)}
                    </span>
                    <span className="font-mono text-[10px] text-ink-500">{tamanho(it)}</span>
                    {it.under_voice && <span title="cabe embaixo da narração" className="text-sky-300/80"><Icon.Mic size={10} /></span>}
                    {edgeOf(it) && <EdgeGlyph side="out" edge={edgeOf(it)!} color={cc.color} size={12} />}
                    <IconButton className="h-6 min-w-6 !px-0 -mr-1" title="acrescentar no fim da sequência, colada na peça anterior"
                      onClick={() => { const p = useEditor.getState().project; if (p) void appendPiece(p, JSON.stringify({ lib: { alias: lib.alias, root: lib.root, declared: lib.declared }, item: it })) }}>
                      <Icon.Plus size={11} />
                    </IconButton>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Chip({ on, color, onClick, children }: { on: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('h-6 px-2 rounded-md text-[11.5px] flex items-center gap-1.5', on ? 'bg-ink-100 text-black' : 'bg-white/[0.05] text-ink-300 hover:text-ink-100')}>
      {color && <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  )
}

/**
 * Put a piece on the timeline at `t` (snapped to the bar): declares the library under
 * `media:` if needed, adds the asset once, and the clip on `trackId` — or on a new track
 * for the piece's category, sent to the music bus when the mix has one.
 */
export async function dropPiece(project: Project, data: string, t: number, trackId: string | null, grid: 'bar' | 'beat' | 'off', audioTrack?: string | null) {
  const parsed = JSON.parse(data)
  if (parsed.kind === 'complement') return dropComplement(project, parsed, t, trackId)
  if (parsed.kind === 'acervo') return dropTrecho(project, parsed, t, audioTrack ?? null)
  const snap = grid !== 'off'
  const { lib, item } = JSON.parse(data) as { lib: { alias: string; root: string; declared: boolean }; item: LibraryItem }
  const bpm = project.project.bpm ?? 72
  const bar = (60 / bpm) * (project.project.meter ?? 4)
  const step = grid === 'beat' ? 60 / bpm : bar
  const off = project.project.grid_offset ?? 0
  let start = snap ? Math.max(0, off + Math.round((t - off) / step) * step) : Math.max(0, t)
  // dropped near the end of a piece already on that track (or over its tail): join it, so the music continues
  if (snap && trackId) {
    const r = resolveProject(project)
    const near = r.tracks.find((x) => x.id === trackId)?.clips
      .filter((c) => c.bodyEnd < c.end || project.assets[c.asset]?.body)
      .map((c) => c.bodyEnd)
      .filter((e) => Math.abs(e - t) < bar * 0.75 || (t > e && t < e + bar))
      .sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0]
    if (near !== undefined) start = near
  }
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = []
  const len = item.body ?? (item.bars ?? 1) * bar
  if (!project.media?.[lib.alias]) {
    ops.push(project.media ? { op: 'add', path: `/media/${lib.alias}`, value: lib.root } : { op: 'add', path: '/media', value: { [lib.alias]: lib.root } })
  }
  if (!project.assets[item.id]) ops.push({ op: 'add', path: `/assets/${item.id}`, value: { src: `@${lib.alias}/${item.src}`, label: item.id, ...(item.body ? { body: item.body } : {}) } })
  const label = `${categoryOf(item.category).label} · ${item.chord ?? ''} · i${item.intensity ?? ''}`
  // regra: peças só moram em trilha de samplers — a pedida, senão a da última peça, senão "Samplers"
  const items = libraryItemsById()
  const holdsComplements = (x: Project['tracks'][number]) => (x.clips ?? []).some((c) => items.get(c.asset ?? '')?.role === 'complemento')
  const lastSampler = resolveProject(project).tracks.filter((x) => x.samplers && !holdsComplements(project.tracks.find((y) => y.id === x.id)!))
    .flatMap((x) => x.clips.map((c) => ({ x, end: c.bodyEnd }))).sort((a, b) => b.end - a.end)[0]?.x.id
  let track = [trackId, lastSampler, 'samplers'].map((id) => project.tracks.find((x) => x.id === id && isSamplerTrack(x) && !holdsComplements(x))).find(Boolean)
  const taken = new Set(project.tracks.flatMap((x) => (x.clips ?? []).map((c) => c.id)))
  let n = 1
  while (taken.has(`${item.id}-${n}`)) n++
  if (track) {
    const rt = resolveProject(project).tracks.find((x) => x.id === track!.id)
    // solta dentro de outra peça, perto de um ponto de corte medido: entra ali e a outra termina ali
    const enc = rt ? encaixeNoCorte(rt, libraryItemsById(), t, len, bar) : null
    if (enc) {
      start = enc.start
      ops.push(...cortarOps(track.id, enc.cut.clip.raw, enc.cut.at) as typeof ops)
    } else {
      // sem sobreposição na trilha de samplers: cai no encaixe livre mais próximo
      start = freeStart(rt?.clips.map((c) => ({ start: c.start, end: c.bodyEnd })) ?? [], start, len)
    }
  }
  const clip = { id: `${item.id}-${n}`, asset: item.id, start: round(start), label }
  if (!track) {
    const bus = project.tracks.find((x) => x.type === 'bus')
    ops.push({ op: 'add', path: '/tracks/-', value: { id: 'samplers', samplers: true, name: 'Samplers', color: '#8a8f9c', ...(bus ? { output: bus.id } : {}), clips: [clip] } })
    await patch(ops, `Peça ${item.id}`)
    return
  }
  ops.push({ op: 'add', path: track.clips ? `/tracks/[id=${track.id}]/clips/-` : `/tracks/[id=${track.id}]/clips`, value: track.clips ? clip : [clip] })
  await patch(ops, `Peça ${item.id}`)
}

/**
 * "+" on a piece: put it right after the last piece, joined where that one's body ends.
 * Goes on the selected audio track, else on the track of the last piece, else on a new one.
 */
export async function appendPiece(project: Project, data: string) {
  const r = resolveProject(project)
  const sel = useEditor.getState().selection
  const pieces = r.tracks.flatMap((t) => t.clips.filter((c) => project.assets[c.asset]?.body).map((c) => ({ t, c })))
  const last = pieces.sort((a, b) => b.c.bodyEnd - a.c.bodyEnd)[0]
  const selTrack = sel && 'trackId' in sel ? r.tracks.find((t) => t.id === sel.trackId && t.samplers) : undefined
  const track = selTrack ?? last?.t ?? null
  const onTrack = track ? pieces.filter((x) => x.t.id === track.id).sort((a, b) => b.c.bodyEnd - a.c.bodyEnd)[0] : undefined
  const at = onTrack?.c.bodyEnd ?? last?.c.bodyEnd ?? 0
  await dropPiece(project, data, at, track?.id ?? null, 'off')
}

/** The complement recipes (from the library's generator): drag a recipe × intensity × length onto the bases. */
function Complements({ libs, play, playing }: { libs: Library[]; play: (lib: Library, it: LibraryItem) => void; playing: string | null }) {
  const recipes = libs.flatMap((lib) => Object.entries(lib.generator?.recipes ?? {})
    .filter(([, r]) => r.role === 'complemento').map(([name, r]) => ({ lib, name, r })))
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
      {recipes.map(({ lib, name, r }) => {
        const ints = lib.generator?.intensities?.complemento ?? [2, 3, 4, 5]
        const sample = lib.items.find((it) => it.recipe === name && it.role === 'complemento')
        return (
          <div key={`${lib.alias}/${name}`} className="rounded-lg bg-ink-850 border border-white/[0.05] p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: r.harmonic ? '#d0a85b' : '#8a8f9c' }} />
              <span className="text-[12px] text-ink-100 truncate flex-1">{name}</span>
              <span className="text-[10px] uppercase tracking-wider text-ink-500">{r.harmonic ? 'harmônico' : 'neutro'} · {r.layer}</span>
              {sample && (
                <IconButton className="h-6 min-w-6 !px-0" title="ouvir um exemplo" onClick={() => play(lib, sample)}>
                  {playing === sample.id ? <Icon.Pause size={11} /> : <Icon.Play size={11} />}
                </IconButton>
              )}
            </div>
            {r.description && <div className="text-[11px] text-ink-400 mb-1.5 leading-snug">{r.description}</div>}
            <div className="flex gap-1">
              {ints.map((i) => (
                <div key={i} draggable title={`${name} · intensidade ${i} — solte sobre as bases; ocupa a base onde cair, e as bordas esticam em compassos`}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'complement', lib: { alias: lib.alias, root: lib.root, declared: lib.declared }, recipe: name, intensity: i, bars: 0, min_bars: r.min_bars ?? 1, harmonic: r.harmonic }))
                    e.dataTransfer.effectAllowed = 'copy'
                  }}
                  className="flex-1 h-7 rounded-md bg-white/[0.04] hover:bg-white/[0.10] cursor-grab active:cursor-grabbing flex items-center justify-center gap-1.5">
                  <span className="text-[10px] text-ink-500 font-mono">i{i}</span>
                  <span className="flex gap-[2px]">{[1, 2, 3, 4, 5].map((q) => <span key={q} className="w-[3px] h-2 rounded-sm" style={{ background: q <= i ? '#d0a85b' : '#333337' }} />)}</span>
                </div>
              ))}
            </div>
            <div className="text-[10px] text-ink-500 mt-1">arraste sobre as bases · estique pelas bordas{(r.min_bars ?? 1) > 1 ? ` · mínimo ${r.min_bars} compassos` : ''}</div>
          </div>
        )
      })}
    </div>
  )
}

/** Library items by asset id (the asset id of a dropped piece is its item id). */
export function libraryItemsById(): Map<string, LibraryItem> {
  return new Map((cache?.libs ?? []).flatMap((l) => l.items.map((it) => [it.id, it] as [string, LibraryItem])))
}

/**
 * The chord of every bar from `start` for `bars` bars, read from the base pieces on the timeline (any track). Bars with
 * no base take the previous chord (or the first base's).
 */
export function chordsUnder(project: Project, start: number, bars: number): string[] {
  const r = resolveProject(project)
  const items = libraryItemsById()
  const bar = (60 / (project.project.bpm ?? 72)) * (project.project.meter ?? 4)
  const bases = r.tracks.flatMap((t) => t.clips.map((c) => ({ c, it: items.get(c.asset ?? '') }))).filter((x) => x.it?.role === 'base')
  const out: string[] = []
  for (let b = 0; b < bars; b++) {
    const mid = start + (b + 0.5) * bar
    const hit = bases.find(({ c }) => c.start <= mid && mid < c.end)
    if (hit) {
      const chords = hit.it!.chords ?? [hit.it!.chord ?? 'D']
      const k = Math.min(chords.length - 1, Math.floor((mid - hit.c.start + hit.c.in) / bar))
      out.push(chords[k])
    } else out.push(out[out.length - 1] ?? bases[0]?.it?.chords?.[0] ?? 'D')
  }
  return out
}

/** Where a complement dropped at t starts: the bar of the base under t (else the nearest bar). */
function complementStart(project: Project, t: number): number {
  const r = resolveProject(project)
  const items = libraryItemsById()
  const bar = (60 / (project.project.bpm ?? 72)) * (project.project.meter ?? 4)
  const base = r.tracks.flatMap((x) => x.clips).find((c) => items.get(c.asset ?? '')?.role === 'base' && c.start <= t && t < c.end)
  if (base) return round(base.start + Math.floor((t - base.start) / bar) * bar)
  const off = project.project.grid_offset ?? 0
  return round(Math.max(0, off + Math.floor((t - off) / bar) * bar))
}

/** Ask the library for a complement over these chords (made to order, cached by the generator). */
export async function renderComplement(libAlias: string, recipe: string, chords: string[], intensity: number) {
  const c = useEditor.getState().projectName
  useEditor.getState().setState({ busy: `gerando ${recipe} sobre ${chords.join(' ')}…` })
  try {
    const res = await fetch('/api/libraries/render', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ c, lib: libAlias, recipe, chords, intensity }) })
    const j = await res.json()
    if (!res.ok || !j.ok) throw new Error(j.error ?? res.statusText)
    if (cache) for (const l of cache.libs) if (l.alias === libAlias && !l.items.some((x) => x.id === j.item.id)) l.items.push(j.item)
    return j as { item: LibraryItem; lib: { alias: string; root: string; declared: boolean } }
  } finally {
    useEditor.getState().setState({ busy: null })
  }
}

/** Default length of a dropped complement: to the end of the base it lands on (at least `min` bars; 2 with no base). */
function complementBars(project: Project, start: number, min: number): number {
  const r = resolveProject(project)
  const items = libraryItemsById()
  const bar = (60 / (project.project.bpm ?? 72)) * (project.project.meter ?? 4)
  const base = r.tracks.flatMap((x) => x.clips).find((c) => items.get(c.asset ?? '')?.role === 'base' && c.start <= start + 0.01 && start < c.bodyEnd - 0.01)
  return Math.max(min, base ? Math.round((base.bodyEnd - start) / bar) : 2)
}

export async function dropComplement(project: Project, data: { lib: { alias: string; root: string; declared: boolean }; recipe: string; intensity: number; bars: number; harmonic: boolean; min_bars?: number },
  t: number, trackId: string | null) {
  await loadLibraries()
  const start = complementStart(project, t)
  if (!data.bars) data = { ...data, bars: complementBars(project, start, data.min_bars ?? 1) }
  const chords = data.harmonic ? chordsUnder(project, start, data.bars) : Array(data.bars).fill('D')
  const { item, lib } = await renderComplement(data.lib.alias, data.recipe, chords, data.intensity)
  const fresh = useEditor.getState().project ?? project
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = []
  if (!fresh.media?.[lib.alias]) ops.push(fresh.media ? { op: 'add', path: `/media/${lib.alias}`, value: lib.root } : { op: 'add', path: '/media', value: { [lib.alias]: lib.root } })
  if (!fresh.assets[item.id]) ops.push({ op: 'add', path: `/assets/${item.id}`, value: { src: `@${lib.alias}/${item.src}`, label: item.id, ...(item.body ? { body: item.body } : {}) } })
  const taken = new Set(fresh.tracks.flatMap((x) => (x.clips ?? []).map((c) => c.id)))
  let n = 1
  while (taken.has(`${item.id}-${n}`)) n++
  const clip = { id: `${item.id}-${n}`, asset: item.id, start, label: `${data.recipe} · ${chords.join(' ')} · i${data.intensity}` }
  const items = libraryItemsById()
  const target = trackId ? fresh.tracks.find((x) => x.id === trackId && isSamplerTrack(x) && !(x.clips ?? []).some((c) => items.get(c.asset ?? '')?.role !== 'complemento')) : undefined
  if (target) {
    ops.push({ op: 'add', path: target.clips ? `/tracks/[id=${target.id}]/clips/-` : `/tracks/[id=${target.id}]/clips`, value: target.clips ? clip : [clip] })
  } else {
    const id = `compl-${data.recipe}`
    const existing = fresh.tracks.find((x) => x.id === id)
    if (existing) ops.push({ op: 'add', path: existing.clips ? `/tracks/[id=${id}]/clips/-` : `/tracks/[id=${id}]/clips`, value: existing.clips ? clip : [clip] })
    else {
      const bus = fresh.tracks.find((x) => x.type === 'bus')
      ops.push({ op: 'add', path: '/tracks/-', value: { id, samplers: true, name: `Compl · ${data.recipe}`, color: '#d0a85b', ...(bus ? { output: bus.id } : {}), clips: [clip] } })
    }
  }
  await patch(ops, `Complemento ${data.recipe}`)
}

/** Remake a complement clip over whatever bases are under it now (after a base changed, or to cover more bars). */
export async function refitComplement(project: Project, trackId: string, clipId: string, bars?: number, start?: number) {
  await loadLibraries()
  const items = libraryItemsById()
  const track = project.tracks.find((t) => t.id === trackId)
  const clip = track?.clips?.find((c) => c.id === clipId)
  const it = clip ? items.get(clip.asset ?? '') : undefined
  if (!clip || !it?.recipe || it.role !== 'complemento') return
  const r = resolveProject(project)
  const rc = r.tracks.find((t) => t.id === trackId)!.clips.find((c) => c.id === clipId)!
  const lib = (cache?.libs ?? []).find((l) => l.items.some((x) => x.id === it.id))
  if (!lib) return
  const n = bars ?? it.bars ?? 1
  const t0 = start ?? rc.start
  const chords = it.harmonic === false ? Array(n).fill('D') : chordsUnder(project, t0, n)
  const { item } = await renderComplement(lib.alias, it.recipe, chords, it.intensity ?? 3)
  const fresh = useEditor.getState().project ?? project
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = []
  if (!fresh.assets[item.id]) ops.push({ op: 'add', path: `/assets/${item.id}`, value: { src: `@${lib.alias}/${item.src}`, label: item.id, ...(item.body ? { body: item.body } : {}) } })
  ops.push({ op: 'replace', path: `/tracks/[id=${trackId}]/clips/[id=${clipId}]/asset`, value: item.id })
  if (start !== undefined && Math.abs(start - rc.start) > 0.001) ops.push({ op: 'replace', path: `/tracks/[id=${trackId}]/clips/[id=${clipId}]/start`, value: start })
  ops.push({ op: clip.label === undefined ? 'add' : 'replace', path: `/tracks/[id=${trackId}]/clips/[id=${clipId}]/label`, value: `${it.recipe} · ${chords.join(' ')} · i${it.intensity}` })
  for (const k of ['in', 'out'] as const) if (clip[k] !== undefined) ops.push({ op: 'remove' as 'replace', path: `/tracks/[id=${trackId}]/clips/[id=${clipId}]/${k}`, value: undefined })
  await patch(ops, `Refazer ${it.recipe} sobre as bases`)
}

/**
 * Change the chord of a base clip: the same recipe, intensity and length in another chord (already in the library),
 * and every complement that sits over it is made again over the new chords.
 */
export async function setBaseChord(project: Project, trackId: string, clipId: string, chord: string) {
  await loadLibraries()
  const items = libraryItemsById()
  const clip = project.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId)
  const it = clip ? items.get(clip.asset ?? '') : undefined
  if (!clip || !it || it.role !== 'base') return
  const lib = (cache?.libs ?? []).find((l) => l.items.some((x) => x.id === it.id))!
  const alt = lib.items.find((x) => x.role === 'base' && x.recipe === it.recipe && x.intensity === it.intensity && x.bars === it.bars && x.chord === chord)
  if (!alt) return
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = []
  if (!project.assets[alt.id]) ops.push({ op: 'add', path: `/assets/${alt.id}`, value: { src: `@${lib.alias}/${alt.src}`, label: alt.id, ...(alt.body ? { body: alt.body } : {}) } })
  ops.push({ op: 'replace', path: `/tracks/[id=${trackId}]/clips/[id=${clipId}]/asset`, value: alt.id })
  ops.push({ op: clip.label === undefined ? 'add' : 'replace', path: `/tracks/[id=${trackId}]/clips/[id=${clipId}]/label`, value: `Base · ${chord} · i${alt.intensity}` })
  await patch(ops, `Base em ${chord}`)
  // the complements over this base follow
  const fresh = useEditor.getState().project ?? project
  const r = resolveProject(fresh)
  const base = r.tracks.find((t) => t.id === trackId)?.clips.find((c) => c.id === clipId)
  if (!base) return
  for (const t of r.tracks) {
    for (const c of t.clips) {
      const ci = items.get(c.asset ?? '')
      if (ci?.role === 'complemento' && ci.harmonic !== false && c.start < base.end && c.end > base.start) {
        await refitComplement(useEditor.getState().project ?? fresh, t.id, c.id)
      }
    }
  }
}

/** The chords a base clip can switch to (same recipe, intensity and length). */
export function baseChords(asset: string): string[] {
  const items = libraryItemsById()
  const it = items.get(asset)
  if (!it || it.role !== 'base') return []
  return [...items.values()].filter((x) => x.role === 'base' && x.recipe === it.recipe && x.intensity === it.intensity && x.bars === it.bars).map((x) => x.chord ?? '').filter(Boolean)
}

/** The library items by asset id, loading the libraries once; re-renders when they arrive. */
export function useLibraryItems(): Map<string, LibraryItem> {
  const c = useEditor((s) => s.projectName)
  const [items, setItems] = useState<Map<string, LibraryItem>>(() => libraryItemsById())
  useEffect(() => { void loadLibraries().then(() => setItems(libraryItemsById())) }, [c])
  return items
}

/** A clip from a library piece: a fixed lego block (the asset knows its musical length). */
export function isLibraryPiece(asset: string): boolean {
  return useEditor.getState().project?.assets[asset]?.body !== undefined
}

/** How long a piece is, for labels: whole bars as "2c", the calços (fractions of a bar) in beats, "2t". */
export function tamanho(it?: LibraryItem): string {
  if (!it?.bars) return ''
  return Number.isInteger(it.bars) ? `${it.bars}c` : `${it.beats ?? Math.round(it.bars * 4)}t`
}

/**
 * "Alinhar com a tag": make a downbeat land on `alvo` (a word of the narration). The music after the anchor piece runs in
 * whole bars, so its downbeats fall on end + k bars; a calço of 1, 2 or 3 beats inserted right after the anchor moves
 * them by that much. Pieces after the anchor (on every samplers track) shift along, so nothing overlaps.
 * The anchor is the selected piece, else the last piece that ends before the tag.
 */
export async function alinharComTag(alvo: number, rotulo: string, anchorId?: { trackId: string; clipId: string } | null): Promise<string> {
  const project = useEditor.getState().project
  if (!project) return 'a mixagem não carregou'
  const libs = await loadLibraries()
  const items = new Map(libs.flatMap((l) => l.items.map((it) => [it.id, { it, lib: l }] as const)))
  const r = resolveProject(project)
  const bpm = project.project.bpm ?? 72
  const T = 60 / bpm
  const bar = T * (project.project.meter ?? 4)
  const pieces = r.tracks.filter((t) => t.samplers).flatMap((t) => t.clips.map((c) => ({ t, c, x: items.get(c.asset ?? '') })))
    .filter((p) => p.x && p.x.it.role !== 'complemento')
  if (!pieces.length) return 'ainda não há peças na trilha de samplers'
  const anchor = (anchorId && pieces.find((p) => p.t.id === anchorId.trackId && p.c.id === anchorId.clipId))
    ?? pieces.filter((p) => p.c.bodyEnd <= alvo + 0.05).sort((a, b) => b.c.bodyEnd - a.c.bodyEnd)[0]
  if (!anchor) return `nenhuma peça termina antes de "${rotulo}"`
  const fim = anchor.c.bodyEnd
  if (alvo < fim - 0.05) return `"${rotulo}" fica antes do fim da peça escolhida`
  const passos = Math.round((alvo - fim) / T)
  const tempos = ((passos % 4) + 4) % 4
  const erro = alvo - (fim + passos * T)
  const cai = (t: number) => `o 1º tempo cai em ${formatTime(t, 1)}${Math.abs(erro) > 0.05 ? ` (${Math.abs(erro).toFixed(2)} s ${erro > 0 ? 'antes' : 'depois'} da tag)` : ''}`
  if (tempos === 0) return `já está alinhado: ${cai(fim + passos * T)}`
  // o calço: mesma família, o acorde em que a peça termina, motor se a peça anda, a intensidade mais próxima
  const a = anchor.x!.it
  const prog = (a.chord ?? '').split('-')
  const acorde = prog[((a.bars ?? 1) - 1) % prog.length] ?? prog[0]
  const fam = familyOf(a)
  const anda = a.layer === 'motor' || a.category === 'acao'
  const calcos = [...items.values()].filter(({ it }) => it.category === 'calco' && it.beats === tempos && familyOf(it) === fam)
  // a peça que vem depois (se houver): o calço tem de emendar dos dois lados
  const seguinte = pieces.filter((p) => p.t.id === anchor.t.id && Math.abs(p.c.start - fim) < 0.06)[0]?.x?.it
  const pref = (x: { it: LibraryItem }) => (x.it.chord === acorde ? 0 : 10) + ((x.it.layer === 'motor') === anda ? 0 : 5) + Math.abs((x.it.intensity ?? 3) - (a.intensity ?? 3))
    + (textura(a.edges?.out, a.edges?.tail, x.it.edges?.in) ?? 0) + (seguinte ? textura(x.it.edges?.out, x.it.edges?.tail, seguinte.edges?.in) ?? 0 : 0)
    // emenda que soaria como corte (instrumento que some, batida que tropeça, textura…) dos dois lados: quase proibido
    + (seam(edgeOf(a, anchor.c.raw)!, edgeOf(x.it)!).kind === 'ok' ? 0 : 100) + (seguinte && edgeOf(seguinte) && seam(edgeOf(x.it)!, edgeOf(seguinte)!).kind !== 'ok' ? 100 : 0)
  const escolha = calcos.sort((x, y) => pref(x) - pref(y))[0]
  if (!escolha) return `não há calço de ${tempos} tempo(s) nesta família — gere os calços na biblioteca`
  const { it, lib } = escolha
  const aviso = pref(escolha) >= 100 ? ' — atenção: nenhum calço emenda sem corte aqui; o melhor disponível foi usado' : ''
  const dt = Math.round(tempos * T * 1000) / 1000
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = []
  if (!project.media?.[lib.alias]) ops.push(project.media ? { op: 'add', path: `/media/${lib.alias}`, value: lib.root } : { op: 'add', path: '/media', value: { [lib.alias]: lib.root } })
  if (!project.assets[it.id]) ops.push({ op: 'add', path: `/assets/${it.id}`, value: { src: `@${lib.alias}/${it.src}`, label: it.id, ...(it.body ? { body: it.body } : {}) } })
  // empurra o que vem depois, em todas as trilhas de samplers
  for (const t of r.tracks.filter((x) => x.samplers)) {
    for (const c of t.clips) {
      if (c.start >= fim - 0.01 && typeof c.raw.start === 'number') ops.push({ op: 'replace', path: `/tracks/[id=${t.id}]/clips/[id=${c.id}]/start`, value: round(c.raw.start + dt) })
    }
  }
  const taken = new Set(project.tracks.flatMap((x) => (x.clips ?? []).map((c) => c.id)))
  let n = 1
  while (taken.has(`${it.id}-${n}`)) n++
  ops.push({ op: 'add', path: `/tracks/[id=${anchor.t.id}]/clips/-`, value: { id: `${it.id}-${n}`, asset: it.id, start: round(fim), label: `Calço · ${tempos}t · ${it.chord}` } })
  await patch(ops, `Alinhar com ${rotulo}`)
  return `calço de ${tempos} tempo(s) (${it.recipe}) depois de ${anchor.c.label ?? anchor.c.id}: ${cai(fim + passos * T)}${aviso}`
}


/** the fake tail of a piece cut short: what came after the cut fades out under the next piece */
export const FADE_CORTE = 0.4

type Op = { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }

/** Cut a clip at one of its measured cut points (`at`, seconds from the start of the file). */
export function cortarOps(trackId: string, clip: { id: string; body?: number; out?: number; fade_out?: number }, at: number): Op[] {
  const p = `/tracks/[id=${trackId}]/clips/[id=${clip.id}]`
  return [
    { op: clip.body === undefined ? 'add' : 'replace', path: `${p}/body`, value: round(at) },
    { op: clip.out === undefined ? 'add' : 'replace', path: `${p}/out`, value: round(at + FADE_CORTE) },
    { op: clip.fade_out === undefined ? 'add' : 'replace', path: `${p}/fade_out`, value: FADE_CORTE },
  ]
}

/** Give a cut clip its whole body back. */
export function restaurarOps(trackId: string, clip: { id: string; body?: number; out?: number; fade_out?: number }): Op[] {
  const p = `/tracks/[id=${trackId}]/clips/[id=${clip.id}]`
  return (['body', 'out', 'fade_out'] as const).filter((k) => clip[k] !== undefined).map((k) => ({ op: 'remove' as const, path: `${p}/${k}` }))
}

/**
 * Dropping or dragging a piece INTO the previous one: if `want` is near one of that piece's measured cut points (half a
 * bar either way), the new piece starts there and the previous one ends there. Only when the new piece fits after the
 * cut without overlapping anything else.
 */
export function encaixeNoCorte(track: { id: string; clips: ResolvedClip[] }, items: Map<string, LibraryItem>, want: number, len: number, bar: number, self?: string)
  : { start: number; cut: { clip: ResolvedClip; at: number } } | null {
  let best: { start: number; cut: { clip: ResolvedClip; at: number } } | null = null
  for (const a of track.clips) {
    if (a.id === self) continue
    const it = items.get(a.asset)
    const inteiro = (it?.body ?? 0) - a.in
    if (!it?.cuts?.length || want < a.start || want > a.start + inteiro) continue
    for (const c of it.cuts) {
      const s = a.start + c.at - a.in
      if (Math.abs(s - want) > bar / 2) continue
      const livre = track.clips.every((o) => o.id === a.id || o.id === self || s + len <= o.start + 0.01 || s >= o.bodyEnd - 0.01)
      if (livre && (!best || Math.abs(s - want) < Math.abs(best.start - want))) best = { start: round(s), cut: { clip: a, at: c.at } }
    }
  }
  return best
}

/** After moves on a samplers track: a cut clip with nothing starting at its cut gets its whole body back. */
export function restaurarSoltos(trackId: string, clips: { id: string; start: number; bodyEnd: number; raw: { body?: number; out?: number; fade_out?: number } }[]): Op[] {
  const ops: Op[] = []
  for (const a of clips) {
    if (a.raw.body === undefined) continue
    if (!clips.some((b) => b.id !== a.id && Math.abs(b.start - a.bodyEnd) < 0.02)) ops.push(...restaurarOps(trackId, { id: a.id, ...a.raw }))
  }
  return ops
}

/** Where the transitions (coberturas) hit, over the whole mix: the joins there are covered. */
export function coberturas(r: { tracks: { id: string; clips: ResolvedClip[] }[] }, items: Map<string, LibraryItem>) {
  return r.tracks.flatMap((t) => t.clips.flatMap((c) => {
    const it = items.get(c.asset ?? '')
    return it?.role === 'cobertura' && it.hit !== undefined ? [{ at: round(c.start + it.hit - c.in), trackId: t.id, clip: c }] : []
  }))
}

/** The join that arrives at this piece (from the piece butting it on the same track), its verdict and its transition. */
export function emendaDe(project: Project, trackId: string, clipId: string) {
  const r = resolveProject(project)
  const items = libraryItemsById()
  const t = r.tracks.find((x) => x.id === trackId)
  const cur = t?.clips.find((c) => c.id === clipId)
  if (!t || !cur) return null
  const prev = t.clips.find((c) => c.id !== cur.id && Math.abs(c.bodyEnd - cur.start) < 0.06 && items.get(c.asset ?? '')?.role !== 'cobertura')
  const ea = prev ? edgeOf(items.get(prev.asset), prev.raw) : null
  const eb = edgeOf(items.get(cur.asset))
  if (!prev || !ea || !eb) return null
  const cobertura = coberturas(r, items).find((x) => Math.abs(x.at - cur.start) < 0.06) ?? null
  return { at: cur.start, prev, cur, sm: seam(ea, eb), cobertura, a: items.get(prev.asset)!, b: items.get(cur.asset)! }
}

/**
 * "＋ transição": cover a join with a percussion transition whose hit lands on the downbeat of the new piece. The kind of
 * problem picks it: a stumbling beat gets a fill (it re-states the beat); instruments dropping out or a texture change get a
 * cymbal swell with a hit; anything else gets just the arrival hit. Intensity: the louder of the two pieces.
 */
export async function cobrirEmenda(trackId: string, clipId: string): Promise<string> {
  const project = useEditor.getState().project
  if (!project) return ''
  await loadLibraries()
  const e = emendaDe(project, trackId, clipId)
  if (!e) return 'esta peça não emenda com nenhuma anterior'
  if (e.cobertura) return 'esta emenda já tem uma transição'
  const todas = (cache?.libs ?? []).flatMap((l) => l.items.filter((it) => it.role === 'cobertura').map((it) => ({ it, lib: l })))
  const receita = e.sm.kind === 'pulse' ? 'cobertura-virada-caixa' : e.sm.kind === 'drop' || e.sm.kind === 'texture' ? 'cobertura-prato' : 'cobertura-chegada'
  const alvo = Math.max(e.a.intensity ?? 3, e.b.intensity ?? 3)
  const cands = todas.filter(({ it }) => it.recipe === receita && (it.hit ?? 0) <= e.at + 0.01)
  // a intensidade mais próxima; depois a virada mais longa e o prato mais curto
  const escolha = cands.sort((x, y) => Math.abs((x.it.intensity ?? 3) - alvo) - Math.abs((y.it.intensity ?? 3) - alvo)
    || (receita === 'cobertura-prato' ? (x.it.bars ?? 0) - (y.it.bars ?? 0) : (y.it.bars ?? 0) - (x.it.bars ?? 0)))[0]
  if (!escolha) return 'não há transição na biblioteca (gere as coberturas)'
  const { it, lib } = escolha
  const start = round(e.at - (it.hit ?? 0))
  const r = resolveProject(project)
  const ops: { op: 'add' | 'replace'; path: string; value: unknown }[] = []
  if (!project.media?.[lib.alias]) ops.push(project.media ? { op: 'add', path: `/media/${lib.alias}`, value: lib.root } : { op: 'add', path: '/media', value: { [lib.alias]: lib.root } })
  if (!project.assets[it.id]) ops.push({ op: 'add', path: `/assets/${it.id}`, value: { src: `@${lib.alias}/${it.src}`, label: it.id, ...(it.body ? { body: it.body } : {}) } })
  // numa trilha própria de transições, por cima da sequência; se ela estiver ocupada ali, numa nova
  const fim = start + (it.body ?? 0)
  const livre = r.tracks.find((t) => t.id.startsWith('transicoes') && t.clips.every((c) => fim <= c.start + 0.01 || start >= c.bodyEnd - 0.01))
  const taken = new Set(project.tracks.flatMap((x) => (x.clips ?? []).map((c) => c.id)))
  let n = 1
  while (taken.has(`${it.id}-${n}`)) n++
  const nome = (it.recipe ?? '').replace('cobertura-', '').replace('-', ' ')
  const clip = { id: `${it.id}-${n}`, asset: it.id, start, label: `Transição · ${nome} · i${it.intensity}` }
  if (livre) {
    const t = project.tracks.find((x) => x.id === livre.id)!
    ops.push({ op: 'add', path: t.clips ? `/tracks/[id=${t.id}]/clips/-` : `/tracks/[id=${t.id}]/clips`, value: t.clips ? clip : [clip] })
  } else {
    const ids = project.tracks.map((x) => x.id)
    let id = 'transicoes'
    for (let k = 2; ids.includes(id); k++) id = `transicoes-${k}`
    const bus = project.tracks.find((x) => x.type === 'bus')
    ops.push({ op: 'add', path: '/tracks/-', value: { id, samplers: true, name: 'Transições', color: '#38bdf8', volume: -4, ...(bus ? { output: bus.id } : {}), clips: [clip] } })
  }
  await patch(ops, `Transição na emenda de ${e.cur.label ?? e.cur.id}`)
  return `${nome} i${it.intensity}: o golpe cai no 1º tempo de ${e.cur.label ?? e.cur.id}`
}

/** Take the transition off a join. */
export async function descobrirEmenda(trackId: string, clipId: string) {
  const project = useEditor.getState().project
  if (!project) return
  const e = emendaDe(project, trackId, clipId)
  if (!e?.cobertura) return
  await patch([{ op: 'remove' as 'replace', path: `/tracks/[id=${e.cobertura.trackId}]/clips/[id=${e.cobertura.clip.id}]`, value: undefined }], 'Tirar transição')
}

/**
 * Aba Músicas: as músicas do acervo com análise profunda, cada uma com as peças (P<n> função · início), a borda na cor
 * da função. Ouvir toca só o trecho; arrastar leva o trecho para a timeline (dropTrecho).
 */
type TrechoDrag = { kind: 'acervo'; root: string; song: { id: string; titulo: string; src: string; bpm?: number; dur?: number }; piece: AcervoPiece & { n: number } }
function AcervoMusicas() {
  const [songs, setSongs] = useState<AcervoSong[] | null>(null)
  const [erro, setErro] = useState('')
  const [q, setQ] = useState('')
  const [aberta, setAberta] = useState<string | null>(null)
  const [tocando, setTocando] = useState<string | null>(null)
  const audio = useRef<Preview | null>(null)
  useEffect(() => { loadAcervoSongs().then(setSongs, (e: Error) => setErro(e.message)) }, [])
  useEffect(() => () => audio.current?.pause(), [])
  const ouvir = (s: AcervoSong, p: AcervoPiece, chave: string) => {
    audio.current?.pause()
    if (tocando === chave) { setTocando(null); return }
    const a = engine.preview(acervoTrechoUrl(s.src, p.start, p.end))
    a.onended = () => setTocando((x) => (x === chave ? null : x))
    audio.current = a
    setTocando(chave)
  }
  if (erro) return <div className="p-4 text-red-400 text-[12px]">{erro}</div>
  if (!songs) return <div className="p-4 text-ink-400 text-[12px]">carregando o acervo…</div>
  const vis = songs.filter((s) => !q || `${s.titulo} ${s.artista ?? ''} ${s.id}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-2">
      <input className="field w-full" placeholder="buscar música…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      {!vis.length && <div className="p-2 text-ink-400 text-[12px] leading-snug">Nenhuma música com análise profunda ainda. No acervo: <code>acervo.py analisar &lt;id&gt; --profunda</code>.</div>}
      {vis.map((s) => {
        const open = aberta === s.id || vis.length === 1
        const funcoes = [...new Set(s.pieces.map((p) => p.role).filter(Boolean))]
        return (
          <div key={s.id} className="rounded-lg bg-ink-850 border border-white/[0.05] p-2">
            <button type="button" className="w-full flex items-center gap-2 text-left" onClick={() => setAberta(open ? null : s.id)}>
              <Icon.Music size={12} />
              <span className="text-[12.5px] text-ink-100 truncate flex-1">{s.titulo}</span>
              <span className="text-[10.5px] text-ink-500 shrink-0">{s.bpm ? `${Math.round(s.bpm)} BPM` : ''}{s.key ? ` · ${s.key}` : ''} · {s.pieces.length} trechos</span>
            </button>
            {open && (<>
              <div className="flex flex-wrap gap-1 mt-2">
                {s.pieces.map((p, i) => {
                  const cor = CORES_FUNCAO[p.role as keyof typeof CORES_FUNCAO] ?? '#8a8f98'
                  const chave = `${s.id}#${i}`
                  const drag: TrechoDrag = { kind: 'acervo', root: s.root, song: { id: s.id, titulo: s.titulo, src: s.src, bpm: s.bpm, dur: s.duracao }, piece: { ...p, n: i + 1 } }
                  return (
                    <div key={i} draggable
                      onDragStart={(e) => { e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(drag)); e.dataTransfer.effectAllowed = 'copy' }}
                      title={`P${i + 1}${p.role ? ` · ${p.role}` : ''}${p.mood ? ` · ${p.mood}` : ''}\n${formatTime(p.start, 1)} → ${formatTime(p.end, 1)} · energia ${Math.round(p.energy * 100)}\narraste para a timeline`}
                      className="flex items-center gap-1 h-7 pl-0.5 pr-2 rounded-md bg-white/[0.04] hover:bg-white/[0.08] cursor-grab active:cursor-grabbing"
                      style={{ borderLeft: `3px solid ${cor}` }}>
                      <IconButton className="h-6 min-w-6 !px-0" title="ouvir o trecho" onClick={() => ouvir(s, p, chave)}>
                        {tocando === chave ? <Icon.Pause size={11} /> : <Icon.Play size={11} />}
                      </IconButton>
                      <b className="text-[11px] text-ink-100">P{i + 1}</b>
                      <span className="text-[10.5px] text-ink-400">{p.role || p.mood} · {formatTime(p.start, 0)}</span>
                    </div>
                  )
                })}
              </div>
              {funcoes.length > 0 && (
                <div className="flex flex-wrap gap-x-2.5 gap-y-1 mt-1.5 text-[10.5px] text-ink-400">
                  {Object.entries(CORES_FUNCAO).filter(([f]) => funcoes.includes(f)).map(([f, c]) => (
                    <span key={f} className="inline-flex items-center gap-1"><i className="inline-block w-2 h-2 rounded-sm" style={{ background: c }} />{f}</span>
                  ))}
                </div>
              )}
            </>)}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Juntas de uma trilha quebra-cabeça: para cada peça, a que começa onde o corpo dela acaba (a próxima). Vizinhas no
 * arquivo (a próxima continua de onde esta parou) emendam sem fade. Pulo = crossfade simétrico de X s centrado na junta:
 * esta segue X/2 além do corpo (o material de depois, no arquivo) e a próxima começa X/2 antes (`head`, o material de
 * antes), as duas em potência constante. X que a junta já tinha fica; sem X ainda, 1 tempo da música. A última peça
 * ganha só a cauda, para não terminar seca.
 */
export type PecaJunta = { id: string; asset: string; start: number; inP: number; body: number; out: number; fadeIn?: number; fadeOut?: number; head?: number; durArquivo: number; bpm?: number }
export function juntasOps(project: Project, trackId: string, pecas: PecaJunta[]): Op[] {
  const ops: Op[] = []
  const xs = [...pecas].sort((a, b) => a.start - b.start)
  const base = `/tracks/[id=${trackId}]/clips/[id=`
  const poe = (id: string, k: string, v: number, antes?: number) => {
    if (antes !== undefined && Math.abs(antes - v) < 0.0005) return
    if (k === 'head' && v < 0.0005) {
      if (antes !== undefined) ops.push({ op: 'remove', path: `${base}${id}]/head` })
      return
    }
    ops.push({ op: antes === undefined ? 'add' : 'replace', path: `${base}${id}]/${k}`, value: round(v) } as Op)
  }
  const tempo = (a: PecaJunta) => Math.min(0.6, Math.max(0.25, 60 / (a.bpm || 120)))
  xs.forEach((a, i) => {
    const fimCorpo = a.start + (a.body - a.inP)
    const prox = xs.find((b, j) => j !== i && Math.abs(b.start - fimCorpo) < 0.02)
    const src = (id: string) => project.assets[id]?.src
    const vizinho = !!prox && src(prox.asset) === src(a.asset) && Math.abs(prox.inP - a.body) < 0.02
    const sobra = Math.max(0, a.durArquivo - a.body)
    if (vizinho) {
      poe(a.id, 'out', a.body, a.out)
      poe(a.id, 'fade_out', 0.005, a.fadeOut)
      poe(prox!.id, 'fade_in', 0.005, prox!.fadeIn)
      poe(prox!.id, 'head', 0, prox!.head)
      return
    }
    if (!prox) {
      const ja = a.out - a.body
      const cauda = Math.min(sobra, ja > 0.02 ? ja : tempo(a))
      poe(a.id, 'out', a.body + cauda, a.out)
      poe(a.id, 'fade_out', Math.max(0.01, cauda), a.fadeOut)
      return
    }
    const ja = (a.out - a.body) + (prox.head ?? 0)
    const X = ja > 0.02 ? ja : tempo(a)
    const cauda = Math.min(X / 2, sobra)
    const cabeca = Math.min(X / 2, prox.inP)
    const L = Math.max(0.01, cauda + cabeca)
    poe(a.id, 'out', a.body + cauda, a.out)
    poe(a.id, 'fade_out', L, a.fadeOut)
    poe(prox.id, 'head', cabeca, prox.head)
    poe(prox.id, 'fade_in', L, prox.fadeIn)
  })
  return ops
}

/** as peças de uma trilha quebra-cabeça no formato de juntasOps (o body ausente vira o out: peça sem cauda) */
export function pecasDaTrilha(project: Project, trackId: string, sem?: string): PecaJunta[] {
  const r = resolveProject(project)
  const t = r.tracks.find((x) => x.id === trackId)
  return (t?.clips ?? []).filter((c) => c.id !== sem).map((c) => ({
    id: c.id, asset: c.asset, start: c.start, inP: c.in, body: c.raw.body ?? c.out, out: c.out, fadeIn: c.raw.fade_in, fadeOut: c.raw.fade_out,
    head: c.raw.head, durArquivo: project.assets[c.asset]?.meta?.duration ?? c.out, bpm: acervoBpm(c.src),
  }))
}
function acervoBpm(src: string): number | undefined {
  return acervoProntas.get(src)?.bpm
}

/**
 * Um trecho de música do acervo solto na timeline: vira uma peça (clipe do arquivo inteiro, in/body = o trecho) numa
 * trilha quebra-cabeça — a onde caiu, senão a última quebra-cabeça, senão uma nova "Música (acervo)". Encaixa colado no
 * fim da peça mais perto (até 1,5 s), nunca em cima de outra (vai ao encaixe livre mais próximo); as juntas se refazem.
 */
async function dropTrecho(project: Project, d: TrechoDrag, t: number, rowTrack: string | null) {
  const ops: Op[] = []
  if (!project.media?.acervo) {
    ops.push(project.media ? { op: 'add', path: '/media/acervo', value: d.root } : { op: 'add', path: '/media', value: { acervo: d.root } })
  }
  const aid = d.song.id.replace(/^musica\//, '').replace(/[^a-z0-9-]+/gi, '-').slice(0, 48)
  if (!project.assets[aid]) ops.push({ op: 'add', path: `/assets/${aid}`, value: { src: `@acervo/${d.song.src}`, label: d.song.titulo } })
  const quebras = project.tracks.filter((x) => x.quebra)
  const track = quebras.find((x) => x.id === rowTrack) ?? quebras[quebras.length - 1]
  const p = d.piece
  const len = p.end - p.start
  const bodies = track ? pecasDaTrilha(project, track.id).map((x) => ({ start: x.start, end: x.start + x.body - x.inP })) : []
  const ima = bodies.map((b) => b.end).filter((e) => Math.abs(e - t) < 1.5).sort((a, b) => Math.abs(a - t) - Math.abs(b - t))[0]
  const start = round(freeStart(bodies, ima ?? Math.max(0, t), len))
  const taken = new Set(project.tracks.flatMap((x) => (x.clips ?? []).map((c) => c.id)))
  let n = 1
  while (taken.has(`${aid}-p${p.n}-${n}`)) n++
  const clip = {
    id: `${aid}-p${p.n}-${n}`, asset: aid, start, in: round(p.start), body: round(p.end), out: round(p.end), fade_in: 0.01, fade_out: 0.01,
    label: `${d.song.titulo} · P${p.n}${p.role ? ` ${p.role}` : ''}${p.mood ? ` · ${p.mood}` : ''}`,
  }
  if (!track) {
    ops.push({ op: 'add', path: '/tracks/-', value: { id: `musica-acervo-${Date.now().toString(36)}`, quebra: true, name: 'Música (acervo)', color: '#c9a227', clips: [clip] } })
    await patch(ops as never, `Trecho P${p.n} de ${d.song.titulo}`)
    return
  }
  ops.push({ op: 'add', path: track.clips ? `/tracks/[id=${track.id}]/clips/-` : `/tracks/[id=${track.id}]/clips`, value: track.clips ? clip : [clip] })
  const durArq = project.assets[aid]?.meta?.duration ?? d.song.dur ?? p.end
  const pecas = [...pecasDaTrilha(project, track.id), { id: clip.id, asset: aid, start, inP: clip.in, body: clip.body, out: clip.out, fadeIn: clip.fade_in, fadeOut: clip.fade_out, durArquivo: durArq, bpm: d.song.bpm }]
  // as juntas do clipe novo nascem já com os valores (os ops dele editariam um clipe que só existe depois do add)
  const jo = juntasOps({ ...project, assets: { ...project.assets, [aid]: { src: `@acervo/${d.song.src}` } } } as Project, track.id, pecas)
  for (const o of jo) {
    const m = o.path.match(/\[id=([^\]]+)\]\/([a-z_]+)$/)
    if (m && m[1] === clip.id) (clip as Record<string, unknown>)[m[2]] = o.value
    else ops.push(o)
  }
  await patch(ops as never, `Trecho P${p.n} de ${d.song.titulo}`)
}
