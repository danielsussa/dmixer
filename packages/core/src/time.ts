import type { Project, TimeValue } from './schema.js'
import { round } from './util.js'

/**
 * Semantic time. A clip can say `start: "@tese - 0.2"` and follow the marker when
 * it moves. Resolution is pure and total: an unknown reference yields 0 plus a
 * diagnostic, never a throw. Markers may themselves reference other markers.
 */
export interface TimeContext {
  refs: Record<string, number>
}

// `\w` is ASCII in JavaScript; marker names are written by people, with accents.
const REF = String.raw`[\p{L}\p{N}_.-]+`
const TOKEN = new RegExp(String.raw`(@${REF}|[-+]|\d*\.?\d+)`, 'gu')

export function resolveTime(value: TimeValue | undefined, ctx: TimeContext, fallback = 0, diagnostics?: string[]): number {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  const raw = value.trim()
  if (raw === '') return fallback
  const tokens = raw.match(TOKEN)
  if (!tokens) {
    diagnostics?.push(`Cannot parse time expression: "${raw}"`)
    return fallback
  }
  let total = 0
  let sign = 1
  let sawTerm = false
  for (const tok of tokens) {
    if (tok === '+') { sign = 1; continue }
    if (tok === '-') { sign = -1; continue }
    let term: number
    if (tok.startsWith('@')) {
      const name = tok.slice(1).replace(/\.$/, '')
      if (name in ctx.refs) term = ctx.refs[name]
      else {
        diagnostics?.push(`Unknown time reference "@${name}" in "${raw}"`)
        term = 0
      }
    } else {
      term = Number.parseFloat(tok)
      if (!Number.isFinite(term)) term = 0
    }
    total += sign * term
    sign = 1
    sawTerm = true
  }
  return sawTerm ? round(total) : fallback
}

export function isTimeExpression(value: TimeValue | undefined): value is string {
  return typeof value === 'string' && /@/.test(value)
}

/** Marker times, resolved in order so a marker may lean on an earlier one. */
export function buildTimeContext(project: Project, diagnostics?: string[]): TimeContext {
  const ctx: TimeContext = { refs: { start: 0 } }
  for (const m of project.markers ?? []) ctx.refs[m.id] = resolveTime(m.at, ctx, 0, diagnostics)
  // regions after markers, so a tag can lean on a marker ("@virada")
  for (const r of project.regions ?? []) {
    ctx.refs[r.id] = resolveTime(r.start, ctx, 0, diagnostics)
    ctx.refs[`${r.id}.end`] = resolveTime(r.end, ctx, ctx.refs[r.id], diagnostics)
  }
  return ctx
}
