import { useEffect, useState } from 'react'
import type { ResolvedTrack } from '@dmixer/core'
import { P, patch } from '../api'
import { useEditor } from '../store'
import { cx, Icon, InlineEdit } from './ui'

const KIND: Record<ResolvedTrack['type'], string> = { audio: 'ÁUDIO', bus: 'BUS', video: 'VÍDEO' }

/** Name, kind, mute / solo / envelope, the fader and the pan. Faders commit on release, so a drag is one undo step. */
export function TrackHeader({ track: t }: { track: ResolvedTrack }) {
  const select = useEditor((s) => s.select)
  const selection = useEditor((s) => s.selection)
  const editing = useEditor((s) => !!s.automation[t.id])
  const toggleAutomation = useEditor((s) => s.toggleAutomation)
  const sel = selection?.kind === 'track' && selection.trackId === t.id
  const set = (key: string, value: unknown, label: string) =>
    patch([{ op: t.raw[key as keyof typeof t.raw] === undefined ? 'add' : 'replace', path: `${P.track(t.id)}/${key}`, value }], label)
  return (
    <div className={cx('relative h-full flex flex-col justify-between px-3 py-2 border-r border-white/[0.05] group', sel ? 'bg-ink-850' : 'bg-ink-900', t.muted && 'opacity-60')}
      onPointerDown={() => select({ kind: 'track', trackId: t.id })}>
      <span className="absolute left-0 top-2 bottom-2 w-[3px] rounded-r" style={{ background: t.color }} />
      <div className="flex items-center gap-2 min-w-0">
        <InlineEdit value={t.name} className="text-[13px] text-ink-100 font-medium flex-1 min-w-0" inputClassName="h-6 w-32 text-[13px]"
          onCommit={(name) => set('name', name, `Rename ${t.id}`)} />
        {t.output && <span className="text-[10px] text-ink-500 truncate max-w-[70px]" title={`saída: ${t.output}`}>→ {t.output}</span>}
        {t.samplers
          ? <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-300/15 text-amber-200" title="só peças da biblioteca: elas não vão para outras trilhas, e nada de fora entra aqui">samplers</span>
          : <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-white/[0.05] text-ink-300">{KIND[t.type]}</span>}
      </div>
      <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
        <Toggle on={t.muted} label="M" title={t.type === 'video' ? 'ocultar' : 'mudo'} cls="bg-amber-400/90" onClick={() => set('muted', !t.muted, `${t.muted ? 'Unmute' : 'Mute'} ${t.id}`)} />
        {t.type !== 'video' && <Toggle on={t.solo} label="S" title="solo" cls="bg-sky-400/90" onClick={() => set('solo', !t.solo, `${t.solo ? 'Unsolo' : 'Solo'} ${t.id}`)} />}
        {t.type !== 'video' && (
          <button type="button" title="editar o envelope de volume (duplo clique cria ponto, Alt+clique apaga)" onClick={() => toggleAutomation(t.id)}
            className={cx('w-6 h-6 rounded grid place-items-center', editing ? 'bg-ink-100 text-black' : 'bg-white/[0.05] text-ink-300 hover:text-ink-100')}>
            <Icon.Automation size={13} />
          </button>
        )}
        {t.type === 'video' ? (
          <span className="text-[10.5px] text-ink-400">{t.clips.length} clipe(s){t.muted ? ' · oculta' : ''}</span>
        ) : (
          <Fader value={t.volume} min={-60} max={12} step={0.5} format={(v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}dB`}
            onCommit={(v) => set('volume', v, `Volume ${t.id}`)} reset={0} />
        )}
      </div>
      {t.type !== 'video' && (
        <div className="flex items-center gap-2" onPointerDown={(e) => e.stopPropagation()}>
          <span className="text-[10px] text-ink-500 w-6">pan</span>
          <Fader value={t.pan} min={-1} max={1} step={0.05} reset={0} onCommit={(v) => set('pan', v, `Pan ${t.id}`)}
            format={(v) => (v === 0 ? 'C' : v < 0 ? `L${Math.round(-v * 100)}` : `R${Math.round(v * 100)}`)} />
        </div>
      )}
    </div>
  )
}

function Toggle({ on, label, title, onClick, cls }: { on: boolean; label: string; title: string; onClick: () => void; cls: string }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={cx('w-6 h-6 rounded text-[11px] font-semibold', on ? `${cls} text-black` : 'bg-white/[0.05] text-ink-300 hover:text-ink-100')}>
      {label}
    </button>
  )
}

export function Fader({ value, min, max, step, onCommit, reset, format }: {
  value: number; min: number; max: number; step: number; onCommit: (v: number) => void; reset: number; format: (v: number) => string
}) {
  const [local, setLocal] = useState(value)
  const [active, setActive] = useState(false)
  useEffect(() => { if (!active) setLocal(value) }, [value, active])
  const commit = () => {
    setActive(false)
    if (local !== value) onCommit(local)
  }
  return (
    <>
      <input type="range" className="fader flex-1 min-w-0" min={min} max={max} step={step} value={local}
        onChange={(e) => { setActive(true); setLocal(Number(e.target.value)) }}
        onPointerUp={commit} onKeyUp={commit} onBlur={() => active && commit()}
        onDoubleClick={() => { setLocal(reset); onCommit(reset) }} />
      <span className="font-mono text-[10.5px] text-ink-400 w-12 text-right tabular">{format(local)}</span>
    </>
  )
}
