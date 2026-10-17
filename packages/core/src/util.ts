/** Times are stored at millisecond precision: readable in YAML, stable in diffs. */
export function round(value: number, decimals = 3): number {
  const f = 10 ** decimals
  return Math.round(value * f) / f
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function dbToGain(db: number): number {
  return db <= -120 ? 0 : 10 ** (db / 20)
}

export function gainToDb(g: number): number {
  return g <= 0 ? -120 : 20 * Math.log10(g)
}

export function formatTime(seconds: number, decimals = 1): string {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const rest = s - m * 60
  return `${m}:${rest.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0')}`
}
