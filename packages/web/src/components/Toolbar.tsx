import { useEffect, useState } from 'react'
import { useEditor } from '../store'
import { colar, copiar, crossfade, fade, mixarAutomatico, splitAt } from '../tools'
import { cx, Icon } from './ui'

const ramp = (d: string) => (
  <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
)
const XFADE = ramp('M3 19L21 5M3 5l18 14')
const FADE_IN = ramp('M3 19L14 6h7')
const FADE_OUT = ramp('M3 6h7l11 13')

/** The editing tools: what a click on a clip does, and the cuts and transitions made on the selection. */
export function Toolbar() {
  const tool = useEditor((s) => s.tool)
  const fadeLen = useEditor((s) => s.fadeLen)
  const selection = useEditor((s) => s.selection)
  const set = useEditor((s) => s.setState)
  const clip = selection?.kind === 'clip'
  const [mixando, setMixando] = useState(false)
  const [aviso, setAviso] = useState('')
  useEffect(() => { if (!aviso) return; const id = setTimeout(() => setAviso(''), 8000); return () => clearTimeout(id) }, [aviso])
  return (
    <div className="h-10 shrink-0 flex items-center gap-1 px-3 bg-ink-900 border-b border-white/[0.05] text-[12px]">
      <Btn on={tool === 'select'} title="Selecionar e mover (V)" onClick={() => set({ tool: 'select' })}><Icon.Pointer size={14} /> Selecionar <Key k="V" /></Btn>
      <Btn on={tool === 'cut'} title="Cortar: clique num clipe para dividi-lo ali (C)" onClick={() => set({ tool: 'cut' })}><Icon.Blade size={14} /> Cortar <Key k="C" /></Btn>
      <Sep />
      <Btn title="Dividir no playhead: o clipe selecionado, os da trilha selecionada, ou todos sob o playhead (S)"
        onClick={() => void splitAt(useEditor.getState().playhead)}><Icon.Split size={14} /> Dividir no playhead <Key k="S" /></Btn>
      <Btn disabled={!clip} title="Copiar o clipe selecionado (Ctrl/⌘+C)" onClick={() => copiar()}>Copiar <Key k="⌘C" /></Btn>
      <Btn title="Colar na agulha, na trilha selecionada (Ctrl/⌘+V); a agulha vai para o fim do colado" onClick={() => void colar()}>Colar na agulha <Key k="⌘V" /></Btn>
      <Sep />
      <Btn title="Mixagem automática: a música sobe nas pausas da locução e desce antes da próxima palavra (envelope de volume, editável). Desfaz com Ctrl/⌘+Z."
        disabled={mixando} onClick={() => {
          setMixando(true)
          void mixarAutomatico().then(setAviso, (e) => setAviso(`Mixar: ${e.message ?? e}`)).finally(() => setMixando(false))
        }}>{mixando ? 'Mixando…' : 'Mixar'}</Btn>
      {aviso && <span className="text-ink-400 truncate max-w-[340px]" title={aviso} onClick={() => setAviso('')}>{aviso}</span>}
      <Sep />
      <Btn disabled={!clip} title="Crossfade do clipe selecionado para o próximo da mesma trilha (X)" onClick={() => void crossfade(fadeLen)}>{XFADE} Crossfade <Key k="X" /></Btn>
      <Btn disabled={!clip} title="Fade in no clipe selecionado" onClick={() => void fade('in', fadeLen)}>{FADE_IN} Fade in</Btn>
      <Btn disabled={!clip} title="Fade out no clipe selecionado" onClick={() => void fade('out', fadeLen)}>{FADE_OUT} Fade out</Btn>
      <label className="flex items-center gap-1 ml-1 text-ink-400" title="duração do crossfade e dos fades">
        <input type="number" min={0.02} max={30} step={0.1} value={fadeLen}
          className="field !h-7 w-16 font-mono text-[12px] text-ink-100"
          onKeyDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (v > 0) { set({ fadeLen: v }); try { localStorage.setItem('dmixer.fadeLen', String(v)) } catch { /* sem storage */ } }
          }} />
        s
      </label>
      <span className="flex-1" />
      <span className="text-ink-500 truncate">
        {tool === 'cut' ? 'clique num clipe para cortá-lo ali (Alt ignora o SNAP)' : clip ? 'Crossfade vai do clipe selecionado para o próximo da trilha' : 'selecione um clipe para as transições'}
      </span>
    </div>
  )
}

function Btn({ on, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { on?: boolean }) {
  return (
    <button type="button" {...props}
      className={cx('h-7 px-2 rounded-md flex items-center gap-1.5 disabled:opacity-35 disabled:hover:bg-transparent',
        on ? 'bg-white/[0.1] text-ink-100' : 'text-ink-300 hover:text-ink-100 hover:bg-white/[0.06]')}>
      {children}
    </button>
  )
}

const Sep = () => <span className="w-px h-5 bg-white/[0.07] mx-1" />
const Key = ({ k }: { k: string }) => <kbd className="ml-0.5 px-1 rounded bg-white/[0.06] text-[10px] text-ink-400 font-mono">{k}</kbd>
