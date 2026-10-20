import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  evalAnimatable, fitSize, formatTime, gradeOf, gradeToSvg, grainToCss, HTML_SEEK_SOURCE, htmlQuery, transitionGain,
  type ResolvedClip, type ResolvedProject, type SvgGrade, type VisualEffect,
} from '@dmixer/core'
import { mediaUrl, pageUrl } from '../api'
import { engine } from '../audio'
import { useEditor } from '../store'
import { cx, Icon } from './ui'

/**
 * O quadro do playhead, composto como o render compõe (server/src/video.ts): as trilhas de vídeo mais acima por
 * cima; cada clipe encaixado no quadro e multiplicado por `scale`, `x/y` em pixels a partir do centro; uma camada de
 * ajuste aplica os efeitos dela a tudo o que está abaixo. O palco tem o tamanho do projeto (1920×1080) e é escalado
 * para caber; os clipes que entram no próximo segundo já ficam montados (escondidos), para a foto e o vídeo estarem
 * carregados no corte.
 */
export function Viewer() {
  const resolved = useEditor((s) => s.resolved)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const [grande, setGrande] = useState(false)
  const projectName = useEditor((s) => s.projectName)
  // o mp4 que o script renderizou (renders/): o visor pode tocá-lo no lugar da composição ao vivo
  const [renders, setRenders] = useState<string[]>([])
  const [pronto, setPronto] = useState<string | null>(null)
  useEffect(() => {
    if (!projectName) return
    void fetch(`/api/renders?c=${projectName}`).then((r) => r.json())
      .then((j) => setRenders((j.renders ?? []).filter((f: string) => /\.mp4$/i.test(f)))).catch(() => {})
  }, [projectName, pronto])
  const box = useRef<HTMLDivElement>(null)
  // tela cheia: a do navegador quando dá; senão (iPhone não deixa uma div ir para tela cheia) a mesma moldura fixa por cima de tudo
  const moldura = useRef<HTMLDivElement>(null)
  const [cheia, setCheia] = useState(false)
  const alternarCheia = () => {
    if (cheia) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
      setCheia(false)
      return
    }
    setCheia(true)
    void moldura.current?.requestFullscreen?.().catch(() => {})
  }
  useEffect(() => {
    if (!cheia) return
    const sair = () => { if (!document.fullscreenElement) setCheia(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setCheia(false) }
    document.addEventListener('fullscreenchange', sair)
    window.addEventListener('keydown', esc)
    return () => { document.removeEventListener('fullscreenchange', sair); window.removeEventListener('keydown', esc) }
  }, [cheia])
  const [k, setK] = useState(0.2)
  useLayoutEffect(() => {
    const el = box.current
    if (!el || !resolved) return
    const ro = new ResizeObserver(() => setK(el.clientWidth / resolved.video.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [resolved?.video.width, grande, cheia])
  if (!resolved) return null
  const { width, height } = resolved.video
  const t = playhead
  const ativos = stack(resolved, t)
  const titulo = ativos.filter((c) => c.start <= t && t < c.end && c.kind !== 'adjustment').map((c) => c.label ?? c.id).join(' · ')
  const tela = (
    <div ref={moldura} className={cx(cheia && 'fixed inset-0 z-[60] bg-black grid place-items-center')}>
    <div ref={box} className="relative w-full overflow-hidden bg-black"
      style={{ aspectRatio: `${width} / ${height}`, width: cheia ? `min(100vw, calc(100vh * ${width / height}))` : undefined }}
      onClick={cheia ? (e) => { if (!(e.target as HTMLElement).closest('button, select')) void (playing ? engine.stop() : engine.play()) } : undefined}>
      {pronto
        ? <Pronto src={`/api/renders/${encodeURIComponent(pronto)}?c=${projectName}`} t={t} playing={playing} />
        : <div className="absolute left-0 top-0 origin-top-left" style={{ width, height, transform: `scale(${k})` }}>
            <Pilha clips={ativos} t={t} playing={playing} r={resolved} />
          </div>}
      {!pronto && !ativos.some((c) => c.start <= t && t < c.end) && <div className="absolute inset-0 grid place-items-center text-[var(--muted)] text-[11px]">sem imagem aqui</div>}
      {renders.length > 0 && (
        <select className="absolute top-1 right-1 text-[10px] bg-black/60 text-white/80 rounded px-1 py-0.5 outline-none" value={pronto ?? ''}
          title="ao vivo: a composição da edição de agora · um mp4: o render pronto, tocado junto com a mix"
          onChange={(e) => setPronto(e.target.value || null)}>
          <option value="">ao vivo</option>
          {renders.map((f) => <option key={f} value={f}>render · {f}</option>)}
        </select>
      )}
      <div className={cx('absolute left-2 truncate num text-white/70', cheia ? 'bottom-3 right-14 text-[13px]' : 'bottom-1 right-14 text-[10px]')} style={{ textShadow: '0 1px 2px #000' }}>
        {formatTime(t, 2)}{titulo ? ` · ${titulo}` : ''}
      </div>
      <div className={cx('absolute flex items-center gap-1.5 text-white/70', cheia ? 'bottom-2.5 right-3' : 'bottom-0.5 right-1.5')} style={{ filter: 'drop-shadow(0 1px 2px #000)' }}>
        {!cheia && <button className="hover:text-white text-[13px] leading-none" title={grande ? 'diminuir' : 'ampliar o visor'}
          onClick={() => setGrande((g) => !g)}>{grande ? '⤡' : '⤢'}</button>}
        <button className="hover:text-white p-0.5" title={cheia ? 'sair da tela cheia (Esc)' : 'tela cheia (clique no vídeo toca / pausa)'} onClick={alternarCheia}>
          {cheia ? <Icon.ExitFullscreen size={18} /> : <Icon.Fullscreen size={12} />}
        </button>
      </div>
    </div>
    </div>
  )
  if (!grande) return <div className="border-b border-[var(--line)] bg-black">{tela}</div>
  return (
    <>
      <div className="border-b border-[var(--line)] bg-black grid place-items-center text-[11px] text-[var(--muted)] py-3">visor ampliado</div>
      <div className="fixed z-40 right-[25rem] top-24 shadow-2xl ring-1 ring-white/10 rounded-md overflow-hidden" style={{ width: 'min(62vw, 1100px)' }}>{tela}</div>
    </>
  )
}

/**
 * O render pronto, preso ao relógio da mix como um vídeo de clipe (o mp4 começa no 0 da timeline). Mudo: o som é o da
 * mix. ⚠️ Mostra o que foi renderizado, não a edição de agora.
 */
function Pronto({ src, t, playing }: { src: string; t: number; playing: boolean }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v || v.readyState < 1) return
    const alvo = engine.position
    if (!playing) {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - alvo) > 0.04) v.currentTime = alvo
    } else {
      if (Math.abs(v.currentTime - alvo) > 0.25) v.currentTime = alvo
      if (v.paused) void v.play().catch(() => {})
    }
  }, [t, playing])
  return <video ref={ref} src={src} className="absolute inset-0 w-full h-full object-contain" muted playsInline preload="auto"
    onLoadedMetadata={(e) => { e.currentTarget.currentTime = engine.position }} />
}

