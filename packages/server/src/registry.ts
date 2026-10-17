import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Diagnostic, Project } from '@dmixer/core'
import { parseProject } from '@dmixer/core'
import { ProjectStore, type StoreEvent } from './project-store.js'
import { probe } from './media.js'
import { Workspace } from './workspace.js'

const AUTOSAVE = process.env.DMIXER_AUTOSAVE === '1'

import { HOME } from './home.js'
import { librariesFor } from './library.js'
export { HOME }

export interface Entry {
  id: string
  path: string
  name: string
  linkedAt: number
}

export type RegistryEvent =
  | (StoreEvent & { c: string })
  | { type: 'projects'; projects: Entry[] }
  | { type: 'render'; c: string; id: string; progress: number; stage: string; done?: boolean; file?: string; error?: string }

/**
 * Every mix the server knows, by id. A mix is any YAML file on disk, in any folder:
 * `link()` gives it an id (written into the file as `project.id`, so the link survives
 * the file moving and being linked again) and the URL is /c/<id>. Each mix works out
 * of its own folder — media, cache and renders sit next to its YAML.
 */
export class ProjectRegistry {
  private entries = new Map<string, Entry>()
  private stores = new Map<string, ProjectStore>()
  private opening = new Map<string, Promise<ProjectStore>>()
  private listeners = new Set<(e: RegistryEvent) => void>()
  private absent = new Set<string>()
  private indexFile = path.join(HOME, 'index.json')

  async init(): Promise<void> {
    await fs.mkdir(HOME, { recursive: true })
    await this.refresh()
  }

  private indexMtime = 0

  /**
   * The CLI and the server share the index file. Re-read it when it changed, so a
   * `dmixer link` or `unlink` from a terminal reaches a running server (and the server
   * never writes back an index that forgot it).
   */
  private async refresh(): Promise<void> {
    try {
      const st = await fs.stat(this.indexFile)
      if (st.mtimeMs === this.indexMtime) return
      const j = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as { projects: Entry[] }
      this.indexMtime = st.mtimeMs
      const before = JSON.stringify(this.list())
      this.entries = new Map((j.projects ?? []).map((e) => [e.id, e]))
      for (const id of [...this.stores.keys()]) {
        if (!this.entries.has(id)) {
          void this.stores.get(id)!.close()
          this.stores.delete(id)
        }
      }
      if (JSON.stringify(this.list()) !== before) this.emit({ type: 'projects', projects: this.list() })
    } catch {
      /* first run */
    }
  }

  /** Poll the index (cheap: one stat) so links made elsewhere show up. */
  watchIndex(): () => void {
    const t = setInterval(() => void this.refresh(), 1500)
    return () => clearInterval(t)
  }

