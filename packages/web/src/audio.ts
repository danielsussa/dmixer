import {
  atenuacaoEm, audibleTracks, dbToGain, duckDbAt, duckRegions, envelopeAt, ESPECTRAL_BANDAS, ESPECTRAL_FATOR, ESPECTRAL_Q, freeverbImpulse,
  mascaraDoJson, processingOrder, type Effect, type MascaraEspectral, type ResolvedPoint, type ResolvedProject,
} from '@dmixer/core'
import { currentId, mediaUrl } from './api'
import { diag } from './diag'
import { useEditor } from './store'

/**
 * The preview: the same mix as the render, built from Web Audio nodes. Effects map
 * one-to-one (biquads, compressor, duck as a scheduled gain, Freeverb as a convolver
 * with the render's own impulse response). Loudness normalisation happens only in
 * the render.
 */
/** seconds of audio decoded ahead of the playhead */
const AHEAD = 40
/** decoded audio kept in memory before far-away files are dropped (an iPhone tab dies around a few hundred MB) */
const KEEP_SECONDS = 240
/** 0.1 s of silence, for the iOS unlock */
const SILENT_WAV = 'data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSADAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA=='

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && 'ontouchend' in document)

export interface Preview {
  onplaying: (() => void) | null
  onended: (() => void) | null
  pause: () => void
}

class Engine {
  ctx: AudioContext | null = null
  private buffers = new Map<string, Promise<AudioBuffer | null>>()
  private nodes: AudioNode[] = []
  private sources: AudioBufferSourceNode[] = []
  private startedAt = 0
  private from = 0
  private raf = 0
  private analyser: AnalyserNode | null = null
  private irs = new Map<string, AudioBuffer>()
  /** bytes received / expected per file, for the loading bar */
  private progress = new Map<string, { got: number; total: number }>()
  private ticket = 0
  private decoded = new Map<string, number>()
  private scheduled = new Set<string>()
  private graph: { r: ResolvedProject; inputs: Map<string, GainNode>; heard: Set<string>; t0: number; from: number; session: number } | null = null
  /** relógio do próprio áudio: com a tela bloqueada o requestAnimationFrame para, mas o contexto continua */
  private pumpNode: ConstantSourceNode | null = null

