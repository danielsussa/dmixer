import fs from 'node:fs/promises'
import path from 'node:path'
import chokidar, { type FSWatcher } from 'chokidar'
import {
  applyPatch, invertPatch, parseProject, serializeProject, summarizePatch,
  validateProject, emptyProject, type Diagnostic, type PatchOp, type Project,
} from '@dmixer/core'
import { Workspace } from './workspace.js'

export type Author = 'user' | 'system' | 'external'

export interface HistoryEntry {
  id: string
  at: number
  author: Author
  label: string
  ops: PatchOp[]
  inverse: PatchOp[]
  changes: { subject: string; description: string }[]
}

export interface ApplyResult {
  ok: boolean
  error?: string
  entry?: HistoryEntry
  project: Project
  diagnostics: Diagnostic[]
}

export type StoreEvent =
  | {
      type: 'project'
      project: Project
      yaml: string
      diagnostics: Diagnostic[]
      reason: string
      dirty: boolean
      savedAt: number | null
    }
  | { type: 'history'; history: HistoryEntry[]; canUndo: boolean; canRedo: boolean }
  /**
   * The file changed on disk while there were unsaved edits here. Neither side
   * is thrown away: the user is asked which one wins.
   */
  | { type: 'conflict'; yaml: string; diagnostics: Diagnostic[] }

/**
 * The single owner of project state. Every mutation — from the UI, the AI, the
 * CLI, or someone editing the YAML in another editor — passes through here, so
 * history, autosave and undo cannot diverge from the file on disk.
 */
export class ProjectStore {
  private project: Project
  private lastWritten = ''
  private watcher?: FSWatcher
  private saveTimer?: NodeJS.Timeout
  private listeners = new Set<(event: StoreEvent) => void>()
  private savedAt: number | null = null
  /** Set aside when the file changes underneath unsaved work. */
  private conflict: string | null = null

  /**
   * With autosave off, edits live in memory until `save()` — the classic editor
   * contract the user asked for. The cost is that the file is briefly not the
   * whole truth, which is why external changes are surfaced as a conflict
   * instead of being applied silently.
   */
  autosave = false

  readonly undoStack: HistoryEntry[] = []
  readonly redoStack: HistoryEntry[] = []
  readonly history: HistoryEntry[] = []

  private constructor(readonly workspace: Workspace, readonly name: string, project: Project) {
    this.project = project
  }

  /** Absolute path of the file this store owns. */
  get file(): string {
    return this.workspace.projectPath(this.name)
  }

  static async open(workspace: Workspace, name = Workspace.DEFAULT_PROJECT): Promise<ProjectStore> {
    await workspace.ensure()
    const file = workspace.projectPath(name)
    let project: Project
    let text = ''
    try {
      text = await fs.readFile(file, 'utf8')
      const parsed = parseProject(text)
      if (!parsed.ok) throw new Error(`Invalid ${name}:\n  ${parsed.errors.join('\n  ')}`)
      project = parsed.project!
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err
      project = emptyProject({ name: path.basename(name, path.extname(name)) })
      text = serializeProject(project)
      await fs.writeFile(file, text, 'utf8')
    }
    const store = new ProjectStore(workspace, name, project)
    store.lastWritten = text
    return store
  }

  getProject(): Project {
    return this.project
  }

  getYaml(): string {
    return serializeProject(this.project, this.lastWritten || undefined)
  }

  /** True when memory and disk differ. */
  isDirty(): boolean {
    return this.getYaml() !== this.lastWritten
  }

  getSavedAt(): number | null {
    return this.savedAt
  }

  /** The version on disk, when it conflicts with unsaved work here. */
  getConflict(): string | null {
    return this.conflict
  }

  /**
   * Checks the schema cannot make on its own — chiefly whether the media a
   * project points at actually exists in the folder. Supplied by the registry,
   * which is the thing that knows what is on disk.
   */
  diagnosticsHook?: (project: Project) => Diagnostic[]

  getDiagnostics(): Diagnostic[] {
    return [...validateProject(this.project), ...(this.diagnosticsHook?.(this.project) ?? [])]
  }

