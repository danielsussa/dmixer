import fs from 'node:fs/promises'
import path from 'node:path'
import express, { type Request, type Response, type NextFunction } from 'express'
import { describeProject, type PatchOp } from '@dmixer/core'
import type { ProjectRegistry } from './registry.js'
import { MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, peaks, thumbnail } from './media.js'
import { renderMix } from './render.js'
import { analyze } from './analysis.js'
import { speech } from './speech.js'
import { libraryFile, librariesFor, renderToOrder } from './library.js'

type Handler = (req: Request, res: Response) => Promise<void>
const route = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next)

/** The mix a request is about: ?c=<id> or { c } in the body. */
function cid(req: Request): string | undefined {
  const v = (req.query.c ?? req.body?.c) as string | undefined
  return v || undefined
}

export function createRoutes({ registry }: { registry: ProjectRegistry }) {
  const app = express()
  app.use(express.json({ limit: '32mb' }))

  const state = async (id?: string) => {
    const store = await registry.get(id)
    return {
      c: id,
      file: store.file,
      project: store.getProject(),
      yaml: store.getYaml(),
      diagnostics: store.getDiagnostics(),
      dirty: store.isDirty(),
      savedAt: store.getSavedAt(),
      conflict: store.getConflict(),
      canUndo: store.undoStack.length > 0,
      canRedo: store.redoStack.length > 0,
      history: store.history.slice(-100),
    }
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  // what the browser saw (phones have no console to look at): one JSON line per event in ~/.dmixer/client.log
  app.post('/api/clientlog', route(async (req, res) => {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 200) : []
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 200)
    const lines = events.map((e: unknown) => JSON.stringify({ at: new Date().toISOString(), ua, e })).join('\n')
    if (lines) await fs.appendFile(path.join(process.env.HOME ?? '.', '.dmixer', 'client.log'), lines + '\n')
    res.json({ ok: true })
  }))
  app.get('/api/projects', route(async (_req, res) => { res.json({ projects: registry.list() }) }))
  /** Link a YAML that lives anywhere on this machine; answers with its id (the URL is /c/<id>). */
  app.post('/api/projects', route(async (req, res) => {
    const file = String(req.body.path ?? '').replace(/^~(?=\/|$)/, process.env.HOME ?? '~')
    if (!/\.ya?ml$/i.test(file)) {
      res.status(400).json({ ok: false, error: 'give the path of a .yaml file' })
      return
    }
    const entry = await registry.link(file)
    res.json({ ok: true, ...entry })
  }))
  app.delete('/api/projects/:id', route(async (req, res) => {
    await registry.unlink(String(req.params.id))
    res.json({ ok: true })
  }))
  app.get('/api/state', route(async (req, res) => { res.json(await state(cid(req))) }))

  app.post('/api/patch', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const ops = req.body.ops as PatchOp[]
    const r = store.apply(ops, req.body.author ?? 'user', req.body.label ?? 'Edit')
    // a new file (a piece dropped from a library, say) needs its duration before it can be drawn or played
    if (r.ok && ops.some((o) => 'path' in o && /^\/(assets|media)\b/.test(o.path))) await registry.backfill(store)
    res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.error })
  }))
  app.post('/api/undo', route(async (req, res) => {
    const r = (await registry.get(cid(req))).undo()
    res.json({ ok: r.ok, error: r.error })
  }))
  app.post('/api/redo', route(async (req, res) => {
    const r = (await registry.get(cid(req))).redo()
    res.json({ ok: r.ok, error: r.error })
  }))
  app.post('/api/yaml', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const r = store.replaceFromYaml(String(req.body.yaml ?? ''), 'user', 'YAML edit')
    if (r.ok) await registry.backfill(store)
    res.status(r.ok ? 200 : 400).json({ ok: r.ok, error: r.error })
  }))
  app.post('/api/save', route(async (req, res) => {
    const saved = await (await registry.get(cid(req))).save()
    res.json({ ok: true, saved })
  }))
  app.post('/api/reload', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const r = await store.takeFromDisk()
    await registry.backfill(store)
    res.json({ ok: r.ok, error: r.error })
  }))
  app.get('/api/context', route(async (req, res) => {
    res.type('text/plain').send(describeProject((await registry.get(cid(req))).getProject()))
  }))

  /** Audio files of the project (and of its declared media folders), with Range support. */
  app.get('/api/media', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const src = String(req.query.src ?? '')
    const file = registry.resolveSrc(store, src)
    if (!MEDIA_EXTENSIONS.test(file)) {
      res.status(400).json({ error: 'not an audio or video file' })
      return
    }
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=3600' } })
  }))
  /**
   * An audio file from the user's computer: the body is the file itself, ?name= its name.
   * It is copied into audio/ beside the YAML (never overwriting), and the answer is its src.
   */
  app.post('/api/import', express.raw({ type: '*/*', limit: '1gb' }), route(async (req, res) => {
    const store = await registry.get(cid(req))
    const original = path.basename(String(req.query.name ?? ''))
    if (!MEDIA_EXTENSIONS.test(original) || VIDEO_EXTENSIONS.test(original)) {
      res.status(400).json({ ok: false, error: 'not an audio file' })
      return
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      res.status(400).json({ ok: false, error: 'empty file' })
      return
    }
    const dir = path.join(store.workspace.root, 'audio')
    await fs.mkdir(dir, { recursive: true })
    const ext = path.extname(original)
    const stem = path.basename(original, ext).replace(/[^\p{L}\p{N}._ -]+/gu, '_').trim() || 'audio'
    let name = `${stem}${ext}`
    for (let n = 2; ; n++) {
      try {
        await fs.writeFile(path.join(dir, name), req.body, { flag: 'wx' })
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        name = `${stem}-${n}${ext}`
      }
    }
    res.json({ ok: true, src: `audio/${name}` })
  }))
  app.get('/api/peaks', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    res.json(await peaks(file, store.workspace.peaksDir))
  }))

  /** Beat grid and cut points of an audio file (computed once, then cached). */
  app.get('/api/analysis', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    if (!MEDIA_EXTENSIONS.test(file) || VIDEO_EXTENSIONS.test(file)) {
      res.status(400).json({ ok: false, error: 'not an audio file' })
      return
    }
    res.json(await analyze(file, store.workspace.analysisDir))
  }))
  /** Onde há fala num arquivo de voz (para a mixagem automática): { spans: [[início, fim], …] } em segundos do arquivo. */
  app.get('/api/speech', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    if (!MEDIA_EXTENSIONS.test(file) || VIDEO_EXTENSIONS.test(file)) {
      res.status(400).json({ ok: false, error: 'not an audio file' })
      return
    }
    res.json(await speech(file, store.workspace.analysisDir))
  }))
  app.get('/api/thumb', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    if (!VIDEO_EXTENSIONS.test(file)) {
      res.status(400).json({ error: 'not a video file' })
      return
    }
    res.sendFile(await thumbnail(file, Number(req.query.t ?? 0), store.workspace.thumbsDir), { headers: { 'Cache-Control': 'private, max-age=86400' } })
  }))

  app.get('/api/libraries', route(async (req, res) => {
    const store = await registry.get(cid(req))
    res.json({ libraries: await librariesFor(store.workspace.root, store.getProject().media ?? {}) })
  }))
  /** A piece made to order: { c, lib, recipe, chords: [...], intensity } → the new library item. */
  app.post('/api/libraries/render', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const libs = await librariesFor(store.workspace.root, store.getProject().media ?? {})
    const lib = libs.find((l) => l.alias === req.body.lib)
    if (!lib) {
      res.status(404).json({ ok: false, error: 'no such library' })
      return
    }
    const item = await renderToOrder(lib, String(req.body.recipe), (req.body.chords ?? []).map(String), Number(req.body.intensity ?? 3))
    res.json({ ok: true, item, lib: { alias: lib.alias, root: lib.root, declared: lib.declared } })
  }))

  /** A piece's audio, for the preview button — works before the mix declares the library. */
  app.get('/api/libraries/audio', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const libs = await librariesFor(store.workspace.root, store.getProject().media ?? {})
    const lib = libs.find((l) => l.alias === req.query.lib)
    if (!lib) {
      res.status(404).json({ error: 'no such library' })
      return
    }
    const file = libraryFile(lib, String(req.query.src ?? ''))
    if (!MEDIA_EXTENSIONS.test(file)) {
      res.status(400).json({ error: 'not an audio file' })
      return
    }
    res.sendFile(file, { headers: { 'Cache-Control': 'private, max-age=86400' } })
  }))

  const renders = new Map<string, Promise<unknown>>()
  app.post('/api/render', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const base = path.basename(store.name, path.extname(store.name))
    const fmt = req.body.format === 'wav' ? 'wav' : req.body.format === 'mp4' ? 'mp4' : 'mp3'
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const out = path.join(store.workspace.rendersDir, `${base}-${stamp}.${fmt}`)
    const id = `${base}-${stamp}`
    const c = cid(req)!
    const job = renderMix(store.getProject(), store.workspace, {
      out,
      from: req.body.from,
      to: req.body.to,
      onProgress: (progress, stage) => registry.emit({ type: 'render', c, id, progress, stage }),
    })
      .then((r) => registry.emit({ type: 'render', c, id, progress: 1, stage: 'done', done: true, file: path.basename(r.out) }))
      .catch((e: Error) => registry.emit({ type: 'render', c, id, progress: 1, stage: 'error', done: true, error: e.message }))
      .finally(() => renders.delete(id))
    renders.set(id, job)
    res.json({ ok: true, id, file: path.basename(out) })
  }))
  app.get('/api/renders', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const files = await fs.readdir(store.workspace.rendersDir).catch(() => [] as string[])
    res.json({ renders: files.filter((f) => MEDIA_EXTENSIONS.test(f) && !f.includes('.tmp.')).sort().reverse() })
  }))
  app.get('/api/renders/:name', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const name = path.basename(String(req.params.name))
    res.sendFile(path.join(store.workspace.rendersDir, name))
  }))

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(/^No mix|Which mix|is gone/.test(err.message) ? 404 : 500).json({ ok: false, error: err.message })
  })
  return app
}
