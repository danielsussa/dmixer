import type { ResolvedClip } from '@dmixer/core'
import type { LibraryItem } from './Library'

/**
 * Lego connectors on the edges of library pieces, so it is visible what joins what.
 *
 *   right edge (out)                     left edge (in)
 *   soando · Ré maior  ◗ round stud      soando · Ré maior  ◖ round socket
 *   soando · Ré dórico ▮ square stud     soando · Ré dórico ▯ square socket
 *   chega              ▶ arrow           golpe              ┃ thick edge (follows anything)
 *   apaga              ░ faded edge      silencio           │ flat edge (starts from nothing)
 *
 * A stud fills the socket of the same shape — the pieces look interlocked when they fit.
 */
export type Family = 'maior' | 'dorico' | null

export function familyOf(it?: LibraryItem): Family {
  const f = it?.family ?? ''
  if (/dórico|dorico/i.test(f) && !/\+/.test(f)) return 'dorico'
  if (/maior/i.test(f) && !/\+/.test(f)) return 'maior'
  return null
}

export interface Edge {
  family: Family
  in: string
  out: string
  /** octave-band energy (dB) every 50 ms over ~300 ms: start of the body, end of the body, start of the tail */
  tin?: number[][]
  tout?: number[][]
  ttail?: number[][]
  /** the beat: is the start / end rhythmic (rin, rout: spread of the attack pattern, dB), and how strong is beat 1 (first) */
  pulse?: { rin: number; rout: number; first: number; drop?: number }
  /** what the piece plays and how full it is, to catch instruments dropping out and intensity cliffs */
  inst?: string[]
  intensity?: number
  category?: string
  /** a slice of a composition (LibraryItem.sequence): which bars it plays */
  seq?: { id: string; bar: number; bars: number; total?: number; loops?: boolean; level?: number }
}

/** B is the music of A going on: the next bars of the same composition (at any arrangement level), or its bar 1 again
 * after the last bar when the composition loops */
export function continuacao(a: Edge, b: Edge): string | null {
  const x = a.seq
  const y = b.seq
  if (!x || !y || x.id !== y.id) return null
  const nivel = x.level && y.level && x.level !== y.level ? ` (nível ${x.level} → ${y.level})` : ''
  if (x.bar + x.bars === y.bar) return `continuação da composição${nivel}`
  if (x.loops && x.total && x.bar + x.bars - 1 === x.total && y.bar === 1) return `a composição volta ao começo${nivel}`
  return null
}

/** The edges of a piece; for a clip cut short (`body` set), the end edge is the measured one of that cut point. */
export function edgeOf(it?: LibraryItem, clip?: { body?: number }): Edge | null {
  if (!it || it.role === 'complemento' || it.role === 'cobertura') return null
  const cut = clip?.body !== undefined ? it.cuts?.find((c) => Math.abs(c.at - clip.body!) < 0.02) : undefined
  if (cut) {
    const e = edgeOf(it)!
    return { ...e, out: 'soando', tout: cut.out, ttail: cut.tail }
  }
  return { family: familyOf(it), in: it.in ?? (it.category === 'abertura' ? 'silencio' : it.category === 'impacto' ? 'golpe' : 'soando'),
    out: it.out ?? (it.category === 'fechamento' || it.category === 'impacto' ? 'apaga' : 'soando'), tin: it.edges?.in, tout: it.edges?.out, ttail: it.edges?.tail, pulse: it.edges?.pulse,
    inst: it.instruments, intensity: it.intensity, category: it.category,
    seq: it.sequence && it.bar !== undefined ? { id: it.sequence, bar: it.bar, bars: it.bars ?? 1, total: it.sequence_bars, loops: it.loops, level: it.level } : undefined }
}

export type SeamKind = 'ok' | 'family' | 'gap' | 'restart' | 'texture' | 'pulse' | 'drop' | 'covered'

