import http from 'node:http'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { WebSocketServer, type WebSocket } from 'ws'
import { ProjectRegistry } from './registry.js'
import { createRoutes } from './routes.js'
import { checkTools } from './media.js'

export interface ServerHandle {
  url: string
  port: number
  registry: ProjectRegistry
  close: () => Promise<void>
}

/** A relative folder is read against where the user typed the command (npm workspaces move cwd). */
export function projectRoot(arg?: string): string {
  const base = process.env.INIT_CWD ?? process.cwd()
  return path.resolve(base, arg ?? '.')
}

/** The API owns the filesystem and has no authentication: loopback unless DMIXER_HOST says otherwise. */
export const DEFAULT_HOST = process.env.DMIXER_HOST ?? '127.0.0.1'

/** The address people open; set DMIXER_PUBLIC_URL to the tailnet name to have `link` print that. */
export const PUBLIC_URL = process.env.DMIXER_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 5184}`

/** One server for every linked mix; `link` folders/files to add them (URL /c/<id>). */
export async function startServer(link: string[] = [], port = Number(process.env.PORT ?? 5184), host = DEFAULT_HOST): Promise<ServerHandle> {
  const registry = new ProjectRegistry()
  await registry.init()
  for (const target of link) {
    const st = fs.statSync(target)
    const entries = st.isDirectory() ? await registry.linkFolder(target) : [await registry.link(target)]
    for (const e of entries) console.log(`linked  ${PUBLIC_URL}/c/${e.id}  ${e.path}`)
  }
  const app = createRoutes({ registry })

  // With a built UI, one port serves everything (`dmixer open`); in dev, Vite proxies to us.
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  if (fs.existsSync(path.join(dist, 'index.html'))) {
    const outer = express()
    outer.use(app)
    outer.use(express.static(dist))
    outer.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')))
    return listen(outer, registry, port, host)
  }
  return listen(app, registry, port, host)
}

async function listen(app: express.Express, registry: ProjectRegistry, port: number, host: string): Promise<ServerHandle> {
  const clients = new Set<WebSocket>()
  const server = http.createServer(app)
  const wss = new WebSocketServer({ server, path: '/ws' })
  const stopIndex = registry.watchIndex()
  const unsubscribe = registry.subscribe((event) => {
    const text = JSON.stringify(event)
    for (const c of clients) if (c.readyState === 1) c.send(text)
  })
  wss.on('connection', (socket) => {
    clients.add(socket)
    socket.send(JSON.stringify({ type: 'projects', projects: registry.list() }))
    socket.on('close', () => clients.delete(socket))
    socket.on('error', () => clients.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  return {
    url: `http://localhost:${port}`,
    port,
    registry,
    async close() {
      stopIndex()
      unsubscribe()
      for (const c of clients) c.terminate()
      wss.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await registry.close()
    },
  }
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))
if (isMain) {
  const handle = await startServer(process.argv.slice(2).map((a) => projectRoot(a)))
  const tools = await checkTools()
  console.log(`dmixer server  ${handle.url}  (public: ${PUBLIC_URL})`)
  console.log(`mixes          ${handle.registry.list().length} linked — see ${PUBLIC_URL}/`)
  if (!tools.ffmpeg || !tools.ffprobe) console.warn('warning: ffmpeg/ffprobe not found — peaks and render will not work')
  const shutdown = async () => {
    await handle.close()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
