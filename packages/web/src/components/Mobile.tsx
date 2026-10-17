import { useEffect, useMemo, useRef, useState } from 'react'
import { formatTime, round, type ResolvedClip, type ResolvedRegion } from '@dmixer/core'
import { go, P, patch, save } from '../api'
import { engine, type Preview } from '../audio'
import { useEditor } from '../store'
import { anchorPiece, edgeOf, EdgeGlyph, fitsAfter, seam } from './Connectors'
import { alinharComTag, appendPiece, axes, cobrirEmenda, coberturas, cortarOps, descobrirEmenda, emendaDe, restaurarOps, tamanho, categoryOf, INSTRUMENTS, loadLibraries, OrigemTag, passa, ordemOrigem, origemOf, rotuloOrigem, type Library, type LibraryItem, useLibraryItems } from './Library'
import { cx, Icon } from './ui'

/** Phone width (or ?view=mobile); ?view=desktop forces the full editor. */
export function useIsMobile(): boolean {
  const forced = new URLSearchParams(location.search).get('view')
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 820px)').matches)
  useEffect(() => {
    const m = window.matchMedia('(max-width: 820px)')
    const on = () => setNarrow(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return forced === 'mobile' ? true : forced === 'desktop' ? false : narrow
}

const SEAM_COLOR = { ok: '#4ade80', family: '#f87171', gap: '#fb923c', restart: '#fb923c', texture: '#fb923c', pulse: '#fb923c', drop: '#fb923c', covered: '#38bdf8' } as const

/**
 * The mobile view: build the chain of library pieces and listen to it with the narration.
 * Overview (narration, tags, pieces, playhead) · the chain as lego blocks · an "add" sheet in connector mode.
 */
export function MobileApp() {
  const s = useEditor()
  const r = s.resolved
  const items = useLibraryItems()
  const [sheet, setSheet] = useState(false)
  const [sel, setSel] = useState<{ trackId: string; clipId: string } | null>(null)

  const pieces = useMemo(() => {
    if (!r || !s.project) return []
    return r.tracks.flatMap((t) => t.clips.filter((c) => s.project!.assets[c.asset]?.body !== undefined && items.get(c.asset)?.role !== 'complemento' && items.get(c.asset)?.role !== 'cobertura')
      .map((c) => ({ t, c, it: items.get(c.asset) })))
      .sort((a, b) => a.c.start - b.c.start)
  }, [r, items, s.project])

  if (!r || !s.project) {
    return <div className="h-full grid place-items-center text-ink-400 p-6 text-center">{s.loadError ?? 'carregando…'}</div>
  }
  const playFrom = (t: number) => { s.setPlayhead(t); void engine.play(t) }
  const current = pieces.find((x) => s.playhead >= x.c.start && s.playhead < x.c.bodyEnd)
  const tagNow = r?.regions.find((g) => s.playhead >= g.start && s.playhead < g.end)

  return (
    <div className="h-full flex flex-col bg-ink-950 text-ink-200">
      {/* top */}
      <header className="shrink-0 flex items-center gap-2 px-3 pt-3 pb-2 bg-ink-900 border-b border-white/[0.05]">
        <button type="button" className="text-ink-400 text-[20px] px-1" onClick={() => { engine.stop(); go('/') }} title="mixagens">‹</button>
        <div className="flex-1 min-w-0">
          <div className="text-[15px] text-ink-100 font-medium truncate">{s.project.project.name}</div>
          <div className="text-[11px] text-ink-500 font-mono">{formatTime(s.playhead, 1)} / {formatTime(r.duration, 0)}{s.busy ? ' · gerando…' : ''}</div>
        </div>
        <button type="button" onClick={() => void save()}
          className={cx('h-9 px-3 rounded-[10px] text-[13px]', s.dirty ? 'bg-ink-100 text-black font-medium' : 'bg-ink-800 text-ink-500')}>{s.dirty ? 'Salvar' : 'Salvo'}</button>
        <button type="button" onClick={() => (s.loading !== null ? engine.cancel() : s.playing ? engine.stop() : void engine.play())}
          className="relative w-12 h-12 rounded-full bg-ink-100 text-black grid place-items-center" title={s.loading !== null ? 'carregando — toque para cancelar' : 'tocar / pausar'}>
          {s.loading !== null ? <LoadRing value={s.loading} /> : s.playing ? <Icon.Pause size={20} /> : <Icon.Play size={20} />}
        </button>
      </header>
      {s.loading !== null && (
        <div className="shrink-0 px-3 py-2 bg-amber-300/10 border-b border-amber-300/20 flex items-center gap-3">
          <Spinner className="text-amber-200" />
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] text-amber-100">{s.loading >= 0.99 ? 'Preparando o áudio…' : `Carregando o áudio… ${Math.round(s.loading * 100)}%`}</div>
            <div className="mt-1 h-1 rounded bg-white/10 overflow-hidden"><div className="h-full bg-amber-200 transition-[width]" style={{ width: `${Math.max(3, s.loading * 100)}%` }} /></div>
          </div>
          <button type="button" className="text-[12px] text-ink-400 px-2 h-8" onClick={() => engine.cancel()}>cancelar</button>
        </div>
      )}

      <Overview pieces={pieces.map((x) => ({ c: x.c, color: x.t.color }))} onSeek={(t) => (s.playing ? playFrom(t) : s.setPlayhead(t))} />

      {/* the chain */}
      <div className="px-3 pt-3 pb-1 flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-ink-400">Sequência · {pieces.length} peça(s)</span>
        {(current || tagNow) && <span className="text-[11px] text-ink-500 truncate max-w-[55%]">tocando: {current ? current.c.label ?? current.c.id : tagNow!.label ?? tagNow!.id}</span>}
      </div>
      <Chain pieces={pieces} sel={sel} setSel={setSel} playhead={s.playhead} covers={coberturas(r, items).map((x) => x.at)} />
      {r.regions.length > 0 && <Tags regions={r.regions} playhead={s.playhead} onPlay={playFrom} anchor={sel} />}

      {sel && (() => {
        const p = pieces.find((x) => x.t.id === sel.trackId && x.c.id === sel.clipId)
        if (!p) return null
        // a emenda que chega neste bloco: no celular não há "passar o mouse" na bolinha, então o texto aparece aqui
        const prev = pieces.find((x) => x.t.id === p.t.id && Math.abs(x.c.bodyEnd - p.c.start) < 0.06)
        const ea = edgeOf(prev?.it, prev?.c.raw)
        const eb = edgeOf(p.it)
        const e = s.project ? emendaDe(s.project, p.t.id, p.c.id) : null
        const sm = e?.cobertura ? { kind: 'covered' as const, text: 'coberta por uma transição' } : ea && eb ? seam(ea, eb) : null
        // encurtar no ponto de emenda medido mais próximo abaixo do tamanho atual (ou voltar inteira); as peças que vêm
        // depois andam junto, para a sequência continuar colada
        const corpoAtual = p.c.bodyEnd - p.c.start + p.c.in
        const corte = [...(p.it?.cuts ?? [])].reverse().find((k) => k.at < corpoAtual - 0.05)
        const encurtar = async (at: number | null) => {
          const novoFim = at === null ? p.c.start + (p.it?.body ?? 0) - p.c.in : p.c.start + at - p.c.in
          const delta = round(novoFim - p.c.bodyEnd)
          const ops = at === null ? restaurarOps(p.t.id, p.c.raw) : cortarOps(p.t.id, p.c.raw, at)
          for (const t of r.tracks.filter((x) => x.samplers)) {
            for (const c of t.clips) {
              if (c.start >= p.c.bodyEnd - 0.01 && typeof c.raw.start === 'number') ops.push({ op: 'replace', path: `/tracks/[id=${t.id}]/clips/[id=${c.id}]/start`, value: round(c.raw.start + delta) })
            }
          }
          await patch(ops as never, at === null ? `Inteira ${p.c.id}` : `Encurtar ${p.c.id}`)
        }
        return (
          <div className="mx-3 mt-1 rounded-xl bg-ink-850 border border-white/[0.06] p-3 flex items-center gap-2 flex-wrap">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] text-ink-100 truncate">{p.c.label ?? p.c.id}</div>
              <div className="text-[11px] text-ink-500 font-mono">{formatTime(p.c.start, 2)} → {formatTime(p.c.bodyEnd, 2)}</div>
            </div>
            <button type="button" className="h-9 px-3 rounded-lg bg-white/[0.06] text-[13px]" onClick={() => playFrom(p.c.start)}>▶ daqui</button>
            {corte && <button type="button" className="h-9 px-3 rounded-lg bg-white/[0.06] text-[13px]" onClick={() => void encurtar(corte.at)}>✂ {corte.bar}c</button>}
            {p.c.raw.body !== undefined && <button type="button" className="h-9 px-3 rounded-lg bg-white/[0.06] text-[13px]" onClick={() => void encurtar(null)}>↔ inteira</button>}
            <button type="button" className="h-9 px-3 rounded-lg bg-red-500/15 text-red-300 text-[13px]"
              onClick={() => { void patch([{ op: 'remove', path: P.clip(p.t.id, p.c.id) }], `Remover ${p.c.id}`); setSel(null) }}>remover</button>
            {sm && sm.kind !== 'ok' && <div className="w-full text-[12px] leading-snug" style={{ color: SEAM_COLOR[sm.kind] }}>emenda com a anterior: {sm.text}</div>}
            {e && !e.cobertura && <button type="button" className={cx('h-9 px-3 rounded-lg text-[13px]', sm?.kind === 'ok' ? 'bg-white/[0.06]' : 'bg-sky-400/15 text-sky-200')}
              onClick={() => void cobrirEmenda(p.t.id, p.c.id)}>＋ transição na emenda</button>}
            {e?.cobertura && <button type="button" className="h-9 px-3 rounded-lg bg-white/[0.06] text-[13px]" onClick={() => void descobrirEmenda(p.t.id, p.c.id)}>tirar transição</button>}
          </div>
        )
      })()}

      <div className="flex-1" />
      <div className="shrink-0 p-3 pb-5">
        <button type="button" onClick={() => setSheet(true)}
          className="w-full h-12 rounded-2xl bg-ink-100 text-black text-[15px] font-medium flex items-center justify-center gap-2">
          <Icon.Plus size={18} /> Adicionar peça {sel || pieces.length ? 'que encaixa' : ''}
        </button>
      </div>
      {sheet && <AddSheet close={() => setSheet(false)} sel={sel} onAdded={() => setSel(null)} />}
    </div>
  )
}