/** Os clipes visíveis em t (e os que entram no próximo segundo), de baixo para cima. */
function stack(r: ResolvedProject, t: number): ResolvedClip[] {
  const out: ResolvedClip[] = []
  for (const tr of [...r.tracks].reverse()) {
    if (tr.type !== 'video' || tr.muted) continue
    for (const c of tr.clips) if (!c.muted && c.end > t && c.start < t + 1) out.push(c)
  }
  return out
}

/** Monta a pilha: uma camada de ajuste embrulha tudo o que veio antes dela (o que está abaixo). */
function Pilha({ clips, t, playing, r }: { clips: ResolvedClip[]; t: number; playing: boolean; r: ResolvedProject }) {
  let acumulado: React.ReactNode[] = []
  for (const c of clips) {
    const agora = c.start <= t && t < c.end
    if (c.kind === 'adjustment') {
      if (agora) acumulado = [<Ajuste key={c.id} clip={c} t={t} playing={playing}>{acumulado}</Ajuste>]
      continue
    }
    acumulado.push(<Camada key={c.id} clip={c} t={t} playing={playing} r={r} visivel={agora} />)
  }
  return <>{acumulado}</>
}

const fill: React.CSSProperties = { position: 'absolute', inset: 0 }

function Camada({ clip: c, t, playing, r, visivel }: { clip: ResolvedClip; t: number; playing: boolean; r: ResolvedProject; visivel: boolean }) {
  const project = useEditor((s) => s.project)
  const local = Math.max(0, t - c.start)
  const raw = c.raw
  const opacity = evalAnimatable(raw.opacity, local, 1) * transitionGain(raw.transition, raw.transition_out, local, c.duration)
  const style: React.CSSProperties = { visibility: visivel ? 'visible' : 'hidden' }
  if (c.kind === 'color') return <div style={{ ...fill, ...style, background: raw.fill || '#000', opacity }} />
  const { width: W, height: H } = r.video
  const meta = project?.assets[c.asset]?.meta
  const fit = c.kind === 'html' ? { w: W, h: H } : fitSize(meta?.width ?? W, meta?.height ?? H, r.video, raw.crop)
  const scale = evalAnimatable(raw.transform?.scale, local, 1)
  const x = evalAnimatable(raw.transform?.x, local, 0)
  const y = evalAnimatable(raw.transform?.y, local, 0)
  const rot = evalAnimatable(raw.transform?.rotation, local, 0)
  const bw = fit.w * scale
  const bh = fit.h * scale
  const cr = { l: raw.crop?.left ?? 0, r: raw.crop?.right ?? 0, t: raw.crop?.top ?? 0, b: raw.crop?.bottom ?? 0 }
  const iw = bw / Math.max(0.001, 1 - cr.l - cr.r)
  const ih = bh / Math.max(0.001, 1 - cr.t - cr.b)
  const media: React.CSSProperties = { position: 'absolute', width: iw, height: ih, left: -cr.l * iw, top: -cr.t * ih, maxWidth: 'none' }
  const efeitos = filtroDe(c.id, raw.effects, playing, t)
  return (
    <div style={{ ...style, position: 'absolute', left: (W - bw) / 2, top: (H - bh) / 2, width: bw, height: bh, overflow: 'hidden', opacity,
      transform: `translate(${x}px, ${y}px) rotate(${rot}deg)`, filter: efeitos.filter }}>
      {efeitos.defs}
      {c.kind === 'image' ? <img src={mediaUrl(c.src)} style={media} draggable={false} alt="" decoding="async" />
        : c.kind === 'html' ? <Pagina clip={c} local={local} style={media} W={W} H={H} />
        : <Video clip={c} local={local} playing={playing && visivel} style={media} />}
    </div>
  )
}

