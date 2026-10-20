import fs from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { HTML_SEEK_SOURCE, htmlQuery } from '@dmixer/core'

/**
 * Clipes html (títulos animados): o Chrome headless desenha a página quadro a quadro, com fundo transparente, e os
 * quadros entram no ffmpeg como uma sequência de PNG. O contrato de tempo é o do vidmeo (core/src/visual.ts).
 * Cache por conteúdo: a pasta dos quadros leva o hash da página, das irmãs dela (css, fontes, imagens), dos params, do
 * tamanho, do fps e da duração. A página é servida por HTTP, não file://, para as fontes e o CSS ao lado carregarem.
 */

export const PAGE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
}

export interface HtmlCaptureOptions {
  file: string
  params?: Record<string, string | number | boolean>
  duration: number
  fps: number
  width: number
  height: number
  cacheDir: string
}

async function fingerprint(o: HtmlCaptureOptions): Promise<string> {
  const h = crypto.createHash('sha1')
  h.update('v1')
  h.update(JSON.stringify([o.params ?? {}, o.duration, o.fps, o.width, o.height]))
  h.update(await fs.readFile(o.file))
  const dir = path.dirname(o.file)
  for (const name of (await fs.readdir(dir)).sort()) {
    const st = await fs.stat(path.join(dir, name)).catch(() => null)
    if (st?.isFile()) h.update(`${name}:${st.size}:${st.mtimeMs}`)
  }
  return h.digest('hex').slice(0, 16)
}

async function serve(root: string): Promise<{ port: number; close: () => void }> {
  const srv = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname))
    if (!file.startsWith(root) || !existsSync(file)) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': PAGE_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' })
    createReadStream(file).on('error', () => res.end()).pipe(res)
  })
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok))
  return { port: (srv.address() as { port: number }).port, close: () => srv.close() }
}

/** Chrome: DMIXER_CHROME, o do playwright, ou o do sistema. */
async function launch() {
  const { chromium } = await import('playwright-core')
  let last: unknown
  for (const executablePath of [process.env.DMIXER_CHROME, undefined, '/usr/bin/google-chrome', '/usr/bin/chromium']) {
    if (executablePath === '' || (executablePath && !existsSync(executablePath))) continue
    try {
      return await chromium.launch(executablePath ? { executablePath } : {})
    } catch (err) {
      last = err
    }
  }
  throw new Error(`No Chrome for html clips (set DMIXER_CHROME): ${(last as Error)?.message ?? ''}`)
}

/** Os quadros da página (`…/f%05d.png`, a partir de 1), capturados ou do cache. */
export async function captureHtml(o: HtmlCaptureOptions): Promise<{ pattern: string; frames: number; cached: boolean }> {
  const total = Math.max(1, Math.round(o.duration * o.fps))
  const dir = path.join(o.cacheDir, 'html', await fingerprint(o))
  const pattern = path.join(dir, 'f%05d.png')
  if (existsSync(path.join(dir, 'pronto'))) return { pattern, frames: total, cached: true }
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  const { port, close } = await serve(path.dirname(o.file))
  const browser = await launch()
  try {
    const page = await browser.newPage({ viewport: { width: o.width, height: o.height } })
    const erros: string[] = []
    page.on('pageerror', (e) => erros.push(e.message))
    await page.addInitScript(HTML_SEEK_SOURCE)
    await page.goto(`http://127.0.0.1:${port}/${encodeURIComponent(path.basename(o.file))}?${htmlQuery(o.params, o.duration)}`)
    await page.evaluate('document.fonts.ready.then(() => true)')
    for (let i = 0; i < total; i++) {
      await page.evaluate(`window.__vidmeoSeek(${i / o.fps}, ${o.duration})`)
      await page.screenshot({ path: path.join(dir, `f${String(i + 1).padStart(5, '0')}.png`), omitBackground: true })
    }
    if (erros.length) throw new Error(`html clip ${path.basename(o.file)}: ${erros[0]}`)
    await fs.writeFile(path.join(dir, 'pronto'), '')
  } finally {
    await browser.close()
    close()
  }
  return { pattern, frames: total, cached: false }
}
