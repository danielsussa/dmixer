import type { Clip } from './schema.js'
import { round } from './util.js'

/**
 * Remontagem de uma música, como um quebra-cabeça. O analisador (analyze.py --pecas) corta a música em peças de
 * compassos inteiros, dá uma função a cada uma e mede a emenda entre todo par. Aqui é só conta: um molde (duração, curva
 * de energia, picos em certos instantes) e uma busca em feixe que acha as sequências de peças que seguem o molde com as
 * emendas mais naturais. O resultado vira clipes comuns da mesma música, que o editor escreve no YAML.
 */

export type Funcao = 'abertura' | 'respiro' | 'base' | 'subida' | 'virada' | 'pico' | 'final'

export interface Peca {
  i: number
  /** segundos do arquivo; a abertura começa em 0 e o final acaba no fim do arquivo */
  start: number
  end: number
  /** índice do primeiro compasso e quantos são */
  bar: number
  bars: number
  /** 0–1 dentro da música */
  energy: number
  role: Funcao
  /** peças quase iguais a esta */
  twins: number[]
  layers?: string[]
  section?: string | null
  change_db?: number
}

export interface Pecas {
  duration: number
  bpm?: number
  /** de onde veio a grade: "essentia" ou "allin1" (análise profunda) */
  grid?: string
  /** duração de um compasso (s) */
  bar: number
  bars?: number[]
  pieces: Peca[]
  /** nota da emenda de A para B (1 = natural; 0,5 = tão parecido quanto um compasso e o seguinte; 0 = proibida) */
  seams: number[][]
  error?: string
}

export interface Molde {
  /** duração pedida (s) */
  duracao: number
  /** energia pedida (0–1) ao longo da remontagem: pares [posição 0–1, energia 0–1] */
  curva: [number, number][]
  /** instantes (s desde o começo da remontagem) onde deve entrar um pico, como o corte de um vídeo */
  picos?: number[]
  /** começar pela abertura da música (padrão) ou por qualquer peça */
  inicio?: 'abertura' | 'qualquer'
  /** acabar no final da música (padrão) ou em qualquer peça (aí o editor põe um fade) */
  fim?: 'final' | 'qualquer'
}

export interface Remontagem {
  /** índices das peças, na ordem */
  seq: number[]
  duracao: number
  custo: number
  /** nota de cada emenda (null na primeira peça) */
  emendas: (number | null)[]
  /** para cada pico pedido: onde entrou o pico mais perto e o erro (s) */
  picos: { at: number; erro: number }[]
}

export const CORES_FUNCAO: Record<Funcao, string> = {
  abertura: '#4f7cff', respiro: '#2bb3c9', base: '#3fb68b', subida: '#ff8a3d', virada: '#f2b705', pico: '#e0312b', final: '#9b3d6e',
}

/** Curvas prontas. "original" é calculada da própria música (curvaOriginal). */
export const CURVAS: Record<string, { nome: string; pts: [number, number][] }> = {
  direto: { nome: 'direto ao pico', pts: [[0, 0.25], [0.2, 0.35], [0.3, 1], [0.85, 1], [1, 0.6]] },
  meio: { nome: 'pico no meio', pts: [[0, 0.15], [0.5, 1], [1, 0.2]] },
  cresce: { nome: 'cresce até o fim', pts: [[0, 0.1], [0.85, 1], [1, 0.9]] },
  respiro: { nome: 'dois picos com um respiro', pts: [[0, 0.2], [0.15, 0.4], [0.22, 1], [0.45, 1], [0.52, 0.2], [0.62, 0.4], [0.7, 1], [0.95, 1], [1, 0.6]] },
}

/** a energia da música original ao longo dela, como curva (para "manter a forma" com outra duração) */
export function curvaOriginal(p: Pecas): [number, number][] {
  const d = p.duration || 1
  return p.pieces.map((x) => [round((x.start + x.end) / 2 / d, 4), x.energy] as [number, number])
}

export function curvaEm(pts: [number, number][], x: number): number {
  if (!pts.length) return 0.5
  if (x <= pts[0][0]) return pts[0][1]
  for (let k = 1; k < pts.length; k++) {
    if (x <= pts[k][0]) {
      const [x0, y0] = pts[k - 1]
      const [x1, y1] = pts[k]
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1)
    }
  }
  return pts[pts.length - 1][1]
}

