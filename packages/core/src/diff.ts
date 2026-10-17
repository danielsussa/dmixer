import type { PatchOp } from './patch.js'
import type { Project } from './schema.js'

/** One line per operation, for the history panel. */
export function summarizePatch(_project: Project, ops: PatchOp[]): { subject: string; description: string }[] {
  return ops.map((op) => {
    const path = 'path' in op ? op.path : ''
    const parts = path.split('/').filter(Boolean)
    const ids = parts.filter((p) => p.startsWith('[id=')).map((p) => p.slice(4, -1))
    const field = parts[parts.length - 1] ?? ''
    const subject = ids.join(' › ') || parts[0] || 'project'
    const value = 'value' in op && (typeof op.value === 'number' || typeof op.value === 'string') ? ` = ${op.value}` : ''
    return { subject, description: `${op.op} ${field}${value}` }
  })
}