  private ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      try {
        // no iPhone a taxa é a do aparelho (48 kHz): forçar 44,1 kHz deixa o contexto rodando mudo
        this.ctx = IOS ? new AC() : new AC({ sampleRate: useEditor.getState().resolved?.sampleRate ?? 44100, latencyHint: 'playback' })
      } catch {
        this.ctx = new AC()   // Safari antigo não aceita escolher a taxa
      }
      const ctx = this.ctx
      ctx.onstatechange = () => diag('ctx state', { state: ctx.state, time: ctx.currentTime })
      diag('ctx created', { state: ctx.state, rate: ctx.sampleRate, base: ctx.baseLatency })
    }
    return this.ctx
  }

  load(src: string): Promise<AudioBuffer | null> {
    const key = mediaUrl(src)
    let p = this.buffers.get(key)
    if (!p) {
      const ctx = this.ensure()
      p = this.fetchBytes(key)
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => (this.decoded.set(key, buf.duration), buf))
        .catch((e) => {
          console.warn('could not load', src, e)
          diag('load failed', { src, error: String(e) })
          return null
        })
      this.buffers.set(key, p)
    }
    return p
  }

  /** Fetch with byte progress (the narration is one big file, so counting files says nothing). */
  private async fetchBytes(url: string): Promise<ArrayBuffer> {
    const r = await fetch(url)
    if (!r.ok) throw new Error(r.statusText)
    const total = Number(r.headers.get('content-length')) || 0
    if (!r.body || !total) {
      const b = await r.arrayBuffer()
      this.progress.set(url, { got: b.byteLength, total: b.byteLength })
      return b
    }
    const reader = r.body.getReader()
    const out = new Uint8Array(total)
    let got = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (got + value.length > out.length) throw new Error('size mismatch')
      out.set(value, got)
      got += value.length
      this.progress.set(url, { got, total })
      this.report()
    }
    return out.buffer.slice(0, got)
  }

  private waiting: string[] = []
  private report() {
    if (!this.waiting.length || useEditor.getState().loading === null) return
    let got = 0
    let total = 0
    for (const k of this.waiting) {
      const p = this.progress.get(k)
      got += p?.got ?? 0
      total += p?.total ?? 1e6
    }
    useEditor.getState().setState({ loading: Math.min(0.99, got / total) })
  }

  /** Cancel a play that is still loading. */
  cancel() {
    this.ticket++
    this.waiting = []
    useEditor.getState().setState({ loading: null })
  }

  get position(): number {
    if (!this.ctx || !useEditor.getState().playing) return useEditor.getState().playhead
    return this.from + (this.ctx.currentTime - this.startedAt)
  }

  async play(from = useEditor.getState().playhead) {
    const r = useEditor.getState().resolved
    if (!r) return
    const me = ++this.ticket
    useEditor.getState().setState({ loading: 0 })   // na hora do toque, antes de qualquer espera
    this.unlock()
    const ctx = this.ensure()
    diag('play tap', { from, state: ctx.state })
    try {
      await ctx.resume()
    } catch (e) {
      diag('resume failed', { error: String(e) })
    }
    diag('resumed', { state: ctx.state, time: ctx.currentTime })
    this.teardown()
    // só o que toca nos próximos segundos precisa estar pronto; o resto vem enquanto toca
    const srcs = [...new Set(r.tracks.flatMap((t) => t.clips.filter((c) => c.end > from && c.start < from + AHEAD).map((c) => c.src)))].filter(Boolean)
    this.waiting = srcs.map((s) => mediaUrl(s))
    this.report()
    await Promise.all(srcs.map((s) => this.load(s).then(() => this.report())))
    if (me !== this.ticket) return
    this.waiting = []
    useEditor.getState().setState({ loading: null })
    try {
      this.build(r, from)
    } catch (e) {
      diag('build failed', { error: String((e as Error)?.stack ?? e) })
      throw e
    }
    useEditor.getState().setState({ playing: true })
    this.mediaSession(true)
    this.pump()
    this.tick()
    diag('started', { state: ctx.state, time: ctx.currentTime, files: srcs.length })
    for (const ms of [500, 2000, 5000]) setTimeout(() => {
      if (me !== this.ticket) return
      let peak = 0
      if (this.analyser) {
        const a = new Float32Array(this.analyser.fftSize)
        this.analyser.getFloatTimeDomainData(a)
        for (const v of a) peak = Math.max(peak, Math.abs(v))
      }
      diag('playing', { ms, state: ctx.state, time: ctx.currentTime, sources: this.sources.length, peak, pos: this.position })
    }, ms)
  }

  /**
   * iOS: Web Audio obeys the silent switch unless the page asks for a playback session — or, on older iOS,
   * unless an <audio> element is playing. Must run inside the tap.
   */
  private silent: HTMLAudioElement | null = null
  private unlock() {
    const nav = navigator as Navigator & { audioSession?: { type: string } }
    try { if (nav.audioSession) nav.audioSession.type = 'playback' } catch { /* not supported */ }
    diag('unlock', { session: nav.audioSession?.type ?? 'none' })
    if (!IOS || nav.audioSession) return   // iOS 17+: a sessão já basta; o <audio> mudo só no iOS antigo
    if (!this.silent) {
      this.silent = new Audio(SILENT_WAV)
      this.silent.loop = true
      this.silent.setAttribute('playsinline', '')
    }
    void this.silent.play().catch(() => {})
  }

  /**
   * Listen to one file outside the mix (library previews). Goes through the same context as the mix, because
   * on iPhone a separate <audio> element stays mute next to it.
   */
  private previewBufs = new Map<string, Promise<AudioBuffer>>()
  private previewing: { src: AudioBufferSourceNode; gain: GainNode; also?: AudioBufferSourceNode } | null = null
  preview(url: string): Preview {
    this.unlock()
    const ctx = this.ensure()
    void ctx.resume()
    this.stopPreview()
    const h: Preview = { onplaying: null, onended: null, pause: () => { stopped = true; if (this.previewing === mine) this.stopPreview() } }
    let stopped = false
    let mine: Engine['previewing'] = null
    let p = this.previewBufs.get(url)
    if (!p) {
      p = this.fetchBytes(url).then((b) => ctx.decodeAudioData(b))
      p.catch(() => this.previewBufs.delete(url))
      if (this.previewBufs.size > 40) this.previewBufs.delete(this.previewBufs.keys().next().value!)
      this.previewBufs.set(url, p)
    }
    p.then((buf) => {
      if (stopped) return
      const src = ctx.createBufferSource()
      src.buffer = buf
      const gain = ctx.createGain()
      src.connect(gain).connect(ctx.destination)
      src.onended = () => { if (this.previewing === mine) this.previewing = null; if (!stopped) h.onended?.() }
      src.start()
      mine = { src, gain }
      this.previewing = mine
      h.onplaying?.()
    }).catch((e) => { diag('preview failed', { url, error: String(e) }); h.onended?.() })
    return h
  }

  stopPreview() {
    const p = this.previewing
    this.previewing = null
    if (!p) return
    for (const s of [p.src, p.also]) {
      if (!s) continue
      try { s.stop() } catch { /* already stopped */ }
      s.disconnect()
    }
    p.gain.disconnect()
  }

  /**
   * Hear a cut before making it: `pre` seconds up to `from`, then straight on from `to`
   * (file seconds), joined by the same short crossfade the cut will get.
   */
  previewJump(src: string, from: number, to: number, pre = 4, post = 4, xfade = 0.06): Preview {
    this.unlock()
    if (useEditor.getState().playing) this.stop()
    const ctx = this.ensure()
    void ctx.resume()
    this.stopPreview()
    let stopped = false
    let mine: Engine['previewing'] = null
    const h: Preview = { onplaying: null, onended: null, pause: () => { stopped = true; if (this.previewing === mine) this.stopPreview() } }
    this.load(src).then((buf) => {
      if (stopped || !buf) return h.onended?.()
      const out = ctx.createGain()
      out.connect(ctx.destination)
      const a0 = Math.max(0, from - pre)
      const t0 = ctx.currentTime + 0.05
      const seam = t0 + (from - a0)
      const a = ctx.createBufferSource()
      const b = ctx.createBufferSource()
      a.buffer = b.buffer = buf
      const ga = ctx.createGain()
      const gb = ctx.createGain()
      a.connect(ga).connect(out)
      b.connect(gb).connect(out)
      ga.gain.setValueAtTime(1, seam - xfade / 2)
      ga.gain.linearRampToValueAtTime(0, seam + xfade / 2)
      gb.gain.setValueAtTime(0, seam - xfade / 2)
      gb.gain.linearRampToValueAtTime(1, seam + xfade / 2)
      a.start(t0, a0, from - a0 + xfade / 2)
      b.start(seam - xfade / 2, Math.max(0, to - xfade / 2), post + xfade / 2)
      b.onended = () => { if (this.previewing === mine) this.stopPreview(); if (!stopped) h.onended?.() }
      mine = { src: a, gain: out, also: b }
      this.previewing = mine
      h.onplaying?.()
    }).catch(() => h.onended?.())
    return h
  }

  stop() {
    if (useEditor.getState().loading !== null) this.cancel()
    const pos = this.position
    this.teardown()
    this.silent?.pause()
    this.mediaSession(false)
    useEditor.getState().setState({ playing: false, meter: -120 })
    useEditor.getState().setPlayhead(pos)
  }

  /** Rebuild at the current position after an edit, so what you hear follows the file. */
  async refresh() {
    if (!useEditor.getState().playing) return
    const pos = this.position
    useEditor.getState().setPlayhead(pos)
    await this.play(pos)
  }

  private teardown() {
    cancelAnimationFrame(this.raf)
    if (this.pumpNode) {
      this.pumpNode.onended = null
      try { this.pumpNode.stop() } catch { /* already stopped */ }
      this.pumpNode.disconnect()
      this.pumpNode = null
    }
    for (const s of this.sources) {
      try { s.stop() } catch { /* already stopped */ }
      s.disconnect()
    }
    for (const n of this.nodes) n.disconnect()
    this.sources = []
    this.nodes = []
    this.scheduled.clear()
    this.graph = null
  }

  /** Schedule the clips of the next AHEAD seconds, and free decoded audio far from the playhead. */
  private feed(pos: number) {
    const g = this.graph
    if (!g) return
    for (const t of g.r.tracks) {
      if (t.type === 'bus' || !g.heard.has(t.id)) continue
      for (const c of t.clips) if (c.end > pos && c.start - c.head < pos + AHEAD) this.schedule(t.id, c, g)
    }
    let total = 0
    for (const d of this.decoded.values()) total += d
    if (total < KEEP_SECONDS) return
    const near = new Set(g.r.tracks.flatMap((t) => t.clips.filter((c) => c.end > pos - 20 && c.start < pos + AHEAD + 20).map((c) => mediaUrl(c.src))))
    for (const k of [...this.decoded.keys()]) {
      if (near.has(k)) continue
      this.decoded.delete(k)
      this.buffers.delete(k)
    }
  }

  private schedule(trackId: string, c: ResolvedProject['tracks'][number]['clips'][number], g: NonNullable<Engine['graph']>) {
    const key = `${trackId}/${c.id}`
    if (c.muted || c.end <= g.from || this.scheduled.has(key)) return
    this.scheduled.add(key)
    const ctx = this.ctx!
    const input = g.inputs.get(trackId)!
    void this.load(c.src).then((buf) => {
      if (!buf || !useEditor.getState().playing || this.graph !== g) return
      const src = ctx.createBufferSource()
      src.buffer = buf
      const gn = ctx.createGain()
      const peak = dbToGain(c.gain)
      // a cabeça (quebra-cabeça): o som começa `head` s antes do início visível, com o material de antes do trecho
      const ini = c.start - c.head
      const offset0 = c.in - c.head
      let when = g.t0 + Math.max(0, ini - g.from)
      let skip = Math.max(0, g.from - ini)
      const late = ctx.currentTime + 0.02 - when
      if (late > 0) { skip += late; when += late }   // chegou atrasado: entra no ponto certo, não do começo
      const dur = c.duration + c.head - skip
      if (dur <= 0) return
      if (c.equalPower && (c.fadeIn > 0.05 || c.fadeOut > 0.05)) {
        // crossfade em potência constante (seno/cosseno): a soma das duas peças não afunda no meio da junta
        const pts = Math.max(2, Math.ceil(dur * 200))
        const curve = new Float32Array(pts)
        for (let i = 0; i < pts; i++) {
          const k = skip + (i / (pts - 1)) * dur
          let v = peak
          if (k < c.fadeIn) v *= Math.sin(((k / c.fadeIn) * Math.PI) / 2)
          const resto = c.duration + c.head - k
          if (resto < c.fadeOut) v *= Math.sin(((Math.max(0, resto) / c.fadeOut) * Math.PI) / 2)
          curve[i] = v
        }
        gn.gain.setValueCurveAtTime(curve, when, dur)
      } else {
        gn.gain.setValueAtTime(skip > 0 && skip >= c.fadeIn ? peak : 0, when)
        if (skip < c.fadeIn) gn.gain.linearRampToValueAtTime(peak, when + (c.fadeIn - skip))
        const foStart = when + dur - c.fadeOut
        if (foStart > when) gn.gain.setValueAtTime(peak, foStart)
        gn.gain.linearRampToValueAtTime(0, when + dur)
      }
      src.connect(gn).connect(input)
      try {
        src.start(when, offset0 + skip, dur)
      } catch (e) {
        diag('start failed', { clip: c.id, when, offset: c.in + skip, dur, now: ctx.currentTime, error: String(e) })
        return
      }
      this.sources.push(src)
      this.nodes.push(gn)
    })
  }

  private tick = () => {
    const s = useEditor.getState()
    if (!s.playing) return
    const pos = this.position
    s.setPlayhead(pos)
    if (this.analyser) {
      const a = new Float32Array(this.analyser.fftSize)
      this.analyser.getFloatTimeDomainData(a)
      let sum = 0
      for (const v of a) sum += v * v
      s.setState({ meter: 10 * Math.log10(sum / a.length + 1e-12) })
    }
    this.raf = requestAnimationFrame(this.tick)
  }

  /**
   * Agenda os próximos clipes uma vez por segundo, contado pelo relógio do áudio (o `onended` de uma fonte muda):
   * timers e requestAnimationFrame congelam com a tela bloqueada, e aí a mix calava depois dos AHEAD s já agendados.
   */
  private pump = () => {
    const s = useEditor.getState()
    const g = this.graph
    if (!s.playing || !g || !this.ctx) return
    const pos = this.position
    if (s.resolved && pos > s.resolved.duration + 3) {
      this.stop()
      return
    }
    this.feed(pos)
    const ctx = this.ctx
    const n = ctx.createConstantSource()
    const mute = ctx.createGain()
    mute.gain.value = 0
    n.connect(mute).connect(ctx.destination)   // fonte solta não é processada em todo navegador
    n.onended = () => {
      n.disconnect()
      mute.disconnect()
      if (this.pumpNode !== n) return
      this.pumpNode = null
      this.pump()
    }
    n.start()
    n.stop(ctx.currentTime + 1)
    this.pumpNode = n
  }

  /** Controles na tela de bloqueio, e o sistema trata a página como player (menos chance de suspender). */
  private mediaSession(playing: boolean) {
    const ms = navigator.mediaSession
    if (!ms) return
    try {
      const p = useEditor.getState().projects.find((x) => x.id === currentId())
      if (playing && typeof MediaMetadata !== 'undefined') ms.metadata = new MediaMetadata({ title: p?.name ?? 'dmixer', artist: 'dmixer' })
      ms.playbackState = playing ? 'playing' : 'paused'
      ms.setActionHandler('play', () => { if (!useEditor.getState().playing) void this.play() })
      ms.setActionHandler('pause', () => { if (useEditor.getState().playing) this.stop() })
      ms.setActionHandler('stop', () => { if (useEditor.getState().playing) this.stop() })
    } catch { /* ação não suportada */ }
  }

  /** Volta da tela bloqueada: se o sistema suspendeu o contexto no meio, retoma e reagenda do ponto certo. */
  wake() {
    const ctx = this.ctx
    diag('visible', { state: ctx?.state, playing: useEditor.getState().playing, hidden: document.hidden })
    if (!ctx || document.hidden || !useEditor.getState().playing) return
    if (ctx.state !== 'running') void this.refresh()
    else this.feed(this.position)
  }

  private build(r: ResolvedProject, from: number) {
    const ctx = this.ctx!
    const t0 = ctx.currentTime + 0.08
    this.startedAt = t0
    this.from = from
    const keep = <T extends AudioNode>(n: T) => (this.nodes.push(n), n)

    this.analyser = keep(ctx.createAnalyser())
    this.analyser.fftSize = 2048
    const masterIn = keep(ctx.createGain())
    const masterOut = this.chain(masterIn, r.master.effects, r, from, t0)
    const masterGain = this.gain(r.master.volume, r.master.envelope, from, t0, r.duration)
    masterOut.connect(masterGain)
    masterGain.connect(this.analyser)
    this.analyser.connect(ctx.destination)

    const heard = audibleTracks(r.tracks)
    const inputs = new Map<string, GainNode>()
    for (const t of r.tracks) inputs.set(t.id, keep(ctx.createGain()))
    this.graph = { r, inputs, heard, t0, from, session: this.ticket }
    for (const t of processingOrder(r.tracks)) {
      if (!heard.has(t.id)) continue
      const input = inputs.get(t.id)!
      const fx = this.chain(input, t.effects, r, from, t0, t.id)
      const vol = this.gain(t.volume, t.envelope, from, t0, r.duration)
      const pan = keep(ctx.createStereoPanner())
      pan.pan.value = t.pan
      fx.connect(vol).connect(pan)
      const dest = t.output ? (heard.has(t.output) ? inputs.get(t.output) : null) : masterIn
      if (dest) pan.connect(dest)
    }
    this.feed(from)
  }

  /** Volume + envelope as one gain, with the envelope written as a value curve from `from` on. */
  private gain(volume: number, env: ResolvedPoint[], from: number, t0: number, duration: number): GainNode {
    const ctx = this.ctx!
    const g = ctx.createGain()
    this.nodes.push(g)
    if (env.length === 0) {
      g.gain.value = dbToGain(volume)
      return g
    }
    const rate = 50
    const len = Math.max(2, Math.ceil((duration + 3 - from) * rate))
    const curve = new Float32Array(len)
    for (let i = 0; i < len; i++) curve[i] = dbToGain(volume + envelopeAt(env, from + i / rate))
    g.gain.setValueCurveAtTime(curve, t0, len / rate)
    return g
  }

  /** a tabela do duck espectral vem do servidor (a mesma do render); guardada por faixa + efeito + estado da mix */
  private mascaras = new Map<string, Promise<MascaraEspectral | null>>()

  private mascara(track: string, fx: number, r: ResolvedProject): Promise<MascaraEspectral | null> {
    const t = r.tracks.find((x) => x.id === track)
    const e = t?.effects[fx]
    const src = e && e.type === 'espectral' ? r.tracks.find((x) => x.id === e.source) : undefined
    // muda a faixa, a voz ou os parâmetros: outra tabela
    const key = JSON.stringify([track, fx, e, t?.clips, t?.effects.slice(0, fx), t?.volume, t?.envelope, src?.clips, src?.volume, src?.envelope])
    let p = this.mascaras.get(key)
    if (!p) {
      const c = currentId()
      p = fetch(`/api/espectral?${c ? `c=${encodeURIComponent(c)}&` : ''}track=${encodeURIComponent(track)}&fx=${fx}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((j) => (j ? mascaraDoJson(j) : null))
        .catch(() => null)
      if (this.mascaras.size > 8) this.mascaras.clear()
      this.mascaras.set(key, p)
      void p.then((m) => { if (!m) this.mascaras.delete(key) })
    }
    return p
  }

  private bandasEspectral(): number[] {
    return ESPECTRAL_BANDAS
  }

  private chain(input: AudioNode, effects: Effect[], r: ResolvedProject, from: number, t0: number, track?: string): AudioNode {
    const ctx = this.ctx!
    let cur: AudioNode = input
    const keep = <T extends AudioNode>(n: T) => (this.nodes.push(n), n)
    for (const [index, e] of effects.entries()) {
      if (e.bypass) continue
      switch (e.type) {
        case 'highpass':
        case 'lowpass': {
          const f = keep(ctx.createBiquadFilter())
          f.type = e.type
          f.frequency.value = e.freq
          f.Q.value = 20 * Math.log10(e.q ?? Math.SQRT1_2) // Web Audio takes this Q in dB
          cur = cur.connect(f)
          break
        }
        case 'eq': {
          const f = keep(ctx.createBiquadFilter())
          f.type = 'peaking'
          f.frequency.value = e.freq
          f.gain.value = e.gain
          f.Q.value = e.q ?? 1
          cur = cur.connect(f)
          break
        }
        case 'shelf': {
          const f = keep(ctx.createBiquadFilter())
          f.type = e.kind === 'low' ? 'lowshelf' : 'highshelf'
          f.frequency.value = e.freq
          f.gain.value = e.gain
          cur = cur.connect(f)
          break
        }
        case 'compressor':
        case 'limiter': {
          const c = keep(ctx.createDynamicsCompressor())
          c.knee.value = 0
          c.threshold.value = e.type === 'limiter' ? e.ceiling : e.threshold
          c.ratio.value = e.type === 'limiter' ? 20 : e.ratio
          c.attack.value = e.type === 'limiter' ? 0.001 : (e.attack ?? 0.01)
          c.release.value = e.type === 'limiter' ? 0.08 : (e.release ?? 0.15)
          cur = cur.connect(c)
          if (e.type === 'compressor' && e.makeup) {
            const m = keep(ctx.createGain())
            m.gain.value = dbToGain(e.makeup)
            cur = cur.connect(m)
          }
          break
        }
        case 'duck': {
          const g = keep(ctx.createGain())
          const regions = duckRegions(r, e)
          const rate = 100
          const len = Math.max(2, Math.ceil((r.duration + 3 - from) * rate))
          const curve = new Float32Array(len)
          for (let i = 0; i < len; i++) curve[i] = dbToGain(duckDbAt(regions, e.depth, e.attack ?? 0.08, e.release ?? 0.4, from + i / rate))
          g.gain.setValueCurveAtTime(curve, t0, len / rate)
          cur = cur.connect(g)
          break
        }
        case 'espectral': {
          if (!track) break
          // o banco de peaking entra já (neutro); as curvas de ganho entram quando a tabela chega
          const filtros = (this.bandasEspectral()).map((f) => {
            const b = keep(ctx.createBiquadFilter())
            b.type = 'peaking'
            b.frequency.value = f
            b.Q.value = ESPECTRAL_Q
            b.gain.value = 0
            cur = cur.connect(b)
            return b
          })
          const session = this.ticket
          void this.mascara(track, index, r).then((m) => {
            if (!m || session !== this.ticket || !this.ctx) return
            const rate = 1 / m.passo
            const agora = Math.max(t0, this.ctx.currentTime + 0.05)
            const desde = from + (agora - t0)
            const len = Math.max(2, Math.ceil((r.duration + 3 - desde) * rate))
            const att = new Float32Array(m.bandas.length)
            const curvas = filtros.map(() => new Float32Array(len))
            for (let i = 0; i < len; i++) {
              atenuacaoEm(m, desde + i / rate, att)
              for (let b = 0; b < filtros.length; b++) curvas[b][i] = -att[b] * ESPECTRAL_FATOR
            }
            filtros.forEach((f, b) => f.gain.setValueCurveAtTime(curvas[b], agora, len / rate))
          })
          break
        }
        case 'reverb': {
          const key = `${ctx.sampleRate}:${e.seconds ?? 2.5}`
          let ir = this.irs.get(key)
          if (!ir) {
            const [l, rr] = freeverbImpulse(ctx.sampleRate, e.seconds ?? 2.5)
            ir = ctx.createBuffer(2, l.length, ctx.sampleRate)
            ir.copyToChannel(l as Float32Array<ArrayBuffer>, 0)
            ir.copyToChannel(rr as Float32Array<ArrayBuffer>, 1)
            this.irs.set(key, ir)
          }
          const conv = keep(ctx.createConvolver())
          conv.normalize = false
          conv.buffer = ir
          const dry = keep(ctx.createGain())
          const wet = keep(ctx.createGain())
          const sum = keep(ctx.createGain())
          dry.gain.value = 1 - e.mix
          wet.gain.value = e.mix
          cur.connect(dry).connect(sum)
          cur.connect(conv).connect(wet).connect(sum)
          cur = sum
          break
        }
      }
    }
    return cur
  }
}

export const engine = new Engine()
document.addEventListener('visibilitychange', () => engine.wake())
