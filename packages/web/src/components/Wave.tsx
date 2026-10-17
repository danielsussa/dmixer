import { useEffect, useRef, useState } from 'react'
import { loadPeaks } from '../api'
import { useEditor } from '../store'

const TILE = 4000

/**
 * The waveform of a clip's slice of its file. Long clips are drawn in tiles, because
 * a canvas wider than ~32k px silently draws nothing.
 */
export function Wave({ src, from, to, width, height, gain, color }: {
  src: string; from: number; to: number; width: number; height: number; gain: number; color: string
}) {
  const [peaks, setPeaks] = useState<{ rate: number; data: number[] } | null>(null)
  const hash = useEditor((s) => Object.values(s.project?.assets ?? {}).find((a) => a.src === src)?.meta?.hash)
  useEffect(() => {
    let alive = true
    if (src) void loadPeaks(src).then((p) => alive && setPeaks(p)).catch(() => {})
    return () => { alive = false }
  }, [src, hash])
  const tiles = Math.max(1, Math.ceil(width / TILE))
  return (
    <>
      {Array.from({ length: tiles }, (_, i) => (
        <Tile key={i} peaks={peaks} x0={i * TILE} w={Math.min(TILE, width - i * TILE)} width={width} height={height}
          from={from} to={to} gain={gain} color={color} />
      ))}
    </>
  )
}

function Tile({ peaks, x0, w, width, height, from, to, gain, color }: {
  peaks: { rate: number; data: number[] } | null; x0: number; w: number; width: number; height: number
  from: number; to: number; gain: number; color: string
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    if (!c || !peaks || w <= 0) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.ceil(w * dpr)
    c.height = Math.ceil(height * dpr)
    const g = c.getContext('2d')!
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, height)
    g.fillStyle = color
    const mid = height / 2
    const span = to - from
    const n = peaks.data.length / 2
    for (let x = 0; x < w; x++) {
      const t0 = from + ((x0 + x) / width) * span
      const t1 = from + ((x0 + x + 1) / width) * span
      let i0 = Math.floor(t0 * peaks.rate)
      const i1 = Math.max(i0 + 1, Math.ceil(t1 * peaks.rate))
      let lo = 0
      let hi = 0
      for (; i0 < i1 && i0 < n; i0++) {
        lo = Math.min(lo, peaks.data[2 * i0])
        hi = Math.max(hi, peaks.data[2 * i0 + 1])
      }
      const y1 = mid - Math.min(1, hi * gain) * mid
      const y2 = mid - Math.max(-1, lo * gain) * mid
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1))
    }
  }, [peaks, x0, w, width, height, from, to, gain, color])
  return <canvas ref={ref} style={{ position: 'absolute', left: x0, top: 0, width: w, height }} />
}
