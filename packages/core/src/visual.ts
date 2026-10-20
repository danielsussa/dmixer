import { z } from 'zod'
import { round } from './util.js'

/**
 * A imagem: o que um clipe de trilha `video` sabe fazer além de tocar um arquivo de vídeo. Trazido do vidmeo
 * (packages/core: anim, color, effects, html), com as mesmas regras de composição dos dois lados, visor e render:
 *   - o clipe é encaixado no quadro (contain) e então multiplicado por `transform.scale`;
 *   - `transform.x/y` são pixels a partir do centro do quadro;
 *   - as trilhas mais acima na lista ficam por cima; uma camada de ajuste (`type: adjustment`) aplica os efeitos
 *     dela a tudo o que está abaixo, enquanto dura.
 */

export const Easing = z.string().describe('linear | ease | ease-in | ease-out | ease-in-out | cubic-bezier(a,b,c,d)')

/** `at` em segundos a partir do início do clipe. */
export const Keyframe = z.object({ at: z.number(), value: z.number(), easing: Easing.optional() })
export type Keyframe = z.infer<typeof Keyframe>

export const Animatable = z.union([z.number(), z.object({ keyframes: z.array(Keyframe).min(1), easing: Easing.optional() })])
export type Animatable = z.infer<typeof Animatable>

export const Transform = z.object({
  x: Animatable.optional(),
  y: Animatable.optional(),
  scale: Animatable.optional(),
  rotation: Animatable.optional(),
})
export type Transform = z.infer<typeof Transform>

/** Frações do quadro da fonte, 0..1. */
export const Crop = z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() })
export type Crop = z.infer<typeof Crop>

/**
 * Efeitos de imagem. `color` é a correção de cor (neutros: 0 no que soma, 1 no que multiplica, 6500K na
 * temperatura; campo ausente = neutro). `grain` é grão de filme, 0..100, `size` 1 = fino.
 */
export const VisualEffect = z.object({
  type: z.enum(['blur', 'brightness', 'contrast', 'saturate', 'grayscale', 'color', 'grain']),
  amount: z.number().optional(),
  value: z.number().optional(),
  exposure: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
  gamma: z.number().optional(),
  temperature: z.number().optional(),
  tint: z.number().optional(),
  red: z.number().optional(),
  green: z.number().optional(),
  blue: z.number().optional(),
  size: z.number().optional(),
})
export type VisualEffect = z.infer<typeof VisualEffect>

/** Uma rampa de opacidade numa ponta do clipe; numa sobreposição entre trilhas vira dissolve. */
export const Transition = z.object({ type: z.enum(['cut', 'fade', 'dissolve']), duration: z.number().min(0).default(0.25) })
export type Transition = z.infer<typeof Transition>

// ── o que é cada arquivo ─────────────────────────────────────────────────────

export const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)$/i
export const PAGE_EXT = /\.html?$/i
export const VIDEO_EXT = /\.(mp4|mov|webm|mkv|m4v)$/i

export type PictureKind = 'video' | 'image' | 'html' | 'color' | 'adjustment'

/** O que um clipe de trilha de vídeo desenha: o `type` dele, ou o tipo do arquivo. */
export function pictureKind(type: string | undefined, src: string): PictureKind {
  if (type === 'color' || type === 'adjustment') return type
  if (PAGE_EXT.test(src)) return 'html'
  if (IMAGE_EXT.test(src)) return 'image'
  return 'video'
}

/** Imagens, páginas, cartões e camadas de ajuste não têm duração própria: o clipe dá a dele. */
export function isStill(kind: PictureKind): boolean {
  return kind !== 'video'
}

// ── animação ─────────────────────────────────────────────────────────────────

const NAMED: Record<string, [number, number, number, number]> = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  'ease-in': [0.42, 0, 1, 1],
  'ease-out': [0, 0, 0.58, 1],
  'ease-in-out': [0.42, 0, 0.58, 1],
}
const BEZIER = /^cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)$/

