import { create } from 'zustand'
import { resolveProject, type Diagnostic, type Project, type ResolvedProject } from '@dmixer/core'

export type Selection =
  | { kind: 'clip'; trackId: string; clipId: string }
  | { kind: 'track'; trackId: string }
  | { kind: 'marker'; markerId: string }
  | { kind: 'region'; regionId: string }
  | { kind: 'lane'; laneId: string }
  | { kind: 'point'; trackId: string; index: number }
  | { kind: 'master' }
  | null

export interface RenderStatus {
  id: string
  progress: number
  stage: string
  done?: boolean
  file?: string
  error?: string
}

interface EditorState {
  connected: boolean
  loadError: string | null
  /** a long action in progress (a complement being made), shown in the top bar */
  busy: string | null
  projects: { id: string; name: string; path: string; linkedAt: number }[]
  /** id of the open mix (the /c/<id> in the URL) */
  projectName: string | null
  file: string | null
  project: Project | null
  resolved: ResolvedProject | null
  yaml: string
  diagnostics: Diagnostic[]
  dirty: boolean
  savedAt: number | null
  conflict: string | null
  canUndo: boolean
  canRedo: boolean
  history: { id: string; label: string; author: string; at: number }[]

  selection: Selection
  /** pixels per second */
  zoom: number
  playhead: number
  playing: boolean
  loading: number | null
  snap: boolean
  /** SNAP resolution: on 'bar' or 'beat', everything moved or dropped lands on the grid */
  snapGrid: 'bar' | 'beat' | 'off'
  automation: Record<string, boolean>
  /** what a click on a clip does: select (and drag), or cut it there */
  tool: 'select' | 'cut'
  /** seconds of a crossfade or fade made from the toolbar */
  fadeLen: number
  /** a stretch of a clip about to be taken out (file seconds), highlighted on the timeline */
  jumpHover: { trackId: string; clipId: string; from: number; to: number } | null
  /** bumps when a song analysis arrives (the timeline redraws its beat grid and snaps to it) */
  analysisTick: number
  panel: 'yaml' | 'problems' | 'history' | null
  render: RenderStatus | null
  meter: number

  setConnected: (v: boolean) => void
  setProjects: (p: EditorState['projects']) => void
  setState: (s: Partial<EditorState>) => void
  select: (s: Selection) => void
  setZoom: (z: number) => void
  setPlayhead: (t: number) => void
  toggleAutomation: (trackId: string) => void
}

export const useEditor = create<EditorState>((set) => ({
  connected: false,
  loadError: null,
  busy: null,
  projects: [],
  projectName: null,
  file: null,
  project: null,
  resolved: null,
  yaml: '',
  diagnostics: [],
  dirty: false,
  savedAt: null,
  conflict: null,
  canUndo: false,
  canRedo: false,
  history: [],
  selection: null,
  zoom: Number(localStorage.getItem('dmixer.zoom') ?? 40),
  playhead: 0,
  playing: false,
  loading: null,
  snap: true,
  snapGrid: (localStorage.getItem('dmixer.snap') as 'bar' | 'beat' | 'off') ?? 'bar',
  automation: {},
  tool: 'select',
  fadeLen: Number(localStorage.getItem('dmixer.fadeLen') ?? 0.5) || 0.5,
  jumpHover: null,
  analysisTick: 0,
  panel: null,
  render: null,
  meter: -120,

  setConnected: (connected) => set({ connected }),
  setProjects: (projects) => set({ projects }),
  setState: (s) =>
    set((prev) => {
      const next: Partial<EditorState> = { ...s }
      if (s.project) next.resolved = resolveProject(s.project)
      // a selection that no longer exists is dropped
      const proj = s.project ?? prev.project
      const sel = prev.selection
      if (proj && sel) {
        if (sel.kind === 'clip' && !proj.tracks.find((t) => t.id === sel.trackId)?.clips?.some((c) => c.id === sel.clipId)) next.selection = null
        if (sel.kind === 'track' && !proj.tracks.some((t) => t.id === sel.trackId)) next.selection = null
        if (sel.kind === 'marker' && !proj.markers?.some((m) => m.id === sel.markerId)) next.selection = null
        if (sel.kind === 'region' && !proj.regions?.some((g) => g.id === sel.regionId)) next.selection = null
      }
      return next
    }),
  select: (selection) => set({ selection }),
  setZoom: (zoom) => {
    const z = Math.min(800, Math.max(2, zoom))
    localStorage.setItem('dmixer.zoom', String(z))
    set({ zoom: z })
  },
  setPlayhead: (playhead) => set({ playhead: Math.max(0, playhead) }),
  toggleAutomation: (trackId) => set((s) => ({ automation: { ...s.automation, [trackId]: !s.automation[trackId] } })),
}))
