import fs from 'node:fs/promises'
import path from 'node:path'
import express, { type Request, type Response, type NextFunction } from 'express'
import { describeProject, mascaraParaJson, type PatchOp } from '@dmixer/core'
import type { ProjectRegistry } from './registry.js'
import { AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, peaks, thumbnail } from './media.js'
import { mascaraDaFaixa, renderMix } from './render.js'
import { analyze, pieces, pythonProfunda } from './analysis.js'
import { speech } from './speech.js'
import { PAGE_TYPES } from './html.js'
import { acervoAnalysis, acervoSongs, acervoTrecho } from './acervo.js'
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
    const imagem = IMAGE_EXTENSIONS.test(original) || VIDEO_EXTENSIONS.test(original)
    if (!AUDIO_EXTENSIONS.test(original) && !imagem) {
      res.status(400).json({ ok: false, error: 'not an audio, image or video file' })
      return
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      res.status(400).json({ ok: false, error: 'empty file' })
      return
    }
    const pasta = imagem ? 'imagem' : 'audio'
    const dir = path.join(store.workspace.root, pasta)
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
    res.json({ ok: true, src: `${pasta}/${name}` })
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
    if (!AUDIO_EXTENSIONS.test(file)) {
      res.status(400).json({ ok: false, error: 'not an audio file' })
      return
    }
    res.json(await analyze(file, store.workspace.analysisDir))
  }))
  /**
   * The song in pieces for the puzzle rebuild (analyze.py --pecas): the result, or { running: true } while it is made
   * (ask again). `profunda=1` uses the All-In-One grid (minutes the first time). Always says if the deep one is set up.
   */
  app.get('/api/pieces', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    if (!AUDIO_EXTENSIONS.test(file)) {
      res.status(400).json({ ok: false, error: 'not an audio file' })
      return
    }
    const r = await pieces(file, store.workspace.analysisDir, req.query.profunda === '1')
    res.json({ ...(r as object), profunda_disponivel: !!(await pythonProfunda()) })
  }))
  /** A análise do acervo (~/dev/acervo) para um arquivo que veio de lá: peças com função, energia e humor; null se não há. */
  app.get('/api/acervo', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    res.json({ analysis: await acervoAnalysis(file) })
  }))
  /** As músicas do acervo com análise profunda e as peças de cada uma (aba Músicas da Biblioteca). */
  app.get('/api/acervo/musicas', route(async (_req, res) => {
    res.json({ songs: await acervoSongs() })
  }))
  /** Um trecho de uma música do acervo, para ouvir antes de arrastar: ?src=<relativo ao acervo>&ini=&fim= */
  app.get('/api/acervo/trecho', route(async (req, res) => {
    res.sendFile(await acervoTrecho(String(req.query.src ?? ''), Number(req.query.ini ?? 0), Number(req.query.fim ?? 0)))
  }))
  /** Onde há fala num arquivo de voz (para a mixagem automática): { spans: [[início, fim], …] } em segundos do arquivo. */
  app.get('/api/speech', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    if (!AUDIO_EXTENSIONS.test(file)) {
      res.status(400).json({ ok: false, error: 'not an audio file' })
      return
    }
    res.json(await speech(file, store.workspace.analysisDir))
  }))
  /**
   * O texto das falas, para o roteiro: { c, srcs } → { [src]: transcrição | null }. A transcrição é o
   * `<nome>.palavras.json` ao lado do áudio (`s0.voice.mp3` → `s0.palavras.json`); null quando não há.
   */
  app.post('/api/palavras', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const srcs = (Array.isArray(req.body?.srcs) ? req.body.srcs : []).map(String).slice(0, 2000) as string[]
    const out: Record<string, unknown> = {}
    await Promise.all(srcs.map(async (src) => {
      out[src] = null
      if (!AUDIO_EXTENSIONS.test(src)) return
      const file = registry.resolveSrc(store, src)
      const stem = path.basename(file, path.extname(file))
      for (const name of new Set([`${stem.replace(/\.voice$/, '')}.palavras.json`, `${stem}.palavras.json`])) {
        try {
          const j = JSON.parse(await fs.readFile(path.join(path.dirname(file), name), 'utf8'))
          if (Array.isArray(j?.palavras)) {
            out[src] = { palavras: j.palavras, frases: Array.isArray(j.frases) ? j.frases : undefined }
            return
          }
        } catch { /* não há, ou não é json */ }
      }
    }))
    res.json(out)
  }))
  app.get('/api/thumb', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const file = registry.resolveSrc(store, String(req.query.src ?? ''))
    if (!VIDEO_EXTENSIONS.test(file) && !IMAGE_EXTENSIONS.test(file)) {
      res.status(400).json({ error: 'not a video file' })
      return
    }
    res.sendFile(await thumbnail(file, Number(req.query.t ?? 0), store.workspace.thumbsDir), { headers: { 'Cache-Control': 'private, max-age=86400' } })
  }))

  /**
   * Páginas de clipes html, por caminho e não por `?src=`: a página pede o CSS, as fontes e as imagens dela com links
   * relativos, e um link relativo não leva query string. `/api/page/<mix>/<src>`; `_` é a mix padrão.
   */
  app.get(/^\/api\/page\/([^/]+)\/(.+)$/, route(async (req, res) => {
    const c = decodeURIComponent((req.params as any)[0])
    const src = decodeURIComponent((req.params as any)[1])
    const tipo = PAGE_TYPES[path.extname(src).toLowerCase()]
    if (!tipo) {
      res.status(400).json({ error: `"${src}" is not a page file` })
      return
    }
    const store = await registry.get(c === '_' ? undefined : c)
    res.sendFile(registry.resolveSrc(store, src), { headers: { 'content-type': tipo, 'cache-control': 'no-cache' } })
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

  /** A tabela do duck espectral de uma faixa (efeito de índice `fx`), para o preview aplicar no banco de filtros. */
  app.get('/api/espectral', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const m = await mascaraDaFaixa(store.getProject(), store.workspace, String(req.query.track ?? ''), Number(req.query.fx ?? 0))
    res.json(mascaraParaJson(m))
  }))

  const renders = new Map<string, Promise<unknown>>()
  app.post('/api/render', route(async (req, res) => {
    const store = await registry.get(cid(req))
    const base = path.basename(store.name, path.extname(store.name))
    // o mp4 compõe a imagem e é pesado: só pelo script (cli render), num processo próprio, nunca pelo servidor
    if (req.body.format === 'mp4') {
      res.status(400).json({ ok: false, error: 'o mp4 sai pelo script: npm run dmixer -- render <mix> --out x.mp4' })
      return
    }
    const fmt = req.body.format === 'wav' ? 'wav' : 'mp3'
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
