import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  applyBiquad, atenuacaoEm, audibleTracks, biquad, dbToGain, duckDbAt, duckRegions, envelopeAt, ESPECTRAL_FATOR, ESPECTRAL_Q,
  freeverbWet, mascaraDoJson, mascaraParaJson, panGains, processingOrder, resolveProject, type Effect, type MascaraEspectral,
  type Project, type ResolvedPoint, type ResolvedProject, type ResolvedTrack,
} from '@dmixer/core'
import { calcularMascara } from './espectral.js'
import { decode, run, runStderr } from './media.js'
import type { Workspace } from './workspace.js'
import { composeVideo } from './video.js'

export interface RenderOptions {
  out: string
  /** Render only a range of the timeline. */
  from?: number
  to?: number
  /** Normalise to the project's loudness target (default true when the project sets one). */
  normalize?: boolean
  onProgress?: (fraction: number, stage: string) => void
}

export interface RenderResult {
  out: string
  duration: number
  loudness?: { input_i: number; output_i?: number }
}

type Stereo = [Float32Array, Float32Array]

const BLOCK = 64
/** Room after the last clip for fades and reverb tails. */
const TAIL = 3

/**
 * The exact mix: every clip placed, every track through its effects, envelope, volume
 * and pan, buses before the master, then loudness normalisation. Pure JS on float
 * buffers, with ffmpeg only for decoding and the final encode.
 */
export async function renderMix(project: Project, ws: Workspace, opts: RenderOptions): Promise<RenderResult> {
  const r = resolveProject(project)
  const sr = r.sampleRate
  const from = Math.max(0, opts.from ?? 0)
  const to = opts.to ?? r.duration + TAIL
  const N = Math.max(1, Math.ceil((to - from) * sr))
  const progress = opts.onProgress ?? (() => {})
  const heard = audibleTracks(r.tracks)
  const order = processingOrder(r.tracks)

  const decoded = new Map<string, Stereo>()
  const load = async (src: string): Promise<Stereo> => {
    let d = decoded.get(src)
    if (!d) {
      d = await decode(ws.resolveMedia(src, project.media ?? {}), sr)
      decoded.set(src, d)
    }
    return d
  }

  const buses = new Map<string, Stereo>()
  const master: Stereo = [new Float32Array(N), new Float32Array(N)]
  const busOf = (id: string): Stereo => {
    let b = buses.get(id)
    if (!b) {
      b = [new Float32Array(N), new Float32Array(N)]
      buses.set(id, b)
    }
    return b
  }

  // duck espectral: a máscara de cada faixa sai da faixa e da voz inteiras (a mesma do preview), não só do trecho
  const mascaras = new Map<string, MascaraEspectral>()
  for (const t of order) {
    if (!heard.has(t.id)) continue
    for (const [i, e] of t.effects.entries()) {
      if (e.type === 'espectral' && !e.bypass) mascaras.set(`${t.id}:${i}`, await mascaraDaFaixa(project, ws, t.id, i, load))
    }
  }

  let done = 0
  for (const t of order) {
    progress(done / (order.length + 1), t.name)
    done++
    if (!heard.has(t.id)) continue
    let buf: Stereo
    if (t.type === 'bus') {
      buf = buses.get(t.id) ?? [new Float32Array(N), new Float32Array(N)]
    } else {
      buf = [new Float32Array(N), new Float32Array(N)]
      for (const c of t.clips) {
        if (c.muted || !c.src) continue
        await placeClip(buf, await load(c.src), c, from, sr)
      }
    }
    applyEffects(buf, t.effects, r, from, sr, (i) => mascaras.get(`${t.id}:${i}`))
    applyGain(buf, t.volume, t.envelope, from, sr)
    const dest = t.output && heard.has(t.output) ? busOf(t.output) : t.output ? null : master
    if (dest) mixInto(dest, buf, t.pan)
    if (t.type === 'bus') buses.delete(t.id) // its children are in; free the buffer
  }

  progress(order.length / (order.length + 1), 'master')
  applyEffects(master, r.master.effects, r, from, sr)
  applyGain(master, r.master.volume, r.master.envelope, from, sr)

  await fs.mkdir(path.dirname(opts.out), { recursive: true })
  const wav = opts.out.replace(/\.[^.]+$/, '') + '.tmp.wav'
  await fs.writeFile(wav, wavFloat(master, sr))
  const result: RenderResult = { out: opts.out, duration: N / sr }
  const loud = r.master.loudness
  const args = ['-v', 'error', '-y', '-i', wav]
  if (loud && opts.normalize !== false) {
    const tp = loud.true_peak ?? -1
    const text = await runStderr('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', `loudnorm=I=${loud.target}:TP=${tp}:LRA=11:print_format=json`, '-f', 'null', '-'])
      .catch((e: Error) => e.message)
    const json = text.slice(text.lastIndexOf('{'), text.lastIndexOf('}') + 1)
    try {
      const j = JSON.parse(json)
      args.push('-af', `loudnorm=I=${loud.target}:TP=${tp}:LRA=11:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset}:linear=true`)
      result.loudness = { input_i: Number(j.input_i) }
    } catch {
      /* measuring failed: encode without normalising */
    }
  }
  args.push('-ar', String(sr))
  const isVideo = /\.mp4$/i.test(opts.out)
  const audioOut = isVideo ? opts.out.replace(/\.mp4$/i, '') + '.tmp.audio.wav' : opts.out
  if (/\.mp3$/i.test(opts.out)) args.push('-b:a', '192k')
  else args.push('-c:a', 'pcm_s24le')
  args.push(audioOut)
  await run('ffmpeg', args)
  await fs.rm(wav, { force: true })
  if (isVideo) {
    progress(0.97, 'video')
    await composeVideo(r, project.assets, ws, project.media ?? {}, audioOut, opts.out, from, N / sr)
    await fs.rm(audioOut, { force: true })
  }
  progress(1, 'done')
  return result
}

