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

/**
 * The song in pieces, to rebuild like a puzzle (analyze.py --pecas). With `profunda`, the grid comes from the All-In-One
 * (profunda.py, in its own venv named in config.json as { "analyzer": { "profunda": "/…/bin/python" } }): slower (minutes
 * on the CPU) but it finds bars where Essentia does not, sections, and the stems. Long jobs run in the background: the
 * answer is the result when cached, or { running: true } while it is being made (ask again), or the error it ended with.
 */
const SCRIPT_PROFUNDA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../analyzer/profunda.py')
const VERSAO_PECAS = 1
const jobs = new Map<string, { promise: Promise<unknown>; error?: string; started: number }>()

export async function pythonProfunda(): Promise<string | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(HOME, 'config.json'), 'utf8'))
    if (j.analyzer?.profunda) return String(j.analyzer.profunda).replace(/^~(?=\/)/, os.homedir())
  } catch { /* sem config */ }
  return null
}

function roda(py: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const p = spawn(py, ['-I', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let o = ''
    let e = ''
    p.stdout.on('data', (c: Buffer) => (o += c.toString()))
    p.stderr.on('data', (c: Buffer) => { e = (e + c.toString()).slice(-8000) })
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(o) : reject(new Error(`${path.basename(args[0])} exited ${code}: ${e.trim().split('\n').slice(-3).join(' ')}`))))
  })
}

export async function pieces(file: string, cacheDir: string, profunda: boolean): Promise<unknown> {
  const { hash } = await fingerprint(file)
  const out = path.join(cacheDir, `${hash}.pecas${profunda ? '-profunda' : ''}.v${VERSAO_PECAS}.json`)
  try {
    return JSON.parse(await fs.readFile(out, 'utf8'))
  } catch { /* not yet */ }
  const key = out
  const job = jobs.get(key)
  if (job?.error) { jobs.delete(key); throw new Error(job.error) }
  if (job) return { running: true, profunda, seconds: Math.round((Date.now() - job.started) / 1000) }
  const j = { started: Date.now(), error: undefined as string | undefined, promise: Promise.resolve() as Promise<unknown> }
  j.promise = (async () => {
    await fs.mkdir(cacheDir, { recursive: true })
    const args = [SCRIPT, file, '--pecas']
    if (profunda) {
      const pyP = await pythonProfunda()
      if (!pyP) throw new Error('análise profunda não configurada: { "analyzer": { "profunda": "/…/bin/python" } } em ~/.dmixer/config.json')
      const grade = path.join(cacheDir, `${hash}.profunda.v1.json`)
      if (!(await fs.access(grade).then(() => true, () => false))) {
        const txt = await roda(pyP, [SCRIPT_PROFUNDA, file, path.join(cacheDir, `profunda-${hash}`)])
        JSON.parse(txt)   // só grava se veio um JSON inteiro
        await fs.writeFile(grade, txt)
      }
      args.push('--grade', grade)
    }
    const txt = await roda(await python(), args)
    const r = JSON.parse(txt)
    await fs.writeFile(out, JSON.stringify(r))
    jobs.delete(key)
  })().catch((e: Error) => { j.error = e.message })
  jobs.set(key, j)
  return { running: true, profunda, seconds: 0 }
}