export function easingFn(easing?: string): (t: number) => number {
  if (!easing) return (t) => t
  const named = NAMED[easing.trim()]
  if (named) return bezier(...named)
  const m = BEZIER.exec(easing.trim())
  return m ? bezier(+m[1], +m[2], +m[3], +m[4]) : (t) => t
}

function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  if (x1 === y1 && x2 === y2) return (t) => t
  const cx = (t: number) => 3 * (1 - t) ** 2 * t * x1 + 3 * (1 - t) * t * t * x2 + t ** 3
  const cy = (t: number) => 3 * (1 - t) ** 2 * t * y1 + 3 * (1 - t) * t * t * y2 + t ** 3
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let lo = 0
    let hi = 1
    let t = x
    for (let i = 0; i < 20; i++) {
      t = (lo + hi) / 2
      if (cx(t) < x) lo = t
      else hi = t
    }
    return cy(t)
  }
}

/** O valor no tempo local do clipe. Fora dos keyframes vale o primeiro (antes) ou o último (depois). */
export function evalAnimatable(value: Animatable | undefined, local: number, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number') return value
  const kfs = [...value.keyframes].sort((a, b) => a.at - b.at)
  if (!kfs.length) return fallback
  if (local <= kfs[0].at) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (local >= last.at) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (local <= b.at) {
      const span = b.at - a.at
      if (span <= 0) return b.value
      // a curva de um trecho é a do keyframe para onde ele vai
      return a.value + (b.value - a.value) * easingFn(b.easing ?? value.easing)((local - a.at) / span)
    }
  }
  return fallback
}

/** A opacidade das transições de entrada e saída (rampas lineares, a de saída acaba no último quadro). */
export function transitionGain(tin: Transition | undefined, tout: Transition | undefined, local: number, duration: number): number {
  let g = 1
  if (tin && tin.type !== 'cut' && tin.duration > 0) g *= Math.min(1, Math.max(0, local / tin.duration))
  if (tout && tout.type !== 'cut' && tout.duration > 0) g *= Math.min(1, Math.max(0, (duration - local) / tout.duration))
  return g
}

/** Tamanho do clipe encaixado no quadro (contain), antes do `scale`, medido na região recortada. */
export function fitSize(w: number, h: number, frame: { width: number; height: number }, crop?: Crop): { w: number; h: number } {
  const sw = Math.max(1, w * (1 - (crop?.left ?? 0) - (crop?.right ?? 0)))
  const sh = Math.max(1, h * (1 - (crop?.top ?? 0) - (crop?.bottom ?? 0)))
  const r = Math.min(frame.width / sw, frame.height / sh)
  return { w: sw * r, h: sh * r }
}

// ── cor ──────────────────────────────────────────────────────────────────────
// Uma fórmula só, em sRGB 0..255, escrita na língua de cada lado: ao ffmpeg como `lutrgb` + `colorchannelmixer`, ao
// navegador como `feComponentTransfer` + `feColorMatrix`. A ordem faz parte da fórmula: exposição, contraste, gama, e só
// então a matriz (saturação × ganho por canal).

export interface ColorGrade {
  exposure: number
  contrast: number
  saturation: number
  gamma: number
  temperature: number
  tint: number
  red: number
  green: number
  blue: number
}

export const NEUTRAL: ColorGrade = { exposure: 0, contrast: 1, saturation: 1, gamma: 1, temperature: 6500, tint: 0, red: 1, green: 1, blue: 1 }
const LUMA = { r: 0.213, g: 0.715, b: 0.072 }
const mexeu = (a: number, b: number, tol = 0.0005) => Math.abs(a - b) > tol

export function gradeOf(e: VisualEffect): ColorGrade {
  return {
    exposure: e.exposure ?? 0, contrast: e.contrast ?? 1, saturation: e.saturation ?? 1, gamma: e.gamma ?? 1,
    temperature: e.temperature ?? 6500, tint: e.tint ?? 0, red: e.red ?? 1, green: e.green ?? 1, blue: e.blue ?? 1,
  }
}