  private async persist() {
    const tmp = `${this.indexFile}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ projects: this.list() }, null, 1))
    await fs.rename(tmp, this.indexFile)
    this.indexMtime = (await fs.stat(this.indexFile)).mtimeMs
    this.emit({ type: 'projects', projects: this.list() })
  }

  list(): Entry[] {
    return [...this.entries.values()].sort((a, b) => b.linkedAt - a.linkedAt)
  }

  entry(id: string): Entry | undefined {
    return this.entries.get(id)
  }

  /**
   * Link a YAML file and return its entry. The file must exist and be a valid mix;
   * if it has no `project.id` yet, one is generated and written into it.
   */
  async link(file: string): Promise<Entry> {
    await this.refresh()
    const abs = path.resolve(file)
    const text = await fs.readFile(abs, 'utf8')
    const parsed = parseProject(text)
    if (!parsed.ok) throw new Error(`Not a valid mix: ${parsed.errors.slice(0, 3).join('; ')}`)
    let id = parsed.project!.project.id
    // the same file linked twice keeps its id; a different file claiming a taken id gets a new one
    const taken = id ? this.entries.get(id) : undefined
    if (!id || (taken && taken.path !== abs)) id = randomUUID()
    for (const [k, e] of this.entries) if (e.path === abs && k !== id) this.entries.delete(k)
    const entry: Entry = { id, path: abs, name: parsed.project!.project.name, linkedAt: Date.now() }
    this.entries.set(id, entry)
    await this.persist()
    const store = await this.get(id)
    if (store.getProject().project.id !== id) {
      store.apply([{ op: 'add', path: '/project/id', value: id }], 'system', 'Link id', { record: false })
      await store.save({ snapshot: false })
    }
    return entry
  }

  async unlink(id: string): Promise<void> {
    await this.refresh()
    const s = this.stores.get(id)
    await s?.close()
    this.stores.delete(id)
    this.entries.delete(id)
    await this.persist()
  }

  /** Link every mix found directly in a folder (what `dmixer open <folder>` does). */
  async linkFolder(dir: string): Promise<Entry[]> {
    const ws = new Workspace(path.resolve(dir))
    const out: Entry[] = []
    for (const f of await ws.listProjects()) out.push(await this.link(path.join(ws.root, f)))
    return out
  }

  subscribe(l: (e: RegistryEvent) => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  emit(e: RegistryEvent) {
    for (const l of this.listeners) l(e)
  }

  async get(id: string | undefined): Promise<ProjectStore> {
    if (!id) throw new Error('Which mix? Pass ?c=<id> (see /api/projects)')
    if (!this.entries.has(id)) await this.refresh()
    const open = this.stores.get(id)
    if (open) return open
    const entry = this.entries.get(id)
    if (!entry) throw new Error(`No mix with id "${id}" — link it with \`dmixer link <file.yaml>\``)
    let pending = this.opening.get(id)
    if (!pending) {
      pending = this.openStore(entry)
      this.opening.set(id, pending)
      pending.finally(() => this.opening.delete(id)).catch(() => {})
    }
    return pending
  }

  private async openStore(entry: Entry): Promise<ProjectStore> {
    try {
      await fs.access(entry.path)
    } catch {
      throw new Error(`The file of this mix is gone: ${entry.path}`)
    }
    const ws = new Workspace(path.dirname(entry.path))
    const store = await ProjectStore.open(ws, path.basename(entry.path))
    store.autosave = AUTOSAVE
    store.diagnosticsHook = (p) => this.missing(p)
    store.subscribe((e) => this.emit({ ...e, c: entry.id }))
    store.watch()
    this.stores.set(entry.id, store)
    // a hand-written file is not in canonical form yet; nothing of the user's is pending right after opening
    if (store.isDirty()) await store.save({ snapshot: false })
    await this.backfill(store)
    return store
  }

  private missing(p: Project): Diagnostic[] {
    const out: Diagnostic[] = []
    for (const [id, a] of Object.entries(p.assets)) {
      if (this.absent.has(a.src)) out.push({ severity: 'error', message: `Asset "${id}": file "${a.src}" not found` })
    }
    return out
  }

  /**
   * A hand-written mix may name a file without its duration. The file knows it, so it
   * is filled in on open (and saved, when nothing else was pending).
   */
  async backfill(store: ProjectStore): Promise<void> {
    const p = store.getProject()
    const wasClean = !store.isDirty()
    const ops: { op: 'replace'; path: string; value: unknown }[] = []
    await Promise.all(
      Object.entries(p.assets).map(async ([id, a]) => {
        try {
          const meta = await probe(store.workspace.resolveMedia(a.src, p.media ?? {}))
          this.absent.delete(a.src)
          if (a.meta?.hash !== meta.hash || a.meta?.duration === undefined) {
            ops.push({ op: 'replace', path: `/assets/${id.replace(/~/g, '~0').replace(/\//g, '~1')}/meta`, value: meta })
          }
        } catch {
          this.absent.add(a.src)
        }
      }),
    )
    // pieces from a library: their musical length (body), so the next piece can join where it ends
    const missing = Object.entries(p.assets).filter(([, a]) => a.body === undefined && a.src.startsWith('@'))
    if (missing.length) {
      const bySrc = new Map<string, number>()
      for (const lib of await librariesFor(store.workspace.root, p.media ?? {})) {
        for (const it of lib.items) if (it.body) bySrc.set(`@${lib.alias}/${it.src}`, it.body)
      }
      for (const [id, a] of missing) {
        const body = bySrc.get(a.src)
        if (body) ops.push({ op: 'add' as 'replace', path: `/assets/${id.replace(/~/g, '~0').replace(/\//g, '~1')}/body`, value: body })
      }
    }
    if (ops.length) {
      store.apply(ops, 'system', 'Media metadata', { record: false })
      if (wasClean) await store.save({ snapshot: false })
    }
  }

  resolveSrc(store: ProjectStore, src: string): string {
    return store.workspace.resolveMedia(src, store.getProject().media ?? {})
  }

  async close(): Promise<void> {
    await Promise.all([...this.stores.values()].map((s) => s.close()))
  }
}