/** Um vídeo preso ao relógio da mix: busca quando parado, toca junto quando toca, corrige deriva acima de 0,25 s. */
function Video({ clip: c, local, playing, style }: { clip: ResolvedClip; local: number; playing: boolean; style: React.CSSProperties }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const v = ref.current
    if (!v || v.readyState < 1) return
    const alvo = c.in + Math.max(0, engine.position - c.start)
    if (!playing) {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - alvo) > 0.04) v.currentTime = alvo
    } else {
      if (Math.abs(v.currentTime - alvo) > 0.25) v.currentTime = alvo
      if (v.paused) void v.play().catch(() => {})
    }
  }, [local, playing, c.in, c.start])
  return <video ref={ref} src={mediaUrl(c.src)} style={{ ...style, objectFit: 'fill' }} muted playsInline preload="auto"
    onLoadedMetadata={(e) => { e.currentTarget.currentTime = c.in + Math.max(0, engine.position - c.start) }} />
}

/** Uma página html num iframe, com as animações dela postas no tempo local do clipe (o mesmo seek do render). */
function Pagina({ clip: c, local, style, W, H }: { clip: ResolvedClip; local: number; style: React.CSSProperties; W: number; H: number }) {
  const ref = useRef<HTMLIFrameElement>(null)
  const [pronta, setPronta] = useState(false)
  const src = pageUrl(c.src, htmlQuery(c.raw.params, c.duration))
  useEffect(() => {
    const win = ref.current?.contentWindow as any
    if (!pronta || !win) return
    try {
      if (!win.__vidmeoSeek) win.eval(HTML_SEEK_SOURCE)
      win.__vidmeoSeek(local, c.duration)
    } catch {
      /* ainda carregando: o próximo quadro tenta de novo */
    }
  }, [pronta, local, c.duration, src])
  return (
    <iframe key={src} ref={ref} src={src} title={c.id} onLoad={() => setPronta(true)}
      style={{ position: 'absolute', left: style.left, top: style.top, width: W, height: H, border: 0, background: 'transparent',
        colorScheme: 'normal', pointerEvents: 'none', transform: `scale(${(Number(style.width) || W) / W})`, transformOrigin: '0 0' }} />
  )
}

/** A camada de ajuste: os efeitos dela por cima do que já foi composto. */
function Ajuste({ clip, t, playing, children }: { clip: ResolvedClip; t: number; playing: boolean; children: React.ReactNode }) {
  const efeitos = filtroDe(clip.id, clip.raw.effects, playing, t)
  return <div style={{ ...fill, filter: efeitos.filter }}>{efeitos.defs}{children}</div>
}

/**
 * Os efeitos como filtro do navegador: os simples em CSS, a correção de cor num filtro SVG com as MESMAS contas do
 * ffmpeg (visual.ts), e o grão como ruído somado. O grão só aparece parado: a turbulência numa tela inteira a cada
 * quadro pesa demais para tocar junto.
 */
