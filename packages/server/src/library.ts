import fs from 'node:fs/promises'
import path from 'node:path'
import { HOME } from './home.js'

/**
 * Libraries of ready-made pieces ("lego" music): a folder with an index.json marked
 * `dmixer_library`, listing items with their file, category, layer, chord, intensity and
 * length in bars. A library is found two ways: a folder the mix already declares under
 * `media:` (its alias is that name), or one listed in ~/.dmixer/config.json:
 *
 *   { "libraries": [{ "alias": "pecas", "path": "/home/…/biblioteca" }] }
 *
 * Dropping a piece from a library the mix does not declare yet adds it under `media:`.
 */
export interface LibraryItem {
  id: string
  src: string
  category: string
  layer?: string
  recipe?: string
  chord?: string
  intensity?: number
  bars?: number
  body?: number
  tail?: number
  loop?: boolean
  description?: string
  family?: string
  source?: string
  role?: string
  harmonic?: boolean
  chords?: string[]
  min_bars?: number
}

export interface Library {
  alias: string
  root: string
  name: string
  declared: boolean
  grid?: { bpm: number; meter: number }
  categories: string[]
  moods?: string[]
  items: LibraryItem[]
  /** how to make a piece to order (a complement over given chords): the command and the recipes it knows */
  generator?: { cmd: string[]; recipes: Record<string, { role: string; harmonic: boolean; min_bars: number; description?: string; layer?: string }>; intensities?: Record<string, number[]> }
}

async function readLibrary(alias: string, root: string, declared: boolean): Promise<Library | null> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(root, 'index.json'), 'utf8'))
    if (!j.dmixer_library) return null
    return { alias, root, name: j.name ?? alias, declared, grid: j.grid, categories: j.categories ?? [], moods: j.moods ?? [], items: j.items ?? [], generator: j.generator }
  } catch {
    return null
  }
}

export async function configuredLibraries(): Promise<{ alias: string; path: string }[]> {
  try {
    const j = JSON.parse(await fs.readFile(path.join(HOME, 'config.json'), 'utf8'))
    return j.libraries ?? []
  } catch {
    return []
  }
}

/** The libraries a mix can use: the ones it declares, then the configured ones. */
export async function librariesFor(projectDir: string, media: Record<string, string>): Promise<Library[]> {
  const out: Library[] = []
  const seen = new Set<string>()
  // the same folder reached by two paths (a symlink) is one library
  const real = async (p: string) => fs.realpath(p).catch(() => p)
  for (const [alias, rel] of Object.entries(media)) {
    const root = await real(path.resolve(projectDir, rel))
    const lib = await readLibrary(alias, root, true)
    if (lib) {
      out.push(lib)
      seen.add(root)
    }
  }
  for (const c of await configuredLibraries()) {
    const root = await real(path.resolve(c.path))
    if (seen.has(root)) continue
    let alias = c.alias
    while (media[alias]) alias += '2'
    const lib = await readLibrary(alias, root, false)
    if (lib) out.push(lib)
  }
  return out
}

/** A file inside a library, refusing anything outside it. */
export function libraryFile(lib: Library, src: string): string {
  const full = path.resolve(lib.root, src)
  const rel = path.relative(lib.root, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('outside the library')
  return full
}

/**
 * Make a piece to order with the library's own generator (declared in its index.json) —
 * e.g. a complement over the chords of the bases under it. The generator caches by name, so
 * asking twice is cheap. Returns the new item.
 */
export async function renderToOrder(lib: Library, recipe: string, chords: string[], intensity: number): Promise<LibraryItem> {
  const g = lib.generator
  if (!g?.cmd?.length) throw new Error(`Library "${lib.alias}" cannot make pieces to order`)
  if (!g.recipes?.[recipe]) throw new Error(`Library "${lib.alias}" has no recipe "${recipe}"`)
  if (!chords.length || chords.some((c) => !/^[A-G][#b]?[a-z0-9]*$/.test(c))) throw new Error('bad chords')
  const { spawn } = await import('node:child_process')
  const out = await new Promise<string>((resolve, reject) => {
    const p = spawn(g.cmd[0], [...g.cmd.slice(1), '--sob-medida', recipe, '--acordes', chords.join(','), '--intensidade', String(intensity)], { cwd: lib.root })
    let o = ''
    let e = ''
    p.stdout.on('data', (c: Buffer) => (o += c.toString()))
    p.stderr.on('data', (c: Buffer) => (e += c.toString()))
    p.on('error', reject)
    p.on('close', (code) => (code === 0 ? resolve(o) : reject(new Error(`generator failed: ${e.slice(-600)}`))))
  })
  const line = out.trim().split('\n').filter((l) => l.startsWith('{')).pop()
  if (!line) throw new Error('generator returned nothing')
  return JSON.parse(line) as LibraryItem
}