function Overview({ pieces, onSeek }: { pieces: { c: ResolvedClip; color: string }[]; onSeek: (t: number) => void }) {
  const r = useEditor((s) => s.resolved)!
  const playhead = useEditor((s) => s.playhead)
  const total = Math.max(r.duration + 3, 1)
  const pct = (t: number) => `${(t / total) * 100}%`
  const project = useEditor((s) => s.project)!
  // a narração: a trilha de áudio com mais clipes que NÃO são peças da biblioteca
  const voice = r.tracks.filter((t) => t.type === 'audio')
    .map((t) => ({ t, n: t.clips.filter((c) => project.assets[c.asset]?.body === undefined).length }))
    .filter((x) => x.n > 0).sort((a, b) => b.n - a.n)[0]?.t
  const ref = useRef<HTMLDivElement>(null)
  const seek = (x: number) => {
    const box = ref.current!.getBoundingClientRect()
    onSeek(Math.max(0, ((x - box.left) / box.width) * total))
  }
  return (
    <div ref={ref} className="relative mx-3 mt-3 h-[76px] rounded-xl bg-ink-900 border border-white/[0.05] overflow-hidden touch-none"
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); seek(e.clientX) }}
      onPointerMove={(e) => e.buttons === 1 && seek(e.clientX)}>
      {r.regions.map((g) => (
        <div key={g.id} className="absolute h-[5px] rounded-sm opacity-80" style={{ left: pct(g.start), width: pct(g.end - g.start), top: 5 + r.lanes.findIndex((l) => l.id === g.lane) * 7, background: g.color }} />
      ))}
      {voice?.clips.filter((c) => project.assets[c.asset]?.body === undefined).map((c) => (
        <div key={c.id} className="absolute rounded-[2px] bg-ink-400/50" style={{ left: pct(c.start), width: pct(c.duration), top: 26, height: 16 }} />
      ))}
      {pieces.map(({ c, color }) => (
        <div key={c.id} className="absolute rounded-[3px]" style={{ left: pct(c.start), width: pct(c.bodyEnd - c.start), top: 48, height: 18, background: color, opacity: 0.85 }} />
      ))}
      <div className="absolute top-0 bottom-0 w-[2px] bg-white" style={{ left: pct(playhead) }} />
      <span className="absolute right-2 bottom-1 text-[9px] text-ink-500">{voice ? 'tags · narração · peças' : 'tags · peças'}</span>
    </div>
  )
}

