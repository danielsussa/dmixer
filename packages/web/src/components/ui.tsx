import React, { useEffect, useRef, useState } from 'react'

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

type IconProps = { size?: number; className?: string }
const svg = (size: number, className: string | undefined, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden>
    {children}
  </svg>
)
/** the parts that are lines (arrows' shafts, handles), drawn heavy enough to read as solid next to the fills */
const L = ({ d }: { d: string }) => <path d={d} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />

/** The handful of glyphs the shell needs, all solid: shapes filled, lines drawn heavy. */
export const Icon = {
  Play: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M7 4.5v15l13-7.5z" />),
  Pause: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>),
  Rewind: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M11 5.5v13L2.5 12z" /><path d="M21 5.5v13L12.5 12z" /></>),
  Record: ({ size = 16, className }: IconProps) => svg(size, className, <circle cx="12" cy="12" r="6" />),
  Loop: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M17 6H8a4 4 0 0 0-4 4v1" /><path d="M16.5 2.5l4.5 3.5-4.5 3.5z" /><L d="M7 18h9a4 4 0 0 0 4-4v-1" /><path d="M7.5 14.5L3 18l4.5 3.5z" /></>),
  Metronome: ({ size = 16, className }: IconProps) =>
    svg(size, className, <>{[3.8, 7.9, 12, 16.1, 20.2].map((x) => <rect key={x} x={x - 1.2} y="5" width="2.4" height="14" rx="1.2" />)}</>),
  Cursor: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M4 12h9" /><path d="M12 6.5l6 5.5-6 5.5z" /><rect x="19" y="4" width="2.6" height="16" rx="1.3" /></>),
  Undo: ({ size = 16, className }: IconProps) => svg(size, className, <><L d="M8 9h7a5 5 0 0 1 0 10h-3" /><path d="M9.5 3.5L3 9l6.5 5.5z" /></>),
  Redo: ({ size = 16, className }: IconProps) => svg(size, className, <><L d="M16 9H9a5 5 0 0 0 0 10h3" /><path d="M14.5 3.5L21 9l-6.5 5.5z" /></>),
  Export: ({ size = 16, className }: IconProps) => svg(size, className, <><L d="M16 10h-6a6 6 0 0 0-6 6v4" /><path d="M14 3.5l7 6.5-7 6.5z" /></>),
  Library: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="3" y="4" width="4" height="16" rx="1" /><rect x="8.5" y="4" width="4" height="16" rx="1" /><path d="M13.6 5.3l3.6-1.2a.8.8 0 0 1 1 .5l4.6 14.2a.8.8 0 0 1-.5 1l-3.6 1.2a.8.8 0 0 1-1-.5L13.1 6.3a.8.8 0 0 1 .5-1z" /></>),
  More: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" /></>),
  Plus: ({ size = 16, className }: IconProps) => svg(size, className, <L d="M12 5v14M5 12h14" />),
  Close: ({ size = 16, className }: IconProps) => svg(size, className, <L d="M6 6l12 12M18 6L6 18" />),
  Split: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="3" y="5" width="8" height="14" rx="2" /><rect x="13" y="5" width="8" height="14" rx="2" /></>),
  Up: ({ size = 16, className }: IconProps) => svg(size, className, <><L d="M12 20V10" /><path d="M5 11.5L12 4l7 7.5z" /></>),
  Chevron: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M6.5 9.5h11a.8.8 0 0 1 .6 1.3l-5.5 5.6a.8.8 0 0 1-1.2 0l-5.5-5.6a.8.8 0 0 1 .6-1.3z" />),
  Speaker: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M3 9.5A1 1 0 0 1 4 8.5h3.5L12 4.6a.6.6 0 0 1 1 .5v13.8a.6.6 0 0 1-1 .5l-4.5-3.9H4a1 1 0 0 1-1-1z" /><L d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></>),
  Mic: ({ size = 16, className }: IconProps) => svg(size, className, <><rect x="8.5" y="2.5" width="7" height="12" rx="3.5" /><L d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  Collapse: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M3 6.5l7 5.5-7 5.5z" /><path d="M21 6.5L14 12l7 5.5z" /></>),
  Expand: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M10 6.5L3 12l7 5.5z" /><path d="M14 6.5l7 5.5-7 5.5z" /></>),
  Tracks: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="3" y="5.5" width="12" height="3" rx="1.5" /><rect x="3" y="10.5" width="8" height="3" rx="1.5" /><rect x="3" y="15.5" width="12" height="3" rx="1.5" /><L d="M17 14.5l3.5 3.5M20.5 14.5L17 18" /></>),
  Mixer: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M6 4v16M12 4v16M18 4v16" /><rect x="3.5" y="12" width="5" height="4" rx="1.3" /><rect x="9.5" y="6" width="5" height="4" rx="1.3" /><rect x="15.5" y="14" width="5" height="4" rx="1.3" /></>),
  Automation: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M3 19c4-1 5-14 9-14s3 9 9 9v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />),
  Wave: ({ size = 16, className }: IconProps) =>
    svg(size, className, <>{[[3, 10.8, 13.2], [6.5, 7.5, 16.5], [10, 4.5, 19.5], [13.5, 8.5, 15.5], [17, 6, 18], [20.5, 9.5, 14.5]].map(([x, a, b]) => <rect key={x} x={x - 1.2} y={a} width="2.4" height={b - a} rx="1.2" />)}</>),
  List: ({ size = 16, className }: IconProps) =>
    svg(size, className, <>{[4.8, 9.6, 14.4, 19.2].map((y) => <rect key={y} x="3.5" y={y - 1.2} width="17" height="2.4" rx="1.2" />)}</>),
  Folder: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />),
  ZoomIn: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path fillRule="evenodd" d="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM10 7.5h2V10h2.5v2H12v2.5h-2V12H7.5v-2H10z" /><L d="M20 20l-4-4" /></>),
  ZoomOut: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path fillRule="evenodd" d="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14zM7.5 10h7v2h-7z" /><L d="M20 20l-4-4" /></>),
  Bulb: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M12 2.5a6.5 6.5 0 0 0-4 11.6V16a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-1.9a6.5 6.5 0 0 0-4-11.6z" /><L d="M9.5 20h5" /></>),
  Video: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="2.5" y="6" width="13.5" height="12" rx="2.5" /><path d="M17 10.2l4-2.7a.6.6 0 0 1 1 .5v8a.6.6 0 0 1-1 .5l-4-2.7z" /></>),
  Music: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M9 18V5.5l11-2V16" /><circle cx="6.5" cy="18" r="3" /><circle cx="17.5" cy="16" r="3" /></>),
  Code: ({ size = 16, className }: IconProps) => svg(size, className, <L d="M8 7l-5 5 5 5M16 7l5 5-5 5" />),
  Trash: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="3.5" y="5.5" width="17" height="2.6" rx="1.3" /><path d="M9 5.5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1.5z" /><path d="M5.5 9.5h13l-1 10.6a1 1 0 0 1-1 .9h-9a1 1 0 0 1-1-.9z" /></>),
  Note: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M10 3h3.2c.4 2.3 2 3.6 4.3 4.2v3c-1.6-.2-3-.8-4.3-1.7V16a4 4 0 1 1-3.2-3.9z" />),
  TextT: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M5 4h14v4h-3V7.5h-2.5V17H15v3H9v-3h1.5V7.5H8V8H5z" />),
  Controls: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M6 4v16M12 4v16M18 4v16" /><rect x="3.5" y="13" width="5" height="4" rx="1.3" /><rect x="9.5" y="6" width="5" height="4" rx="1.3" /><rect x="15.5" y="11" width="5" height="4" rx="1.3" /></>),
  Pointer: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M6 3.5l12 7.5-5.2 1.3 2.9 5.8-2.3 1.2-2.9-5.8L6 17z" />),
  Blade: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><circle cx="6" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><L d="M8 7.5L20 18M8 16.5L20 6" /></>),
  RangeTool: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M8 5H5v14h3M16 5h3v14h-3" /><rect x="8.5" y="10.3" width="7" height="3.4" rx="1.2" /></>),
  Sparkle: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />),
  Download: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><L d="M12 4v8" /><path d="M6.5 10.5h11L12 16.5z" /><rect x="4" y="18.5" width="16" height="2.6" rx="1.3" /></>),
  Fullscreen: ({ size = 16, className }: IconProps) => svg(size, className, <L d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />),
  ExitFullscreen: ({ size = 16, className }: IconProps) => svg(size, className, <L d="M9 4v5H4M15 4v5h5M20 15h-5v5M4 15h5v5" />),
  Copy: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="8" y="8" width="13" height="13" rx="2.5" /><path d="M4 6a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v.5H9.5a3 3 0 0 0-3 3V16H6a2 2 0 0 1-2-2z" /></>),
}