/** Kelvin → o branco daquela temperatura (Tanner Helland). */
function whitePoint(kelvin: number): [number, number, number] {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100
  const canal = (v: number) => Math.max(0, Math.min(255, v)) / 255
  const r = t <= 66 ? 1 : canal(329.698727446 * Math.pow(t - 60, -0.1332047592))
  const g = t <= 66 ? canal(99.4708025861 * Math.log(t) - 161.1195681661) : canal(288.1221695283 * Math.pow(t - 60, -0.0755148492))
  const b = t >= 66 ? 1 : t <= 19 ? 0 : canal(138.5177312231 * Math.log(t - 10) - 305.0447927307)
  return [r, g, Math.max(b, 0.0001)]
}

/** O ganho por canal da temperatura (a luz da cena: 4000K = imagem laranja, que é preciso esfriar) e do tinte. */
export function channelGain(g: ColorGrade): [number, number, number] {
  const alvo = whitePoint(NEUTRAL.temperature)
  const cena = whitePoint(g.temperature)
  const gain: [number, number, number] = [alvo[0] / cena[0], alvo[1] / cena[1], alvo[2] / cena[2]]
  const t = Math.max(-1, Math.min(1, g.tint))
  gain[1] *= 1 + t * 0.25
  gain[0] *= 1 - t * 0.12
  gain[2] *= 1 - t * 0.12
  const norm = gain[1] || 1
  return [round((gain[0] / norm) * g.red, 4), round((gain[1] / norm) * g.green, 4), round((gain[2] / norm) * g.blue, 4)]
}

export function colorMatrix(g: ColorGrade): number[][] | null {
  const s = g.saturation
  const [gr, gg, gb] = channelGain(g)
  if (!mexeu(s, 1) && !mexeu(gr, 1) && !mexeu(gg, 1) && !mexeu(gb, 1)) return null
  const sat = [
    [LUMA.r + s * (1 - LUMA.r), LUMA.g * (1 - s), LUMA.b * (1 - s)],
    [LUMA.r * (1 - s), LUMA.g + s * (1 - LUMA.g), LUMA.b * (1 - s)],
    [LUMA.r * (1 - s), LUMA.g * (1 - s), LUMA.b + s * (1 - LUMA.b)],
  ]
  const gain = [gr, gg, gb]
  // o colorchannelmixer recusa coeficientes fora de [-2, 2] (e o render inteiro falha)
  const limite = (v: number) => round(Math.max(-2, Math.min(2, v)), 5)
  return sat.map((linha, i) => linha.map((v) => limite(v * gain[i])))
}

function toneCurve(g: ColorGrade): { exposure: number; contrast: number; gamma: number } | null {
  if (!mexeu(g.exposure, 0) && !mexeu(g.contrast, 1) && !mexeu(g.gamma, 1)) return null
  return { exposure: g.exposure, contrast: g.contrast, gamma: g.gamma }
}

export function gradeToFfmpeg(g: ColorGrade): string[] {
  const steps: string[] = []
  const c = toneCurve(g)
  if (c) {
    // lutrgb e não eq: o eq trabalha em YUV, e o mesmo número dá outra imagem
    const expr = `clip(pow(clip((val/255+${round(c.exposure, 5)}-0.5)*${round(c.contrast, 5)}+0.5,0,1),${round(1 / c.gamma, 5)})*255,0,255)`
    steps.push(`lutrgb=r='${expr}':g='${expr}':b='${expr}'`)
  }
  const m = colorMatrix(g)
  if (m) {
    steps.push(`colorchannelmixer=rr=${m[0][0]}:rg=${m[0][1]}:rb=${m[0][2]}:gr=${m[1][0]}:gg=${m[1][1]}:gb=${m[1][2]}:br=${m[2][0]}:bg=${m[2][1]}:bb=${m[2][2]}`)
  }
  return steps
}

