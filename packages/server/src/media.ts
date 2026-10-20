import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AssetMeta } from '@dmixer/core'

export const AUDIO_EXTENSIONS = /\.(wav|mp3|flac|ogg|m4a|aac|aif|aiff|opus)$/i
export const VIDEO_EXTENSIONS = /\.(mp4|mov|webm|mkv|m4v)$/i
export const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?)$/i
export const PAGE_EXTENSIONS = /\.html?$/i
export const MEDIA_EXTENSIONS = /\.(wav|mp3|flac|ogg|m4a|aac|aif|aiff|opus|mp4|mov|webm|mkv|m4v|jpe?g|png|webp|gif|avif|bmp|tiff?)$/i

function run(cmd: string, args: string[], { binary = false } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    p.stdout.on('data', (c: Buffer) => chunks.push(c))
    p.stderr.on('data', (c: Buffer) => { if (!binary || err.length < 4000) err += c.toString() })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))))
  })
}

export async function checkTools(): Promise<{ ffmpeg: boolean; ffprobe: boolean }> {
  const ok = async (c: string) => run(c, ['-version']).then(() => true, () => false)
  return { ffmpeg: await ok('ffmpeg'), ffprobe: await ok('ffprobe') }
}

/** Cache key of a file: path, size and modification time. Re-encoding a file changes it. */
export async function fingerprint(file: string): Promise<{ hash: string; size: number }> {
  const st = await fs.stat(file)
  const hash = createHash('sha1').update(`${file}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 16)
  return { hash, size: st.size }
}

export async function probe(file: string): Promise<AssetMeta> {
  // uma página html (título animado) não tem o que o ffprobe medir: só a impressão digital
  if (PAGE_EXTENSIONS.test(file)) return fingerprint(file)
  const out = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,channels,sample_rate,width,height,avg_frame_rate:format=duration', '-of', 'json', file])
  const j = JSON.parse(out.toString())
  const streams: any[] = j.streams ?? []
  const a = streams.find((x) => x.codec_type === 'audio')
  const v = streams.find((x) => x.codec_type === 'video' && x.width)
  const { hash, size } = await fingerprint(file)
  const meta: AssetMeta = { duration: Math.round(Number(j.format?.duration ?? 0) * 1000) / 1000, size, hash }
  if (a) {
    meta.channels = Number(a.channels ?? 2)
    meta.sample_rate = Number(a.sample_rate ?? 44100)
  }
  // a still image inside an mp3 (cover art) is a "video" stream too; only real video files count
  if (v && IMAGE_EXTENSIONS.test(file)) {
    // uma foto: só o tamanho; a duração é a do clipe
    return { size, hash, width: Number(v.width), height: Number(v.height) }
  }
  if (v && VIDEO_EXTENSIONS.test(file)) {
    meta.width = Number(v.width)
    meta.height = Number(v.height)
    const [n, d] = String(v.avg_frame_rate ?? '30/1').split('/').map(Number)
    meta.fps = d ? Math.round((n / d) * 1000) / 1000 : 30
    meta.has_audio = !!a
  }
  return meta
}

/** One frame (JPEG, 120 px tall) at time t, cached by file and time. */
export async function thumbnail(file: string, t: number, cacheDir: string): Promise<string> {
  const { hash } = await fingerprint(file)
  const at = Math.max(0, Math.round(t * 2) / 2)
  const out = path.join(cacheDir, `${hash}-${at.toFixed(1)}.jpg`)
  try {
    await fs.access(out)
    return out
  } catch {
    /* make it */
  }
  await fs.mkdir(cacheDir, { recursive: true })
  const still = IMAGE_EXTENSIONS.test(file)
  await run('ffmpeg', ['-v', 'error', '-y', ...(still ? [] : ['-ss', String(at)]), '-i', file, '-frames:v', '1', '-vf', 'scale=-2:120', '-q:v', '5', out])
  return out
}

/** Decoded audio, planar float, at the project's sample rate. */
export async function decode(file: string, sampleRate: number): Promise<[Float32Array, Float32Array]> {
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(sampleRate), '-'], { binary: true })
  const inter = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4))
  const n = inter.length >> 1
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    l[i] = inter[2 * i]
    r[i] = inter[2 * i + 1]
  }
  return [l, r]
}

export const PEAKS_PER_SECOND = 50

/** Min/max per 1/50 s, mono, for drawing the waveform. Cached by fingerprint. */
export async function peaks(file: string, cacheDir: string): Promise<{ rate: number; duration: number; data: number[] }> {
  const { hash } = await fingerprint(file)
  const cached = path.join(cacheDir, `${hash}.json`)
  try {
    return JSON.parse(await fs.readFile(cached, 'utf8'))
  } catch {
    /* build it */
  }
  const sr = 8000
  const buf = await run('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '1', '-ar', String(sr), '-'], { binary: true })
  const s = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2))
  const bin = sr / PEAKS_PER_SECOND
  const data: number[] = []
  for (let i = 0; i < s.length; i += bin) {
    let lo = 0
    let hi = 0
    for (let j = i; j < Math.min(s.length, i + bin); j++) {
      const v = s[j]
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    data.push(Math.round((lo / 32768) * 1000) / 1000, Math.round((hi / 32768) * 1000) / 1000)
  }
  const result = { rate: PEAKS_PER_SECOND, duration: s.length / sr, data }
  await fs.mkdir(cacheDir, { recursive: true })
  await fs.writeFile(cached, JSON.stringify(result))
  return result
}

/** Like run, but returns what the tool wrote to stderr (ffmpeg prints measurements there). */
export function runStderr(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', (c: Buffer) => (err += c.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(err) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))))
  })
}

export { run }