  subscribe(listener: (event: StoreEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: StoreEvent) {
    for (const l of this.listeners) l(event)
  }

  private broadcastProject(reason: string) {
    this.emit({
      type: 'project',
      project: this.project,
      yaml: this.getYaml(),
      diagnostics: this.getDiagnostics(),
      reason,
      dirty: this.isDirty(),
      savedAt: this.savedAt,
    })
  }

  private broadcastHistory() {
    this.emit({
      type: 'history',
      history: this.history.slice(-100),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    })
  }

  /**
   * The one write path. Refuses a patch that would not parse back as a valid
   * project, so a bad AI patch can never corrupt the file.
   */
  apply(ops: PatchOp[], author: Author, label: string, options: { record?: boolean } = {}): ApplyResult {
    if (ops.length === 0) {
      return { ok: true, project: this.project, diagnostics: this.getDiagnostics() }
    }

    let next: Project
    let inverse: PatchOp[]
    let changes: { subject: string; description: string }[]
    try {
      changes = summarizePatch(this.project, ops).map((c) => ({ subject: c.subject, description: c.description }))
      inverse = invertPatch(this.project, ops)
      next = applyPatch(this.project, ops)
    } catch (err) {
      return { ok: false, error: (err as Error).message, project: this.project, diagnostics: this.getDiagnostics() }
    }

    // Round-trip through the schema: what we cannot serialize, we do not accept.
    const roundTrip = parseProject(serializeProject(next as Project, this.lastWritten || undefined))
    if (!roundTrip.ok) {
      return {
        ok: false,
        error: `Patch produced an invalid project: ${roundTrip.errors.join('; ')}`,
        project: this.project,
        diagnostics: this.getDiagnostics(),
      }
    }

    this.project = roundTrip.project!
    const entry: HistoryEntry = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      at: Date.now(),
      author,
      label,
      ops,
      inverse,
      changes,
    }

    if (options.record !== false) {
      this.undoStack.push(entry)
      this.redoStack.length = 0
      this.history.push(entry)
      if (this.history.length > 500) this.history.splice(0, this.history.length - 500)
    }

    this.scheduleSave()
    this.broadcastProject(label)
    this.broadcastHistory()
    return { ok: true, entry, project: this.project, diagnostics: this.getDiagnostics() }
  }

  /**
   * Would this patch land? Answers without touching state, so the AI preview
   * can promise a change it can actually make.
   */
  dryRun(ops: PatchOp[]): { ok: boolean; error?: string } {
    try {
      const next = applyPatch(this.project, ops)
      const roundTrip = parseProject(serializeProject(next as Project, this.lastWritten || undefined))
      if (!roundTrip.ok) return { ok: false, error: roundTrip.errors.join('; ') }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  }

  undo(): ApplyResult {
    const entry = this.undoStack.pop()
    if (!entry) return { ok: false, error: 'Nothing to undo', project: this.project, diagnostics: this.getDiagnostics() }
    const result = this.apply(entry.inverse, 'system', `Undo: ${entry.label}`, { record: false })
    if (result.ok) {
      this.redoStack.push(entry)
      this.history.push({ ...entry, id: `${entry.id}-undo`, at: Date.now(), label: `Undo — ${entry.label}`, author: 'system' })
      this.broadcastHistory()
    } else {
      this.undoStack.push(entry)
    }
    return result
  }

  redo(): ApplyResult {
    const entry = this.redoStack.pop()
    if (!entry) return { ok: false, error: 'Nothing to redo', project: this.project, diagnostics: this.getDiagnostics() }
    const result = this.apply(entry.ops, entry.author, entry.label, { record: false })
    if (result.ok) {
      this.undoStack.push(entry)
      this.history.push({ ...entry, id: `${entry.id}-redo`, at: Date.now(), label: `Redo — ${entry.label}` })
      this.broadcastHistory()
    } else {
      this.redoStack.push(entry)
    }
    return result
  }

  /** Replace the whole project — used by the YAML editor and by file reloads. */
  replaceFromYaml(text: string, author: Author, label: string): ApplyResult {
    const parsed = parseProject(text)
    if (!parsed.ok) {
      return { ok: false, error: parsed.errors.join('; '), project: this.project, diagnostics: this.getDiagnostics() }
    }
    return this.apply(this.diffTopLevel(parsed.project!), author, label)
  }

  /**
   * A whole-document swap expressed as per-key operations, because the patch
   * engine deliberately refuses to operate on the document root.
   */
  private diffTopLevel(next: Project): PatchOp[] {
    const ops: PatchOp[] = []
    const current = this.project as Record<string, unknown>
    const incoming = next as unknown as Record<string, unknown>

    for (const key of Object.keys(incoming)) {
      const value = incoming[key]
      if (value === undefined) continue
      if (JSON.stringify(current[key]) === JSON.stringify(value)) continue
      ops.push({ op: key in current ? 'replace' : 'add', path: `/${key}`, value })
    }
    for (const key of Object.keys(current)) {
      if (!(key in incoming) || incoming[key] === undefined) ops.push({ op: 'remove', path: `/${key}` })
    }
    return ops
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private scheduleSave() {
    if (!this.autosave) return
    clearTimeout(this.saveTimer)
    // Coalesce the burst of patches a timeline drag produces (§36).
    this.saveTimer = setTimeout(() => void this.save(), 120)
  }

  /**
   * Write the project to disk. The write is atomic — a temporary file renamed
   * into place — so a reader never sees a half-written project.
   */
  async save({ snapshot = true }: { snapshot?: boolean } = {}): Promise<boolean> {
    clearTimeout(this.saveTimer)
    const text = this.getYaml()
    if (text === this.lastWritten) return false

    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, this.file)
    this.lastWritten = text
    this.savedAt = Date.now()
    this.conflict = null

    if (snapshot) await this.writeSnapshot('save')
    this.broadcastProject('saved')
    return true
  }

  /** Discard unsaved work and take what is on disk. */
  async takeFromDisk(): Promise<ApplyResult> {
    const text = await fs.readFile(this.file, 'utf8')
    this.lastWritten = text
    this.conflict = null
    const result = this.replaceFromYaml(text, 'external', 'Reloaded from disk')
    this.savedAt = Date.now()
    this.broadcastProject('reloaded')
    return result
  }

  /** Point-in-time copies, so any run is recoverable (§85, §86). */
  async snapshot(label = 'auto'): Promise<string> {
    await this.save({ snapshot: false })
    return this.writeSnapshot(label)
  }

  private async writeSnapshot(label: string): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const base = path.basename(this.name, path.extname(this.name))
    const file = path.join(this.workspace.snapshotsDir, `${stamp}-${base}-${label}.yaml`)
    await fs.mkdir(this.workspace.snapshotsDir, { recursive: true })
    await fs.writeFile(file, this.getYaml(), 'utf8')
    await this.pruneSnapshots()
    return file
  }

