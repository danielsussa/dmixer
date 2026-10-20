import fs from 'node:fs/promises'
import { evalAnimatable, effectToFfmpeg, fitSize, round, type Animatable, type Project, type ResolvedProject } from '@dmixer/core'
import { captureHtml } from './html.js'
import { run } from './media.js'
import type { Workspace } from './workspace.js'

/**
 * A imagem do mp4: as trilhas de vídeo compostas num filter_complex só, sobre o preto, com a mixagem como som.
 * Regras (as mesmas do visor, web/src/components/Viewer.tsx; trazidas do vidmeo):
 *   - as trilhas mais acima na lista ficam por cima; dentro de uma trilha, a ordem do tempo;
 *   - o clipe é encaixado no quadro (contain) e multiplicado por `transform.scale`; `x/y` são pixels a partir do centro;
 *   - uma camada de ajuste aplica os efeitos dela ao que já está composto (tudo o que está abaixo), só enquanto dura;
 *   - `transition` / `transition_out` são rampas de opacidade nas pontas.
 */
/**
 * ⚠️ Memória: o render é feito em trechos de SEGMENTO s, cada um com só os clipes que caem nele, e cada entrada leva
 *   `-itsoffset` (o lugar dela no tempo). Sem isso o ffmpeg lia TODAS as fotos desde o começo e guardava os quadros
 *   (uma foto com zoom 2× tem ~60 MB por quadro) até a hora de cada uma entrar: em 2026-10-18, um render de 5:25 com
 *   ~130 clipes chegou a 14 GB e derrubou a máquina. Com o offset, o agendador do ffmpeg só lê uma entrada quando o
 *   tempo dela chega. E cada ffmpeg roda com teto (FFMPEG_TETO, via systemd-run), para um erro nunca mais levar a VM.
 */
const SEGMENTO = 20
const FFMPEG_TETO = process.env.DMIXER_FFMPEG_MAX ?? '6G'