async function placeClip(buf: Stereo, src: Stereo, c: ResolvedTrack['clips'][number], from: number, sr: number) {
  const g = dbToGain(c.gain)
  // a cabeça (quebra-cabeça): o som começa antes do início visível, com o material de antes do trecho no arquivo
  const s0 = Math.round((c.in - c.head) * sr)
  const len = Math.round((c.duration + c.head) * sr)
  const at = Math.round((c.start - c.head - from) * sr)
  const fi = Math.max(1, Math.round(c.fadeIn * sr))
  const fo = Math.max(1, Math.round(c.fadeOut * sr))
  const curva = (x: number) => (c.equalPower ? Math.sin((x * Math.PI) / 2) : x)   // potência constante: o crossfade não afunda
  const N = buf[0].length
  for (let k = 0; k < len; k++) {
    const i = at + k
    if (i < 0) continue
    if (i >= N) break
    const j = s0 + k
    if (j >= src[0].length) break
    let gk = g
    if (k < fi) gk *= curva(k / fi)
    if (len - k < fo) gk *= curva((len - k) / fo)
    buf[0][i] += src[0][j] * gk
    buf[1][i] += src[1][j] * gk
  }
}

function applyGain(buf: Stereo, volume: number, env: ResolvedPoint[], from: number, sr: number) {
  const N = buf[0].length
  if (env.length === 0) {
    const g = dbToGain(volume)
    if (g === 1) return
    for (let i = 0; i < N; i++) {
      buf[0][i] *= g
      buf[1][i] *= g
    }
    return
  }
  let prev = dbToGain(volume + envelopeAt(env, from))
  for (let b = 0; b < N; b += BLOCK) {
    const next = dbToGain(volume + envelopeAt(env, from + (b + BLOCK) / sr))
    const end = Math.min(N, b + BLOCK)
    for (let i = b; i < end; i++) {
      const g = prev + ((next - prev) * (i - b)) / BLOCK
      buf[0][i] *= g
      buf[1][i] *= g
    }
    prev = next
  }
}

function mixInto(dest: Stereo, src: Stereo, pan: number) {
  const p = panGains(pan)
  const [dl, dr] = dest
  const [sl, sr_] = src
  for (let i = 0; i < dl.length; i++) {
    const l = sl[i]
    const r = sr_[i]
    dl[i] += l * p.ll + r * p.rl
    dr[i] += l * p.lr + r * p.rr
  }
}

