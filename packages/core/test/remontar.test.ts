import { test } from 'node:test'
import assert from 'node:assert/strict'
import { clipesDaRemontagem, CURVAS, curvaOriginal, remontar, type Funcao, type Pecas } from '../src/index.ts'

/** uma música de mentira: abertura, 2 respiros, 3 picos (2 gêmeos), uma virada e o final; peças de 4 compassos de 2 s */
function musica(): Pecas {
  const roles: [Funcao, number][] = [['abertura', 0], ['respiro', 0.2], ['respiro', 0.3], ['pico', 1], ['pico', 0.95], ['virada', 0.7], ['pico', 1], ['final', 0.8]]
  const pieces = roles.map(([role, energy], i) => ({ i, start: i * 8, end: (i + 1) * 8, bar: i * 4, bars: 4, energy, role, twins: [] as number[] }))
  pieces[3].twins = [6]
  pieces[6].twins = [3]
  const n = pieces.length
  const seams = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) => {
    if (a === n - 1 || b === 0) return 0            // nada depois do final; a abertura só abre
    if (b === a + 1) return 1                        // vizinhas no original
    if (pieces[b].role === 'pico' && pieces[a].role !== 'abertura') return 0.6
    return 0.2
  }))
  return { duration: n * 8, bar: 2, pieces, seams }
}

test('remontar: com a duração original e a curva dela, volta a ordem original', () => {
  const p = musica()
  const [r] = remontar(p, { duracao: 64, curva: curvaOriginal(p) })
  assert.deepEqual(r.seq, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.ok(r.emendas.slice(1).every((e) => e === 1))
})

test('remontar: começa na abertura, acaba no final, perto da duração e sem emenda proibida', () => {
  const p = musica()
  for (const duracao of [24, 40, 100]) {
    const rs = remontar(p, { duracao, curva: CURVAS.direto.pts })
    assert.ok(rs.length >= 1)
    for (const r of rs) {
      assert.equal(r.seq[0], 0)
      assert.equal(r.seq[r.seq.length - 1], 7)
      assert.ok(Math.abs(r.duracao - duracao) <= 8 + 1e-9, `${duracao}: ${r.duracao}`)
      assert.ok(r.emendas.slice(1).every((e) => (e ?? 0) > 0))
    }
  }
})

test('remontar: um pico pedido cai no começo de uma peça forte', () => {
  const p = musica()
  const [r] = remontar(p, { duracao: 48, curva: [[0, 0.5], [1, 0.5]], picos: [16] })
  assert.equal(r.picos[0].erro, 0)
  let t = 0
  for (const j of r.seq) { if (t === 16) assert.ok(p.pieces[j].energy >= 0.75); t += 8 }
})

test('remontar: as opções saem diferentes umas das outras', () => {
  const rs = remontar(musica(), { duracao: 48, curva: CURVAS.meio.pts }, 3)
  assert.equal(new Set(rs.map((r) => r.seq.join())).size, rs.length)
})

test('clipesDaRemontagem: encostados com crossfade, emenda antes do golpe, abertura e final inteiros', () => {
  const p = musica()
  const r = remontar(p, { duracao: 32, curva: CURVAS.direto.pts })[0]
  const cs = clipesDaRemontagem(p, r, { asset: 'm', start: 5, ids: r.seq.map((_, k) => `r${k}`), pre: 0.01, xfade: 0.02 })
  assert.equal(cs[0].start, 5)
  assert.equal(cs[0].in, 0)
  assert.equal(cs[cs.length - 1].out, p.duration)
  for (let k = 1; k < cs.length; k++) {
    const a = cs[k - 1]
    const b = cs[k]
    const fimA = (a.start as number) + (a.out! - (a.in ?? 0))
    assert.ok(Math.abs(fimA - (b.start as number) - 0.02) < 1e-6, 'sobreposição = crossfade')
    assert.equal(b.fade_in, 0.02)
    assert.equal(a.fade_out, 0.02)
    // a peça nova entra 10 ms antes do 1º tempo dela, e o crossfade acaba antes dele
    assert.ok(Math.abs((b.in ?? 0) + 0.02 - (p.pieces[r.seq[k]].start - 0.01 + 0.01)) < 1e-6)
  }
})
