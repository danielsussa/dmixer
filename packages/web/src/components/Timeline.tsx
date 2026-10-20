import { useEffect, useMemo, useRef, useState } from 'react'
import {
  dbToGain, duckRegions, FAIXA_HUMOR, HUMORES, formatTime, isSamplerTrack, isTimeExpression, round,
  type Point, type ResolvedClip, type ResolvedProject, type ResolvedRegion, type ResolvedTrack, CORES_FUNCAO } from '@dmixer/core'
import { acervoProntas, gradeDaMusica, importAudio, loadAcervo, P, patch, pontoDaMusica } from '../api'
import { editable, splitAt } from '../tools'
import { engine } from '../audio'
import { useEditor } from '../store'
import { Wave } from './Wave'
import { VideoBody } from './Viewer'
import { cx, Icon, IconButton } from './ui'
import { coberturas, cortarOps, DRAG_TYPE, dropPiece, encaixeNoCorte, freeStart, isLibraryPiece, juntasOps, libraryItemsById, pecasDaTrilha, refitComplement, restaurarSoltos, useLibraryItems } from './Library'
import { LaneConnectors } from './Connectors'

const alpha = (hex: string, a: number) => {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`
}
import { TrackHeader } from './TrackHeader'

const HEADER = 264
const RULER = 30
const ROW = 96
const BUS_ROW = 84
const DB_TOP = 6
const DB_BOTTOM = -48
const SNAP_PX = 8
const LANE = 34
const CLIP_HEAD = 18

const rowHeight = (t: ResolvedTrack) => (t.type === 'bus' ? BUS_ROW : ROW)
const dbToY = (db: number, h: number) => ((DB_TOP - Math.max(DB_BOTTOM, Math.min(DB_TOP, db))) / (DB_TOP - DB_BOTTOM)) * h
const yToDb = (y: number, h: number) => round(DB_TOP - (y / h) * (DB_TOP - DB_BOTTOM), 1)

type Drag =
  | { kind: 'clip'; mode: 'move' | 'left' | 'right'; track: ResolvedTrack; clip: ResolvedClip; x0: number; y0: number; dx: number; toTrack: string }
  | { kind: 'marker'; id: string; x0: number; at: number; dx: number }
  | { kind: 'region'; mode: 'move' | 'left' | 'right'; region: ResolvedRegion; x0: number; dx: number; toLane: string }
  | { kind: 'point'; track: ResolvedTrack; index: number; x0: number; y0: number; at: number; db: number; dx: number; dy: number }
  | { kind: 'scrub' }
  | null

export function Timeline() {
  const resolved = useEditor((s) => s.resolved)
  const project = useEditor((s) => s.project)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const automation = useEditor((s) => s.automation)
  const snap = useEditor((s) => s.snap)
  const scroller = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; trackId: string | null } | null>(null)
  const dragRef = useRef<Drag>(null)
  dragRef.current = drag

  const width = Math.max(1200, ((resolved?.duration ?? 60) + 20) * zoom)

  // zoom com gesto, sempre centrado onde está o cursor (ou entre os dedos):
  //   • a roda do mouse sozinha (Shift+roda e a roda lateral rolam para os lados; Alt+roda rola as trilhas);
  //   • roda com Ctrl/⌘, e a pinça do trackpad (no Chrome ela chega como roda com Ctrl, em passos pequenos): proporcional;
  //   • a pinça do trackpad no Safari (eventos gesture*);
  //   • dois dedos numa tela de toque (iPad, celular na visão de editor).
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const zoomAt = (clientX: number, z: number) => {
      const s = useEditor.getState()
      const px = clientX - el.getBoundingClientRect().left - HEADER
      const t = (el.scrollLeft + px) / s.zoom
      s.setZoom(z)
      requestAnimationFrame(() => (el.scrollLeft = t * useEditor.getState().zoom - px))
    }
    const onWheel = (e: WheelEvent) => {
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY   // linhas → pixels
      // roda de mouse (como no REAPER): sozinha dá zoom; Shift rola para os lados (o navegador já faz); Alt rola as trilhas.
      // A roda lateral (deltaX) rola para os lados sozinha. O trackpad (deltas pequenos, quebrados, com deltaX) segue
      // rolando normal e dá zoom só com a pinça/Ctrl. Um clique de roda chega como linhas (Firefox) ou ~100 px inteiros.
      const mouse = e.deltaMode === 1 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 40 && Number.isInteger(e.deltaY))
      if (mouse && e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault()
        el.scrollTop += d
        return
      }
      if (!(e.ctrlKey || e.metaKey || (mouse && !e.shiftKey && !e.altKey))) return
      e.preventDefault()
      // a pinça manda deltas pequenos e seguidos (zoom suave); um clique da roda do mouse (~100) vale ~15%
      const f = Math.min(1.25, Math.max(1 / 1.25, Math.exp(-d * 0.0035)))
      zoomAt(e.clientX, useEditor.getState().zoom * f)
    }
    let z0 = 0
    const gStart = (e: Event) => { e.preventDefault(); z0 = useEditor.getState().zoom }
    const gChange = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number }
      if (z0) zoomAt(g.clientX, z0 * g.scale)
    }
    const gEnd = (e: Event) => { e.preventDefault(); z0 = 0 }
    // dois dedos: a razão entre a distância atual e a inicial, a partir do zoom de quando o segundo dedo encostou
    const toques = new Map<number, { x: number; y: number }>()
    let pinca: { dist: number; zoom: number } | null = null
    const dist = () => { const [a, b] = [...toques.values()]; return Math.hypot(a.x - b.x, a.y - b.y) }
    const meio = () => { const [a, b] = [...toques.values()]; return (a.x + b.x) / 2 }
    const pDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return
      toques.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (toques.size === 2) {
        pinca = { dist: dist(), zoom: useEditor.getState().zoom }
        setDrag(null)   // o primeiro dedo pode ter começado a arrastar um clipe: com dois, é zoom
      }
    }
    const pMove = (e: PointerEvent) => {
      if (!toques.has(e.pointerId)) return
      toques.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pinca && toques.size === 2) {
        e.preventDefault()
        zoomAt(meio(), pinca.zoom * (dist() / Math.max(1, pinca.dist)))
      }
    }
    const pUp = (e: PointerEvent) => { toques.delete(e.pointerId); if (toques.size < 2) pinca = null }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('gesturestart', gStart as EventListener)
    el.addEventListener('gesturechange', gChange as EventListener)
    el.addEventListener('gestureend', gEnd as EventListener)
    el.addEventListener('pointerdown', pDown, true)
    el.addEventListener('pointermove', pMove, { capture: true, passive: false })
    el.addEventListener('pointerup', pUp, true)
    el.addEventListener('pointercancel', pUp, true)
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('gesturestart', gStart as EventListener)
      el.removeEventListener('gesturechange', gChange as EventListener)
      el.removeEventListener('gestureend', gEnd as EventListener)
      el.removeEventListener('pointerdown', pDown, true)
      el.removeEventListener('pointermove', pMove, true)
      el.removeEventListener('pointerup', pUp, true)
      el.removeEventListener('pointercancel', pUp, true)
    }
    // a área de rolagem só existe depois que a mixagem carrega ("carregando…" antes): liga os gestos quando ela aparece
  }, [!!resolved])

  // keep the playhead in view while playing
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  useEffect(() => {
    const el = scroller.current
    if (!el || !playing) return
    const x = playhead * zoom
    const view = el.clientWidth - HEADER
    if (x < el.scrollLeft || x > el.scrollLeft + view - 40) el.scrollLeft = Math.max(0, x - view * 0.15)
  }, [playhead, playing, zoom])

  const snapTimes = useMemo(() => {
    if (!resolved) return []
    const out: number[] = [0, ...resolved.markers.map((m) => m.at)]
    // a library piece is joined where its body ends (its tail rings over the next one), not at the end of the file
    for (const t of resolved.tracks) for (const c of t.clips) out.push(c.start, c.bodyEnd)
    for (const g of resolved.regions) out.push(g.start, g.end)
    return out
  }, [resolved])

  const snapGrid = useEditor((s) => s.snapGrid)
  /**
   * SNAP. Off (or Alt held): free, to the millisecond. On: edges of other clips and tags,
   * markers and the playhead win when they are within a few pixels — so pieces butt
   * together; otherwise the time lands on the grid (bar or beat). With `dur`, the end of
   * what is being moved may grab an edge too.
   */
  const snapTo = (t: number, alt: boolean, exclude?: ResolvedClip, dur?: number): number => {
    if (snapGrid === 'off' || alt || !resolved) return round(t)
    const tol = SNAP_PX / zoom
    const cands = [...(exclude ? snapTimes.filter((x) => x !== exclude.start && x !== exclude.bodyEnd) : snapTimes), useEditor.getState().playhead]
    let best: number | null = null
    let bestD = tol
    for (const x of cands) {
      const d = Math.abs(x - t)
      if (d < bestD) { best = x; bestD = d }
      if (dur !== undefined) {
        const de = Math.abs(x - (t + dur))
        if (de < bestD) { best = x - dur; bestD = de }
      }
    }
    if (best !== null) return round(Math.max(0, best))
    const step = (60 / (resolved.bpm ?? 72)) * (snapGrid === 'bar' ? resolved.meter : 1)
    const g0 = resolved.gridOffset
    return round(Math.max(0, g0 + Math.round((t - g0) / step) * step))
  }

  // global pointer handling for drags
  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d) return
      if (d.kind === 'clip') {
        const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-track]') as HTMLElement | null
        const toTrack = d.mode === 'move' && over?.dataset.kind === kindOf(d.track) ? over.dataset.track! : d.track.id   // samplers só entre trilhas de samplers
        setDrag({ ...d, dx: e.clientX - d.x0, toTrack })
      } else if (d.kind === 'marker') setDrag({ ...d, dx: e.clientX - d.x0 })
      else if (d.kind === 'region') {
        const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest('[data-lane]') as HTMLElement | null
        setDrag({ ...d, dx: e.clientX - d.x0, toLane: d.mode === 'move' && over ? over.dataset.lane! : d.toLane })
      }
      else if (d.kind === 'point') setDrag({ ...d, dx: e.clientX - d.x0, dy: e.clientY - d.y0 })
      else if (d.kind === 'scrub') scrubAt(e.clientX)
    }
    const up = (e: PointerEvent) => {
      const d = dragRef.current
      setDrag(null)
      if (d) void commit(d, e.altKey)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up, { once: true })
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
  }, [drag?.kind])

  const scrubAt = (clientX: number) => {
    const el = scroller.current!
    const x = clientX - el.getBoundingClientRect().left - HEADER + el.scrollLeft
    const t = Math.max(0, x / useEditor.getState().zoom)
    useEditor.getState().setPlayhead(t)
  }

  const commit = async (d: NonNullable<Drag>, alt: boolean) => {
    if (!project || !resolved) return
    if (d.kind === 'scrub') {
      if (useEditor.getState().playing) void engine.play(useEditor.getState().playhead)
      return
    }
    if (d.kind === 'clip') {
      if (Math.abs(d.dx) < 2 && d.toTrack === d.track.id) return
      const c = d.clip
      const dt = d.dx / zoom
      const path = P.clip(d.track.id, c.id)
      if (d.mode === 'move') {
        const len = c.bodyEnd - c.start
        let start = Math.max(0, snapTo(c.start + dt, alt, c, len))
        const alvo = resolved.tracks.find((t) => t.id === d.toTrack)
        let corte: { clip: ResolvedClip; at: number } | null = null
        if (alvo?.samplers) {
          const bar = (60 / (project.project.bpm ?? 72)) * (project.project.meter ?? 4)
          // solta dentro da anterior, perto de um ponto de corte medido: entra ali, e a anterior termina ali
          const enc = encaixeNoCorte(alvo, libraryItemsById(), c.start + dt, len, bar, alvo.id === d.track.id ? c.id : undefined)
          if (enc) {
            start = enc.start
            corte = enc.cut
          } else {
            // lego: as peças não se sobrepõem; a solta em cima de outra vai para o encaixe livre mais próximo
            const others = alvo.clips.filter((x) => !(alvo.id === d.track.id && x.id === c.id)).map((x) => ({ start: x.start, end: x.bodyEnd }))
            start = round(freeStart(others, start, len))
          }
        } else if (alvo?.quebra) {
          // quebra-cabeça: a peça não cai em cima de outra; solta perto do fim de uma, cola nela
          const others = alvo.clips.filter((x) => !(alvo.id === d.track.id && x.id === c.id)).map((x) => ({ start: x.start, end: x.bodyEnd }))
          const want = c.start + dt
          const ima = others.map((o) => o.end).filter((e) => Math.abs(e - want) < 1.5).sort((a, b) => Math.abs(a - want) - Math.abs(b - want))[0]
          start = round(freeStart(others, ima ?? want, len))
        }
        if (Math.abs(start - c.start) < 0.001 && d.toTrack === d.track.id) return
        const ops: { op: 'add' | 'replace' | 'remove'; path: string; value?: unknown }[] = d.toTrack !== d.track.id
          ? [{ op: 'remove', path }, { op: 'add', path: `${P.track(d.toTrack)}/clips/-`, value: { ...c.raw, start } }]
          : [{ op: 'replace', path: `${path}/start`, value: start }]
        if (corte) ops.push(...cortarOps(d.toTrack, corte.clip.raw, corte.at))
        // quebra-cabeça: as juntas da trilha de onde a peça saiu e da que ela entrou se refazem (vizinhas sem fade, pulo
        // com crossfade de cauda)
        for (const tid of new Set([d.track.id, d.toTrack])) {
          if (!resolved.tracks.find((x) => x.id === tid)?.quebra) continue
          const pecas = pecasDaTrilha(project, tid, c.id)
          if (tid === d.toTrack) {
            pecas.push({ id: c.id, asset: c.asset, start, inP: c.in, body: c.raw.body ?? c.out, out: c.out, fadeIn: c.raw.fade_in, fadeOut: c.raw.fade_out, head: c.raw.head,
              durArquivo: project.assets[c.asset]?.meta?.duration ?? c.out, bpm: acervoProntas.get(c.src)?.bpm })
          }
          ops.push(...juntasOps(project, tid, pecas))
        }
        // as peças cortadas que ficaram sem ninguém no ponto de corte voltam inteiras (arrastar de volta desfaz)
        for (const t of resolved.tracks.filter((x) => x.samplers && (x.id === d.toTrack || x.id === d.track.id))) {
          const depois = t.clips.filter((x) => !(t.id === d.track.id && x.id === c.id) && x.id !== corte?.clip.id)
            .map((x) => ({ id: x.id, start: x.start, bodyEnd: x.bodyEnd, raw: x.raw }))
          const vizinhos = [...depois]
          if (t.id === d.toTrack) vizinhos.push({ id: c.id, start, bodyEnd: start + len, raw: c.raw })
          if (corte && t.id === d.toTrack) vizinhos.push({ id: corte.clip.id, start: corte.clip.start, bodyEnd: corte.clip.start + corte.at - corte.clip.in, raw: { ...corte.clip.raw, body: corte.at } })
          ops.push(...restaurarSoltos(t.id, vizinhos).filter((o) => !o.path.includes(`[id=${corte?.clip.id}]`)))
        }
        await patch(ops as never, corte ? `Encaixar ${c.id} no compasso ${Math.round(corte.at / ((60 / (project.project.bpm ?? 72)) * 4))} de ${corte.clip.id}` : `Move ${c.id}`)
      } else if (libraryItemsById().get(c.asset)?.role === 'complemento') {
        // complemento: as bordas andam em compassos inteiros e a camada é gerada de novo no novo tamanho, sobre as bases de baixo
        const it = libraryItemsById().get(c.asset)!
        const bar = (60 / (project.project.bpm ?? 72)) * (project.project.meter ?? 4)
        const fim = c.bodyEnd
        let ini = c.start
        let fimNovo = fim
        if (d.mode === 'left') ini = c.start + Math.round(dt / bar) * bar
        else fimNovo = fim + Math.round(dt / bar) * bar
        // não invade o vizinho da mesma trilha (lego: nada se sobrepõe)
        const viz = d.track.clips.filter((x) => x.id !== c.id)
        const antes = Math.max(0, ...viz.filter((x) => x.bodyEnd <= c.start + 0.01).map((x) => x.bodyEnd))
        const depois = Math.min(Infinity, ...viz.filter((x) => x.start >= fim - 0.01).map((x) => x.start))
        ini = Math.max(ini, c.start - Math.floor((c.start - antes + 0.01) / bar) * bar)
        fimNovo = Math.min(fimNovo, fim + Math.floor((depois - fim + 0.01) / bar) * bar)
        let bars = Math.max(it.min_bars ?? 1, Math.round((fimNovo - ini) / bar))
        if (d.mode === 'right' && c.start + bars * bar > depois + 0.01) bars = Math.max(it.min_bars ?? 1, Math.floor((depois - c.start + 0.01) / bar))
        if (d.mode === 'left') ini = fim - bars * bar
        if (ini < 0) return
        if (bars === Math.round((fim - c.start) / bar) && Math.abs(ini - c.start) < 0.01) return
        await refitComplement(project, d.track.id, c.id, bars, round(ini))
      } else if (d.mode === 'left') {
        // uma música analisada: a borda anda na grade dela (encurtar e alongar), não na da mixagem
        const newStart = (alt ? null : pontoDaMusica(c, c.start + dt, snapGrid)) ?? snapTo(c.start + dt, alt, c)
        const delta = Math.max(-c.in, Math.min(c.duration - 0.02, newStart - c.start))
        await patch([
          { op: 'replace', path: `${path}/start`, value: round(c.start + delta) },
          { op: 'replace', path: `${path}/in`, value: round(c.in + delta) },
          ...(c.raw.out === undefined ? [{ op: 'replace' as const, path: `${path}/out`, value: round(c.out) }] : []),
        ], `Trim ${c.id}`)
      } else {
        const newEnd = (alt ? null : pontoDaMusica(c, c.end + dt, snapGrid)) ?? snapTo(c.end + dt, alt, c)
        const fileDur = project.assets[c.asset]?.meta?.duration ?? Infinity
        const out = Math.min(fileDur, Math.max(c.in + 0.02, c.out + (newEnd - c.end)))
        await patch([{ op: 'replace', path: `${path}/out`, value: round(out) }], `Trim ${c.id}`)
      }
    } else if (d.kind === 'region') {
      const g = d.region
      if (Math.abs(d.dx) < 2 && d.toLane === g.lane) return
      const dt = d.dx / zoom
      const path = P.region(g.id)
      const ops: { op: 'replace' | 'add'; path: string; value: unknown }[] = []
      if (d.mode === 'move') {
        const start = Math.max(0, snapTo(g.start + dt, alt, undefined, g.end - g.start))
        ops.push({ op: 'replace', path: `${path}/start`, value: start }, { op: 'replace', path: `${path}/end`, value: round(start + g.end - g.start) })
        if (d.toLane !== g.lane) ops.push({ op: g.raw.lane === undefined ? 'add' : 'replace', path: `${path}/lane`, value: d.toLane })
      } else if (d.mode === 'left') ops.push({ op: 'replace', path: `${path}/start`, value: Math.min(g.end - 0.1, Math.max(0, snapTo(g.start + dt, alt))) })
      else ops.push({ op: 'replace', path: `${path}/end`, value: Math.max(g.start + 0.1, snapTo(g.end + dt, alt)) })
      await patch(ops, `Tag ${g.id}`)
    } else if (d.kind === 'marker') {
      if (Math.abs(d.dx) < 2) return
      await patch([{ op: 'replace', path: `${P.marker(d.id)}/at`, value: Math.max(0, snapTo(d.at + d.dx / zoom, alt)) }], `Move marker ${d.id}`)
    } else if (d.kind === 'point') {
      if (Math.abs(d.dx) < 2 && Math.abs(d.dy) < 2) return
      const h = rowHeight(d.track)
      const pts = [...(d.track.raw.automation?.volume ?? [])] as Point[]
      const rawIdx = d.track.envelope[d.index].index
      const at = Math.max(0, snapTo(d.at + d.dx / zoom, alt))
      const db = yToDb(dbToY(d.db, h) + d.dy, h)
      pts[rawIdx] = { ...pts[rawIdx], at, db }
      await patch([{ op: 'replace', path: `${P.track(d.track.id)}/automation/volume`, value: pts }], `Envelope ${d.track.id}`)
    }
  }

  const loadError = useEditor((s) => s.loadError)
  if (!resolved) return <div className="flex-1 grid place-items-center text-[var(--muted)]">{loadError ? <span className="text-red-400">{loadError}</span> : 'carregando…'}</div>

  const rows = resolved.tracks
  const lanes = resolved.lanes.length ? resolved.lanes : []
  const totalH = RULER + lanes.length * LANE + rows.reduce((n, t) => n + rowHeight(t), 0) + 56

  return (
    <div ref={scroller} data-timeline style={{ touchAction: 'pan-x pan-y' }} className="flex-1 overflow-auto relative bg-ink-950"
      onDragOver={(e) => { if (e.dataTransfer.types.includes(DRAG_TYPE) || e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' } }}
      onDrop={(e) => {
        if (!project) return
        const el = scroller.current!
        const t = Math.max(0, (e.clientX - el.getBoundingClientRect().left - HEADER + el.scrollLeft) / zoom)
        const row = (e.target as HTMLElement).closest('[data-track]') as HTMLElement | null
        // an audio file from the computer: onto the audio track under the pointer
        const fotos = [...e.dataTransfer.files].filter((f) => PICTURE_FILE.test(f.name))
        if (fotos.length) {
          e.preventDefault()
          if (row?.dataset.kind !== 'video') return alert('Solte a foto ou o vídeo sobre uma trilha de vídeo.')
          void (async () => { let at = snapTo(t, e.altKey); for (const f of fotos) { await importAudio(f, row.dataset.track!, at); at += 4 } })()
          return
        }
        const files = [...e.dataTransfer.files].filter((f) => AUDIO_FILE.test(f.name))
        if (files.length) {
          e.preventDefault()
          if (row?.dataset.kind !== 'audio') return alert('Solte o arquivo de áudio sobre uma trilha de áudio.')
          void (async () => { for (const f of files) await importAudio(f, row.dataset.track!, snapTo(t, e.altKey)) })()
          return
        }
        const data = e.dataTransfer.getData(DRAG_TYPE)
        if (!data) return
        e.preventDefault()
        void dropPiece(project, data, t, row?.dataset.kind === 'samplers' ? row.dataset.track! : null, e.altKey ? 'off' : snapGrid,
          row?.dataset.kind === 'quebra' || row?.dataset.kind === 'audio' ? row.dataset.track! : null)
      }}>
      <div className="flex flex-col" style={{ width: width + HEADER, minHeight: `max(${totalH}px, 100%)`, position: 'relative' }}>
        {/* ruler */}
        <div className="sticky top-0 z-20 flex" style={{ height: RULER }}>
          <div className="sticky left-0 z-30 border-r border-b border-white/[0.05] bg-ink-900 px-2 flex items-center gap-2" style={{ width: HEADER, minWidth: HEADER }}>
            <span className="flex-1 text-[11px] uppercase tracking-wider text-ink-400 pl-1">{resolved.lanes.length ? 'Tags' : 'Trilhas'}</span>
            <IconButton className="h-6 min-w-6 gap-1 px-2 text-[11px]" title="nova faixa de tags" onClick={() => addLane(project, resolved)}>
              <Icon.Plus size={12} /> tags
            </IconButton>
          </div>
          <Ruler r={resolved} zoom={zoom} width={width} drag={drag} setDrag={setDrag} onScrub={(x) => { scrubAt(x); setDrag({ kind: 'scrub' }) }} />
        </div>

        {lanes.map((l) => (
          <div key={l.id} className="flex border-b border-white/[0.04]" style={{ height: LANE }} data-lane={l.id}>
            <div className={cx('sticky left-0 z-10 border-r border-white/[0.05] px-3 flex items-center gap-2 cursor-default', selection?.kind === 'lane' && selection.laneId === l.id ? 'bg-ink-850' : 'bg-ink-900')}
              style={{ width: HEADER, minWidth: HEADER }} onPointerDown={() => useEditor.getState().select({ kind: 'lane', laneId: l.id })}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, trackId: null }) }}>
              <span className="text-[12.5px] text-ink-100 truncate flex-1">{l.name}</span>
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-ink-400">TAGS</span>
            </div>
            <TagLane r={resolved} lane={l.id} zoom={zoom} width={width} drag={drag} setDrag={setDrag} snapTo={snapTo} />
          </div>
        ))}

        {rows.map((t) => (
          <div key={t.id} className="flex border-b border-white/[0.04]" style={{ height: rowHeight(t) }} data-track={t.id} data-kind={kindOf(t)}>
            <div className="sticky left-0 z-10" style={{ width: HEADER, minWidth: HEADER }}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, trackId: t.id }) }}>
              <TrackHeader track={t} />
            </div>
            <Lane r={resolved} t={t} zoom={zoom} width={width} selection={selection} drag={drag} setDrag={setDrag}
              editEnvelope={!!automation[t.id]} snapTo={snapTo} />
          </div>
        ))}

        <div className="flex" style={{ flex: '1 0 56px' }}>
          <div className="sticky left-0 z-10 bg-ink-950 border-r border-white/[0.05] px-2 pt-2" style={{ width: HEADER, minWidth: HEADER }}
            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, trackId: null }) }}>
            <button type="button" className="flex items-center gap-2 text-ink-400 hover:text-ink-100 rounded-lg px-3 py-2 hover:bg-white/[0.04] text-[13px]"
              onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 4, trackId: null }) }}>
              <Icon.Plus size={14} /> Nova trilha
            </button>
          </div>
          <div className="flex-1 flex items-center pl-4 text-[11.5px] text-ink-500">solte uma peça da biblioteca em qualquer lugar: ela vai para a trilha de samplers · arraste um mp3/wav do computador para uma trilha de áudio para importá-lo</div>
        </div>

        {/* markers cross every lane */}
        {resolved.markers.map((m) => (
          <div key={m.id} className="absolute z-[5] pointer-events-none" style={{
            left: HEADER + m.at * zoom + (drag?.kind === 'marker' && drag.id === m.id ? drag.dx : 0), top: RULER, height: totalH - RULER, width: 0,
            borderLeft: `2px dashed ${m.color ?? '#e5b84d'}aa`,
          }} />
        ))}

        {/* playhead */}
        <Playhead height={totalH} zoom={zoom} scroller={scroller} />
        {menu && project && <TrackMenu at={menu} project={project} close={() => setMenu(null)} />}
      </div>
    </div>
  )
}

/**
 * The needle. It lives in the scrolled content, so once the view scrolls past it to the
 * left it would slide over the sticky track headers: it is hidden there instead.
 */
function Playhead({ height, zoom, scroller }: { height: number; zoom: number; scroller: React.RefObject<HTMLDivElement | null> }) {
  const t = useEditor((s) => s.playhead)
  const [scrollLeft, setScrollLeft] = useState(0)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const on = () => setScrollLeft(el.scrollLeft)
    on()
    el.addEventListener('scroll', on)
    return () => el.removeEventListener('scroll', on)
  }, [scroller])
  if (t * zoom < scrollLeft - 1) return null
  return (
    <div className="absolute top-0 z-30 pointer-events-none" style={{ left: HEADER + t * zoom, height, width: 0 }}>
      <div className="sticky top-0 -ml-[6px] w-0 h-0 border-x-[6px] border-x-transparent border-t-[8px] border-t-white" />
      <div className="absolute top-0 bottom-0 -ml-px w-px bg-white" />
    </div>
  )
}

function Ruler({ r, zoom, width, drag, setDrag, onScrub }: {
  r: ResolvedProject; zoom: number; width: number; drag: Drag; setDrag: (d: Drag) => void; onScrub: (clientX: number) => void
}) {
  const select = useEditor((s) => s.select)
  const selection = useEditor((s) => s.selection)
  // tick spacing that keeps labels ~80 px apart
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
  const step = steps.find((s) => s * zoom >= 80) ?? 600
  const ticks: number[] = []
  for (let t = 0; t * zoom < width; t += step) ticks.push(round(t, 2))
  const bars: number[] = []
  if (r.bpm) {
    const bar = (60 / r.bpm) * r.meter
    if (bar * zoom >= 6) for (let t = r.gridOffset; t * zoom < width; t += bar) bars.push(t)
  }
  return (
    <div className="relative border-b border-white/[0.05] bg-ink-900 cursor-text" style={{ width, height: RULER }}
      onPointerDown={(e) => { if (e.button === 0 && !(e.target as HTMLElement).closest('[data-marker]')) onScrub(e.clientX) }}>
      {bars.map((t, i) => {
        const every = Math.max(1, Math.ceil(56 / (((60 / r.bpm!) * r.meter) * zoom)))
        const labelled = i % every === 0
        return (
          <div key={`b${i}`} className="absolute bottom-0" style={{ left: t * zoom }}>
            <div className={labelled ? 'w-px h-[14px] bg-ink-400' : 'w-px h-[7px] bg-ink-600'} />
            {labelled && <span className="absolute left-1 bottom-[2px] font-mono text-[10.5px] text-ink-300">{i + 1}</span>}
          </div>
        )
      })}
      {!r.bpm && ticks.map((t) => (
        <div key={t} className="absolute bottom-0" style={{ left: t * zoom }}>
          <div className="w-px h-[14px] bg-ink-400" />
          <span className="absolute left-1 bottom-[2px] font-mono text-[10.5px] text-ink-300">{formatTime(t, step < 1 ? 1 : 0)}</span>
        </div>
      ))}
      {r.markers.map((m) => {
        const dx = drag?.kind === 'marker' && drag.id === m.id ? drag.dx : 0
        const sel = selection?.kind === 'marker' && selection.markerId === m.id
        return (
          <div key={m.id} data-marker className="absolute top-[2px] flex items-center gap-1 cursor-ew-resize" style={{ left: m.at * zoom + dx }}
            title={`${m.id} · ${formatTime(m.at, 2)}`}
            onPointerDown={(e) => {
              e.stopPropagation()
              select({ kind: 'marker', markerId: m.id })
              setDrag({ kind: 'marker', id: m.id, x0: e.clientX, at: m.at, dx: 0 })
            }}>
            <div style={{ width: 2, height: 12, background: m.color ?? '#f2c14e' }} />
            <div className={`text-[10px] px-1.5 rounded whitespace-nowrap ${sel ? 'bg-amber-300 text-black' : 'bg-amber-300/15 text-amber-200'}`}>
              {m.label ?? m.id}
            </div>
          </div>
        )
      })}
    </div>
  )
}

function Lane({ r, t, zoom, width, selection, drag, setDrag, editEnvelope, snapTo }: {
  r: ResolvedProject; t: ResolvedTrack; zoom: number; width: number; selection: ReturnType<typeof useEditor.getState>['selection']
  drag: Drag; setDrag: (d: Drag) => void; editEnvelope: boolean; snapTo: (t: number, alt: boolean, exclude?: ResolvedClip, dur?: number) => number
}) {
  const select = useEditor((s) => s.select)
  const cutting = useEditor((s) => s.tool === 'cut')
  const jump = useEditor((s) => s.jumpHover)
  const snapGrid = useEditor((s) => s.snapGrid)
  useEditor((s) => s.analysisTick)   // redesenha quando chega a análise de uma música
  const libItems = useLibraryItems()
  const project = useEditor((s) => s.project)
  // músicas que vieram do acervo: as peças dele (função, energia, humor) aparecem no clipe. O analisador antigo
  // (analyze.py: grade e SNAP da música) é legado: não roda mais sozinho, só quando uma ferramenta do inspetor pede.
  useEffect(() => {
    for (const c of t.clips) {
      // veio do acervo? as peças dele (função, energia, humor) aparecem no clipe
      if (t.type === 'audio' && !libItems.has(c.asset) && (project?.assets[c.asset]?.meta?.duration ?? 0) >= 30) void loadAcervo(c.src).catch(() => {})
    }
  }, [t.clips, libItems, project])
  const h = rowHeight(t)
  const ducks = t.effects.filter((e) => e.type === 'duck' && !e.bypass)
  const regions = useMemo(() => ducks.flatMap((e) => (e.type === 'duck' ? duckRegions(r, e) : [])), [r, t])
  const laneRef = useRef<HTMLDivElement>(null)

  const addPoint = async (e: React.MouseEvent) => {
    const rect = laneRef.current!.getBoundingClientRect()
    const at = snapTo((e.clientX - rect.left) / zoom, e.altKey)
    const db = yToDb(e.clientY - rect.top, h)
    const pts = [...(t.raw.automation?.volume ?? []), { at, db }]
    const op = t.raw.automation
      ? { op: 'replace' as const, path: `${P.track(t.id)}/automation/volume`, value: pts }
      : { op: 'add' as const, path: `${P.track(t.id)}/automation`, value: { volume: pts } }
    await patch([op], `Envelope point on ${t.id}`)
  }

  return (
    <div ref={laneRef} className="relative" style={{ width, height: h, background: t.type === 'bus' ? 'rgba(255,255,255,0.015)' : undefined }}
      onPointerDown={(e) => {
        if (e.target === laneRef.current) select({ kind: 'track', trackId: t.id })
      }}
      onDoubleClick={(e) => { if (editEnvelope) void addPoint(e) }}>
      {regions.map(([a, b], i) => (
        <div key={i} className="absolute top-0 pointer-events-none" title="duck"
          style={{ left: a * zoom, width: (b - a) * zoom, height: h, background: 'repeating-linear-gradient(135deg, #ffffff08 0 4px, transparent 4px 8px)' }} />
      ))}
      {t.clips.map((c) => {
        const d = drag?.kind === 'clip' && drag.clip.id === c.id && drag.track.id === t.id ? drag : null
        const dt = d ? d.dx / zoom : 0
        let start = c.start
        // peça da biblioteca: o bloco mostra só o corpo (é o que encaixa); a cauda soa por baixo da próxima, sem aparecer
        const corpo = (libItems.has(c.asset) || t.quebra) && c.bodyEnd < c.end - 0.01
        let dur = corpo ? c.bodyEnd - c.start : c.duration
        let from = c.in
        if (d?.mode === 'move') start = Math.max(0, snapTo(c.start + dt, false, c, c.bodyEnd - c.start))
        // a prévia das bordas já gruda onde vai cair: na grade da música, se for uma música analisada
        const dtL = d?.mode === 'left' ? (pontoDaMusica(c, c.start + dt, snapGrid) ?? c.start + dt) - c.start : dt
        const dtR = d?.mode === 'right' ? (pontoDaMusica(c, c.end + dt, snapGrid) ?? c.end + dt) - c.end : dt
        if (d?.mode === 'left') {
          const delta = Math.max(-c.in, Math.min(c.duration - 0.02, dtL))
          start = c.start + delta
          dur = c.duration - delta
          from = c.in + delta
        }
        if (d?.mode === 'right') dur = Math.max(0.02, (corpo ? c.bodyEnd - c.start : c.duration) + dtR)
        const sel = selection?.kind === 'clip' && selection.clipId === c.id && selection.trackId === t.id
        const w = Math.max(2, dur * zoom)
        const anchored = isTimeExpression(c.raw.start)
        // peças da biblioteca só movem; complementos esticam pelas bordas (são refeitos no novo tamanho)
        const locked = (isLibraryPiece(c.asset) && libItems.get(c.asset)?.role !== 'complemento') || t.quebra
        return (
          <div key={c.id}
            className={cx('absolute top-[4px] rounded-md overflow-hidden', cutting ? (editable(c) && t.type !== 'video' ? 'cursor-crosshair' : 'cursor-not-allowed') : 'cursor-grab active:cursor-grabbing', sel ? 'ring-[1.5px] ring-white' : 'ring-1 ring-black/40',
              editEnvelope && 'pointer-events-none opacity-60', d && 'shadow-xl shadow-black/50 z-20')}
            style={{
              left: start * zoom, width: w, height: h - 8,
              background: alpha(t.color, c.muted ? 0.07 : 0.18),
              opacity: d && d.toTrack !== t.id ? 0.4 : c.muted ? 0.5 : undefined,
            }}
            title={`${c.label ?? c.id}\n${formatTime(c.start, 2)} → ${formatTime(c.end, 2)}${anchored ? `\nancorado: ${c.raw.start}` : ''}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              select({ kind: 'clip', trackId: t.id, clipId: c.id })
              const local = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left
              // cut tool: the clip splits where it was clicked (on the grid, unless Alt)
              if (cutting) {
                const at = c.start + local / zoom
                // uma música analisada corta na grade DELA (as batidas e compassos dela), não na da mixagem
                const grade = snapGrid !== 'off' ? gradeDaMusica(c, snapGrid === 'bar' ? 'bar' : 'beat') : []
                const snapped = grade.length && !e.altKey ? grade.reduce((b, x) => (Math.abs(x - at) < Math.abs(b - at) ? x : b), grade[0]) : snapTo(at, e.altKey, c)
                // a grid line outside the clip does not count: then it cuts where it was clicked
                const cut = snapped > c.start + 0.02 && snapped < c.end - 0.02 ? snapped : round(at)
                if (editable(c) && t.type !== 'video') void splitAt(cut, { trackId: t.id, clipId: c.id })
                return
              }
              // a library piece is a fixed block: it moves, it is not trimmed
              const mode = locked ? 'move' : local < 6 ? 'left' : local > w - 6 ? 'right' : 'move'
              setDrag({ kind: 'clip', mode, track: t, clip: c, x0: e.clientX, y0: e.clientY, dx: 0, toTrack: t.id })
            }}>
            <div className="flex items-center gap-1.5 px-1.5 text-[11px] font-medium truncate pointer-events-none" style={{ height: CLIP_HEAD, background: alpha(t.color, 0.55), color: '#0b0b0c' }}>
              {t.type === 'video' ? <Icon.Video size={11} /> : <Icon.Music size={11} />}
              <span className="truncate">{anchored ? '⚓ ' : ''}{c.label ?? c.id}</span>
            </div>
            <div className="relative" style={{ height: h - 8 - CLIP_HEAD }}>
              {t.type === 'video'
                ? <VideoBody clip={c} from={from} to={from + dur} width={w} height={h - 8 - CLIP_HEAD} />
                : <Wave src={c.src} from={from} to={from + dur} width={w} height={h - 8 - CLIP_HEAD} gain={dbToGain(c.gain)} color={alpha(t.color, 0.95)} />}
            </div>
            {t.type === 'audio' && <AcervoPecas src={c.src} from={from} dur={dur} zoom={zoom} height={h - 8 - CLIP_HEAD} />}
            {c.bodyEnd < c.end - 0.01 && !corpo && (
              <div className="absolute top-0 bottom-0 hatch bg-black/40 border-l border-white/40 pointer-events-none"
                style={{ left: Math.max(0, (c.bodyEnd - c.start) * zoom), right: 0 }} title="cauda: soa por cima da próxima peça" />
            )}
            {/* pontos de emenda medidos: onde outra peça pode entrar (e esta termina ali) */}
            {libItems.get(c.asset)?.cuts?.filter((k) => k.at - c.in > 0.05 && k.at - c.in < dur - 0.05).map((k) => (
              <div key={k.bar} className="absolute top-0 bottom-0 pointer-events-none"
                style={{ left: (k.at - c.in) * zoom, borderLeft: '1.5px dashed rgba(255,255,255,0.55)' }}
                title={`ponto de emenda (compasso ${k.bar + 1}): solte outra peça aqui e esta termina neste ponto`} />
            ))}
            {jump && jump.clipId === c.id && jump.trackId === t.id && (
              <div className="absolute top-0 bottom-0 pointer-events-none border-x-2 border-red-400"
                style={{ left: (jump.from - from) * zoom, width: (jump.to - jump.from) * zoom, background: 'repeating-linear-gradient(135deg, rgba(248,113,113,0.35) 0 5px, transparent 5px 10px)' }}
                title="este trecho sai" />
            )}
                        {/* fades: the gain ramps, drawn over the clip (a crossfade is a fade-out over the next clip's fade-in) */}
            {t.type !== 'video' && (c.fadeIn > 0.05 || c.fadeOut > 0.05) && (
              <svg className="absolute left-0 pointer-events-none" style={{ top: CLIP_HEAD }} width={w} height={h - 8 - CLIP_HEAD}>
                {c.fadeIn > 0.05 && <path d={`M0 0 L0 ${h - 8 - CLIP_HEAD} L${Math.min(w, c.fadeIn * zoom)} 0 Z`} fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.7)" strokeWidth={1} />}
                {c.fadeOut > 0.05 && <path d={`M${w} 0 L${w} ${h - 8 - CLIP_HEAD} L${Math.max(0, w - c.fadeOut * zoom)} 0 Z`} fill="rgba(0,0,0,0.35)" stroke="rgba(255,255,255,0.7)" strokeWidth={1} />}
              </svg>
            )}
            {!locked && !cutting && <div className="absolute inset-y-0 left-0 w-[6px] cursor-ew-resize hover:bg-white/20" />}
            {!locked && !cutting && <div className="absolute inset-y-0 right-0 w-[6px] cursor-ew-resize hover:bg-white/20" />}
          </div>
        )
      })}
      {t.quebra && <JuntasCrossfade t={t} zoom={zoom} />}
      {t.type === 'audio' && <LaneConnectors clips={t.clips} items={libItems} zoom={zoom} top={4 + CLIP_HEAD} height={h - 8 - CLIP_HEAD} color={t.color} covers={coberturas(r, libItems).map((x) => x.at)} />}
      <Envelope t={t} zoom={zoom} width={width} h={h} editing={editEnvelope} drag={drag} setDrag={setDrag} />
    </div>
  )
}