function filtroDe(id: string, effects: VisualEffect[] | undefined, playing: boolean, t: number): { filter?: string; defs?: React.ReactNode } {
  if (!effects?.length) return {}
  const css: string[] = []
  let grade: SvgGrade | null = null
  let grao: VisualEffect | undefined
  for (const e of effects) {
    if (e.type === 'blur') css.push(`blur(${e.amount ?? 4}px)`)
    else if (e.type === 'brightness') css.push(`brightness(${1 + (e.value ?? 0)})`)
    else if (e.type === 'contrast') css.push(`contrast(${e.value ?? 1})`)
    else if (e.type === 'saturate') css.push(`saturate(${e.value ?? 1})`)
    else if (e.type === 'grayscale') css.push('grayscale(1)')
    else if (e.type === 'color') {
      const g = gradeToSvg(gradeOf(e))
      if (g.matrix || g.curve) grade = g
    } else if (e.type === 'grain' && !playing) grao = e
  }
  const gid = `grade-${id}`
  const nid = `grao-${id}`
  if (grade) css.push(`url(#${gid})`)
  if (grao) css.push(`url(#${nid})`)
  const g = grade as SvgGrade | null
  const ruido = grao ? grainToCss(grao) : null
  const defs = (g || ruido) && (
    <svg width={0} height={0} style={{ position: 'absolute' }} aria-hidden>
      {g && (
        <filter id={gid} colorInterpolationFilters="sRGB">
          {g.curve && (<>
            <feComponentTransfer>
              <feFuncR type="linear" slope={g.curve.slope} intercept={g.curve.intercept} />
              <feFuncG type="linear" slope={g.curve.slope} intercept={g.curve.intercept} />
              <feFuncB type="linear" slope={g.curve.slope} intercept={g.curve.intercept} />
            </feComponentTransfer>
            <feComponentTransfer>
              <feFuncR type="gamma" exponent={g.curve.gamma} />
              <feFuncG type="gamma" exponent={g.curve.gamma} />
              <feFuncB type="gamma" exponent={g.curve.gamma} />
            </feComponentTransfer>
          </>)}
          {g.matrix && <feColorMatrix type="matrix" values={g.matrix.join(' ')} />}
        </filter>
      )}
      {ruido && (
        <filter id={nid} colorInterpolationFilters="sRGB" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency={ruido.frequency} numOctaves={1} seed={Math.floor(t * 24) % 8} result="ruido" />
          <feColorMatrix in="ruido" type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 1" result="cinza" />
          <feComposite in="SourceGraphic" in2="cinza" operator="arithmetic" k1={0} k2={1} k3={ruido.strength} k4={-ruido.strength / 2} />
        </filter>
      )}
    </svg>
  )
  return { filter: css.length ? css.join(' ') : undefined, defs }
}

/** O corpo de um clipe de vídeo na timeline: quadros de um vídeo, a foto, ou o nome do título / cartão. */
export function VideoBody({ clip: c, from, to, width, height }: { clip: ResolvedClip; from: number; to: number; width: number; height: number }) {
  if (c.kind === 'image') return <div className="absolute inset-0 pointer-events-none" style={{ backgroundImage: `url(${mediaUrl(c.src)})`, backgroundSize: 'auto 100%', backgroundRepeat: 'repeat-x', opacity: 0.85 }} />
  if (c.kind === 'video' || !c.kind) return <Thumbs src={c.src} from={from} to={to} width={width} height={height} />
  const texto = c.kind === 'color' ? `cartão ${c.raw.fill ?? '#000000'}`
    : c.kind === 'adjustment' ? (c.raw.effects ?? []).map((e) => e.type).join(' + ')
    : Object.values(c.raw.params ?? {}).filter((v) => typeof v === 'string').join(' · ') || c.src.split('/').pop()
  return (
    <div className="absolute inset-0 px-1.5 py-0.5 text-[10px] leading-tight text-white/75 overflow-hidden pointer-events-none"
      style={{ background: c.kind === 'color' ? c.raw.fill ?? '#000' : undefined }}>{texto}</div>
  )
}

/** Frames of a video clip along its length, for the timeline. */
export function Thumbs({ src, from, to, width, height }: { src: string; from: number; to: number; width: number; height: number }) {
  const c = useEditor((s) => s.projectName)
  const tw = Math.round((height * 16) / 9)
  const n = Math.max(1, Math.min(80, Math.floor(width / tw)))
  const step = width / n
  return (
    <div className="absolute inset-0 flex overflow-hidden pointer-events-none">
      {Array.from({ length: n }, (_, i) => {
        const t = from + ((i * step + step / 2) / width) * (to - from)
        return (
          <img key={i} loading="lazy" draggable={false} alt=""
            src={`/api/thumb?c=${c}&src=${encodeURIComponent(src)}&t=${(Math.round(t * 2) / 2).toFixed(1)}`}
            style={{ width: step, height, objectFit: 'cover', opacity: 0.85, borderRight: '1px solid #0006' }} />
        )
      })}
    </div>
  )
}
