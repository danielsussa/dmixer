import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyPatch, audibleTracks, duckDbAt, duckRegions, envelopeAt, parseProject, resolveProject, serializeProject, subidasNasPausas,
} from '../src/index.ts'

const YAML = `# comentário do topo
version: 1
project: { name: t, bpm: 72 }
assets:
  a: { src: a.wav, meta: { duration: 10 } }
markers:
  - { id: m1, at: 4 }
  - { id: m2, at: "@m1 + 1.5" }
tracks:
  - id: voz
    clips:
      - { id: c1, asset: a, start: 1, in: 2, out: 4 }   # frase um
      - { id: c2, asset: a, start: "@m2", in: 0, out: 1 }
  - id: mus
    output: bus
    clips: [{ id: m, asset: a, start: 0 }]
  - id: bus
    type: bus
    effects: [{ type: duck, source: voz, depth: 10, attack: 0.1, release: 0.5, hold: 1 }]
    automation: { volume: [{ at: 2, db: 0 }, { at: 0, db: -6 }] }
`

test('resolve: markers, expressions, durations', () => {
  const p = parseProject(YAML)
  assert.ok(p.ok, p.errors.join())
  const r = resolveProject(p.project!)
  assert.equal(r.markers[1].at, 5.5)
  const [c1, c2] = r.tracks[0].clips
  assert.equal(c1.end, 3)
  assert.equal(c2.start, 5.5)
  assert.equal(r.tracks[1].clips[0].duration, 10)
  assert.equal(r.duration, 10)
})

test('envelope: sorted, linear in dB, keeps the file index', () => {
  const r = resolveProject(parseProject(YAML).project!)
  const env = r.tracks[2].envelope
  assert.deepEqual(env.map((p) => p.index), [1, 0])
  assert.equal(envelopeAt(env, -1), -6)
  assert.equal(envelopeAt(env, 1), -3)
  assert.equal(envelopeAt(env, 9), 0)
})

test('duck: regions merge gaps shorter than hold', () => {
  const r = resolveProject(parseProject(YAML).project!)
  const e = r.tracks[2].effects[0] as Extract<(typeof r.tracks)[number]['effects'][number], { type: 'duck' }>
  const regions = duckRegions(r, e)
  assert.deepEqual(regions, [[0.9, 3.5], [5.4, 7]])
  assert.equal(duckDbAt(regions, 10, 0.1, 0.5, 2), -10)
  assert.equal(duckDbAt(regions, 10, 0.1, 0.5, 4.5), -0)
})

test('solo keeps the bus a soloed track feeds', () => {
  const p = parseProject(YAML).project!
  const solo = applyPatch(p, [{ op: 'add', path: '/tracks/[id=mus]/solo', value: true }])
  const heard = audibleTracks(resolveProject(solo).tracks)
  assert.deepEqual([...heard].sort(), ['bus', 'mus'])
})

test('serialize keeps comments across a patch', () => {
  const p = parseProject(YAML).project!
  const next = applyPatch(p, [{ op: 'replace', path: '/tracks/[id=voz]/clips/[id=c1]/start', value: 2 }])
  const out = serializeProject(next, YAML)
  assert.match(out, /# comentário do topo/)
  assert.match(out, /# frase um/)
  assert.equal(parseProject(out).project!.tracks[0].clips![0].start, 2)
})

test('subidas nas pausas: desce na fala, sobe só nas pausas longas o bastante, volta antes da próxima palavra', () => {
  // fala 2–5 e 5,5–8 (pausa curta, fica embaixo), depois 11–14 (pausa de 3 s, sobe com o swell)
  const pts = subidasNasPausas([[2, 5], [5.5, 8], [11, 14]], { depth: 6 }).map((p) => ({ at: p.at as number, db: p.db }))
  const v = (t: number) => envelopeAt(pts, t)
  assert.equal(v(0.5), 0)                    // antes da primeira fala: cheia
  assert.equal(v(2), -6)                     // a fala entra com a música já embaixo
  assert.equal(v(5.25), -6)                  // respiro curto: não bombeia
  assert.equal(v(9.5), 2)                    // pausa longa: sobe além do normal
  assert.ok(v(10.9) <= -6 + 1e-9)            // já embaixo antes da próxima palavra
  assert.equal(v(20), 0)                     // depois da última fala: volta ao normal
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].at > pts[i - 1].at)
})