/**
 * Trilha quebra-cabeça: em cada junta com pulo, uma barra de crossfade no topo, centrada na emenda: a peça anterior sai
 * e a próxima entra dentro dela (cauda de uma, cabeça da outra, em potência constante). Arrastar a borda direita muda o
 * tamanho (até 8 s, limitado ao material que os arquivos têm antes e depois); duplo clique zera (corte seco).
 */
function JuntasCrossfade({ t, zoom }: { t: ResolvedTrack; zoom: number }) {
  const project = useEditor((s) => s.project)
  const [arrasto, setArrasto] = useState<{ id: string; x0: number; len0: number; len: number } | null>(null)
  if (!project) return null
  const juntas = t.clips.flatMap((a) => {
    const b = t.clips.find((x) => x.id !== a.id && Math.abs(x.start - a.bodyEnd) < 0.02)
    if (!b) return []
    const corpoA = a.raw.body ?? a.out
    const vizinho = project.assets[b.asset]?.src === project.assets[a.asset]?.src && Math.abs(b.in - corpoA) < 0.02
    if (vizinho) return []
    const sobraA = Math.max(0, (project.assets[a.asset]?.meta?.duration ?? a.out) - corpoA)
    return [{ a, b, corpoA, len: Math.max(0, a.end - a.bodyEnd) + b.head, max: Math.min(8, 2 * Math.min(sobraA, b.in) || 0.02) }]
  })
  // X s centrado na junta: a anterior segue X/2 além do corpo, a próxima começa X/2 antes (cabeça); as duas se cruzam em X
  const aplica = async (a: ResolvedClip, b: ResolvedClip, corpoA: number, len: number) => {
    const sobraA = Math.max(0, (project.assets[a.asset]?.meta?.duration ?? a.out) - corpoA)
    const cauda = Math.min(len / 2, sobraA)
    const cabeca = Math.min(len / 2, b.in)
    const L = Math.max(0.01, cauda + cabeca)
    const pa = P.clip(t.id, a.id)
    const pb = P.clip(t.id, b.id)
    const put = (path: string, has: boolean, v: number) => ({ op: has ? 'replace' as const : 'add' as const, path, value: round(v) })
    await patch([
      ...(a.raw.body === undefined ? [{ op: 'add' as const, path: `${pa}/body`, value: round(corpoA) }] : []),
      put(`${pa}/out`, true, corpoA + cauda),
      put(`${pa}/fade_out`, a.raw.fade_out !== undefined, L),
      ...(cabeca > 0.0005 ? [put(`${pb}/head`, b.raw.head !== undefined, cabeca)] : b.raw.head !== undefined ? [{ op: 'remove' as const, path: `${pb}/head` }] : []),
      put(`${pb}/fade_in`, b.raw.fade_in !== undefined, L),
    ] as never, `Crossfade ${a.id} → ${b.id} ${len.toFixed(2)} s`)
  }
  return (<>
    {juntas.map(({ a, b, corpoA, len, max }) => {
      const l = arrasto?.id === a.id ? arrasto.len : len
      const w = Math.max(8, l * zoom)
      const left = (a.bodyEnd - l / 2) * zoom
      return (
        <div key={a.id} className="absolute z-30 select-none" style={{ left: Math.min(left, a.bodyEnd * zoom - 4), top: 1, width: w, height: CLIP_HEAD + 2 }}
          title={`crossfade de ${l.toFixed(2)} s centrado na junta: ${a.label ?? a.id} sai enquanto ${b.label ?? b.id} entra\narraste a borda direita · duplo clique: corte seco`}
          onDoubleClick={(e) => { e.stopPropagation(); void aplica(a, b, corpoA, 0) }}>
          <svg className="absolute inset-0 pointer-events-none" width={w} height={CLIP_HEAD + 2}>
            <rect x={0} y={0} width={w} height={CLIP_HEAD + 2} rx={3} fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.75)" strokeWidth={1} />
            <path d={`M0 ${CLIP_HEAD + 1} L${w} 1 M0 1 L${w} ${CLIP_HEAD + 1}`} stroke="rgba(255,255,255,0.85)" strokeWidth={1} />
          </svg>
          {w > 40 && <span className="absolute left-1 top-0 text-[9.5px] font-mono text-white/90 pointer-events-none">{l.toFixed(2)}s</span>}
          <div className="absolute top-0 bottom-0 -right-1 w-[8px] cursor-ew-resize"
            onPointerDown={(e) => {
              e.stopPropagation()
              ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
              setArrasto({ id: a.id, x0: e.clientX, len0: len, len })
            }}
            onPointerMove={(e) => {
              if (!arrasto || arrasto.id !== a.id) return
              // a barra cresce para os dois lados: a borda direita anda metade do que o crossfade cresce
              setArrasto({ ...arrasto, len: Math.min(max, Math.max(0.02, arrasto.len0 + (2 * (e.clientX - arrasto.x0)) / zoom)) })
            }}
            onPointerUp={(e) => {
              e.stopPropagation()
              if (arrasto?.id === a.id && Math.abs(arrasto.len - len) > 0.005) void aplica(a, b, corpoA, arrasto.len)
              setArrasto(null)
            }} />
        </div>
      )
    })}
  </>)
}