function Chain({ pieces, sel, setSel, playhead, covers }: {
  pieces: { t: { id: string; color: string }; c: ResolvedClip; it?: LibraryItem }[]
  sel: { trackId: string; clipId: string } | null; setSel: (s: { trackId: string; clipId: string } | null) => void; playhead: number
  covers: number[]
}) {
  const box = useRef<HTMLDivElement>(null)
  const playing = pieces.findIndex((x) => playhead >= x.c.start && playhead < x.c.bodyEnd)
  useEffect(() => {
    if (playing < 0 || !box.current) return
    const el = box.current.children[playing] as HTMLElement | undefined
    el?.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' })
  }, [playing])
  if (!pieces.length) {
    return <div className="mx-3 rounded-xl border border-dashed border-white/[0.1] p-6 text-center text-ink-400 text-[13px]">Ainda não há peças. Toque em <b className="text-ink-200">Adicionar peça</b>.</div>
  }
  return (
    <div ref={box} className="flex items-stretch gap-0 overflow-x-auto px-3 py-2 snap-x">
      {pieces.map((x, i) => {
        const e = edgeOf(x.it)
        const prev = pieces[i - 1]
        const pe = prev ? edgeOf(prev.it, prev.c.raw) : null
        const touching = prev && Math.abs(prev.c.bodyEnd - x.c.start) < 0.06
        const sm0 = touching && pe && e ? seam(pe, e) : null
        const sm = sm0 && covers.some((t) => Math.abs(t - x.c.start) < 0.06) ? { kind: 'covered' as const, text: 'coberta por uma transição' } : sm0
        const cc = x.it ? categoryOf(x.it.category) : { label: '', color: x.t.color }
        const on = sel?.clipId === x.c.id && sel?.trackId === x.t.id
        return (
          <div key={`${x.t.id}/${x.c.id}`} className="relative flex items-center snap-start shrink-0" style={{ marginLeft: i && !touching ? 14 : 0 }}>
            {sm && <span className="absolute -left-[5px] top-1 z-10 w-[10px] h-[10px] rounded-full border border-black/60" style={{ background: SEAM_COLOR[sm.kind] }} title={sm.text} />}
            {e && <span className="absolute left-0 top-1/2 -translate-y-1/2 z-[5]"><EdgeGlyph side="in" edge={e} color={cc.color} size={20} bg="#0b0b0c" /></span>}
            <button type="button" onClick={() => setSel(on ? null : { trackId: x.t.id, clipId: x.c.id })}
              className={cx('h-[76px] rounded-lg px-3 text-left flex flex-col justify-center', on ? 'ring-2 ring-white' : '', i === playing ? 'brightness-125' : '')}
              style={{ width: Math.max(96, x.c.duration * 14), background: `${cc.color}cc`, color: '#0b0b0c' }}>
              <span className="text-[12px] font-semibold truncate">{cc.label}</span>
              <span className="text-[11px] truncate">{x.it?.chord} · i{x.it?.intensity} · {tamanho(x.it)}</span>
              <span className="text-[10px] opacity-70 truncate">{x.it?.recipe}</span>
            </button>
            {e && <span className="absolute -right-[10px] top-1/2 -translate-y-1/2 z-[6]"><EdgeGlyph side="out" edge={e} color={cc.color} size={20} /></span>}
          </div>
        )
      })}
      <div className="shrink-0 w-6" />
    </div>
  )
}