/** A rounded dark capsule — the shape every group of controls sits in. */
export const Pill: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className, ...props }) => (
  <div className={cx('flex items-center rounded-[10px] bg-ink-800 border border-white/[0.04] h-9', className)} {...props} />
)

export const IconButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }
> = ({ className, active, ...props }) => (
  <button
    type="button"
    className={cx(
      'inline-flex items-center justify-center rounded-md h-8 min-w-8 px-1.5 transition-colors',
      'text-ink-300 hover:text-ink-100 hover:bg-white/[0.06] disabled:opacity-30 disabled:hover:bg-transparent',
      active && 'text-ink-100 bg-white/[0.08]',
      className,
    )}
    {...props}
  />
)

export interface MenuItem {
  label: string
  icon?: React.ReactNode
  hint?: string
  onSelect?: () => void
  danger?: boolean
  checked?: boolean
  separator?: boolean
  disabled?: boolean
}

/** A click-to-open menu that closes on outside click or Escape. */
export const Menu: React.FC<{
  trigger: (open: boolean) => React.ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
  side?: 'bottom' | 'top'
  width?: number
  header?: React.ReactNode
  /** Bigger rows and type, like Suno's prompt-box menu. */
  large?: boolean
}> = ({ trigger, items, align = 'left', side = 'bottom', width = 220, header, large }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <div ref={ref} className="relative">
      <div onClick={() => setOpen((o) => !o)}>{trigger(open)}</div>
      {open && (
        <div
          className={cx(
            'absolute z-50 bg-ink-800 border border-white/[0.07] shadow-2xl shadow-black/60',
            large ? 'rounded-2xl p-2 bg-[#232326]' : 'rounded-xl p-1.5',
            align === 'right' ? 'right-0' : 'left-0',
            side === 'bottom' ? 'top-full mt-1.5' : 'bottom-full mb-1.5',
          )}
          style={{ width }}
        >
          {header}
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 h-px bg-white/[0.06]" />
            ) : (
              <button
                key={i}
                type="button"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false)
                  item.onSelect?.()
                }}
                className={cx(
                  'w-full flex items-center text-left disabled:opacity-40',
                  large ? 'gap-3.5 rounded-xl px-3.5 py-3 text-[16px] [&_svg]:text-ink-100' : 'gap-2.5 rounded-lg px-2.5 py-2 text-[13px]',
                  item.danger ? 'text-red-400 hover:bg-red-500/10' : 'text-ink-200 hover:bg-white/[0.06]',
                )}
              >
                {item.icon && <span className="text-ink-300 shrink-0">{item.icon}</span>}
                <span className="flex-1 truncate">{item.label}</span>
                {item.checked && <span className="text-ink-100">✓</span>}
                {item.hint && <span className="text-ink-400 text-[11px]">{item.hint}</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  )
}

/** Text that turns into an input on click and commits on Enter or blur. */
export const InlineEdit: React.FC<{
  value: string
  onCommit: (v: string) => void
  className?: string
  inputClassName?: string
  title?: string
  /** One click opens the editor instead of a double click. */
  clickToEdit?: boolean
}> = ({ value, onCommit, className, inputClassName, title, clickToEdit }) => {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  if (!editing) {
    return (
      <span className={cx('cursor-text truncate', className)} title={title} onDoubleClick={() => setEditing(true)} onClick={() => clickToEdit && setEditing(true)}>
        {value}
      </span>
    )
  }
  const finish = (commit: boolean) => {
    setEditing(false)
    if (commit && draft.trim() && draft !== value) onCommit(draft.trim())
    else setDraft(value)
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') finish(false)
      }}
      onFocus={(e) => e.target.select()}
      className={cx('bg-ink-950 border border-white/10 rounded px-1.5 outline-none text-ink-100', inputClassName)}
    />
  )
}
