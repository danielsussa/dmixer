/**
 * DSP shared by the render (server) and the preview (browser). The preview runs on
 * Web Audio nodes, so these formulas follow the Web Audio spec — the render and the
 * preview are meant to sound the same.
 */

export interface Biquad {
  b0: number; b1: number; b2: number; a1: number; a2: number
}

/** RBJ cookbook, the same equations BiquadFilterNode uses. `q` is the plain Q (not dB). */
export function biquad(type: 'lowpass' | 'highpass' | 'peaking' | 'lowshelf' | 'highshelf', freq: number, sr: number, q = Math.SQRT1_2, gainDb = 0): Biquad {
  const w0 = (2 * Math.PI * Math.min(freq, sr / 2 - 1)) / sr
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const A = 10 ** (gainDb / 40)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number
  if (type === 'lowpass' || type === 'highpass') {
    const alpha = sin / (2 * q)
    b1 = type === 'lowpass' ? 1 - cos : -(1 + cos)
    b0 = b2 = type === 'lowpass' ? (1 - cos) / 2 : (1 + cos) / 2
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else if (type === 'peaking') {
    const alpha = sin / (2 * q)
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  } else {
    // shelf with S = 1, as in Web Audio
    const alpha = (sin / 2) * Math.SQRT2
    const k = 2 * Math.sqrt(A) * alpha
    if (type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cos + k)
      b1 = 2 * A * (A - 1 - (A + 1) * cos)
      b2 = A * (A + 1 - (A - 1) * cos - k)
      a0 = A + 1 + (A - 1) * cos + k
      a1 = -2 * (A - 1 + (A + 1) * cos)
      a2 = A + 1 + (A - 1) * cos - k
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + k)
      b1 = -2 * A * (A - 1 + (A + 1) * cos)
      b2 = A * (A + 1 + (A - 1) * cos - k)
      a0 = A + 1 - (A - 1) * cos + k
      a1 = 2 * (A - 1 - (A + 1) * cos)
      a2 = A + 1 - (A - 1) * cos - k
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

export function applyBiquad(x: Float32Array, c: Biquad): void {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0
  for (let i = 0; i < x.length; i++) {
    const v = x[i]
    const y = c.b0 * v + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2
    x2 = x1; x1 = v; y2 = y1; y1 = y
    x[i] = y
  }
}

/** Web Audio StereoPannerNode, for a stereo input. */
export function panGains(pan: number): { ll: number; rl: number; lr: number; rr: number } {
  // out L = in L * ll + in R * rl ; out R = in L * lr + in R * rr
  if (pan <= 0) {
    const x = pan + 1
    const gl = Math.cos((x * Math.PI) / 2)
    const gr = Math.sin((x * Math.PI) / 2)
    return { ll: 1, rl: gl, lr: 0, rr: gr }
  }
  const gl = Math.cos((pan * Math.PI) / 2)
  const gr = Math.sin((pan * Math.PI) / 2)
  return { ll: gl, rl: 0, lr: gr, rr: 1 }
}

/**
 * Freeverb (Schroeder–Moorer: 8 parallel combs + 4 allpasses per channel). Linear and
 * time-invariant, so the preview can use its impulse response in a ConvolverNode and
 * get exactly what the render computes directly.
 */
const COMBS = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASSES = [556, 441, 341, 225]
const SPREAD = 23

export function freeverbWet(l: Float32Array, r: Float32Array, sr: number, seconds = 2.5, damping = 0.45): [Float32Array, Float32Array] {
  const scale = sr / 44100
  const room = Math.min(1, Math.max(0, (seconds - 0.4) / 4))
  const feedback = 0.7 + 0.28 * room
  const out: Float32Array[] = []
  for (const [ch, x] of [[0, l], [1, r]] as [number, Float32Array][]) {
    const y = new Float32Array(x.length)
    const combs = COMBS.map((d) => ({ buf: new Float32Array(Math.round((d + ch * SPREAD) * scale)), i: 0, store: 0 }))
    const alls = ALLPASSES.map((d) => ({ buf: new Float32Array(Math.round((d + ch * SPREAD) * scale)), i: 0 }))
    for (let n = 0; n < x.length; n++) {
      const input = x[n] * 0.015
      let acc = 0
      for (const c of combs) {
        const o = c.buf[c.i]
        c.store = o * (1 - damping) + c.store * damping
        c.buf[c.i] = input + c.store * feedback
        if (++c.i >= c.buf.length) c.i = 0
        acc += o
      }
      for (const a of alls) {
        const b = a.buf[a.i]
        a.buf[a.i] = acc + b * 0.5
        if (++a.i >= a.buf.length) a.i = 0
        acc = b - acc
      }
      y[n] = acc
    }
    out.push(y)
  }
  return [out[0], out[1]]
}

/** Freeverb's impulse response, for a ConvolverNode. Mono impulse in, stereo response out. */
export function freeverbImpulse(sr: number, seconds = 2.5): [Float32Array, Float32Array] {
  const n = Math.ceil(sr * (seconds + 0.5))
  const l = new Float32Array(n)
  const r = new Float32Array(n)
  l[0] = 1
  r[0] = 1
  return freeverbWet(l, r, sr, seconds)
}