/**
 * As peças que o acervo achou na música (quando o arquivo veio de lá): uma fita no topo com a cor da função de cada peça,
 * o rótulo P<n> · humor dominante, a divisa entre as peças e a curva de energia tracejada. `from` é o tempo do arquivo
 * no começo do clipe.
 */
function AcervoPecas({ src, from, dur, zoom, height }: { src: string; from: number; dur: number; zoom: number; height: number }) {
  const a = acervoProntas.get(src)
  if (!a?.pieces.length) return null
  const vis = a.pieces.map((p, i) => ({ ...p, n: i + 1 })).filter((p) => p.end > from && p.start < from + dur)
  if (!vis.length) return null
  const x = (t: number) => (Math.min(Math.max(t, from), from + dur) - from) * zoom
  const top = CLIP_HEAD + 4
  const y = (e: number) => top + 16 + (1 - e) * Math.max(4, height - 22)
  const curva = vis.flatMap((p) => [`${x(p.start)},${y(p.energy)}`, `${x(p.end)},${y(p.energy)}`]).join(' ')
  return (
    <div className="absolute inset-0 pointer-events-none">
      {vis.map((p) => {
        const l = x(p.start)
        const w = x(p.end) - l
        const cor = CORES_FUNCAO[p.role as keyof typeof CORES_FUNCAO] ?? '#8a8f98'
        const humores = Object.entries(p.moods).sort((m, n) => n[1] - m[1]).map(([k, v]) => `${k} ${v}`).join(' · ')
        return (
          <div key={p.n} className="absolute bottom-0 pointer-events-auto" style={{ left: l, width: w, top: CLIP_HEAD }}
            title={`P${p.n}${p.role ? ` · ${p.role}` : ' (sem compassos: trecho pelo humor)'}${p.mood ? ` · ${p.mood}` : ''}\n${formatTime(p.start, 1)} → ${formatTime(p.end, 1)} do arquivo · energia ${Math.round(p.energy * 100)}${humores ? `\nhumor (percentil no acervo): ${humores}` : ''}`}>
            <div style={{ height: 4, background: cor }} />
            {p.start >= from && <div className="absolute top-0 bottom-0 left-0" style={{ borderLeft: `1.5px solid ${alpha(cor, 0.9)}` }} />}
            {w > 26 && (
              <div className="absolute left-1 top-[6px] text-[10px] leading-none truncate pl-1 pr-1.5 py-[3px] rounded-sm"
                style={{ maxWidth: w - 6, background: 'rgba(0,0,0,0.6)', color: '#e8e9ec', borderLeft: `2.5px solid ${cor}` }}>
                <b className="font-semibold">P{p.n}</b>
                {p.role && w > 60 && <span className="text-ink-300"> {p.role}</span>}
                {p.mood && w > 90 && <span className="text-ink-300"> · {p.mood}</span>}
              </div>
            )}
          </div>
        )
      })}
      <svg className="absolute left-0 top-0" width={(dur * zoom) | 0} height={top + height} style={{ overflow: 'visible' }}>
        <polyline points={curva} fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={1.2} strokeDasharray="4 3" />
      </svg>
    </div>
  )
}

