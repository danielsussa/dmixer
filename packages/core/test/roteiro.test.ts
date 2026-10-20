import { test } from 'node:test'
import assert from 'node:assert/strict'
import { criarFaixasDoRoteiro, describeProject, duracaoDaLeitura, montarRoteiro, Project, resolveProject } from '../src/index.ts'

const fala = {
  palavras: [[0, 0.5, 'Era'], [0.5, 1, 'uma'], [1, 1.5, 'vez.'], [2, 2.5, 'Fim'], [2.5, 3, 'mesmo.']] as [number, number, string][],
  frases: [[0, 1.5, 'Era uma vez.'], [2, 3, 'Fim mesmo.']] as [number, number, string][],
}

function mix() {
  return resolveProject(Project.parse({
    assets: { a: { src: 'voz/s0.voice.mp3', meta: { duration: 3 } }, m: { src: 'musica.mp3', meta: { duration: 60 } } },
    lanes: [{ id: 'capitulos' }, { id: 'humor' }],
    regions: [
      { id: 'c1', start: 10, end: 20, label: '1 · Começo', lane: 'capitulos' },
      { id: 'c2', start: 20, end: 30, label: '2 · Fim', lane: 'capitulos' },
      { id: 'h1', start: 10, end: 12, label: 'leve', lane: 'humor' },
      { id: 'h2', start: 12, end: 30, label: 'tenso', lane: 'humor' },
    ],
    tracks: [
      // o segundo clipe toca só "mesmo." (in 2.5)
      { id: 'voz', clips: [{ id: 'f1', asset: 'a', start: 10, out: 1.5 }, { id: 'f2', asset: 'a', start: 21, in: 2.5 }] },
      { id: 'trilha', clips: [{ id: 'm1', asset: 'm', start: 0 }] },
    ],
  }))
}

test('roteiro: palavras no tempo da mix, cortes somem, capítulos e humores', () => {
  const r = montarRoteiro(mix(), { 'voz/s0.voice.mp3': fala })
  assert.deepEqual(r.capitulos.map((c) => c.label), ['1 · Começo', '2 · Fim'])
  const [p1] = r.capitulos[0].paragrafos
  assert.deepEqual(p1.frases.map((f) => f.palavras.map((w) => w.texto).join(' ')), ['Era uma vez.'])
  assert.equal(p1.frases[0].palavras[0].start, 10)
  assert.deepEqual(p1.frases[0].palavras.map((w) => w.humor), ['h1', 'h1', 'h1'])
  const [p2] = r.capitulos[1].paragrafos
  assert.deepEqual(p2.frases.map((f) => f.palavras.map((w) => w.texto).join(' ')), ['mesmo.'])
  assert.equal(p2.frases[0].start, 21)
  assert.equal(p2.frases[0].palavras[0].humor, 'h2')
  assert.equal(r.humores.h2.color, '#c9a227', 'humor sem cor ganha a cor da paleta')
  assert.deepEqual(r.semTexto, [])
})

test('roteiro: clipe de fala sem transcrição e sem faixa de capítulos', () => {
  const p = mix()
  p.regions = []
  const r = montarRoteiro(p, { 'voz/s0.voice.mp3': null })
  assert.equal(r.capitulos.length, 0)
  assert.deepEqual(r.semTexto.map((s) => s.clipId), ['f1', 'f2'])
})

test('criarFaixasDoRoteiro: só as que faltam, antes das outras', () => {
  const p = Project.parse({ lanes: [{ id: 'musica' }, { id: 'humor' }] })
  assert.deepEqual(criarFaixasDoRoteiro(p), [{ op: 'replace', path: '/lanes', value: [{ id: 'capitulos', name: 'Capítulos' }, { id: 'texto', name: 'Texto' }, { id: 'musica' }, { id: 'humor' }] }])
  assert.deepEqual(criarFaixasDoRoteiro(Project.parse({ lanes: [{ id: 'capitulos' }, { id: 'humor' }, { id: 'texto' }] })), [])
})

test('roteiro: antes da gravação, a fala vem da faixa texto; o gravado tem precedência', () => {
  const p = Project.parse({
    assets: { a: { src: 'voz/s0.voice.mp3', meta: { duration: 3 } } },
    lanes: [{ id: 'capitulos' }, { id: 'humor' }, { id: 'texto' }],
    regions: [
      { id: 'c1', start: 0, end: 40, label: '1 · Começo', lane: 'capitulos' },
      { id: 'h1', start: 0, end: 5, label: 'leve', lane: 'humor' },
      { id: 'h2', start: 5, end: 40, label: 'tenso', lane: 'humor' },
      { id: 'b1', start: 0, end: 10, lane: 'texto', text: 'Primeira frase aqui. Segunda frase.' },
      { id: 'b2', start: 10, end: 14, lane: 'texto', text: 'Esta já foi gravada.' },
    ],
    tracks: [{ id: 'voz', clips: [{ id: 'f1', asset: 'a', start: 10 }] }],
  })
  const r = montarRoteiro(resolveProject(p), { 'voz/s0.voice.mp3': fala })
  const [b1, f1] = r.capitulos[0].paragrafos
  assert.equal(b1.estimado, true)
  assert.equal(b1.clipId, 'b1')
  assert.deepEqual(b1.frases.map((f) => f.palavras.map((w) => w.texto).join(' ')), ['Primeira frase aqui.', 'Segunda frase.'])
  assert.equal(b1.frases[0].palavras[0].humor, 'h1')
  assert.equal(b1.frases[1].palavras[0].humor, 'h2')
  assert.equal(f1.clipId, 'f1', 'b2 some: a fala gravada cobre o trecho')
  assert.equal(r.capitulos[0].paragrafos.length, 2)
  assert.match(describeProject(p), /\| Primeira frase aqui\. Segunda frase\./)
  assert.equal(resolveProject(p).regions.find((g) => g.id === 'b1')!.label, 'Primeira frase aqui. Segunda frase.')
})

test('duracaoDaLeitura: palavras no ritmo de leitura, mais um respiro por frase', () => {
  assert.equal(duracaoDaLeitura('um dois três quatro cinco.'), 2.4)
  assert.equal(duracaoDaLeitura('oi'), 1)
})