export interface SvgGrade {
  /** 20 números de `feColorMatrix`, ou nulo. */
  matrix: number[] | null
  /** A curva de tom, aplicada antes da matriz. */
  curve: { slope: number; intercept: number; gamma: number } | null
}

export function gradeToSvg(g: ColorGrade): SvgGrade {
  const m = colorMatrix(g)
  const c = toneCurve(g)
  return {
    matrix: m ? [...m[0], 0, 0, ...m[1], 0, 0, ...m[2], 0, 0, 0, 0, 0, 1, 0] : null,
    curve: c ? { slope: round(c.contrast, 5), intercept: round((c.exposure - 0.5) * c.contrast + 0.5, 5), gamma: round(1 / c.gamma, 5) } : null,
  }
}

// ── efeitos ──────────────────────────────────────────────────────────────────

export function grainOf(e: VisualEffect): { amount: number; size: number } {
  return { amount: Math.max(0, Math.min(100, e.amount ?? 25)), size: Math.max(0.5, Math.min(4, e.size ?? 1)) }
}

/** Força da turbulência SVG por unidade de `amount`, medida contra o `noise` do ffmpeg (vidmeo). */
export const GRAIN_STRENGTH_PER_UNIT = 0.0141

export function grainToCss(e: VisualEffect): { frequency: number; strength: number } {
  const { amount, size } = grainOf(e)
  return { frequency: round(0.9 / size, 3), strength: round(amount * GRAIN_STRENGTH_PER_UNIT, 4) }
}

export function effectToFfmpeg(e: VisualEffect): string[] {
  switch (e.type) {
    case 'blur': return [`gblur=sigma=${e.amount ?? 4}`]
    case 'brightness': return [`eq=brightness=${e.value ?? 0}`]
    case 'contrast': return [`eq=contrast=${e.value ?? 1}`]
    case 'saturate': return [`eq=saturation=${e.value ?? 1}`]
    case 'grayscale': return ['hue=s=0']
    case 'color': return gradeToFfmpeg(gradeOf(e))
    // temporal e uniforme: sem o `t` o grão fica parado e lê como sujeira na lente
    case 'grain': return [`noise=alls=${Math.round(grainOf(e).amount)}:allf=t+u`]
    default: return []
  }
}

// ── páginas html ─────────────────────────────────────────────────────────────
// O contrato de tempo é o do vidmeo, com os mesmos nomes, para as páginas servirem nos dois: as animações da página
// ficam pausadas e são postas no tempo local do clipe; `--vidmeo-duration` e `--vidmeo-time` ficam no <html>; se a
// página definir `window.vidmeoSeek(t, duração)`, ele é chamado a cada quadro; o fundo é transparente.

export const HTML_SEEK_SOURCE = `(() => {
  const transparente = () => {
    if (document.getElementById('__vidmeo')) return
    const s = document.createElement('style')
    s.id = '__vidmeo'
    s.textContent = 'html,body{background:transparent!important}'
    ;(document.head || document.documentElement).appendChild(s)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', transparente)
  else transparente()
  window.__vidmeoSeek = (t, dur) => {
    transparente()
    const raiz = document.documentElement.style
    raiz.setProperty('--vidmeo-duration', String(dur))
    raiz.setProperty('--vidmeo-time', String(t))
    for (const a of document.getAnimations()) {
      a.pause()
      a.currentTime = t * 1000
    }
    if (typeof window.vidmeoSeek === 'function') window.vidmeoSeek(t, dur)
  }
})()`

/** A query string de um clipe html: os `params` dele mais a duração. */
export function htmlQuery(params: Record<string, string | number | boolean> | undefined, duration: number): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params ?? {})) q.set(k, String(v))
  q.set('vidmeo_duration', String(duration))
  return q.toString()
}
