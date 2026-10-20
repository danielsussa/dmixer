import { useEffect, useState } from 'react'
import { go, patch, redo, save, startRender, undo } from '../api'
import { engine } from '../audio'
import { useEditor } from '../store'
import { cx, Icon, IconButton, InlineEdit, Menu, Pill } from './ui'
import { Fader } from './TrackHeader'

/** "001.2.3": bar, beat and sixteenth at time t, on the project's grid. */
function bars(t: number, bpm: number, meter: number, offset: number) {
  const beat = 60 / bpm
  const b = Math.max(0, (t - offset) / beat)
  const bar = Math.floor(b / meter) + 1
  const inBar = Math.floor(b % meter) + 1
  const six = Math.floor((b % 1) * 4) + 1
  return `${String(bar).padStart(3, '0')}.${inBar}.${six}`
}

function clock(t: number) {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

export function Logo() {
  return (
    <a href="/" onClick={(e) => { e.preventDefault(); go('/') }} title="todas as mixagens"
      className="flex items-center pl-1 pr-2 select-none text-[20px] font-semibold tracking-[0.12em] text-ink-100">
      DMIXER
    </a>
  )
}

export function TopBar() {
  const s = useEditor()
  const r = s.resolved
  const meterPct = Math.max(0, Math.min(100, ((s.meter + 60) / 60) * 100))
  const setProject = (key: string, value: unknown, label: string) =>
    patch([{ op: 'replace', path: '/project', value: { ...s.project!.project, [key]: value } }], label)
  return (
    <header className="h-[52px] shrink-0 flex items-center gap-2 px-3 bg-ink-900 border-b border-white/[0.05]">
      <Logo />
      <Pill className="pl-3 pr-1 gap-1 max-w-[300px]">
        <span className="text-[13px] text-ink-100 font-medium truncate" title={s.file ?? ''}>{s.project?.project.name ?? '…'}</span>
        <span className={cx('ml-1 w-1.5 h-1.5 rounded-full shrink-0', s.connected ? 'bg-emerald-400' : 'bg-red-500')} title={s.connected ? 'conectado' : 'sem conexão'} />
        <Menu width={300} trigger={() => <IconButton title="Mixagens"><Icon.More /></IconButton>}
          header={<div className="px-2.5 pt-1.5 pb-2 text-[11px] uppercase tracking-wider text-ink-400">Mixagens ligadas</div>}
          items={[
            ...s.projects.map((p) => ({ label: p.name, icon: <Icon.Music size={14} />, checked: p.id === s.projectName, onSelect: () => go(`/c/${p.id}`) })),
            { separator: true, label: '' },
            { label: 'Todas as mixagens…', icon: <Icon.Library size={14} />, onSelect: () => go('/') },
          ]} />
      </Pill>
      <Pill className="px-1 gap-0.5">
        <IconButton title="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => void undo()}><Icon.Undo /></IconButton>
        <IconButton title="Redo (Ctrl+Shift+Z)" disabled={!s.canRedo} onClick={() => void redo()}><Icon.Redo /></IconButton>
      </Pill>

      <span className="flex-1" />

      <Pill className="px-1 gap-0.5">
        <IconButton title="Voltar ao início (Home)" onClick={() => { s.setPlayhead(0); if (s.playing) void engine.play(0) }}><Icon.Rewind /></IconButton>
        <IconButton title="Tocar / pausar (Espaço)" className="text-ink-100" onClick={() => (s.playing ? engine.stop() : void engine.play())}>
          {s.playing ? <Icon.Pause /> : <Icon.Play />}
        </IconButton>
      </Pill>
      <Pill className="px-1 gap-1">
        <SnapControl />
        <span className="font-mono text-[12.5px] text-ink-200 tabular w-[84px] text-center">{clock(s.playhead)}</span>
        {r?.bpm && <span className="font-mono text-[12.5px] text-ink-200 tabular w-[70px] text-center">{bars(s.playhead, r.bpm, r.meter, r.gridOffset)}</span>}
        <div className="w-16 h-1 mx-2 rounded bg-ink-700 overflow-hidden" title={`${s.meter.toFixed(1)} dBFS no preview (sem normalização)`}>
          <div className="h-full" style={{ width: `${meterPct}%`, background: s.meter > -6 ? '#ff5d5d' : s.meter > -18 ? '#f2c14e' : '#4ade80' }} />
        </div>
      </Pill>
      {s.loading !== null && <span className="text-[11px] text-ink-400 font-mono">{s.loading >= 0.99 ? 'preparando o áudio…' : `carregando o áudio ${Math.round(s.loading * 100)}%`}</span>}
      {s.busy && <span className="text-[11px] text-amber-200/80 truncate max-w-[260px]">{s.busy}</span>}

      <span className="flex-1" />

      {s.project && (
        <Pill className="px-3 gap-4 font-mono text-[12.5px] text-ink-200">
          <span className="flex items-center gap-1">
            <InlineEdit clickToEdit value={String(r?.bpm ?? '—')} title="Tempo (grade)" inputClassName="w-12 h-6 font-mono"
              onCommit={(v) => { const n = Number(v); if (n >= 20 && n <= 400) void setProject('bpm', n, `Tempo ${n} BPM`) }} />
            <span className="text-ink-400">BPM</span>
          </span>
          <InlineEdit clickToEdit value={`${r?.meter ?? 4}/4`} title="Compasso" inputClassName="w-12 h-6 font-mono"
            onCommit={(v) => { const n = Number(v.split('/')[0]); if (n >= 1 && n <= 16) void setProject('meter', n, `Meter ${n}/4`) }} />
        </Pill>
      )}
      <button type="button" onClick={() => go(`/c/${s.projectName}/roteiro`)} title="O texto da narração, por capítulo e humor"
        className="h-9 px-3 rounded-[10px] text-[13px] bg-ink-800 text-ink-200 border border-white/[0.04] hover:bg-ink-750 flex items-center gap-1.5">
        <Icon.TextT size={14} /> Roteiro
      </button>
      <button type="button" onClick={() => void save()} title="Salvar (Ctrl+S)"
        className={cx('h-9 px-3.5 rounded-[10px] text-[13px] border', s.dirty ? 'bg-ink-100 text-black border-transparent font-medium' : 'bg-ink-800 text-ink-400 border-white/[0.04]')}>
        {s.dirty ? 'Salvar' : 'Salvo'}
      </button>
      <ExportMenu />
    </header>
  )
}

function ExportMenu() {
  const s = useEditor()
  const [renders, setRenders] = useState<string[]>([])
  const busy = !!s.render && !s.render.done
  useEffect(() => {
    if (s.projectName) void fetch(`/api/renders?c=${s.projectName}`).then((r) => r.json()).then((j) => setRenders(j.renders ?? [])).catch(() => {})
  }, [s.render?.done, s.projectName])
  const hasVideo = !!s.project?.tracks.some((t) => t.type === 'video')
  const dl = (name: string) => window.open(`/api/renders/${name}?c=${s.projectName}`, '_blank')
  return (
    <Menu align="right" width={260}
      trigger={() => (
        <Pill className="px-3 gap-2 cursor-pointer hover:bg-ink-750 text-ink-200">
          <Icon.Export size={15} />
          <span className="text-[13px]">{busy ? `${Math.round((s.render?.progress ?? 0) * 100)}% ${s.render?.stage}` : 'Exportar'}</span>
        </Pill>
      )}
      items={[
        { label: 'Render mp3', icon: <Icon.Music size={14} />, disabled: busy, onSelect: () => void startRender('mp3') },
        { label: 'Render wav', icon: <Icon.Wave size={14} />, disabled: busy, onSelect: () => void startRender('wav') },
        // o mp4 (com a imagem) não sai daqui: é pesado, e roda só por script (`npm run dmixer -- render <mix> --out x.mp4`)
        ...(hasVideo ? [{ label: 'mp4: pelo script (render na pasta renders/)', icon: <Icon.Video size={14} />, disabled: true }] : []),
        { separator: true, label: '' },
        ...(s.render?.error ? [{ label: `Erro: ${s.render.error.slice(0, 40)}`, danger: true }] : []),
        ...renders.slice(0, 5).map((f) => ({ label: f, icon: <Icon.Download size={14} />, onSelect: () => dl(f) })),
        ...(renders.length ? [{ separator: true, label: '' }] : []),
        {
          label: 'Baixar o YAML', icon: <Icon.Code size={14} />,
          onSelect: () => {
            const url = URL.createObjectURL(new Blob([s.yaml], { type: 'text/yaml' }))
            Object.assign(document.createElement('a'), { href: url, download: s.file?.split('/').pop() ?? 'mix.yaml' }).click()
            URL.revokeObjectURL(url)
          },
        },
        { label: 'Copiar o YAML', icon: <Icon.Copy size={14} />, onSelect: () => void navigator.clipboard.writeText(s.yaml) },
      ]} />
  )
}

export function BottomBar() {
  const s = useEditor()
  const fit = () => {
    const el = document.querySelector('[data-timeline]') as HTMLElement | null
    if (el && s.resolved) s.setZoom((el.clientWidth - 280) / Math.max(10, s.resolved.duration + 5))
  }
  return (
    <footer className="h-[52px] shrink-0 flex items-center gap-2 px-3 bg-ink-900 border-t border-white/[0.05]">
      <Pill className="px-1">
        <IconButton title="Master: volume, loudness e efeitos" active={s.selection?.kind === 'master'} onClick={() => s.select({ kind: 'master' })}><Icon.Mixer size={15} /></IconButton>
      </Pill>
      <Pill className="px-1">
        <IconButton title="YAML" active={s.panel === 'yaml'} onClick={() => s.setState({ panel: s.panel === 'yaml' ? null : 'yaml' })}><Icon.Code size={15} /></IconButton>
        <IconButton title="Problemas" active={s.panel === 'problems'} onClick={() => s.setState({ panel: s.panel === 'problems' ? null : 'problems' })}>
          <span className="relative"><Icon.Bulb size={15} />{s.diagnostics.length > 0 && <span className="absolute -top-1 -right-1.5 text-[9px] font-mono text-amber-300">{s.diagnostics.length}</span>}</span>
        </IconButton>
        <IconButton title="Histórico" active={s.panel === 'history'} onClick={() => s.setState({ panel: s.panel === 'history' ? null : 'history' })}><Icon.List size={15} /></IconButton>
      </Pill>
      {s.savedAt && <span className="text-[11px] text-ink-500 ml-1">YAML salvo às {new Date(s.savedAt).toLocaleTimeString()}</span>}
      <span className="flex-1" />
      <Pill className="px-1">
        <IconButton title="Menos zoom (−)" onClick={() => s.setZoom(s.zoom / 1.4)}><Icon.ZoomOut size={15} /></IconButton>
        <IconButton title="Ver tudo" onClick={fit}><Icon.Collapse size={15} /></IconButton>
        <IconButton title="Mais zoom (+)" onClick={() => s.setZoom(s.zoom * 1.4)}><Icon.ZoomIn size={15} /></IconButton>
      </Pill>
    </footer>
  )
}


/** Under the timeline: the master fader ("Main") and the whole mix at a glance, with the visible window on it. */
export function MasterRow() {
  const s = useEditor()
  const [view, setView] = useState({ left: 0, width: 0 })
  useEffect(() => {
    const el = document.querySelector('[data-timeline]') as HTMLElement | null
    if (!el) return
    const update = () => setView({ left: el.scrollLeft / s.zoom, width: (el.clientWidth - 264) / s.zoom })
    update()
    el.addEventListener('scroll', update)
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', update); ro.disconnect() }
  }, [s.zoom, s.resolved])
  const r = s.resolved
  if (!r || !s.project) return null
  const total = Math.max(r.duration + 5, 1)
  const pct = (t: number) => `${(t / total) * 100}%`
  const step = [5, 10, 15, 30, 60, 120, 300].find((x) => (x / total) * 900 >= 60) ?? 600
  const labels: number[] = []
  for (let t = 0; t <= total; t += step) labels.push(t)
  const timeline = () => document.querySelector('[data-timeline]') as HTMLElement | null
  /** Show the window [a, b] (seconds): zoom so it fills the timeline, then scroll to it. */
  const showWindow = (a: number, b: number) => {
    const el = timeline()
    if (!el) return
    const visible = el.clientWidth - 264
    const z = Math.min(800, Math.max(2, visible / Math.max(0.5, b - a)))
    s.setZoom(z)
    requestAnimationFrame(() => (el.scrollLeft = Math.max(0, a * useEditor.getState().zoom)))
  }
  const scrollTo = (clientX: number, box: DOMRect) => {
    const el = timeline()
    const t = ((clientX - box.left) / box.width) * total
    if (el) el.scrollLeft = Math.max(0, (t - view.width / 2) * s.zoom)
  }
  /** Drag the window (move) or one of its sides (resize = zoom), in seconds of the overview. */
  const dragWindow = (e: React.PointerEvent, mode: 'move' | 'left' | 'right') => {
    e.stopPropagation()
    const box = ((e.currentTarget as HTMLElement).closest('[data-overview]') as HTMLElement).getBoundingClientRect()
    const x0 = e.clientX
    const a0 = view.left
    const b0 = view.left + view.width
    const perPx = total / box.width
    const move = (ev: PointerEvent) => {
      const dt = (ev.clientX - x0) * perPx
      if (mode === 'move') {
        const el = timeline()
        if (el) el.scrollLeft = Math.max(0, (a0 + dt) * useEditor.getState().zoom)
      } else if (mode === 'left') showWindow(Math.max(0, Math.min(b0 - 0.5, a0 + dt)), b0)
      else showWindow(a0, Math.max(a0 + 0.5, Math.min(total, b0 + dt)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const master = s.project.master ?? {}
  return (
    <div className="h-[52px] shrink-0 flex border-t border-white/[0.05]">
      <div className="shrink-0 flex flex-col justify-center gap-1.5 px-3 bg-ink-900 border-r border-white/[0.05] relative cursor-pointer" style={{ width: 264 }}
        onPointerDown={() => s.select({ kind: 'master' })}>
        <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r bg-white" />
        <div className="flex items-center justify-between">
          <span className="text-[12.5px] text-ink-100">Main</span>
          <span className="text-[10.5px] font-mono text-ink-400">{master.loudness ? `${master.loudness.target} LUFS` : ''}</span>
        </div>
        <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
          <Fader value={master.volume ?? 0} min={-24} max={12} step={0.5} reset={0} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`}
            onCommit={(v) => void patch([{ op: s.project!.master ? 'replace' : 'add', path: '/master', value: { ...master, volume: v } }], 'Master volume')} />
        </div>
      </div>
      <div data-overview className="flex-1 relative bg-ink-900 cursor-pointer overflow-hidden"
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); scrollTo(e.clientX, e.currentTarget.getBoundingClientRect()) }}
        onPointerMove={(e) => e.buttons === 1 && scrollTo(e.clientX, e.currentTarget.getBoundingClientRect())}>
        {r.regions.map((g) => (
          <div key={g.id} className="absolute h-[5px] top-2 rounded-sm opacity-70" style={{ left: pct(g.start), width: pct(g.end - g.start), background: g.color, top: 6 + (r.lanes.findIndex((l) => l.id === g.lane) * 6) }} />
        ))}
        <div className="absolute top-2 bottom-2 rounded bg-white/[0.07] border border-white/10 cursor-grab active:cursor-grabbing group/win"
          style={{ left: pct(view.left), width: pct(Math.min(view.width, total - view.left)) }}
          title="arraste para mover; arraste as laterais para ampliar ou reduzir o campo de visão"
          onPointerDown={(e) => dragWindow(e, 'move')}>
          <div className="absolute -left-[4px] top-0 bottom-0 w-[9px] cursor-ew-resize flex items-center justify-center" onPointerDown={(e) => dragWindow(e, 'left')}>
            <div className="w-[3px] h-4 rounded-full bg-white/30 group-hover/win:bg-white/70" />
          </div>
          <div className="absolute -right-[4px] top-0 bottom-0 w-[9px] cursor-ew-resize flex items-center justify-center" onPointerDown={(e) => dragWindow(e, 'right')}>
            <div className="w-[3px] h-4 rounded-full bg-white/30 group-hover/win:bg-white/70" />
          </div>
        </div>
        {labels.map((t) => (
          <span key={t} className={cx('absolute bottom-1.5 font-mono text-[10.5px] text-ink-400', t > 0 && '-translate-x-1/2')} style={{ left: `calc(${pct(t)} + ${t === 0 ? 6 : 0}px)` }}>
            {`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`}
          </span>
        ))}
        <div className="absolute top-0 bottom-0 w-px bg-white/70" style={{ left: pct(s.playhead) }} />
      </div>
    </div>
  )
}

/** SNAP on/off and its resolution. On: moves and drops land on the grid, and edges grab each other. */
function SnapControl() {
  const grid = useEditor((s) => s.snapGrid)
  const set = (g: 'bar' | 'beat' | 'off') => {
    localStorage.setItem('dmixer.snap', g)
    useEditor.getState().setState({ snapGrid: g, snap: g !== 'off' })
  }
  const label = { bar: 'compasso', beat: 'tempo', off: 'livre' }[grid]
  return (
    <Menu width={230}
      trigger={() => (
        <button type="button" title="SNAP: onde as coisas caem ao mover e soltar (Alt ao arrastar inverte)"
          className={cx('h-8 px-2.5 rounded-md flex items-center gap-1.5 text-[11px] font-semibold tracking-wider',
            grid !== 'off' ? 'bg-white/[0.10] text-ink-100' : 'text-ink-500 hover:text-ink-100 hover:bg-white/[0.06]')}>
          <span className={cx('w-1.5 h-1.5 rounded-full', grid !== 'off' ? 'bg-emerald-400' : 'bg-ink-600')} />
          SNAP <span className="font-normal tracking-normal text-ink-400">{label}</span>
        </button>
      )}
      items={[
        { label: 'Compasso', hint: 'peças de lego', checked: grid === 'bar', onSelect: () => set('bar') },
        { label: 'Tempo', hint: '1/4 de compasso', checked: grid === 'beat', onSelect: () => set('beat') },
        { label: 'Desligado', hint: 'livre', checked: grid === 'off', onSelect: () => set('off') },
      ]} />
  )
}
