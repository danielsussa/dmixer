import { useEffect, useRef, useState } from 'react'
import { formatTime } from '@dmixer/core'
import { applyYaml, connect, currentId, fetchProjects, go, linkPath, loadState, P, patch, redo, reload, save, startRender, undo, unlinkMix } from './api'
import { engine } from './audio'
import { useEditor } from './store'
import { Timeline } from './components/Timeline'
import { Inspector } from './components/Inspector'
import { Viewer } from './components/Viewer'
import { LibraryPanel } from './components/Library'
import { MobileApp, useIsMobile } from './components/Mobile'
import { BottomBar, Logo, MasterRow, TopBar } from './components/Bars'
import { Toolbar } from './components/Toolbar'
import { colar, copiar, crossfade, splitAt } from './tools'

export function App() {
  const project = useEditor((s) => s.project)
  const [id, setId] = useState(currentId())
  const mobile = useIsMobile()
  useEffect(() => connect(), [])
  useEffect(() => {
    const onPop = () => setId(currentId())
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  // opening another mix: stop the audio, forget the old one, load the new one
  useEffect(() => {
    engine.stop()
    useEditor.getState().setState({ project: null, resolved: null, selection: null, render: null, yaml: '', loadError: null, projectName: id })
    if (id) void loadState(id)
    else void fetchProjects()
    document.title = id ? 'dmixer' : 'dmixer · mixagens'
  }, [id])

  // what you hear follows the file: an edit while playing rebuilds the graph at the playhead
  useEffect(() => {
    const t = setTimeout(() => void engine.refresh(), 120)
    return () => clearTimeout(t)
  }, [project])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const tag = el.tagName
      if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && !['range', 'checkbox', 'color'].includes((el as HTMLInputElement).type))) return
      const s = useEditor.getState()
      const mod = e.ctrlKey || e.metaKey
      if (e.code === 'Space') {
        e.preventDefault()
        ;(document.activeElement as HTMLElement | null)?.blur?.()
        if (s.playing) engine.stop()
        else void engine.play()
      } else if (e.key === 'Home') {
        s.setPlayhead(0)
        if (s.playing) void engine.play(0)
      } else if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      } else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        void (e.shiftKey ? redo() : undo())
      } else if (mod && e.key.toLowerCase() === 'c' && s.selection?.kind === 'clip' && !window.getSelection()?.toString()) {
        e.preventDefault()
        copiar()
      } else if (mod && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        void colar()
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        void redo()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const sel = s.selection
        if (sel?.kind === 'clip') void patch([{ op: 'remove', path: P.clip(sel.trackId, sel.clipId) }], `Delete ${sel.clipId}`)
        if (sel?.kind === 'marker') void patch([{ op: 'remove', path: P.marker(sel.markerId) }], `Delete marker ${sel.markerId}`)
        if (sel?.kind === 'region') void patch([{ op: 'remove', path: P.region(sel.regionId) }], `Delete tag ${sel.regionId}`)
        if (sel?.kind === 'point') {
          const t = s.resolved?.tracks.find((x) => x.id === sel.trackId)
          const p = t?.envelope[sel.index]
          if (t && p) void patch([{ op: 'remove', path: `${P.track(t.id)}/automation/volume/${p.index}` }], 'Delete envelope point')
        }
        s.select(null)
      } else if (e.key === '+' || e.key === '=') s.setZoom(s.zoom * 1.25)
      else if (e.key === '-') s.setZoom(s.zoom / 1.25)
      else if (!mod && !e.altKey && e.key.toLowerCase() === 'v') s.setState({ tool: 'select' })
      else if (!mod && !e.altKey && e.key.toLowerCase() === 'c') s.setState({ tool: 'cut' })
      else if (!mod && !e.altKey && e.key.toLowerCase() === 's') void splitAt(s.playhead)
      else if (!mod && !e.altKey && e.key.toLowerCase() === 'x') void crossfade(s.fadeLen)
      else if (e.key === 'Escape' && s.tool !== 'select') s.setState({ tool: 'select' })
      else if (e.key.toLowerCase() === 'm' && !mod) {
        // drop a marker at the playhead
        const n = (s.project?.markers?.length ?? 0) + 1
        const id = `m${n}`
        const op = s.project?.markers ? { op: 'add' as const, path: '/markers/-', value: { id, at: Math.round(s.playhead * 1000) / 1000 } } : { op: 'add' as const, path: '/markers', value: [{ id, at: Math.round(s.playhead * 1000) / 1000 }] }
        void patch([op], `Marker ${id}`)
      }
    }
    // Space is transport, never "press the focused button" (that is how a mute got toggled by playing)
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.target as HTMLElement).tagName === 'BUTTON') e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp, true)
    }
  }, [])

  const hasVideo = !!project?.tracks.some((t) => t.type === 'video')
  if (!id) return <Home />
  if (mobile) return <MobileApp />
  return (
    <div className="h-full flex flex-col">
      <TopBar />
      <Toolbar />
      <Conflict />
      <div className="flex-1 flex min-h-0">
        <Timeline />
        <div className="w-96 min-w-96 border-l border-white/[0.05] bg-ink-900 flex flex-col min-h-0">
          {hasVideo && <Viewer />}
          <RightTabs />
        </div>
      </div>
      <MasterRow />
      <BottomPanel />
      <BottomBar />
    </div>
  )
}