/** The library as a bottom sheet, in connector mode by default: ▶ to listen, + to put it at the end of the chain. */
function AddSheet({ close, sel, onAdded }: { close: () => void; sel: { trackId: string; clipId: string } | null; onAdded: () => void }) {
  const project = useEditor((s) => s.project)!
  const resolved = useEditor((s) => s.resolved)!
  const [libs, setLibs] = useState<Library[]>([])
  const [conector, setConector] = useState(true)
  const [cat, setCat] = useState<string | null>(null)
  const [busca, setBusca] = useState('')
  const [lote, setLote] = useState<string | null>(null)
  const [mood, setMood] = useState<string | null>(null)
  const [inst, setInst] = useState<string | null>(null)
  const [voz, setVoz] = useState(false)
  const [mais, setMais] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const [buffering, setBuffering] = useState<string | null>(null)
  const audio = useRef<Preview | null>(null)
  const c = useEditor((s) => s.projectName)
  useEffect(() => { void loadLibraries(true).then(setLibs) }, [])
  useEffect(() => () => audio.current?.pause(), [])
  const all = libs.flatMap((l) => l.items.filter((it) => !it.role || it.role === 'base').map((it) => ({ lib: l, it })))
  const map = new Map(all.map(({ it }) => [it.id, it]))
  const ancora = anchorPiece(project, resolved, map, sel ? { kind: 'clip', ...sel } : null)
  const termos = busca.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = all.filter(({ it }) => (!conector || !ancora || fitsAfter(ancora.item, it)) && (!cat || it.category === cat) && (!lote || origemOf(it) === lote) && passa(it, { mood, inst, voz })
    && termos.every((w) => `${it.id} ${it.recipe ?? ''} ${it.description ?? ''} ${it.chord ?? ''} ${rotuloOrigem(origemOf(it))} ${(it.mood ?? []).join(' ')} ${(it.instruments ?? []).map((x) => INSTRUMENTS[x]).join(' ')}`.toLowerCase().includes(w)))
  const cats = [...new Set(all.map(({ it }) => it.category))]
  const lotes = [...new Set(all.map(({ it }) => origemOf(it)))].sort(ordemOrigem)
  const newest = lotes.find((x) => /^lote-\d+$/.test(x))
  const eixos = axes(libs, all.map(({ it }) => it))
  const ativos = [mood, inst, lote].filter(Boolean).length
  const play = (lib: Library, it: LibraryItem) => {
    audio.current?.pause()
    if (playing === it.id) { setPlaying(null); setBuffering(null); return }
    const a = engine.preview(`/api/libraries/audio?c=${c}&lib=${encodeURIComponent(lib.alias)}&src=${encodeURIComponent(it.src)}`)
    a.onended = () => { setPlaying((x) => (x === it.id ? null : x)); setBuffering((b) => (b === it.id ? null : b)) }
    a.onplaying = () => setBuffering((b) => (b === it.id ? null : b))
    setBuffering(it.id)
    audio.current = a
    setPlaying(it.id)
  }
  const add = async (lib: Library, it: LibraryItem) => {
    audio.current?.pause()
    setPlaying(null)
    if (sel) useEditor.getState().select({ kind: 'track', trackId: sel.trackId })
    await appendPiece(useEditor.getState().project!, JSON.stringify({ lib: { alias: lib.alias, root: lib.root, declared: lib.declared }, item: it }))
    onAdded()
  }
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={close}>
      <div className="max-h-[78%] flex flex-col rounded-t-2xl bg-ink-900 border-t border-white/[0.08]" onClick={(e) => e.stopPropagation()}>
        <div className="mx-auto mt-2 w-10 h-1 rounded-full bg-ink-600" />
        <div className="px-4 pt-3 pb-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[15px] text-ink-100 font-medium flex-1">Adicionar peça</span>
            <button type="button" onClick={() => setConector(!conector)}
              className={cx('h-8 px-3 rounded-lg text-[12.5px]', conector ? 'bg-ink-100 text-black' : 'bg-white/[0.06] text-ink-300')}>◗ só as que encaixam</button>
            <button type="button" className="h-8 w-8 rounded-lg bg-white/[0.06]" onClick={close}>✕</button>
          </div>
          <div className="text-[12px] text-ink-400">{conector && ancora ? <>depois de <b className="text-ink-200">{ancora.clip.label ?? ancora.item.id}</b></> : conector ? 'a primeira peça: comece por uma abertura' : 'todas as peças'}</div>
          <div className="flex gap-2">
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="buscar: oboé, metais, Bm, i5…"
              className="flex-1 min-w-0 h-9 px-3 rounded-lg bg-white/[0.06] text-[14px] text-ink-100 placeholder:text-ink-500 outline-none" />
            <button type="button" onClick={() => setMais(!mais)}
              className={cx('h-9 px-3 rounded-lg text-[12.5px] shrink-0', ativos ? 'bg-amber-300/15 text-amber-200' : 'bg-white/[0.06] text-ink-300')}>
              Filtros{ativos ? ` · ${ativos}` : ''} {mais ? '▴' : '▾'}
            </button>
          </div>
          <Chips>
            {eixos.voice && (
              <Chip on={voz} onClick={() => setVoz(!voz)}><Icon.Mic size={13} /> sob a voz</Chip>
            )}
            <Chip on={!cat} onClick={() => setCat(null)}>Todas</Chip>
            {cats.map((k) => (
              <Chip key={k} on={cat === k} onClick={() => setCat(cat === k ? null : k)}>
                <span className="w-2 h-2 rounded-full" style={{ background: categoryOf(k).color }} />{categoryOf(k).label}
              </Chip>
            ))}
          </Chips>
          {mais && (
            <>
              {eixos.moods.length > 0 && (
                <Chips label="clima">
                  {eixos.moods.map((x) => <Chip key={x} on={mood === x} onClick={() => setMood(mood === x ? null : x)}>{x}</Chip>)}
                </Chips>
              )}
              {eixos.instruments.length > 0 && (
                <Chips label="instrumentos">
                  {eixos.instruments.map((x) => <Chip key={x} on={inst === x} onClick={() => setInst(inst === x ? null : x)}>{INSTRUMENTS[x]}</Chip>)}
                </Chips>
              )}
              <Chips label="lote">
                {lotes.map((x) => (
                  <Chip key={x} on={lote === x} hot={x === newest} onClick={() => setLote(lote === x ? null : x)}>
                    {rotuloOrigem(x)}{x === newest ? ' · novo' : ''}
                  </Chip>
                ))}
              </Chips>
            </>
          )}
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-6 space-y-1.5">
          {shown.length === 0 && <div className="text-center text-ink-400 text-[13px] py-8">Nenhuma peça encaixa aqui com esse filtro.</div>}
          {shown.length > 300 && <div className="text-center text-ink-500 text-[12px] py-1">{shown.length} peças — mostrando 300; filtre ou busque</div>}
          {shown.slice(0, 300).map(({ lib, it }) => {
            const cc = categoryOf(it.category)
            const e = edgeOf(it)
            return (
              <div key={it.id} className="flex items-center gap-2 rounded-xl bg-ink-850 border border-white/[0.04] pl-2 pr-1 py-1.5">
                {e && <EdgeGlyph side="in" edge={e} color={cc.color} size={16} bg="#151516" />}
                <span className="w-2 h-2 rounded-full shrink-0" style={{ background: cc.color }} />
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] text-ink-100 truncate">{cc.label} · {it.chord} · i{it.intensity} · {tamanho(it)}</div>
                  <div className="text-[11px] text-ink-500 truncate flex items-center gap-1.5"><OrigemTag it={it} newest={newest} />{it.under_voice && <span className="text-sky-300/80 shrink-0"><Icon.Mic size={11} /></span>}<span className="truncate">{it.recipe}</span></div>
                </div>
                {e && <EdgeGlyph side="out" edge={e} color={cc.color} size={16} />}
                <button type="button" className="w-11 h-11 rounded-lg bg-white/[0.06] grid place-items-center" onClick={() => play(lib, it)}>
                  {buffering === it.id && playing === it.id ? <Spinner /> : playing === it.id ? <Icon.Pause size={16} /> : <Icon.Play size={16} />}
                </button>
                <button type="button" className="w-11 h-11 rounded-lg bg-ink-100 text-black grid place-items-center" onClick={() => void add(lib, it)}>
                  <Icon.Plus size={18} />
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Spinner({ className }: { className?: string }) {
  return <span className={cx('inline-block w-4 h-4 rounded-full border-2 border-current border-r-transparent animate-spin', className)} />
}

/** The play button while loading: a ring that fills with the bytes received, spinning until they start to arrive. */
function LoadRing({ value }: { value: number }) {
  const r = 16
  const len = 2 * Math.PI * r
  return (
    <svg width={40} height={40} viewBox="0 0 40 40" className={value < 0.02 || value >= 0.99 ? 'animate-spin' : ''}>
      <circle cx={20} cy={20} r={r} fill="none" stroke="rgba(0,0,0,0.15)" strokeWidth={4} />
      <circle cx={20} cy={20} r={r} fill="none" stroke="black" strokeWidth={4} strokeLinecap="round"
        strokeDasharray={`${value < 0.02 || value >= 0.99 ? len * 0.25 : len * value} ${len}`} transform="rotate(-90 20 20)" />
    </svg>
  )
}

/** The tags as a list: tap one to play from its start. */
function Tags({ regions, playhead, onPlay, anchor }: { regions: ResolvedRegion[]; playhead: number; onPlay: (t: number) => void; anchor?: { trackId: string; clipId: string } | null }) {
  const box = useRef<HTMLDivElement>(null)
  const [msg, setMsg] = useState('')
  const alinhar = (g: ResolvedRegion) => void alinharComTag(g.start, g.label ?? g.id, anchor).then((m) => { setMsg(m); setTimeout(() => setMsg(''), 8000) })
  const now = regions.findIndex((g) => playhead >= g.start && playhead < g.end)
  useEffect(() => {
    const el = now >= 0 ? (box.current?.children[now] as HTMLElement | undefined) : undefined
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [now])
  return (
    <>
      <div className="px-3 pt-4 pb-1 text-[11px] uppercase tracking-wider text-ink-400">Tags · {regions.length}
        <span className="normal-case tracking-normal text-ink-500"> · ⇥ alinha a música com a tag</span></div>
      {msg && <div className="mx-3 mb-2 px-3 py-2 rounded-lg bg-sky-400/10 text-sky-100 text-[12.5px] leading-snug">{msg}</div>}
      <div ref={box} className="mx-3 mb-28 max-h-[40vh] overflow-y-auto rounded-xl border border-white/[0.05] divide-y divide-white/[0.04]">
        {regions.map((g, i) => (
          <div key={g.id} className={cx('flex items-center', i === now ? 'bg-white/[0.07]' : 'bg-ink-900')}>
            <button type="button" onClick={() => onPlay(g.start)} className="flex-1 min-w-0 flex items-center gap-2.5 pl-3 h-11 text-left">
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: g.color ?? '#8a8f9c' }} />
              <span className={cx('flex-1 min-w-0 truncate text-[13px]', i === now ? 'text-ink-100' : 'text-ink-300')}>{g.label ?? g.id}</span>
              <span className="text-[11px] font-mono text-ink-500">{formatTime(g.start, 0)}</span>
            </button>
            <button type="button" onClick={() => alinhar(g)} title="alinhar a música com esta tag" className="w-11 h-11 text-ink-400 text-[16px]">⇥</button>
          </div>
        ))}
      </div>
    </>
  )
}

function Chips({ label, children }: { label?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {label && <span className="text-[10.5px] uppercase tracking-wider text-ink-500 shrink-0 pr-1">{label}</span>}
      {children}
    </div>
  )
}

function Chip({ on, hot, onClick, children }: { on: boolean; hot?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick}
      className={cx('h-8 px-3 rounded-lg text-[12.5px] shrink-0 flex items-center gap-1.5', on ? 'bg-ink-100 text-black' : hot ? 'bg-amber-300/15 text-amber-200' : 'bg-white/[0.06] text-ink-300')}>
      {children}
    </button>
  )
}
