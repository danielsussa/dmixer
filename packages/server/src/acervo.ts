import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { HOME } from './home.js'

/**
 * The acervo's own analysis of a song (~/dev/acervo: catalogo/analises/<id>/pecas.json + humor.json), when the file
 * came from there: its pieces with their role (abertura, respiro, base, subida, virada, pico, final), energy, and the
 * dominant mood of each piece among the 8 of humor.py. The acervo root is ~/dev/acervo or { "acervo": "…" } in
 * ~/.dmixer/config.json. Files under cache/<tipo>/ are named after the item id; files under local/ are matched
 * against the catalog's `local` paths.
 */
const CATS = ['valencia', 'energia', 'feliz', 'triste', 'agressivo', 'relaxado', 'festa', 'dancante'] as const
type Cat = (typeof CATS)[number]
export const MOOD_LABEL: Record<Cat, string> = {
  valencia: 'valência', energia: 'energia', feliz: 'feliz', triste: 'triste',
  agressivo: 'agressivo', relaxado: 'relaxado', festa: 'festa', dancante: 'dançante',
}

export interface AcervoPiece { start: number; end: number; role: string; energy: number; mood: string; moods: Record<string, number> }
export interface AcervoAnalysis { id: string; bpm?: number; key?: string; pieces: AcervoPiece[] }

export async function root(): Promise<string> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(HOME, 'config.json'), 'utf8'))
    if (j.acervo) return String(j.acervo).replace(/^~(?=\/)/, os.homedir())
  } catch { /* sem config */ }
  return path.join(os.homedir(), 'dev/acervo')
}

/** analysis folder name of the item the file belongs to, or null */
async function itemFor(file: string, base: string): Promise<string | null> {
  const real = await fs.realpath(file).catch(() => file)
  const rel = path.relative(base, real)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null
  const parts = rel.split(path.sep)
  // cache/musica/musica__artlist-x-1.trabalho.m4a → musica__artlist-x-1
  if (parts[0] === 'cache' && parts.length === 3) return parts[2].split('.')[0]
  for (const tipo of ['musica', 'sfx']) {
    const txt = await fs.readFile(path.join(base, 'catalogo', `${tipo}.jsonl`), 'utf8').catch(() => '')
    for (const line of txt.split('\n')) {
      if (!line.trim()) continue
      const x = JSON.parse(line)
      if (x.local && path.normalize(x.local) === rel) return String(x.id).replace('/', '__')
    }
  }
  return null
}

/** every humor frame in the acervo, sorted per category: a value's percentile makes the 8 scales comparable */
let dist: { key: string; v: Record<Cat, Float64Array> } | null = null
async function distribution(base: string): Promise<Record<Cat, Float64Array>> {
  const dir = path.join(base, 'catalogo/analises')
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith('musica__')).sort()
  const key = names.join('|')
  if (dist?.key === key) return dist.v
  const all = Object.fromEntries(CATS.map((c) => [c, [] as number[]])) as Record<Cat, number[]>
  for (const n of names) {
    const h = JSON.parse(await fs.readFile(path.join(dir, n, 'humor.json'), 'utf8').catch(() => 'null'))
    if (!h?.quadros) continue
    for (const c of CATS) all[c].push(...(h.quadros[c] ?? []))
  }
  const v = Object.fromEntries(CATS.map((c) => [c, Float64Array.from(all[c]).sort()])) as Record<Cat, Float64Array>
  dist = { key, v }
  return v
}

function percentile(sorted: Float64Array, x: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < x) lo = m + 1; else hi = m }
  return sorted.length ? lo / sorted.length : 0
}

export async function acervoAnalysis(file: string): Promise<AcervoAnalysis | null> {
  const base = await root()
  const id = await itemFor(file, base)
  return id ? analysisById(base, id) : null
}

async function analysisById(base: string, id: string): Promise<AcervoAnalysis | null> {
  const dir = path.join(base, 'catalogo/analises', id)
  // só a análise profunda (grade do All-In-One) vale: a do Essentia sozinha erra a grade, e o analyzer é a base da montagem
  if (id.startsWith('musica__') && !(await fs.access(path.join(dir, 'profunda.json')).then(() => true, () => false))) return null
  const pecas = JSON.parse(await fs.readFile(path.join(dir, 'pecas.json'), 'utf8').catch(() => 'null'))
  const humor = JSON.parse(await fs.readFile(path.join(dir, 'humor.json'), 'utf8').catch(() => 'null'))
  const d = humor?.quadros ? await distribution(base) : null
  const t: number[] = humor?.quadros?.t ?? []
  // sem batida firme o acervo não corta em peças: então os trechos saem só do humor (sem função)
  const brutas: { start: number; end: number; role: string; energy: number }[] = pecas?.pieces?.length
    ? pecas.pieces
    : d ? porHumor(humor.quadros, d) : []
  if (!brutas.length) return null
  const pieces: AcervoPiece[] = brutas.map((p) => {
    const moods: Record<string, number> = {}
    let mood = ''
    if (d) {
      const idx = t.map((x, i) => [x, i] as const).filter(([x]) => x >= p.start && x < p.end).map(([, i]) => i)
      let best = -1
      for (const c of CATS) {
        const vals = idx.map((i) => percentile(d[c], humor.quadros[c][i]))
        const m = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
        moods[MOOD_LABEL[c]] = Math.round(m * 100)
        if (vals.length && m > best) { best = m; mood = MOOD_LABEL[c] }
      }
    }
    return { start: p.start, end: p.end, role: p.role, energy: p.energy, mood, moods }
  })
  return { id: id.replace('__', '/'), bpm: pecas?.bpm, key: humor?.tom, pieces }
}