/** families that, when they stop at a join, are heard as the music being cut (sustained brass, the drums) */
const PESADOS: Record<string, string> = { metais: 'os metais', percussao: 'a percussão' }
/** categories made to change the scene: they can drop instruments or intensity on purpose */
const MUDA_CENA = new Set(['impacto', 'transicao', 'fechamento', 'abertura'])

/**
 * The texture jump at a join A → B (the same sum as etiquetas.salto): B butts the end of A's body while A's tail rings
 * under B's start, so "after" is B's start plus A's tail, band by band. The jump is the mean difference per octave band
 * between the ~300 ms before and after (dB) plus the change in movement. It predicts the jump measured in the audio with
 * a 0.95 correlation; above TEXTURA the join sounds like a cut even at equal level.
 */
export function textura(out?: number[][], tail?: number[][], inn?: number[][]): number | null {
  if (!out?.length || !inn?.length || !Array.isArray(out[0])) return null
  const depois = inn.map((fr, i) => (tail?.[i] ? fr.map((v, k) => 10 * Math.log10(10 ** (v / 10) + 10 ** (tail[i][k] / 10))) : fr))
  const media = (q: number[][]) => q[0].map((_, k) => q.reduce((s, fr) => s + fr[k], 0) / q.length)
  const mov = (q: number[][]) => {
    const m = q.map((fr) => fr.reduce((s, v) => s + v, 0) / fr.length)
    return m.length > 1 ? m.slice(1).reduce((s, v, i) => s + Math.abs(v - m[i]), 0) / (m.length - 1) : 0
  }
  const a = media(out)
  const b = media(depois)
  return a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0) / a.length + 2 * Math.abs(mov(out) - mov(depois))
}
export const TEXTURA = 6.5
/** same limits as etiquetas.py: a rhythmic edge, and a beat 1 weak enough to stumble after one */
export const RITMICO = 2
export const TEMPO_FRACO = -6
/** a piece with some beat before the join, and a first downbeat this far below the piece's own usual downbeat */
export const RITMICO_ANTES = 1.5
export const MURCHO = -4

/** Does B fit after A? */
export function seam(a: Edge, b: Edge): { kind: SeamKind; text: string } {
  const cont = continuacao(a, b)
  if (cont) return { kind: 'ok', text: cont }
  const famA = a.family
  const famB = b.family
  const harmonic = (e: Edge, side: 'in' | 'out') => (side === 'in' ? e.in !== 'golpe' && e.in !== 'silencio' : e.out !== 'apaga')
  if (famA && famB && famA !== famB && harmonic(a, 'out') && harmonic(b, 'in')) {
    return { kind: 'family', text: `famílias diferentes (${famA === 'maior' ? 'Ré maior' : 'Ré dórico'} → ${famB === 'maior' ? 'Ré maior' : 'Ré dórico'}): Fá e Dó brigam na emenda — passe por um acorde comum (Sol ou Ré) ou por um golpe` }
  }
  const tx = a.out === 'soando' && b.in === 'soando' ? textura(a.tout, a.ttail, b.tin) : null
  if (a.out === 'soando' && b.in === 'soando' && !MUDA_CENA.has(b.category ?? '')) {
    const somem = (a.inst ?? []).filter((x) => PESADOS[x] && !(b.inst ?? []).includes(x))
    if (b.inst && somem.length) return { kind: 'drop', text: `${somem.map((x) => PESADOS[x]).join(' e ')} param de repente na emenda — a próxima não tem ${somem.length > 1 ? 'esses instrumentos' : 'esse instrumento'}: use uma peça com eles, ou passe por um impacto ou uma transição` }
    if (a.intensity && b.intensity && Math.abs(a.intensity - b.intensity) >= 3) return { kind: 'drop', text: `a intensidade ${b.intensity < a.intensity ? 'despenca' : 'salta'} de i${a.intensity} para i${b.intensity}: soa como corte — use uma intensidade mais próxima ou uma transição` }
  }
  // a batida: depois de uma peça rítmica, a próxima (rítmica) precisa chegar com o 1º tempo; se ele vem fraco, tropeça
  if (a.out === 'soando' && b.in === 'soando' && a.pulse && b.pulse && !MUDA_CENA.has(b.category ?? '')) {
    // o groove dela já é sincopado (1º tempo fraco em todo compasso) e a anterior tem batida
    if (a.pulse.rout > RITMICO && b.pulse.rin > RITMICO && b.pulse.first < TEMPO_FRACO) {
      return { kind: 'pulse', text: `a batida tropeça: a próxima chega com o 1º tempo fraco (${b.pulse.first.toFixed(0)} dB) depois de uma peça com batida — o ouvido espera o 1º tempo e ele não vem` }
    }
    // ou ela começa "murcha": o 1º tempo do 1º compasso bem abaixo do 1º tempo normal dela
    if (a.pulse.rout > RITMICO_ANTES && (b.pulse.drop ?? 0) < MURCHO) {
      return { kind: 'pulse', text: `a próxima começa murcha: o 1º tempo dela vem ${(-b.pulse.drop!).toFixed(0)} dB abaixo do normal dela, logo depois de uma peça com batida` }
    }
  }
  if (tx !== null && tx > TEXTURA) return { kind: 'texture', text: `a textura muda de repente na emenda (${tx.toFixed(1)}): soa como corte — use uma peça de textura parecida, um calço com movimento ou uma transição` }
  if (a.out === 'apaga' && b.in === 'soando') return { kind: 'gap', text: 'a anterior se apaga e esta entra já soando: fica um buraco no meio — aqui cabe uma abertura ou um golpe' }
  if (a.out === 'soando' && b.in === 'silencio') return { kind: 'restart', text: 'a anterior está soando e esta entra do silêncio: a música corta e recomeça' }
  if (a.out === 'chega' && b.in === 'soando') return { kind: 'restart', text: 'a subida pede um golpe ou uma entrada forte depois' }
  return { kind: 'ok', text: 'encaixa' }
}

