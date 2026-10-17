import type { Point } from './schema.js'

/**
 * Mixagem automática. Cada passo é uma conta pura sobre medidas que o servidor faz (a fala de cada arquivo de voz, …);
 * o botão "Mixar" do editor junta as medidas e escreve o resultado no YAML, onde ele fica visível e editável.
 */

export interface SubidasOpts {
  /** dB que a música desce enquanto alguém fala */
  depth: number
  /** pausas mais curtas que isso (s) não sobem: a música não "bombeia" entre frases */
  minPause?: number
  /** pausas a partir disso (s) sobem um pouco além do nível normal */
  longPause?: number
  /** dB a mais nas pausas longas */
  swell?: number
  /** a subida começa este tanto (s) depois da última palavra … */
  upDelay?: number
  /** … e leva até isso (s) */
  upTime?: number
  /** a descida termina este tanto (s) antes da próxima palavra … */
  downLead?: number
  /** … e leva até isso (s) */
  downTime?: number
}

export const SUBIDAS_PADRAO: Required<Omit<SubidasOpts, 'depth'>> = {
  minPause: 0.9,
  longPause: 2.5,
  swell: 2,
  upDelay: 0.15,
  upTime: 0.6,
  downLead: 0.12,
  downTime: 0.45,
}

/** junta trechos que se tocam ou se sobrepõem, em ordem */
export function juntarTrechos(spans: [number, number][], gap = 0): [number, number][] {
  const out: [number, number][] = []
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    const last = out[out.length - 1]
    if (last && a - last[1] <= gap) last[1] = Math.max(last[1], b)
    else out.push([a, b])
  }
  return out
}

const r3 = (v: number) => Math.round(v * 1000) / 1000

/**
 * Envelope de volume da música a partir da fala (trechos em segundos da timeline): embaixo da voz fica em −depth; numa
 * pausa de pelo menos `minPause` ela sobe até 0 dB (ou +swell nas longas) e já está de volta embaixo um pouco antes da
 * próxima palavra, para a voz nunca entrar por cima da música cheia.
 */
export function subidasNasPausas(speech: [number, number][], opts: SubidasOpts): Point[] {
  const o = { ...SUBIDAS_PADRAO, ...opts }
  const fala = juntarTrechos(speech)
  if (!fala.length) return []
  const down = -o.depth
  const topo = (gap: number) => (gap >= o.longPause ? o.swell : 0)
  const pts: { at: number; db: number }[] = []
  const push = (at: number, db: number) => {
    const last = pts[pts.length - 1]
    if (last && at <= last.at) at = last.at + 0.001
    pts.push({ at: r3(Math.max(0, at)), db: r3(db) })
  }
  // antes da primeira fala: cheia, e desce para ela
  const a0 = fala[0][0]
  if (a0 >= o.minPause) {
    const dn1 = a0 - o.downLead
    push(0, topo(a0))
    push(dn1 - Math.min(o.downTime, a0 / 3), topo(a0))
    push(dn1, down)
  } else {
    push(0, down)
  }
  for (let i = 0; i < fala.length - 1; i++) {
    const e = fala[i][1]
    const a = fala[i + 1][0]
    const gap = a - e
    if (gap < o.minPause) continue
    const top = topo(gap)
    const up0 = e + o.upDelay
    let up1 = up0 + Math.min(o.upTime, gap / 3)
    const dn1 = a - o.downLead
    let dn0 = dn1 - Math.min(o.downTime, gap / 3)
    if (up1 > dn0) up1 = dn0 = (up1 + dn0) / 2
    push(up0, down)
    push(up1, top)
    if (dn0 > up1) push(dn0, top)
    push(dn1, down)
  }
  // depois da última fala: sobe e fica
  const e = fala[fala.length - 1][1]
  push(e + o.upDelay, down)
  push(e + o.upDelay + o.upTime, 0)
  return pts as Point[]
}