  private async pruneSnapshots(keep = 50) {
    try {
      const prefix = path.basename(this.name, path.extname(this.name))
      const files = (await fs.readdir(this.workspace.snapshotsDir))
        .filter((f) => f.endsWith('.yaml') && f.includes(`-${prefix}-`))
        .sort()
      for (const stale of files.slice(0, Math.max(0, files.length - keep))) {
        await fs.rm(path.join(this.workspace.snapshotsDir, stale), { force: true })
      }
    } catch {
      /* snapshots are best-effort */
    }
  }

  /**
   * Watch the file so the YAML can be edited in another editor, or by another
   * agent, while the app is open (§76, §78).
   *
   * ⚰️ POLLING IS NOT A PREFERENCE HERE, IT IS THE ONLY THING THAT SURVIVES OUR
   * OWN SAVE. `save()` writes atomically — temp file plus rename — which swaps
   * the inode. chokidar watching a single PATH holds the old inode, so the very
   * first save the app makes leaves the watcher pointing at a file nobody will
   * ever write again. It dies silently: no error, no event, and external edits
   * stop arriving for the rest of the session.
   *
   * Measured 2026-09-10 on reel9: the server had been up since the day before,
   * `dirty: true`, `conflict: null`, and every edit an agent wrote to disk was
   * ignored — while the same file on disk was several versions ahead. The store
   * had picked up an asset added BEFORE the first save and nothing after it.
   *
   * Polling a single small YAML every 300 ms costs nothing and is what makes
   * the promise in the line above actually true.
   */
  watch(): void {
    if (this.watcher) return
    this.watcher = chokidar.watch(this.file, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
      usePolling: true,
      interval: 300,
    })
    this.watcher.on('change', async () => {
      let text: string
      try {
        text = await fs.readFile(this.file, 'utf8')
      } catch {
        return
      }
      if (text === this.lastWritten) return

      const parsed = parseProject(text)
      if (!parsed.ok) {
        this.emit({
          type: 'project',
          project: this.project,
          yaml: this.getYaml(),
          diagnostics: parsed.errors.map((message) => ({ severity: 'error' as const, message })),
          reason: 'external edit rejected',
          dirty: this.isDirty(),
          savedAt: this.savedAt,
        })
        return
      }

      // Unsaved work here and a new version there: two truths. Take neither
      // until the user says which one they mean.
      if (this.isDirty()) {
        this.conflict = text
        this.emit({
          type: 'conflict',
          yaml: text,
          diagnostics: validateProject(parsed.project!),
        })
        return
      }

      this.lastWritten = text
      this.savedAt = Date.now()
      this.replaceFromYaml(text, 'external', 'External edit')
    })
  }

  async close(): Promise<void> {
    await this.watcher?.close()
    if (this.autosave) await this.save({ snapshot: false })
  }
}