const SEAM_COLOR: Record<SeamKind, string> = { ok: '#4ade80', family: '#f87171', gap: '#fb923c', restart: '#fb923c', texture: '#fb923c', pulse: '#fb923c', drop: '#fb923c', covered: '#38bdf8' }

/** The connector glyph of one edge, `size` px tall. Studs (out) stick out to the right; sockets (in) are cut in. */
export function EdgeGlyph({ side, edge, color, size = 14, bg = '#0b0b0c' }: { side: 'in' | 'out'; edge: Edge; color: string; size?: number; bg?: string }) {
  const w = size / 2 + 1
  const kind = side === 'in' ? edge.in : edge.out
  const square = edge.family === 'dorico'
  const line = 'rgba(255,255,255,0.75)'
  const stud = (fill: string) => (
    <svg width={w} height={size} viewBox={`0 0 ${w} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      {square
        ? <rect x={-0.5} y={size * 0.16} width={w - 1} height={size * 0.68} rx={1.5} fill={fill} stroke={line} strokeWidth={1} />
        : <path d={`M-0.5,0.5 A${size / 2 - 0.5},${size / 2 - 0.5} 0 0 1 -0.5,${size - 0.5}`} fill={fill} stroke={line} strokeWidth={1} />}
    </svg>
  )
  if (side === 'out') {
    if (kind === 'soando') return stud(color)
    if (kind === 'chega') return <svg width={w} height={size} viewBox={`0 0 ${w} ${size}`} style={{ display: 'block' }}><path d={`M0,0.5 L${w - 1},${size / 2} L0,${size - 0.5} Z`} fill={color} stroke={line} strokeWidth={1} /></svg>
    return <svg width={3} height={size} style={{ display: 'block' }}><rect x={-1} y={0} width={2} height={size} fill={line} opacity={0.3} /></svg>
  }
  if (kind === 'soando') return stud(bg)
  if (kind === 'golpe') return <svg width={3} height={size} style={{ display: 'block' }}><rect x={0} y={0} width={3} height={size} fill="#ffffff" opacity={0.9} /></svg>
  return <svg width={2} height={size} style={{ display: 'block' }}><rect x={0} y={0} width={1} height={size} fill={line} opacity={0.5} /></svg>
}

/** Connectors and seam marks for the library pieces of one lane. */
export function LaneConnectors({ clips, items, zoom, top, height, color, covers = [] }: {
  clips: ResolvedClip[]; items: Map<string, LibraryItem>; zoom: number; top: number; height: number; color: string
  /** times where a transition (cobertura) hits: a join there shows as covered */
  covers?: number[]
}) {
  const size = Math.min(20, Math.max(12, height * 0.3))
  const y = top + 5   // logo abaixo da faixa de título, acima da onda
  const placed = clips.map((c) => ({ c, e: edgeOf(items.get(c.asset), c.raw) })).filter((x) => x.e) as { c: ResolvedClip; e: Edge }[]
  const sorted = [...placed].sort((a, b) => a.c.start - b.c.start)
  const seams: { x: number; kind: SeamKind; text: string }[] = []
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (Math.abs(a.c.bodyEnd - b.c.start) < 0.06) {
      const sm = seam(a.e, b.e)
      const coberta = covers.some((t) => Math.abs(t - b.c.start) < 0.06)
      seams.push({ x: b.c.start * zoom, ...(coberta ? { kind: 'covered' as SeamKind, text: `coberta por uma transição${sm.kind === 'ok' ? '' : ` (sem ela: ${sm.text})`}` } : sm) })
    }
  }
  return (
    <>
      {placed.map(({ c, e }) => (
        <div key={`in-${c.id}`} className="absolute pointer-events-none z-[6]" style={{ left: c.start * zoom, top: y }}>
          <EdgeGlyph side="in" edge={e} color={color} size={size} bg="#0b0b0c" />
        </div>
      ))}
      {placed.map(({ c, e }) => (
        <div key={`out-${c.id}`} className="absolute pointer-events-none z-[7]" style={{ left: c.bodyEnd * zoom, top: y }}>
          <EdgeGlyph side="out" edge={e} color={color} size={size} />
        </div>
      ))}
      {seams.map((s, i) => (
        <div key={`seam-${i}`} className="absolute z-[8] -translate-x-1/2 rounded-full border border-black/60" title={s.text}
          style={{ left: s.x, top: top - 13, width: 9, height: 9, background: SEAM_COLOR[s.kind], cursor: 'help' }} />
      ))}
    </>
  )
}

/**
 * Connector mode: the piece new ones should follow — the selected clip if it is a library piece, else the last piece
 * (by end time) on the selected track, else the last piece of the whole mix.
 */
export function anchorPiece(project: import('@dmixer/core').Project, r: import('@dmixer/core').ResolvedProject, items: Map<string, LibraryItem>,
  selection: { kind: string; trackId?: string; clipId?: string } | null): { clip: ResolvedClip; item: LibraryItem; trackId: string } | null {
  const pieces = r.tracks.flatMap((t) => t.clips.map((c) => ({ c, t, it: items.get(c.asset) })))
    .filter((x) => x.it && x.it.role !== 'complemento' && x.it.role !== 'cobertura' && project.assets[x.c.asset]?.body !== undefined)
  if (selection?.kind === 'clip') {
    const s = pieces.find((x) => x.t.id === selection.trackId && x.c.id === selection.clipId)
    if (s) return { clip: s.c, item: s.it!, trackId: s.t.id }
  }
  const pool = selection?.trackId ? pieces.filter((x) => x.t.id === selection.trackId) : pieces
  const last = (pool.length ? pool : pieces).sort((a, b) => b.c.bodyEnd - a.c.bodyEnd)[0]
  return last ? { clip: last.c, item: last.it!, trackId: last.t.id } : null
}

/** Does `next` join cleanly after `prev`? (same family, studs and sockets that fit, no hole) */
export function fitsAfter(prev: LibraryItem, next: LibraryItem): boolean {
  const a = edgeOf(prev)
  const b = edgeOf(next)
  if (!a || !b) return false
  if (a.family && b.family && a.family !== b.family) return false
  return seam(a, b).kind === 'ok'
}
