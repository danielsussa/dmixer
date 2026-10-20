import type { Project } from './schema.js'
import { resolveProject } from './resolve.js'
import { formatTime } from './util.js'

/** The mix described the way an engineer would read it out — what an agent reads instead of the raw YAML. */
export function describeProject(project: Project): string {
  const r = resolveProject(project)
  const lines: string[] = []
  lines.push('PROJECT')
  lines.push(`  name: ${r.name}`)
  lines.push(`  ${r.sampleRate} Hz · duration ${formatTime(r.duration)}${r.bpm ? ` · ${r.bpm} BPM ${r.meter}/4` : ''}`)
  if (r.master.loudness) lines.push(`  master: ${r.master.loudness.target} LUFS, ${r.master.loudness.true_peak ?? -1} dBTP`)
  if (r.markers.length) {
    lines.push('', 'MARKERS (referenceable as "@id")')
    for (const m of r.markers) lines.push(`  @${m.id} at ${formatTime(m.at, 2)}${m.label ? ` — ${m.label}` : ''}`)
  }
  if (r.regions.length) {
    lines.push('', 'TAGS (referenceable as "@id" and "@id.end")')
    if (r.regions.some((g) => g.lane === 'texto')) lines.push('  (lane "texto": unrecorded narration, one tag per block, in `text`; time is estimated by reading speed)')
    for (const l of r.lanes) {
      const items = r.regions.filter((g) => g.lane === l.id).sort((a, b) => a.start - b.start)
      if (!items.length) continue
      lines.push(`  ${l.name}:`)
      for (const g of items) {
        lines.push(`    @${g.id} ${formatTime(g.start, 2)} → ${formatTime(g.end, 2)}  ${g.raw.text ? '' : g.label}`.trimEnd())
        // a fala ainda não gravada, inteira: é o roteiro que se revisa
        if (g.raw.text) lines.push(...g.raw.text.trim().split('\n').map((x) => `      | ${x}`))
      }
    }
  }
  for (const t of r.tracks) {
    const flags = [t.muted && 'muted', t.solo && 'solo', t.output && `→ ${t.output}`].filter(Boolean).join(' ')
    lines.push('', `TRACK ${t.id} (${t.type}) vol ${t.volume} dB pan ${t.pan}${flags ? ' ' + flags : ''}`)
    if (t.effects.length) lines.push(`  fx: ${t.effects.map((e) => e.type + (e.bypass ? '(off)' : '')).join(', ')}`)
    if (t.envelope.length) lines.push(`  envelope: ${t.envelope.length} points, ${Math.min(...t.envelope.map((p) => p.db))}…${Math.max(...t.envelope.map((p) => p.db))} dB`)
    const shown = t.clips.slice(0, 12)
    for (const c of shown) lines.push(`  ${c.id}: ${formatTime(c.start, 2)} → ${formatTime(c.end, 2)}  ${c.asset}${c.gain ? ` ${c.gain} dB` : ''}${c.label ? ` "${c.label}"` : ''}`)
    if (t.clips.length > shown.length) lines.push(`  … ${t.clips.length - shown.length} more clips`)
  }
  if (r.diagnostics.length) lines.push('', 'PROBLEMS', ...r.diagnostics.map((d) => `  ${d}`))
  return lines.join('\n')
}