/** quadros de 1,5 s → trechos pelo humor dominante (percentil), juntando os menores que MIN segundos ao vizinho */
const MIN = 8
function porHumor(q: Record<string, number[]>, d: Record<Cat, Float64Array>): { start: number; end: number; role: string; energy: number }[] {
  const t = q.t
  if (!t?.length) return []
  const hop = t.length > 1 ? t[1] - t[0] : 1.5
  const dom = t.map((_, i) => CATS.reduce((b, c) => (percentile(d[c], q[c][i]) > percentile(d[b], q[b][i]) ? c : b), CATS[0] as Cat))
  let runs: { a: number; b: number; c: Cat }[] = []
  dom.forEach((c, i) => {
    const r = runs[runs.length - 1]
    if (r && r.c === c) r.b = i + 1
    else runs.push({ a: i, b: i + 1, c })
  })
  // o trecho curto some no vizinho mais longo, até não sobrar nenhum curto
  for (;;) {
    const k = runs.findIndex((r) => (r.b - r.a) * hop < MIN)
    if (k < 0 || runs.length < 2) break
    const v = k === 0 ? 1 : k === runs.length - 1 ? k - 1 : (runs[k - 1].b - runs[k - 1].a >= runs[k + 1].b - runs[k + 1].a ? k - 1 : k + 1)
    runs[v] = { a: Math.min(runs[v].a, runs[k].a), b: Math.max(runs[v].b, runs[k].b), c: runs[v].c }
    runs.splice(k, 1)
    runs = runs.reduce((o, r) => { const l = o[o.length - 1]; if (l && l.c === r.c) l.b = r.b; else o.push({ ...r }); return o }, [] as typeof runs)
  }
  const en = q.energia ?? []
  const lo = Math.min(...en)
  const hi = Math.max(...en)
  return runs.map((r, k) => {
    const seg = en.slice(r.a, r.b)
    const m = seg.length ? seg.reduce((x, y) => x + y, 0) / seg.length : lo
    return { start: k === 0 ? 0 : t[r.a] - hop / 2, end: t[r.b - 1] + hop / 2, role: '', energy: hi > lo ? (m - lo) / (hi - lo) : 0.5 }
  })
}

/**
 * As músicas do acervo com análise profunda (All-In-One: catalogo/analises/<id>/profunda.json) e baixadas aqui, com as
 * peças de cada uma — a aba Músicas da Biblioteca, de onde cada trecho se arrasta para a timeline. `src` é relativo à
 * raiz do acervo (o alias de mídia "acervo").
 */
export interface AcervoSong extends AcervoAnalysis { titulo: string; artista?: string; fonte?: string; duracao?: number; src: string; root: string }
export async function acervoSongs(): Promise<AcervoSong[]> {
  const base = await root()
  const txt = await fs.readFile(path.join(base, 'catalogo/musica.jsonl'), 'utf8').catch(() => '')
  const out: AcervoSong[] = []
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue
    const x = JSON.parse(line)
    const pasta = String(x.id).replace('/', '__')
    if (!(await fs.access(path.join(base, 'catalogo/analises', pasta, 'profunda.json')).then(() => true, () => false))) continue
    let src: string | null = x.local ?? null
    if (!src) {   // no cache: <tipo>/<id com __>[.qualidade].ext — a melhor qualidade que houver
      const nomes = await fs.readdir(path.join(base, 'cache', x.tipo)).catch(() => [] as string[])
      const meus = nomes.filter((n) => n.startsWith(pasta + '.') && !n.endsWith('.parte'))
      const rank = (n: string) => (n.includes('.original.') ? 0 : n.includes('.leve.') ? 2 : 1)
      const melhor = meus.sort((a, b) => rank(a) - rank(b))[0]
      src = melhor ? path.join('cache', x.tipo, melhor) : null
    }
    if (!src) continue
    const a = await analysisById(base, pasta)
    if (!a) continue
    out.push({ ...a, titulo: x.titulo, artista: x.artista, fonte: x.fonte?.nome, duracao: x.midia?.duracao ?? x.analise?.duracao, src, root: base })
  }
  return out.sort((a, b) => a.titulo.localeCompare(b.titulo))
}

/** um trecho de uma música do acervo em wav (para ouvir na Biblioteca): cortado com ffmpeg e guardado em cache */
export async function acervoTrecho(src: string, ini: number, fim: number): Promise<string> {
  const base = await root()
  const file = path.resolve(base, src)
  if (path.relative(base, file).startsWith('..')) throw new Error('fora do acervo')
  const dir = path.join(os.tmpdir(), 'dmixer-acervo-trechos')
  await fs.mkdir(dir, { recursive: true })
  const out = path.join(dir, createHash('sha1').update(`${file}|${ini.toFixed(3)}|${fim.toFixed(3)}`).digest('hex').slice(0, 16) + '.wav')
  if (await fs.access(out).then(() => true, () => false)) return out
  await new Promise<void>((ok, no) => {
    const p = spawn('ffmpeg', ['-v', 'error', '-y', '-ss', String(ini), '-t', String(Math.max(0.1, fim - ini)), '-i', file, '-ac', '2', '-ar', '44100', out])
    p.on('error', no)
    p.on('close', (c) => (c === 0 ? ok() : no(new Error(`ffmpeg saiu com ${c}`))))
  })
  return out
}