function Envelope({ t, zoom, width, h, editing, drag, setDrag }: {
  t: ResolvedTrack; zoom: number; width: number; h: number; editing: boolean; drag: Drag; setDrag: (d: Drag) => void
}) {
  const select = useEditor((s) => s.select)
  const selection = useEditor((s) => s.selection)
  if (!t.envelope.length && !editing) return null
  const pts = t.envelope.map((p, i) => {
    if (drag?.kind === 'point' && drag.track.id === t.id && drag.index === i) {
      return { ...p, at: Math.max(0, p.at + drag.dx / zoom), db: yToDb(dbToY(p.db, h) + drag.dy, h) }
    }
    return p
  })
  const path: string[] = []
  if (pts.length) {
    path.push(`M0 ${dbToY(pts[0].db, h)}`)
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      if (i > 0 && pts[i - 1].curve === 'hold') path.push(`L${p.at * zoom} ${dbToY(pts[i - 1].db, h)}`)
      path.push(`L${p.at * zoom} ${dbToY(p.db, h)}`)
    }
    path.push(`L${width} ${dbToY(pts[pts.length - 1].db, h)}`)
  } else path.push(`M0 ${dbToY(0, h)} L${width} ${dbToY(0, h)}`)
  return (
    <svg className="absolute inset-0" width={width} height={h} style={{ pointerEvents: editing ? 'auto' : 'none', overflow: 'visible' }}>
      {editing && <line x1={0} x2={width} y1={dbToY(0, h)} y2={dbToY(0, h)} stroke="#ffffff18" strokeDasharray="3 4" />}
      <path d={path.join(' ')} fill="none" stroke={editing ? '#ffd166' : '#ffd16688'} strokeWidth={editing ? 1.6 : 1} />
      {editing && pts.map((p, i) => {
        const sel = selection?.kind === 'point' && selection.trackId === t.id && selection.index === i
        return (
          <circle key={i} cx={p.at * zoom} cy={dbToY(p.db, h)} r={sel ? 5 : 4} fill={sel ? '#fff' : '#ffd166'} stroke="#000" strokeWidth={1}
            style={{ cursor: 'move' }}
            onPointerDown={async (e) => {
              e.stopPropagation()
              if (e.altKey) {
                const raw = [...(t.raw.automation?.volume ?? [])]
                raw.splice(t.envelope[i].index, 1)
                await patch([{ op: 'replace', path: `${P.track(t.id)}/automation/volume`, value: raw }], `Delete envelope point`)
                return
              }
              select({ kind: 'point', trackId: t.id, index: i })
              setDrag({ kind: 'point', track: t, index: i, x0: e.clientX, y0: e.clientY, at: t.envelope[i].at, db: t.envelope[i].db, dx: 0, dy: 0 })
            }}>
            <title>{`${formatTime(p.at, 2)} · ${p.db} dB`}</title>
          </circle>
        )
      })}
    </svg>
  )
}




