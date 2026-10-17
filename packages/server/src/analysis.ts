import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOME } from './home.js'
import { fingerprint } from './media.js'

/**
 * Cut points of a song (packages/analyzer/analyze.py): its beat grid and the stretches that can
 * be taken out with the rest joining seamlessly. It runs in Python (Essentia), in the venv at
 * ~/.dmixer/venv or the one named in ~/.dmixer/config.json as { "analyzer": { "python": "…" } }.
 * The answer is cached per file, like the peaks.
 */
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../analyzer/analyze.py')
const running = new Map<string, Promise<unknown>>()
/** bump when analyze.py changes what it answers: the cache is per file AND per version */
const VERSAO = 3

async function python(): Promise<string> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(HOME, 'config.json'), 'utf8'))
    if (j.analyzer?.python) return String(j.analyzer.python).replace(/^~(?=\/)/, os.homedir())
  } catch { /* sem config */ }
  for (const p of [path.join(HOME, 'venv/bin/python'), path.join(os.homedir(), '.dmixer/venv/bin/python')]) {
    if (await fs.access(p).then(() => true, () => false)) return p
  }
  throw new Error('analyzer not installed: npm run setup:analyzer')
}

export async function analyze(file: string, cacheDir: string): Promise<unknown> {
  const { hash } = await fingerprint(file)
  const out = path.join(cacheDir, `${hash}.v${VERSAO}.json`)
  try {
    return JSON.parse(await fs.readFile(out, 'utf8'))
  } catch { /* not yet */ }
  let job = running.get(hash)
  if (!job) {
    job = (async () => {
      const py = await python()
      const text = await new Promise<string>((resolve, reject) => {
        const p = spawn(py, ['-I', SCRIPT, file], { stdio: ['ignore', 'pipe', 'pipe'] })
        let o = ''
        let e = ''
        p.stdout.on('data', (c: Buffer) => (o += c.toString()))
        p.stderr.on('data', (c: Buffer) => { if (e.length < 8000) e += c.toString() })
        p.on('error', reject)
        p.on('close', (code) => (code === 0 ? resolve(o) : reject(new Error(`analyzer exited ${code}: ${e.trim().split('\n').slice(-3).join(' ')}`))))
      })
      const j = JSON.parse(text)
      await fs.mkdir(cacheDir, { recursive: true })
      await fs.writeFile(out, JSON.stringify(j))
      return j
    })().finally(() => running.delete(hash))
    running.set(hash, job)
  }
  return job
}