/** pesos do custo: a emenda conta mais que a curva, que conta mais que a repetição */
const PESO = { emenda: 1.6, ruim: 2, curva: 1.2, uso: 0.35, repetida: 2, pedePico: 0.6, picoErrado: 2, picoNoMeio: 1.5, duracao: 0.6, semFinal: 0.3 }
/** abaixo disto uma emenda soa como corte: custa bem mais, para só entrar quando não há outro caminho */
export const EMENDA_RUIM = 0.35
const FEIXE = 300

type Estado = { custo: number; seq: number[]; t: number }

export function remontar(p: Pecas, m: Molde, quantas = 3): Remontagem[] {
  const P = p.pieces
  if (!P.length) return []
  const n = P.length
  const bar = p.bar || 2
  const dur = P.map((x) => x.end - x.start)
  const alvo = Math.max(bar, m.duracao)
  const picos = [...(m.picos ?? [])].filter((t) => t >= 0 && t < alvo).sort((a, b) => a - b)
  const abertura = P.find((x) => x.role === 'abertura')?.i ?? 0
  const final = P.find((x) => x.role === 'final')?.i ?? n - 1
  const inicios = m.inicio === 'qualquer' ? P.filter((x) => x.i !== final).map((x) => x.i) : [abertura]
  const emenda = (a: number, b: number) => p.seams[a]?.[b] ?? 0

  const curva = (j: number, t: number) => Math.abs(P[j].energy - curvaEm(m.curva, Math.min(1, (t + dur[j] / 2) / alvo)))
  // um pico pedido em T: a peça que começa perto de T (meio compasso) tem de ser forte; cair no meio de uma peça custa
  const custoPicos = (j: number, t: number) => {
    let c = 0
    for (const T of picos) {
      if (Math.abs(t - T) <= bar / 2) c += P[j].energy >= 0.75 ? 0 : PESO.picoErrado
      else if (T > t + bar / 2 && T < t + dur[j] - bar / 2) c += PESO.picoNoMeio
    }
    return c
  }
  const passo = (s: Estado, j: number) => {
    const a = s.seq[s.seq.length - 1]
    const e = emenda(a, j)
    if (e <= 0) return null
    let c = PESO.emenda * (1 - e) + PESO.ruim * Math.max(0, EMENDA_RUIM - e) / EMENDA_RUIM + PESO.curva * curva(j, s.t) + custoPicos(j, s.t)
    const usos = s.seq.filter((x) => x === j).length + 0.5 * s.seq.filter((x) => P[j].twins.includes(x)).length   // gêmea usada conta meio uso
    c += PESO.uso * usos
    if (a === j) c += PESO.repetida
    if ((P[a].role === 'virada' || P[a].role === 'subida') && P[j].energy < 0.7) c += PESO.pedePico
    return c
  }

  let feixe: Estado[] = inicios.map((i) => ({ custo: PESO.curva * curva(i, 0) + custoPicos(i, 0), seq: [i], t: dur[i] }))
  const prontos: Estado[] = []
  const fecha = (s: Estado, extra: number) => {
    const erro = Math.abs(s.t - alvo) / bar   // em compassos
    prontos.push({ ...s, custo: s.custo + extra + PESO.duracao * Math.max(0, erro - 1) })
  }
  for (const s of feixe) if (s.seq[0] === final || (m.fim === 'qualquer' && s.t >= alvo - bar)) fecha(s, 0)
  for (let it = 0; it < 400 && feixe.length; it++) {
    const novos: Estado[] = []
    for (const s of feixe) {
      for (let j = 0; j < n; j++) {
        if (j === abertura && m.inicio !== 'qualquer') continue
        const c = passo(s, j)
        if (c === null) continue
        const ns = { custo: s.custo + c, seq: [...s.seq, j], t: s.t + dur[j] }
        if (j === final) fecha(ns, 0)
        else {
          if (m.fim === 'qualquer' && Math.abs(ns.t - alvo) <= bar * 2) fecha(ns, PESO.semFinal)
          if (ns.t < alvo + 4 * bar) novos.push(ns)
        }
      }
    }
    novos.sort((a, b) => a.custo - b.custo)
    // diversidade: um estado por (últimas duas peças, compasso onde está)
    const vistos = new Set<string>()
    feixe = []
    for (const s of novos) {
      const k = `${s.seq.slice(-2).join(',')}@${Math.round(s.t / bar)}`
      if (vistos.has(k)) continue
      vistos.add(k)
      feixe.push(s)
      if (feixe.length >= FEIXE) break
    }
  }

  prontos.sort((a, b) => a.custo - b.custo)
  // as melhores que não sejam quase a mesma (pelo menos um quarto das emendas diferente)
  const pares = (seq: number[]) => new Set(seq.slice(1).map((x, k) => `${seq[k]}>${x}`))
  const escolhidas: Estado[] = []
  for (const s of prontos) {
    const ps = pares(s.seq)
    const parecida = escolhidas.some((o) => {
      const po = pares(o.seq)
      let comum = 0
      for (const x of ps) if (po.has(x)) comum++
      return comum / Math.max(ps.size, po.size, 1) > 0.75
    })
    if (parecida) continue
    escolhidas.push(s)
    if (escolhidas.length >= quantas) break
  }
  return escolhidas.map((s) => {
    const inicio: number[] = []
    let t = 0
    for (const j of s.seq) { inicio.push(t); t += dur[j] }
    return {
      seq: s.seq,
      duracao: round(s.t),
      custo: round(s.custo),
      emendas: s.seq.map((j, k) => (k ? round(emenda(s.seq[k - 1], j)) : null)),
      picos: picos.map((T) => {
        const fortes = inicio.filter((_, k) => P[s.seq[k]].energy >= 0.75)
        const at = fortes.length ? fortes.reduce((b, x) => (Math.abs(x - T) < Math.abs(b - T) ? x : b), fortes[0]) : NaN
        return { at: round(at), erro: round(Math.abs(at - T)) }
      }),
    }
  })
}

