import React, { useEffect, useRef, useState } from 'react'

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ')

type IconProps = { size?: number; className?: string }
const svg = (size: number, className: string | undefined, children: React.ReactNode, fill = false) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={fill ? 'currentColor' : 'none'}
    stroke={fill ? 'none' : 'currentColor'}
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden
  >
    {children}
  </svg>
)

/** The handful of glyphs the shell needs, drawn to one stroke weight. */
export const Icon = {
  Play: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M7 4.5v15l13-7.5z" />, true),
  Pause: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="6" y="4.5" width="4" height="15" rx="1" /><rect x="14" y="4.5" width="4" height="15" rx="1" /></>, true),
  Rewind: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M11 5.5v13L2.5 12z" /><path d="M21 5.5v13L12.5 12z" /></>, true),
  Record: ({ size = 16, className }: IconProps) => svg(size, className, <circle cx="12" cy="12" r="6" />, true),
  Loop: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M17 3l3 3-3 3" /><path d="M20 6H8a4 4 0 0 0-4 4v1" /><path d="M7 21l-3-3 3-3" /><path d="M4 18h12a4 4 0 0 0 4-4v-1" /></>),
  Metronome: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M5 5v14M9 5v14M13 5v14M17 5v14M21 5v14" /></>),
  Cursor: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M4 12h13" /><path d="M13 7l5 5-5 5" /><path d="M20 4v16" /></>),
  Undo: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M9 14L4 9l5-5" /><path d="M4 9h11a5 5 0 0 1 0 10h-3" /></>),
  Redo: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M15 14l5-5-5-5" /><path d="M20 9H9a5 5 0 0 0 0 10h3" /></>),
  Export: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M14 4l6 6-6 6" /><path d="M20 10H10a6 6 0 0 0-6 6v4" /></>),
  Library: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M5 4v16M9 4v16" /><path d="M13.5 4.5l5 15" /></>),
  More: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" /></>, true),
  Plus: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M12 5v14M5 12h14" /></>),
  Close: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M6 6l12 12M18 6L6 18" /></>),
  Split: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="3.5" y="5" width="17" height="14" rx="2" /><path d="M12 5v14" /></>),
  Up: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M12 19V5M6 11l6-6 6 6" /></>),
  Chevron: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M7 10l5 5 5-5" />),
  Speaker: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12" /></>),
  Mic: ({ size = 16, className }: IconProps) => svg(size, className, <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>),
  Collapse: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M4 7l5 5-5 5M20 7l-5 5 5 5" /></>),
  Expand: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M9 7l-5 5 5 5M15 7l5 5-5 5" /></>),
  Tracks: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M4 7h10M4 12h7M4 17h10" /><path d="M17 15l3 3M20 15l-3 3" /></>),
  Mixer: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M6 4v16M12 4v16M18 4v16" /><path d="M4 14h4M10 8h4M16 16h4" /></>),
  Automation: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M4 19c4-1 5-14 9-14s3 9 7 9" />),
  Wave: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M3 12h2M7 8v8M10 5v14M13 9v6M16 6v12M19 10v4M21 12h0" />),
  List: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />),
  Folder: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><path d="M7 13h4" /></>),
  ZoomIn: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5M8.5 11h5M11 8.5v5" /></>),
  ZoomOut: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5M8.5 11h5" /></>),
  Bulb: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9V16h7v-2.1A6 6 0 0 0 12 3z" /></>),
  Video: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="3" y="6" width="13" height="12" rx="2" /><path d="M16 10l5-3v10l-5-3" /></>),
  Music: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M9 18V5l11-2v13" /><circle cx="6.5" cy="18" r="2.5" /><circle cx="17.5" cy="16" r="2.5" /></>),
  Code: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M8 7l-5 5 5 5M16 7l5 5-5 5" /></>),
  Trash: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M4 7h16M10 7V4h4v3M6 7l1 13h10l1-13" /></>),
  Note: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M10 3h3.2c.4 2.3 2 3.6 4.3 4.2v3c-1.6-.2-3-.8-4.3-1.7V16a4 4 0 1 1-3.2-3.9z" /></>, true),
  TextT: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M5 4h14v4h-3V7.5h-2.5V17H15v3H9v-3h1.5V7.5H8V8H5z" />, true),
  Controls: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><path d="M6 4v16M12 4v16M18 4v16" /><path d="M3.5 15h5M9.5 8h5M15.5 13h5" /></>),
  Pointer: ({ size = 16, className }: IconProps) => svg(size, className, <path d="M6 3.5l12 7.5-5.2 1.3 2.9 5.8-2.3 1.2-2.9-5.8L6 17z" />),
  Blade: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><circle cx="6" cy="18" r="2.5" /><circle cx="6" cy="6" r="2.5" /><path d="M8 7.5L20 18M8 16.5L20 6" /></>),
  RangeTool: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M8 5H5v14h3M16 5h3v14h-3" /><path d="M9 12h6" /></>),
  Sparkle: ({ size = 16, className }: IconProps) =>
    svg(size, className, <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />, true),
  Download: ({ size = 16, className }: IconProps) => svg(size, className, <><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>),
  Copy: ({ size = 16, className }: IconProps) =>
    svg(size, className, <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>),
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
