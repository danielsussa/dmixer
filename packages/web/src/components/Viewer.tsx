import { useEffect, useRef } from 'react'
import { formatTime, videoAt } from '@dmixer/core'
import { mediaUrl } from '../api'
import { engine } from '../audio'
import { useEditor } from '../store'

/**
 * The picture at the playhead. A single <video> follows the timeline: it switches to
 * the clip under the playhead, seeks while paused or scrubbing, and plays along while
 * the mix plays (muted — the sound is the mix). Drift beyond a quarter second is
 * corrected by seeking.
 */
export function Viewer() {
  const ref = useRef<HTMLVideoElement>(null)
  const resolved = useEditor((s) => s.resolved)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const clip = resolved ? videoAt(resolved.tracks, playhead) : null

  useEffect(() => {
    const v = ref.current
    if (!v) return
    if (!clip) {
      if (!v.paused) v.pause()
      return
    }
    const src = mediaUrl(clip.src)
    const target = clip.in + (engine.position - clip.start)
    if (v.dataset.src !== src) {
      // a seek before the file's metadata arrives is ignored: aim once it is known
      v.dataset.src = src
      v.src = src
      v.addEventListener('loadedmetadata', () => {
        const c = videoAt(useEditor.getState().resolved?.tracks ?? [], engine.position)
        if (c && mediaUrl(c.src) === v.dataset.src) v.currentTime = c.in + (engine.position - c.start)
        if (useEditor.getState().playing) void v.play().catch(() => {})
      }, { once: true })
      return
    }
    if (v.readyState < 1) return
    if (!playing) {
      if (!v.paused) v.pause()
      if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target
    } else {
      if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target
      if (v.paused) void v.play().catch(() => {})
    }
  }, [clip?.id, clip?.src, clip?.start, clip?.in, playhead, playing])

  if (!resolved) return null
  const { width, height } = resolved.video
  return (
    <div className="border-b border-[var(--line)] bg-black">
      <div className="relative w-full" style={{ aspectRatio: `${width} / ${height}` }}>
        <video ref={ref} className="absolute inset-0 w-full h-full object-contain" muted playsInline preload="auto"
          style={{ visibility: clip ? 'visible' : 'hidden' }} />
        {!clip && <div className="absolute inset-0 grid place-items-center text-[var(--muted)] text-[11px]">sem imagem aqui</div>}
        <div className="absolute bottom-1 right-2 text-[10px] num text-white/70" style={{ textShadow: '0 1px 2px #000' }}>
          {clip ? `${clip.label ?? clip.id} · ${formatTime(clip.in + (playhead - clip.start), 2)}` : ''}
        </div>
      </div>
    </div>
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
