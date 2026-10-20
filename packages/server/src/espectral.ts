import { ESPECTRAL_BANDAS, ESPECTRAL_PASSO, type MascaraEspectral } from '@dmixer/core'

/**
 * A máscara do duck espectral, a partir da voz e da faixa (mono, já com volume e automação). A cada 20 ms, por banda:
 * atenuação = quanto a faixa passa de (voz − snr), só nas bandas que a voz está usando, até `max` dB (menos nas pontas
 * do espectro). A voz segura a sílaba (ataque 10 ms, soltura 200 ms) e a atenuação solta devagar (300 ms), com 40 ms
 * de antecipação: a máscara não treme entre fonemas.
 */
export function calcularMascara(voz: Float32Array, faixa: Float32Array, sr: number, snr: number, max: number): MascaraEspectral {
  // análise a meia taxa: as bandas vão só até ~8 kHz
  const v = metade(voz)
  const m = metade(faixa)
  const sa = sr / 2
  const WIN = 1024
  const hop = Math.round(ESPECTRAL_PASSO * sa)
  const passo = hop / sa
  const nq = Math.ceil(v.length / hop) + 1
  const nb = ESPECTRAL_BANDAS.length
  const bordas = [ESPECTRAL_BANDAS[0] / 1.26, ...ESPECTRAL_BANDAS.slice(1).map((c, i) => Math.sqrt(c * ESPECTRAL_BANDAS[i])), ESPECTRAL_BANDAS[nb - 1] * 1.26]
  const banda = new Int8Array(WIN / 2 + 1).fill(-1)
  for (let k = 0; k <= WIN / 2; k++) {
    const f = (k * sa) / WIN
    for (let b = 0; b < nb; b++) if (f >= bordas[b] && f < bordas[b + 1]) banda[k] = b
  }
  const janela = new Float64Array(WIN)
  for (let i = 0; i < WIN; i++) janela[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN)
  const fft = criarFft(WIN)
  const Lv = new Float32Array(nq * nb)
  const Lm = new Float32Array(nq * nb)
  const re = new Float64Array(WIN)
  const im = new Float64Array(WIN)
  for (const [x, L] of [[v, Lv], [m, Lm]] as const) {
    for (let k = 0; k < nq; k++) {
      const a = k * hop - WIN / 2   // quadro centrado em k * passo
      for (let i = 0; i < WIN; i++) {
        const j = a + i
        re[i] = j >= 0 && j < x.length ? x[j] * janela[i] : 0
        im[i] = 0
      }
      fft(re, im)
      const p = new Float64Array(nb)
      for (let i = 0; i <= WIN / 2; i++) if (banda[i] >= 0) p[banda[i]] += re[i] * re[i] + im[i] * im[i]
      for (let b = 0; b < nb; b++) L[k * nb + b] = 10 * Math.log10(p[b] + 1e-10)
    }
  }
  // voz segurando a sílaba
  const Lvs = suavizar(Lv, nb, passo, 0.01, 0.2)
  let topo = -Infinity
  for (const x of Lvs) topo = Math.max(topo, x)
  const peso = ESPECTRAL_BANDAS.map((f) => interpLog(f, [120, 300, 5000, 10000], [0.35, 1, 1, 0.35]))
  const att = new Float32Array(nq * nb)
  for (let k = 0; k < nq; k++) {
    let mx = -Infinity
    for (let b = 0; b < nb; b++) mx = Math.max(mx, Lvs[k * nb + b])
    if (mx < topo - 55) continue   // sem voz neste quadro
    for (let b = 0; b < nb; b++) {
      const lv = Lvs[k * nb + b]
      if (lv < mx - 35) continue   // banda que a voz não está usando agora
      att[k * nb + b] = Math.min(Math.max(0, Lm[k * nb + b] - (lv - snr)), max * peso[b])
    }
  }
  // entre bandas vizinhas [¼ ½ ¼], depois no tempo (ataque 15 ms, soltura 300 ms)
  const viz = new Float32Array(nq * nb)
  for (let k = 0; k < nq; k++) {
    for (let b = 0; b < nb; b++) {
      const e = att[k * nb + Math.max(0, b - 1)], c = att[k * nb + b], d = att[k * nb + Math.min(nb - 1, b + 1)]
      viz[k * nb + b] = 0.25 * e + 0.5 * c + 0.25 * d
    }
  }
  const suave = suavizar(viz, nb, passo, 0.015, 0.3)
  // 40 ms de antecipação
  const adiant = Math.round(0.04 / passo)
  const out = new Float32Array(nq * nb)
  out.set(suave.subarray(adiant * nb))
  return { passo, bandas: [...ESPECTRAL_BANDAS], att: out }
}

function metade(x: Float32Array): Float32Array {
  const y = new Float32Array(Math.floor(x.length / 2))
  for (let i = 0; i < y.length; i++) y[i] = 0.5 * (x[2 * i] + x[2 * i + 1])
  return y
}

/** um polo assimétrico no tempo, por banda: sobe com `ataque`, desce com `soltura` (s) */
function suavizar(x: Float32Array, nb: number, passo: number, ataque: number, soltura: number): Float32Array {
  const a = Math.exp(-passo / ataque)
  const r = Math.exp(-passo / soltura)
  const y = new Float32Array(x.length)
  y.set(x.subarray(0, nb))
  for (let i = nb; i < x.length; i++) {
    const prev = y[i - nb]
    const c = x[i] > prev ? a : r
    y[i] = c * prev + (1 - c) * x[i]
  }
  return y
}

function interpLog(f: number, xs: number[], ys: number[]): number {
  const lf = Math.log(f)
  if (lf <= Math.log(xs[0])) return ys[0]
  for (let i = 0; i < xs.length - 1; i++) {
    const a = Math.log(xs[i]), b = Math.log(xs[i + 1])
    if (lf <= b) return ys[i] + ((ys[i + 1] - ys[i]) * (lf - a)) / (b - a)
  }
  return ys[ys.length - 1]
}

/** FFT complexa radix-2, in place (n potência de 2) */
function criarFft(n: number): (re: Float64Array, im: Float64Array) => void {
  const rev = new Uint32Array(n)
  const bits = Math.log2(n)
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n)
    sin[i] = -Math.sin((2 * Math.PI * i) / n)
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2
      const step = n / size
      for (let s = 0; s < n; s += size) {
        for (let k = 0; k < half; k++) {
          const wr = cos[k * step], wi = sin[k * step]
          const a = s + k, b = a + half
          const tr = re[b] * wr - im[b] * wi
          const ti = re[b] * wi + im[b] * wr
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}