export interface ClipesOpts {
  asset: string
  /** onde a remontagem começa na timeline (s) */
  start: number
  /** ids novos, um por peça */
  ids: string[]
  /** corta este tanto antes do 1º tempo, para o golpe da peça nova entrar inteiro (s) */
  pre?: number
  /** crossfade de igual potência em cada emenda (s) */
  xfade?: number
  gain?: number
  /** fade no fim quando a remontagem não acaba no final da música (s) */
  fadeFinal?: number
}

/**
 * A remontagem como clipes da mesma música, encostados com um crossfade curto: cada emenda fica `pre` antes do 1º tempo
 * da peça nova, e o crossfade acaba antes do golpe dela. A abertura entra desde o começo do arquivo (com a anacruse) e
 * o final vai até o fim (com a cauda).
 */
export function clipesDaRemontagem(p: Pecas, r: Remontagem, o: ClipesOpts): Clip[] {
  const pre = o.pre ?? 0.012
  const xf = o.xfade ?? 0.02
  const h = xf / 2
  const P = p.pieces
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
  let pos = o.start
  return r.seq.map((j, k) => {
    const x = P[j]
    const ultimo = k === r.seq.length - 1
    const a = x.start <= 0 ? 0 : x.start - pre            // emenda de entrada, em segundos do arquivo
    const b = x.end >= p.duration - 0.001 ? p.duration : x.end - pre
    const clip: Clip = {
      id: o.ids[k],
      asset: o.asset,
      start: round(k ? pos - h : pos),
      in: round(k ? Math.max(0, a - h) : a),
      out: round(ultimo ? b : Math.min(p.duration, b + h)),
      label: `P${j + 1} · ${x.role}`,
      color: CORES_FUNCAO[x.role],
      note: `remontagem: do original ${fmt(x.start)}–${fmt(x.end)}` + (k ? ` · emenda ${Math.round((r.emendas[k] ?? 0) * 100)}%` : ''),
    }
    if (o.gain) clip.gain = o.gain
    if (k) clip.fade_in = xf
    if (!ultimo) clip.fade_out = xf
    else if (x.role !== 'final' && o.fadeFinal) clip.fade_out = o.fadeFinal
    pos += b - a
    return clip
  })
}