function Conflict() {
  const conflict = useEditor((s) => s.conflict)
  if (!conflict) return null
  return (
    <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-200 flex items-center gap-3">
      <span>O arquivo mudou no disco enquanto havia alterações não salvas aqui.</span>
      <button className="btn" onClick={() => void save().then(() => useEditor.getState().setState({ conflict: null }))}>Manter as minhas</button>
      <button className="btn" onClick={() => void reload().then(() => useEditor.getState().setState({ conflict: null }))}>Usar o arquivo</button>
    </div>
  )
}

function BottomPanel() {
  const panel = useEditor((s) => s.panel)
  if (!panel) return null
  return (
    <div className="h-72 border-t border-white/[0.05] bg-ink-900 flex flex-col">
      {panel === 'yaml' && <YamlPanel />}
      {panel === 'problems' && <Problems />}
      {panel === 'history' && <History />}
    </div>
  )
}

function YamlPanel() {
  const yaml = useEditor((s) => s.yaml)
  const [text, setText] = useState(yaml)
  const [error, setError] = useState<string | null>(null)
  const editing = useRef(false)
  useEffect(() => { if (!editing.current) setText(yaml) }, [yaml])
  const changed = text !== yaml
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-2 px-3 py-1 border-b border-[var(--line)]">
        <span className="text-[var(--muted)]">O arquivo é a fonte da verdade. Edite aqui ou em qualquer editor; a tela acompanha.</span>
        <div className="flex-1" />
        {error && <span className="text-red-400 truncate max-w-[50%]" title={error}>{error}</span>}
        <button className="btn" disabled={!changed} onClick={() => { editing.current = false; setText(yaml); setError(null) }}>descartar</button>
        <button className="btn on" disabled={!changed}
          onClick={() => applyYaml(text).then(() => { editing.current = false; setError(null) }).catch((e: Error) => setError(e.message))}>aplicar</button>
      </div>
      <textarea className="flex-1 bg-ink-950 p-3 font-mono text-[12px] text-ink-200 outline-none resize-none" spellCheck={false} value={text}
        onChange={(e) => { editing.current = true; setText(e.target.value) }}
        onKeyDown={(e) => {
          e.stopPropagation()
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void applyYaml(text).then(() => { editing.current = false; setError(null) }).catch((er: Error) => setError(er.message))
        }} />
    </div>
  )
}

function Problems() {
  const d = useEditor((s) => s.diagnostics)
  return (
    <div className="flex-1 overflow-auto p-3 space-y-1">
      {d.length === 0 && <div className="text-[var(--muted)]">Nenhum problema.</div>}
      {d.map((x, i) => <div key={i} className={x.severity === 'error' ? 'text-red-400' : 'text-yellow-300'}>{x.severity}: {x.message}</div>)}
    </div>
  )
}