export function applyEffects(buf: Stereo, effects: Effect[], r: ResolvedProject, from: number, sr: number,
  mascara: (index: number) => MascaraEspectral | undefined = () => undefined) {
  for (const [index, e] of effects.entries()) {
    if (e.bypass) continue
    switch (e.type) {
      case 'highpass':
      case 'lowpass': {
        const c = biquad(e.type, e.freq, sr, e.q ?? Math.SQRT1_2)
        applyBiquad(buf[0], c)
        applyBiquad(buf[1], c)
        break
      }
      case 'eq': {
        const c = biquad('peaking', e.freq, sr, e.q ?? 1, e.gain)
        applyBiquad(buf[0], c)
        applyBiquad(buf[1], c)
        break
      }
      case 'shelf': {
        const c = biquad(e.kind === 'low' ? 'lowshelf' : 'highshelf', e.freq, sr, 1, e.gain)
        applyBiquad(buf[0], c)
        applyBiquad(buf[1], c)
        break
      }
      case 'compressor':
        compress(buf, sr, e.threshold, e.ratio, e.attack ?? 0.01, e.release ?? 0.15, e.makeup ?? 0)
        break
      case 'limiter':
        compress(buf, sr, e.ceiling, 30, 0.001, 0.08, 0)
        break
      case 'duck': {
        const regions = duckRegions(r, e)
        const attack = e.attack ?? 0.08
        const release = e.release ?? 0.4
        const N = buf[0].length
        for (let b = 0; b < N; b += BLOCK) {
          const g = dbToGain(duckDbAt(regions, e.depth, attack, release, from + b / sr))
          if (g === 1) continue
          const end = Math.min(N, b + BLOCK)
          for (let i = b; i < end; i++) {
            buf[0][i] *= g
            buf[1][i] *= g
          }
        }
        break
      }
      case 'espectral': {
        const m = mascara(index)
        if (m) aplicarEspectral(buf, m, from, sr)
        break
      }
      case 'reverb': {
        const [wl, wr] = freeverbWet(buf[0], buf[1], sr, e.seconds ?? 2.5)
        const dry = 1 - e.mix
        for (let i = 0; i < buf[0].length; i++) {
          buf[0][i] = buf[0][i] * dry + wl[i] * e.mix
          buf[1][i] = buf[1][i] * dry + wr[i] * e.mix
        }
        break
      }
    }
  }
}

/**
 * O banco de peaking do duck espectral, com o ganho de cada banda mudando a cada bloco (como o BiquadFilterNode do
 * preview faz a cada quantum). Bloco sem atenuação nenhuma passa direto, só levando o estado dos filtros adiante.
 */
function aplicarEspectral(buf: Stereo, m: MascaraEspectral, from: number, sr: number) {
  const nb = m.bandas.length
  const att = new Float32Array(nb)
  const st = Array.from({ length: nb * 2 }, () => ({ x1: 0, x2: 0, y1: 0, y2: 0 }))
  const N = buf[0].length
  const B = 128
  for (let b0 = 0; b0 < N; b0 += B) {
    const end = Math.min(N, b0 + B)
    atenuacaoEm(m, from + (b0 + B / 2) / sr, att)
    for (let b = 0; b < nb; b++) {
      const g = -att[b] * ESPECTRAL_FATOR
      for (let ch = 0; ch < 2; ch++) {
        const x = buf[ch]
        const s = st[b * 2 + ch]
        if (g > -0.01) {   // filtro neutro: y = x
          if (end - b0 >= 2) { s.x1 = s.y1 = x[end - 1]; s.x2 = s.y2 = x[end - 2] }
          continue
        }
        const c = biquad('peaking', m.bandas[b], sr, ESPECTRAL_Q, g)
        let { x1, x2, y1, y2 } = s
        for (let i = b0; i < end; i++) {
          const v = x[i]
          const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
          x2 = x1; x1 = v; y2 = y1; y1 = y
          x[i] = y
        }
        Object.assign(s, { x1, x2, y1, y2 })
      }
    }
  }
}

const mascarasEmCurso = new Map<string, Promise<MascaraEspectral>>()

/**
 * A máscara do efeito `espectral` (índice `fx`) da faixa: a faixa (com os efeitos de antes, o volume e a automação) e
 * a voz da `source` (os clipes, mesmo com a faixa mutada, como o duck), a mix inteira. Fica em cache no disco pela
 * soma do que entra nela.
 */