export async function composeVideo(r: ResolvedProject, assets: Project['assets'], ws: Workspace, media: Record<string, string>, audio: string, out: string, from: number, dur: number): Promise<void> {
  const fps = r.video.fps
  const base = out.replace(/\.mp4$/i, '')
  const total = Math.round(dur * fps)
  const porTrecho = SEGMENTO * fps
  const partes: string[] = []
  try {
    for (let q = 0; q * porTrecho < total; q++) {
      const quadros = Math.min(porTrecho, total - q * porTrecho)
      const parte = `${base}.parte${String(q).padStart(3, '0')}.mp4`
      await composeSegment(r, assets, ws, media, parte, from + (q * porTrecho) / fps, quadros)
      partes.push(parte)
    }
    const lista = `${base}.partes.txt`
    await fs.writeFile(lista, partes.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'))
    const tmp = `${base}.tmp.mp4`
    await ffmpeg(['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lista, '-i', audio, '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-t', round(dur).toFixed(3), '-movflags', '+faststart', tmp])
    await fs.rename(tmp, out)
    await fs.rm(lista, { force: true })
  } finally {
    await Promise.all(partes.map((f) => fs.rm(f, { force: true })))
  }
}

/** Um trecho da imagem, sem som: `quadros` quadros a partir de `from`. */
async function composeSegment(r: ResolvedProject, assets: Project['assets'], ws: Workspace, media: Record<string, string>, out: string, from: number, quadros: number): Promise<void> {
  const { width: W, height: H, fps } = r.video
  const dur = quadros / fps
  const layers = r.tracks.filter((t) => t.type === 'video' && !t.muted).reverse()
  const clips = layers.flatMap((t) => [...t.clips].sort((a, b) => a.start - b.start)).filter((c) => !c.muted && c.end > from && c.start < from + dur)
  const inputs: string[] = []
  const filters: string[] = [`color=c=black:s=${W}x${H}:r=${fps}:d=${round(dur)},format=rgba[base]`]
  let chain = '[base]'
  let n = 0
  for (const c of clips) {
    // o clipe no tempo do render (que pode começar em `from`): onde entra, quanto da cabeça fica de fora
    const skip = Math.max(0, from - c.start)
    const at = Math.max(0, c.start - from)
    const len = c.duration - skip
    const until = at + len
    const local = `(t-${round(c.start - from)})`
    const kind = c.kind ?? 'video'
    if (kind === 'adjustment') {
      const passos = (c.raw.effects ?? []).flatMap(effectToFfmpeg)
      if (!passos.length) continue
      const janela = `enable='between(t,${round(at)},${round(until)})'`
      filters.push(`${chain}${passos.map((f) => `${f}:${janela}`).join(',')}[j${filters.length}]`)
      chain = `[j${filters.length - 1}]`
      continue
    }
    const steps: string[] = []
    if (kind === 'color') {
      inputs.push('-itsoffset', String(round(at)), '-f', 'lavfi', '-t', String(round(len)), '-i', `color=c=${c.raw.fill || '#000000'}:s=${W}x${H}:r=${fps}`)
      steps.push(`setpts=PTS-STARTPTS+${round(at)}/TB`, 'format=rgba')
    } else {
      const file = ws.resolveMedia(c.src, media)
      if (kind === 'html') {
        const shot = await captureHtml({ file, params: c.raw.params, duration: c.duration, fps, width: W, height: H, cacheDir: ws.cacheDir })
        const first = 1 + Math.round(skip * fps)
        inputs.push('-itsoffset', String(round(at)), '-framerate', String(fps), '-start_number', String(first), '-t', String(round(len)), '-i', shot.pattern)
      } else if (kind === 'image') {
        inputs.push('-itsoffset', String(round(at)), '-loop', '1', '-framerate', String(fps), '-t', String(round(len)), '-i', file)
      } else {
        // webm (motions com transparência): o decodificador nativo do ffmpeg descarta o alfa do VP9; o libvpx mantém
        const alfa = /\.webm$/i.test(file) ? ['-c:v', 'libvpx-vp9'] : []
        inputs.push('-itsoffset', String(round(at)), '-ss', String(round(c.in + skip)), '-t', String(round(len)), ...alfa, '-i', file)
      }
      steps.push(`setpts=PTS-STARTPTS+${round(at)}/TB`, `fps=${fps}`)
      const crop = c.raw.crop
      if (crop && (crop.top || crop.right || crop.bottom || crop.left)) {
        const [l, rr, t, b] = [crop.left ?? 0, crop.right ?? 0, crop.top ?? 0, crop.bottom ?? 0]
        steps.push(`crop=iw*${round(1 - l - rr)}:ih*${round(1 - t - b)}:iw*${round(l)}:ih*${round(t)}`)
      }
      const m = assets[c.asset]?.meta
      // a página é diagramada no tamanho do quadro
      const fit = kind === 'html' ? { w: W, h: H } : fitSize(m?.width ?? W, m?.height ?? H, r.video, crop)
      const fw = Math.round(fit.w)
      const fh = Math.round(fit.h)
      const s = anim(c.raw.transform?.scale, 1, local, fps)
      if (s.animated) {
        // eval=frame: o tamanho muda a cada quadro (o Ken Burns); par, por causa do yuv420p
        steps.push(`scale=w='trunc(${fw}*(${s.expr})/2)*2':h='trunc(${fh}*(${s.expr})/2)*2':eval=frame:flags=bicubic`)
      } else {
        const k = Number(s.expr)
        steps.push(`scale=${Math.max(2, Math.round((fw * k) / 2) * 2)}:${Math.max(2, Math.round((fh * k) / 2) * 2)}:flags=bicubic`)
      }
      const rot = anim(c.raw.transform?.rotation, 0, local, fps)
      if (rot.animated) steps.push(`rotate=a='(${rot.expr})*PI/180':ow=rotw(iw):oh=roth(ih):c=none`)
      else if (Number(rot.expr)) steps.push(`rotate=${round((Number(rot.expr) * Math.PI) / 180, 6)}:ow=rotw(iw):oh=roth(ih):c=none`)
      for (const e of c.raw.effects ?? []) steps.push(...effectToFfmpeg(e))
      steps.push('format=rgba')
    }
    const op = c.raw.opacity
    if (typeof op === 'number' && op < 1) steps.push(`colorchannelmixer=aa=${round(op, 3)}`)
    else if (op && typeof op === 'object') steps.push(`geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip(${anim(op, 1, local, fps).expr},0,1)'`)
    const tin = c.raw.transition
    if (tin && tin.type !== 'cut' && tin.duration > 0 && skip < tin.duration) steps.push(`fade=t=in:st=${round(c.start - from)}:d=${round(tin.duration)}:alpha=1`)
    const tout = c.raw.transition_out
    if (tout && tout.type !== 'cut' && tout.duration > 0) {
      const d = Math.min(round(tout.duration), len)
      steps.push(`fade=t=out:st=${round(until - d)}:d=${d}:alpha=1`)
    }
    filters.push(`[${n}:v]${steps.join(',')}[v${n}]`)
    const x = anim(c.raw.transform?.x, 0, local, fps)
    const y = anim(c.raw.transform?.y, 0, local, fps)
    filters.push(`${chain}[v${n}]overlay=x='(W-w)/2+(${x.expr})':y='(H-h)/2+(${y.expr})':eval=frame:eof_action=pass:shortest=0:enable='between(t,${round(at)},${round(until)})'[c${n}]`)
    chain = `[c${n}]`
    n++
  }
  filters.push(`${chain}format=yuv420p[vout]`)
  // os trechos são emendados sem recodificar: mesmos parâmetros em todos, e cada um abre num quadro-chave
  await ffmpeg(['-v', 'error', '-y', ...inputs, '-filter_complex', filters.join(';'), '-map', '[vout]', '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(fps), '-frames:v', String(quadros), out])
}

let comTeto: boolean | undefined
/** O ffmpeg com teto de memória (systemd-run --scope), quando o systemd do usuário existe; sem ele, o ffmpeg puro. */
async function ffmpeg(args: string[]): Promise<void> {
  process.env.XDG_RUNTIME_DIR ??= `/run/user/${process.getuid?.() ?? 1000}`
  if (comTeto === undefined) comTeto = await run('systemd-run', ['--user', '--scope', '-q', 'true']).then(() => true, () => false)
  if (comTeto) await run('systemd-run', ['--user', '--scope', '-q', '-p', `MemoryMax=${FFMPEG_TETO}`, '-p', 'MemorySwapMax=0', 'ffmpeg', ...args])
  else await run('ffmpeg', args)
}

/**
 * Um valor animado vira uma expressão do ffmpeg no tempo local: uma soma de trechos lineares (o parser do ffmpeg
 * recusa `if()` muito aninhado). Com easing, a curva é amostrada (até 120 pontos) e vira trechos lineares.
 */
function anim(value: Animatable | undefined, fallback: number, local: string, fps: number): { expr: string; animated: boolean } {
  if (value === undefined || value === null) return { expr: String(fallback), animated: false }
  if (typeof value === 'number') return { expr: String(value), animated: false }
  let pts = [...value.keyframes].sort((a, b) => a.at - b.at).map((k) => ({ at: k.at, value: k.value }))
  if (pts.length < 2) return { expr: String(pts[0]?.value ?? fallback), animated: false }
  const eased = value.easing || value.keyframes.some((k) => k.easing)
  if (eased) {
    const a = pts[0].at
    const span = pts[pts.length - 1].at - a
    const m = Math.min(120, Math.max(pts.length, Math.ceil(span * fps)))
    pts = Array.from({ length: m + 1 }, (_, i) => ({ at: a + (i * span) / m, value: evalAnimatable(value, a + (i * span) / m, fallback) }))
  }
  const terms = [`lt(${local},${round(pts[0].at, 4)})*${round(pts[0].value, 4)}`]
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    if (b.at <= a.at) continue
    terms.push(`gte(${local},${round(a.at, 4)})*lt(${local},${round(b.at, 4)})*(${round(a.value, 5)}+(${round(b.value - a.value, 5)})*((${local}-${round(a.at, 4)})/${round(b.at - a.at, 5)}))`)
  }
  const last = pts[pts.length - 1]
  terms.push(`gte(${local},${round(last.at, 4)})*${round(last.value, 4)}`)
  return { expr: `(${terms.join('+')})`, animated: true }
}