function History() {
  const h = useEditor((s) => s.history)
  return (
    <div className="flex-1 overflow-auto p-3 space-y-0.5">
      {[...h].reverse().map((x) => (
        <div key={x.id} className="flex gap-3">
          <span className="num text-[var(--muted)] w-16">{new Date(x.at).toLocaleTimeString()}</span>
          <span className="w-14 text-[var(--muted)]">{x.author}</span>
          <span>{x.label}</span>
        </div>
      ))}
    </div>
  )
}

/** The list of linked mixes, and a box to link one from any folder on this machine. */
function Home() {
  const projects = useEditor((s) => s.projects)
  const connected = useEditor((s) => s.connected)
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const link = async () => {
    try {
      setError(null)
      const e = await linkPath(path.trim())
      go(`/c/${e.id}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto p-4 sm:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <Logo />
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-red-500'}`} />
          <span className="text-ink-400">a mixagem é um arquivo YAML</span>
        </div>
        <div className="space-y-2">
          <div className="text-[var(--muted)]">Ligar uma mixagem: o caminho de um <code>.yaml</code> nesta máquina (em qualquer pasta).</div>
          <div className="flex gap-2">
            <input className="field flex-1 font-mono" placeholder="/home/daniel/…/mixagem/trilha.yaml" value={path}
              onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void link() }} />
            <button className="btn on" disabled={!path.trim()} onClick={() => void link()}>ligar</button>
          </div>
          {error && <div className="text-red-400">{error}</div>}
        </div>
        <div className="space-y-1">
          {projects.length === 0 && <div className="text-[var(--muted)]">Nenhuma mixagem ligada ainda.</div>}
          {projects.map((p) => (
            <div key={p.id} className="flex items-center gap-3 rounded-xl border border-white/[0.05] bg-ink-900 px-4 py-3 hover:bg-ink-850">
              <a className="flex-1 min-w-0 cursor-pointer" href={`/c/${p.id}`} onClick={(e) => { e.preventDefault(); go(`/c/${p.id}`) }}>
                <div className="font-medium text-ink-100">{p.name}</div>
                <div className="text-[11px] text-[var(--muted)] font-mono truncate">{p.path}</div>
              </a>
              <span className="text-[10px] text-[var(--muted)] font-mono">/c/{p.id.slice(0, 8)}…</span>
              <button className="btn !h-7" title="desligar (o arquivo não é apagado)" onClick={() => void unlinkMix(p.id).then(fetchProjects)}>desligar</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function RightTabs() {
  const [tab, setTab] = useState<'inspector' | 'library'>(() => (localStorage.getItem('dmixer.tab') as 'library') ?? 'inspector')
  const selection = useEditor((s) => s.selection)
  // selecting something on the timeline brings the inspector back
  // no automatic switching: placing pieces from the library keeps the library open (a dot tells there is a selection)
  const pick = (t: 'inspector' | 'library') => { setTab(t); localStorage.setItem('dmixer.tab', t) }
  return (
    <>
      <div className="flex gap-1 p-2 border-b border-white/[0.05]">
        {(['inspector', 'library'] as const).map((t) => (
          <button key={t} type="button" onClick={() => pick(t)}
            className={`h-7 px-3 rounded-md text-[12px] ${tab === t ? 'bg-white/[0.08] text-ink-100' : 'text-ink-400 hover:text-ink-100'}`}>
            {t === 'inspector' ? 'Inspetor' : 'Biblioteca'}
            {t === 'inspector' && tab !== 'inspector' && selection && <span className="ml-1.5 inline-block w-1.5 h-1.5 rounded-full bg-amber-300 align-middle" title="há algo selecionado" />}
          </button>
        ))}
      </div>
      {tab === 'inspector' ? <Inspector /> : <LibraryPanel />}
    </>
  )
}