function uid(prefix: string, taken: string[]) {
  let i = taken.length + 1
  while (taken.includes(`${prefix}${i}`)) i++
  return `${prefix}${i}`
}

function addLane(project: ReturnType<typeof useEditor.getState>['project'], r: ResolvedProject) {
  if (!project) return
  const id = uid('faixa', r.lanes.map((l) => l.id))
  const lanes = [...(project.lanes ?? r.lanes.map((l) => ({ id: l.id, name: l.name }))), { id, name: r.lanes.length ? `Tags ${r.lanes.length + 1}` : 'Música' }]
  void patch([{ op: project.lanes ? 'replace' : 'add', path: '/lanes', value: lanes }], 'New tag lane')
}

function TagLane({ r, lane, zoom, width, drag, setDrag, snapTo }: {
  r: ResolvedProject; lane: string; zoom: number; width: number; drag: Drag; setDrag: (d: Drag) => void; snapTo: (t: number, alt: boolean, exclude?: ResolvedClip, dur?: number) => number
}) {
  const select = useEditor((s) => s.select)
  const selection = useEditor((s) => s.selection)
  const project = useEditor((s) => s.project)
  const ref = useRef<HTMLDivElement>(null)
  const items = r.regions.filter((g) => (drag?.kind === 'region' && drag.region.id === g.id ? drag.toLane : g.lane) === lane)
  const create = (e: React.MouseEvent) => {
    if (e.target !== ref.current || !project) return
    const at = snapTo((e.clientX - ref.current!.getBoundingClientRect().left) / zoom, e.altKey)
    const id = uid('tag', r.regions.map((g) => g.id))
    // na faixa Humor, uma tag nova já é um humor da paleta (a cor vem do nome)
    const next = { id, start: at, end: round(at + 5), label: lane === FAIXA_HUMOR ? HUMORES[0].nome : 'nova tag', lane }
    void patch([{ op: 'add', path: project.regions ? '/regions/-' : '/regions', value: project.regions ? next : [next] }], `New tag ${id}`)
    select({ kind: 'region', regionId: id })
  }
  return (
    <div ref={ref} className="relative" style={{ width, height: LANE }} onDoubleClick={create}
      title="duplo clique cria uma tag">
      {items.map((g) => {
        const d = drag?.kind === 'region' && drag.region.id === g.id ? drag : null
        const dt = d ? d.dx / zoom : 0
        let a = g.start
        let b = g.end
        if (d?.mode === 'move') { a = Math.max(0, g.start + dt); b = a + (g.end - g.start) }
        if (d?.mode === 'left') a = Math.min(g.end - 0.1, Math.max(0, g.start + dt))
        if (d?.mode === 'right') b = Math.max(g.start + 0.1, g.end + dt)
        const w = Math.max(4, (b - a) * zoom)
        const sel = selection?.kind === 'region' && selection.regionId === g.id
        return (
          <div key={g.id} className={cx('absolute top-[4px] rounded-md flex items-center justify-start overflow-hidden cursor-grab', sel ? 'ring-[1.5px] ring-white' : 'ring-1 ring-black/40')}
            style={{ left: a * zoom, width: w, height: LANE - 8, background: alpha(g.color, 0.85) }}
            title={`${g.label}\n${formatTime(g.start, 2)} → ${formatTime(g.end, 2)} (${(g.end - g.start).toFixed(2)} s)\n@${g.id}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              select({ kind: 'region', regionId: g.id })
              const local = e.clientX - (e.currentTarget as HTMLElement).getBoundingClientRect().left
              const mode = local < 6 ? 'left' : local > w - 6 ? 'right' : 'move'
              setDrag({ kind: 'region', mode, region: g, x0: e.clientX, dx: 0, toLane: g.lane })
            }}>
            <span className="text-[11.5px] font-medium whitespace-nowrap px-2 pointer-events-none" style={{ color: '#0b0b0c' }}>{g.label}</span>
            <div className="absolute inset-y-0 left-0 w-[5px] cursor-ew-resize" />
            <div className="absolute inset-y-0 right-0 w-[5px] cursor-ew-resize" />
          </div>
        )
      })}
    </div>
  )
}


/** Right click on the left column: add a track (below the one clicked), or move, duplicate, delete it. */
function TrackMenu({ at, project, close }: { at: { x: number; y: number; trackId: string | null }; project: NonNullable<ReturnType<typeof useEditor.getState>['project']>; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) close() }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close()
    window.addEventListener('pointerdown', down)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down); window.removeEventListener('keydown', key) }
  }, [close])
  const idx = at.trackId ? project.tracks.findIndex((t) => t.id === at.trackId) : -1
  const track = idx >= 0 ? project.tracks[idx] : null
  const insertAt = idx >= 0 ? idx + 1 : project.tracks.length
  const ids = project.tracks.map((t) => t.id)
  const fresh = (base: string) => { let n = 1; while (ids.includes(`${base}-${n}`)) n++; return `${base}-${n}` }
  const add = (type: 'audio' | 'bus' | 'video' | 'samplers') => {
    if (type === 'samplers') {
      const id = ids.includes('samplers') ? fresh('samplers') : 'samplers'
      const bus = project.tracks.find((t) => t.type === 'bus')
      void patch([{ op: 'add', path: `/tracks/${insertAt}`, value: { id, samplers: true, name: 'Samplers', color: '#8a8f9c', ...(bus ? { output: bus.id } : {}), clips: [] } }], 'Nova trilha de samplers')
      useEditor.getState().select({ kind: 'track', trackId: id })
      return
    }
    const base = type === 'audio' ? 'trilha' : type
    const id = fresh(base)
    const name = type === 'audio' ? `Trilha ${id.split('-').pop()}` : type === 'bus' ? `Bus ${id.split('-').pop()}` : `Vídeo ${id.split('-').pop()}`
    const value = { id, ...(type !== 'audio' ? { type } : {}), name, ...(type === 'audio' ? { clips: [] } : type === 'video' ? { clips: [] } : {}) }
    void patch([{ op: 'add', path: `/tracks/${insertAt}`, value }], `Nova trilha ${name}`)
    useEditor.getState().select({ kind: 'track', trackId: id })
  }
  const addLane = () => {
    const lanes = project.lanes ?? []
    let n = lanes.length + 1
    while (lanes.some((l) => l.id === `faixa${n}`)) n++
    void patch([{ op: 'add', path: project.lanes ? '/lanes/-' : '/lanes', value: project.lanes ? { id: `faixa${n}`, name: `Tags ${n}` } : [{ id: `faixa${n}`, name: `Tags ${n}` }] }], 'Nova faixa de tags')
  }
  const move = (d: -1 | 1) => {
    const to = idx + d
    if (!track || to < 0 || to >= project.tracks.length) return
    void patch([{ op: 'move', from: `/tracks/${idx}`, path: `/tracks/${to}` }], `Mover ${track.id}`)
  }
  const duplicate = () => {
    if (!track) return
    const id = fresh(track.id.replace(/-\d+$/, ''))
    void patch([{ op: 'add', path: `/tracks/${insertAt}`, value: { ...JSON.parse(JSON.stringify(track)), id, name: `${track.name ?? track.id} (cópia)`, solo: undefined } }], `Duplicar ${track.id}`)
  }
  const remove = () => {
    if (!track) return
    const n = track.clips?.length ?? 0
    const feeders = project.tracks.filter((t) => t.output === track.id).length
    if ((n || feeders) && !confirm(`Apagar "${track.name ?? track.id}"${n ? ` e seus ${n} clipe(s)` : ''}?${feeders ? ` ${feeders} trilha(s) mandam para ela e passam a ir para o master.` : ''}`)) return
    void patch([
      ...project.tracks.filter((t) => t.output === track.id).map((t) => ({ op: 'remove' as const, path: `/tracks/[id=${t.id}]/output` })),
      { op: 'remove', path: `/tracks/[id=${track.id}]` },
    ], `Apagar ${track.id}`)
  }
  const item = (label: string, icon: React.ReactNode, fn: () => void, opts: { danger?: boolean; disabled?: boolean } = {}) => (
    <button type="button" disabled={opts.disabled} onClick={() => { close(); fn() }}
      className={cx('w-full flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-left disabled:opacity-35',
        opts.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-ink-200 hover:bg-white/[0.06]')}>
      <span className="text-ink-300 shrink-0">{icon}</span>{label}
    </button>
  )
  return (
    <div ref={ref} className="fixed z-50 w-60 rounded-xl bg-ink-800 border border-white/[0.07] shadow-2xl shadow-black/60 p-1.5"
      style={{ left: Math.min(at.x, window.innerWidth - 250), top: Math.min(at.y, window.innerHeight - 330) }}>
      {track && <div className="px-2.5 pt-1 pb-1.5 text-[11px] uppercase tracking-wider text-ink-400 truncate">{track.name ?? track.id}</div>}
      {item(track ? 'Nova trilha de áudio abaixo' : 'Nova trilha de áudio', <Icon.Music size={14} />, () => add('audio'))}
      {item('Nova trilha de samplers', <Icon.Music size={14} />, () => add('samplers'))}
      {item('Novo bus', <Icon.Mixer size={14} />, () => add('bus'))}
      {item('Nova trilha de vídeo', <Icon.Video size={14} />, () => add('video'))}
      {item('Nova faixa de tags', <Icon.Tracks size={14} />, addLane)}
      {track && (
        <>
          <div className="my-1 h-px bg-white/[0.06]" />
          {track.type !== 'bus' && track.type !== 'video' && !isSamplerTrack(track) && item('Importar áudio…', <Icon.Music size={14} />, () => pickAudio(track.id))}
          {track.type === 'video' && item('Importar foto ou vídeo…', <Icon.Video size={14} />, () => pickPicture(track.id))}
          {track.type === 'video' && item('Cartão preto no playhead', <Icon.Video size={14} />, () => addCard(track.id))}
          {item('Subir', <Icon.Up size={14} />, () => move(-1), { disabled: idx === 0 })}
          {item('Descer', <span className="inline-block rotate-180"><Icon.Up size={14} /></span>, () => move(1), { disabled: idx === project.tracks.length - 1 })}
          {item('Duplicar', <Icon.Copy size={14} />, duplicate)}
          {item('Apagar trilha', <Icon.Trash size={14} />, remove, { danger: true })}
        </>
      )}
    </div>
  )
}

/** What a track accepts when something is dragged onto it: samplers tracks are their own kind. */
const AUDIO_FILE = /\.(wav|mp3|flac|ogg|m4a|aac|aif|aiff|opus)$/i
const PICTURE_FILE = /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|mp4|mov|webm|mkv|m4v)$/i

/** Fotos e vídeos do computador, na trilha de vídeo, a partir do playhead (uma foto a cada 4 s). */
function pickPicture(trackId: string) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*,video/*'
  input.multiple = true
  input.onchange = async () => {
    let at = useEditor.getState().playhead
    for (const f of [...(input.files ?? [])]) {
      await importAudio(f, trackId, at)
      at += 4
    }
  }
  input.click()
}

/** Um cartão chapado (preto) de 2 s no playhead. */
function addCard(trackId: string) {
  const p = useEditor.getState().project
  const track = p?.tracks.find((t) => t.id === trackId)
  if (!p || !track) return
  const ids = new Set(p.tracks.flatMap((t) => (t.clips ?? []).map((c) => c.id)))
  let n = 1
  while (ids.has(`cartao-${n}`)) n++
  const value = { id: `cartao-${n}`, type: 'color', start: Math.round(useEditor.getState().playhead * 1000) / 1000, duration: 2, fill: '#000000' }
  void patch([track.clips ? { op: 'add', path: `${P.track(trackId)}/clips/-`, value } : { op: 'add', path: `${P.track(trackId)}/clips`, value: [value] }] as never, 'Novo cartão')
}

/** The file picker: the chosen files land on the track at the playhead. */
function pickAudio(trackId: string) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.aif,.aiff,.opus'
  input.multiple = true
  input.onchange = async () => {
    for (const f of [...(input.files ?? [])]) await importAudio(f, trackId, useEditor.getState().playhead)
  }
  input.click()
}

function kindOf(t: { type: string; samplers: boolean; quebra?: boolean }) {
  return t.samplers ? 'samplers' : t.quebra ? 'quebra' : t.type
}
