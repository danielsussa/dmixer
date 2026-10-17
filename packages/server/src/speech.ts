import fs from 'node:fs/promises'
import path from 'node:path'
import { decode, fingerprint } from './media.js'

/**
 * Onde há fala num arquivo de voz, pela energia: quadros de 20 ms acima de (nível típico da fala − 28 dB). Respiros de
 * até 0,25 s ficam dentro da frase; estalos de menos de 0,1 s não contam. A resposta fica em cache por arquivo, como os
 * picos e a análise de música.
 */
const VERSAO = 1
const SR = 16000
const QUADRO = 0.02
const ABAIXO = 28
const PISO = -55
const RESPIRO = 0.25
const MINIMO = 0.1

const running = new Map<string, Promise<{ spans: [number, number][] }>>()

export async function speech(file: string, cacheDir: string): Promise<{ spans: [number, number][] }> {
  const { hash } = await fingerprint(file)
  const out = path.join(cacheDir, `${hash}.fala.v${VERSAO}.json`)
  try {
    return JSON.parse(await fs.readFile(out, 'utf8'))
  } catch { /* not yet */ }
  let job = running.get(hash)
  if (!job) {
    job = (async () => {
      const [l, r] = await decode(file, SR)
      const w = Math.round(QUADRO * SR)
      const n = Math.floor(l.length / w)
      const db = new Float32Array(n)
      for (let f = 0; f < n; f++) {
        let s = 0
        for (let i = f * w; i < (f + 1) * w; i++) {
          const v = (l[i] + r[i]) / 2
          s += v * v
        }
        db[f] = 10 * Math.log10(s / w + 1e-12)
      }
      const vivos = [...db].filter((v) => v > -70).sort((a, b) => a - b)
      const ref = vivos.length ? vivos[Math.floor(vivos.length * 0.95)] : -20
      const lim = Math.max(ref - ABAIXO, PISO)
      const spans: [number, number][] = []
      let ini = -1
      for (let f = 0; f <= n; f++) {
        const fala = f < n && db[f] > lim
        if (fala && ini < 0) ini = f
        if (!fala && ini >= 0) {
          const a = ini * QUADRO
          const b = f * QUADRO
          const last = spans[spans.length - 1]
          if (last && a - last[1] <= RESPIRO) last[1] = b
          else spans.push([a, b])
          ini = -1
        }
      }
      const j = { spans: spans.filter(([a, b]) => b - a >= MINIMO).map(([a, b]) => [Math.round(a * 100) / 100, Math.round(b * 100) / 100] as [number, number]) }
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(out, JSON.stringify(j))
      return j
    })().finally(() => running.delete(hash))
    running.set(hash, job)
  }
  return job
}