export async function mascaraDaFaixa(project: Project, ws: Workspace, trackId: string, fx: number,
  load?: (src: string) => Promise<Stereo>): Promise<MascaraEspectral> {
  const r = resolveProject(project)
  const sr = r.sampleRate
  const t = r.tracks.find((x) => x.id === trackId)
  const e = t?.effects[fx]
  if (!t || !e || e.type !== 'espectral') throw new Error(`faixa ${trackId} não tem duck espectral em ${fx}`)
  const src = r.tracks.find((x) => x.id === e.source)
  if (!src) throw new Error(`duck espectral: a fonte ${e.source} não é uma faixa`)
  const snr = e.snr ?? 12
  const max = e.max ?? 7
  const N = Math.ceil((r.duration + TAIL) * sr)
  const arquivos = [...new Set([...t.clips, ...src.clips].filter((c) => c.src).map((c) => c.src!))]
  const mtimes = await Promise.all(arquivos.map((a) => fs.stat(ws.resolveMedia(a, project.media ?? {})).then((x) => x.mtimeMs, () => 0)))
  const chave = createHash('sha1').update(JSON.stringify({
    v: 1, sr, N, snr, max, arquivos, mtimes,
    faixa: { clips: t.clips, effects: t.effects.slice(0, fx), volume: t.volume, envelope: t.envelope },
    fonte: { clips: src.clips, effects: src.effects, volume: src.volume, envelope: src.envelope },
  })).digest('hex')
  const arq = path.join(ws.cacheDir, 'espectral', `${chave}.json`)
  const pronta = mascarasEmCurso.get(chave)
  if (pronta) return pronta
  const p = (async () => {
    try {
      return mascaraDoJson(JSON.parse(await fs.readFile(arq, 'utf8')))
    } catch { /* ainda não calculada */ }
    const carregadas = new Map<string, Stereo>()
    const carregar = load ?? (async (s: string) => {
      let d = carregadas.get(s)
      if (!d) carregadas.set(s, (d = await decode(ws.resolveMedia(s, project.media ?? {}), sr)))
      return d
    })
    const mono = async (tr: ResolvedTrack, effects: Effect[]): Promise<Float32Array> => {
      const buf: Stereo = [new Float32Array(N), new Float32Array(N)]
      for (const c of tr.clips) {
        if (c.muted || !c.src) continue
        await placeClip(buf, await carregar(c.src), c, 0, sr)
      }
      applyEffects(buf, effects.filter((x) => x.type !== 'espectral'), r, 0, sr)
      applyGain(buf, tr.volume, tr.envelope, 0, sr)
      const out = buf[0]
      for (let i = 0; i < N; i++) out[i] = 0.5 * (out[i] + buf[1][i])
      return out
    }
    const voz = await mono(src, src.effects)
    const faixa = await mono(t, t.effects.slice(0, fx))
    const m = calcularMascara(voz, faixa, sr, snr, max)
    await fs.mkdir(path.dirname(arq), { recursive: true })
    const j = mascaraParaJson(m)
    await fs.writeFile(arq, JSON.stringify(j))
    return mascaraDoJson(j)   // a mesma tabela (em quartos de dB) que o preview recebe
  })()
  mascarasEmCurso.set(chave, p)
  try {
    return await p
  } finally {
    mascarasEmCurso.delete(chave)
  }
}

/** Feed-forward compressor on the stereo-linked peak, hard knee. */
function compress(buf: Stereo, sr: number, threshold: number, ratio: number, attack: number, release: number, makeup: number) {
  const a = Math.exp(-1 / (attack * sr))
  const rel = Math.exp(-1 / (release * sr))
  const mk = dbToGain(makeup)
  let env = 0 // gain reduction in dB (≥ 0)
  for (let i = 0; i < buf[0].length; i++) {
    const peak = Math.max(Math.abs(buf[0][i]), Math.abs(buf[1][i]))
    const lvl = peak > 1e-9 ? 20 * Math.log10(peak) : -180
    const over = lvl - threshold
    const target = over > 0 ? over * (1 - 1 / ratio) : 0
    env = target > env ? a * env + (1 - a) * target : rel * env + (1 - rel) * target
    const g = dbToGain(-env) * mk
    buf[0][i] *= g
    buf[1][i] *= g
  }
}

function wavFloat([l, r]: Stereo, sr: number): Buffer {
  const n = l.length
  const data = 8 * n
  const b = Buffer.alloc(44 + data)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + data, 4)
  b.write('WAVE', 8)
  b.write('fmt ', 12)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(3, 20) // IEEE float
  b.writeUInt16LE(2, 22)
  b.writeUInt32LE(sr, 24)
  b.writeUInt32LE(sr * 8, 28)
  b.writeUInt16LE(8, 32)
  b.writeUInt16LE(32, 34)
  b.write('data', 36)
  b.writeUInt32LE(data, 40)
  for (let i = 0; i < n; i++) {
    b.writeFloatLE(l[i], 44 + 8 * i)
    b.writeFloatLE(r[i], 48 + 8 * i)
  }
  return b
}
