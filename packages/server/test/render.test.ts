import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseProject, resolveProject } from '@dmixer/core'
import { renderMix } from '../src/render.ts'
import { decode, runStderr } from '../src/media.ts'
import { Workspace } from '../src/workspace.ts'

const DEMO = path.resolve(import.meta.dirname, '../../../examples/demo')
const hasMedia = fs.existsSync(path.join(DEMO, 'audio/musica.wav'))

const rms = (x: Float32Array, a: number, b: number, sr: number) => {
  let s = 0
  for (let i = Math.floor(a * sr); i < Math.floor(b * sr); i++) s += x[i] * x[i]
  return 10 * Math.log10(s / ((b - a) * sr) + 1e-12)
}

test('render: loudness target and ducking under the voice', { skip: !hasMedia && 'run examples/demo/make-media.sh' }, async () => {
  const project = parseProject(fs.readFileSync(path.join(DEMO, 'mix.yaml'), 'utf8')).project!
  const out = path.join(os.tmpdir(), `dmixer-test-${process.pid}.wav`)
  await renderMix(project, new Workspace(DEMO), { out })
  const err = await runStderr('ffmpeg', ['-hide_banner', '-nostats', '-i', out, '-af', 'ebur128', '-f', 'null', '-'])
  const lufs = Number(/I:\s+(-?[\d.]+) LUFS/.exec(err.slice(err.lastIndexOf('Summary')))![1])
  assert.ok(Math.abs(lufs - -14) < 1, `integrated ${lufs} LUFS`)

  // music alone: duck depth shows between a voice-free stretch and one under the voice
  const solo = { ...project, tracks: project.tracks.map((t) => (t.id === 'voz' ? { ...t, muted: true } : t)) }
  await renderMix(solo, new Workspace(DEMO), { out, normalize: false })
  const [l] = await decode(out, 44100)
  const [c1, c2] = resolveProject(project).tracks.find((t) => t.id === 'voz')!.clips
  const free = rms(l, c1.end + 1, c2.start - 0.5, 44100)
  const under = rms(l, c1.start + 0.3, c1.end - 0.3, 44100)
  assert.ok(free - under > 7, `duck ${free - under} dB`)
  fs.rmSync(out, { force: true })
})
