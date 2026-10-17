import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * A mix is a folder on disk. Nothing lives in a database.
 *
 *   mix.yaml       a project (a folder may hold several)
 *   cache/         derived and disposable: waveform peaks, decoded audio
 *   renders/       outputs
 *   .snapshots/    save history
 */
export class Workspace {
  constructor(readonly root: string) {}

  static readonly DEFAULT_PROJECT = 'mix.yaml'

  projectPath(name: string): string {
    const base = path.basename(name)
    if (base !== name) throw new Error(`Project name "${name}" must not contain a path`)
    return path.join(this.root, base)
  }

  async listProjects(): Promise<string[]> {
    let entries: string[]
    try {
      entries = await fs.readdir(this.root)
    } catch {
      return []
    }
    const out: string[] = []
    for (const f of entries.filter((f) => /\.ya?ml$/i.test(f) && !f.startsWith('.'))) {
      if (await looksLikeMix(path.join(this.root, f))) out.push(f)
    }
    return out.sort((a, b) => (a === Workspace.DEFAULT_PROJECT ? -1 : b === Workspace.DEFAULT_PROJECT ? 1 : a.localeCompare(b)))
  }

  get cacheDir() { return path.join(this.root, 'cache') }
  get peaksDir() { return path.join(this.cacheDir, 'peaks') }
  get thumbsDir() { return path.join(this.cacheDir, 'thumbs') }
  get analysisDir() { return path.join(this.cacheDir, 'analysis') }
  get rendersDir() { return path.join(this.root, 'renders') }
  get snapshotsDir() { return path.join(this.root, '.snapshots') }

  async ensure(): Promise<void> {
    await Promise.all([this.peaksDir, this.rendersDir, this.snapshotsDir].map((d) => fs.mkdir(d, { recursive: true })))
  }

  /**
   * Resolve a media path. A plain path cannot leave this folder; "@name/…" reaches
   * into a folder the project declared under `media:` — and only into it.
   */
  resolveMedia(src: string, media: Record<string, string> = {}): string {
    const m = /^@([\p{L}\p{N}_-]+)\/(.+)$/u.exec(src)
    const base = m ? media[m[1]] : undefined
    if (m && !base) throw new Error(`Unknown media folder "@${m[1]}" — declare it under \`media:\``)
    const root = m ? path.resolve(this.root, base!) : this.root
    const full = path.resolve(root, m ? m[2] : src)
    const rel = path.relative(root, full)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Path "${src}" escapes its folder`)
    return full
  }
}

async function looksLikeMix(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024) return false
    const head = await fs.readFile(file, 'utf8')
    return /^\s*tracks\s*:/m.test(head) && /^\s*(version|project)\s*:/m.test(head)
  } catch {
    return false
  }
}
