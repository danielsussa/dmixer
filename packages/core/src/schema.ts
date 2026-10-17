import { z } from 'zod'

/**
 * The whole mix is this file. Times are seconds on the timeline (or an expression
 * like "@tese - 0.2" anchored to a marker); levels are dB; pan is −1 (left) … +1.
 *
 * The model follows a DAW like REAPER: tracks hold clips, a track has a volume,
 * a pan, a chain of effects and a volume envelope, and it sends its output to the
 * master or to a bus (a track with no clips that mixes others).
 */
export const SCHEMA_VERSION = 1

export const TimeValue = z.union([z.number(), z.string()])
export type TimeValue = z.infer<typeof TimeValue>

const db = z.number().min(-120).max(48)

export const Point = z.object({
  at: TimeValue,
  /** Envelope value in dB, added to the track volume. */
  db,
  /** How the envelope travels from this point to the next. */
  curve: z.enum(['linear', 'hold']).optional(),
})
export type Point = z.infer<typeof Point>

export const Effect = z.discriminatedUnion('type', [
  z.object({ type: z.literal('highpass'), freq: z.number().positive(), q: z.number().positive().optional(), bypass: z.boolean().optional() }),
  z.object({ type: z.literal('lowpass'), freq: z.number().positive(), q: z.number().positive().optional(), bypass: z.boolean().optional() }),
  z.object({
    type: z.literal('eq'),
    freq: z.number().positive(),
    gain: db,
    q: z.number().positive().optional(),
    bypass: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('shelf'),
    kind: z.enum(['low', 'high']),
    freq: z.number().positive(),
    gain: db,
    bypass: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('compressor'),
    threshold: db,
    ratio: z.number().min(1).max(30),
    attack: z.number().positive().optional(),
    release: z.number().positive().optional(),
    makeup: db.optional(),
    bypass: z.boolean().optional(),
  }),
  /**
   * Ducking: the track dips by `depth` dB while the `source` track has a clip
   * playing (from `attack` before the clip until `release` after it). Gaps between
   * the source clips shorter than `hold` stay down, so the music does not pump in
   * the breaths between sentences. It follows the clips, not the signal, which is
   * what keeps the preview and the render identical.
   */
  z.object({
    type: z.literal('duck'),
    source: z.string(),
    depth: z.number().min(0).max(60),
    attack: z.number().min(0).optional(),
    release: z.number().min(0).optional(),
    hold: z.number().min(0).optional(),
    bypass: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('reverb'),
    mix: z.number().min(0).max(1),
    seconds: z.number().positive().optional(),
    bypass: z.boolean().optional(),
  }),
  z.object({ type: z.literal('limiter'), ceiling: db, bypass: z.boolean().optional() }),
])
export type Effect = z.infer<typeof Effect>
export type EffectType = Effect['type']

export const Clip = z.object({
  id: z.string().min(1),
  asset: z.string().min(1),
  start: TimeValue,
  /** Source in/out, in seconds of the file. `out` defaults to the end of the file. */
  in: z.number().min(0).optional(),
  out: z.number().positive().optional(),
  gain: db.optional(),
  fade_in: z.number().min(0).optional(),
  fade_out: z.number().min(0).optional(),
  /**
   * A library piece cut short at one of its measured cut points: its body ends here (seconds from the start of the
   * file), the next piece butts it, and what plays after (up to `out`, faded) rings under the next one like a tail.
   */
  body: z.number().positive().optional(),
  label: z.string().optional(),
  color: z.string().optional(),
  muted: z.boolean().optional(),
  note: z.string().optional(),
})
export type Clip = z.infer<typeof Clip>

export const Track = z.object({
  id: z.string().min(1),
  /**
   * `bus` has no clips: other tracks send their output to it with `output`.
   * `video` holds picture: its clips show in the viewer and the mp4 render, and add no
   * sound (put the same file on an audio track to hear it).
   */
  type: z.enum(['audio', 'bus', 'video']).optional(),
  /**
   * A track only for library pieces (samplers). They never share a track with narration or other audio,
   * and library pieces never go anywhere else.
   */
  samplers: z.boolean().optional(),
  name: z.string().optional(),
  color: z.string().optional(),
  volume: db.optional(),
  pan: z.number().min(-1).max(1).optional(),
  muted: z.boolean().optional(),
  solo: z.boolean().optional(),
  /** Id of a bus track; default is the master. */
  output: z.string().optional(),
  effects: z.array(Effect).optional(),
  automation: z.object({ volume: z.array(Point).optional() }).optional(),
  clips: z.array(Clip).optional(),
  note: z.string().optional(),
})
export type Track = z.infer<typeof Track>

export const Marker = z.object({
  id: z.string().min(1),
  at: TimeValue,
  label: z.string().optional(),
  color: z.string().optional(),
})
export type Marker = z.infer<typeof Marker>

/**
 * A region (a tag, in the plan): a labelled stretch of time on a lane, used to plan the
 * mix before any audio exists — "tensão crescente" from 0 to 15 s, "impacto" after it.
 * Clips and markers can anchor to it: "@impacto" is its start, "@impacto.end" its end.
 */
export const Region = z.object({
  id: z.string().min(1),
  start: TimeValue,
  end: TimeValue,
  label: z.string().optional(),
  color: z.string().optional(),
  /** Id of the lane it sits on (see `lanes`); default is the first lane. */
  lane: z.string().optional(),
  note: z.string().optional(),
})
export type Region = z.infer<typeof Region>

export const Lane = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  color: z.string().optional(),
})
export type Lane = z.infer<typeof Lane>

export const AssetMeta = z.object({
  duration: z.number().nonnegative().optional(),
  channels: z.number().int().positive().optional(),
  sample_rate: z.number().int().positive().optional(),
  size: z.number().nonnegative().optional(),
  hash: z.string().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  has_audio: z.boolean().optional(),
})
export type AssetMeta = z.infer<typeof AssetMeta>

export const Asset = z.object({
  src: z.string().min(1),
  label: z.string().optional(),
  /**
   * Musical length of a library piece (seconds), before its tail. The next piece is
   * meant to start where the body ends, while the tail rings over the join.
   */
  body: z.number().positive().optional(),
  meta: AssetMeta.optional(),
})
export type Asset = z.infer<typeof Asset>

export const Master = z.object({
  volume: db.optional(),
  effects: z.array(Effect).optional(),
  automation: z.object({ volume: z.array(Point).optional() }).optional(),
  /** Loudness the render is normalised to (integrated LUFS) and its true-peak ceiling. */
  loudness: z.object({ target: z.number().min(-40).max(0), true_peak: z.number().min(-10).max(0).optional() }).optional(),
})
export type Master = z.infer<typeof Master>

export const Project = z.object({
  version: z.number().int().default(SCHEMA_VERSION),
  project: z
    .object({
      /** Stable id of this mix; its URL is /c/<id>. Written by `dmixer link`. */
      id: z.string().optional(),
      name: z.string().default('untitled'),
      sample_rate: z.number().int().positive().default(44100),
      /** Optional musical grid, for snapping and the bar ruler. */
      bpm: z.number().positive().optional(),
      meter: z.number().int().positive().optional(),
      grid_offset: z.number().optional(),
      /** Length of the timeline; defaults to the end of the last clip. */
      duration: z.number().positive().optional(),
      /** Frame of the mp4 render and of the viewer. */
      video: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive().optional() }).optional(),
    })
    .default({}),
  /** Folders outside this one that assets may reference as "@name/path". */
  media: z.record(z.string()).optional(),
  assets: z.record(Asset).default({}),
  markers: z.array(Marker).optional(),
  /** Lanes of tags shown above the tracks, in this order. */
  lanes: z.array(Lane).optional(),
  regions: z.array(Region).optional(),
  master: Master.optional(),
  tracks: z.array(Track).default([]),
})
export type Project = z.infer<typeof Project>

export function emptyProject(opts: { name?: string } = {}): Project {
  return Project.parse({ version: SCHEMA_VERSION, project: { name: opts.name ?? 'untitled' }, assets: {}, tracks: [] })
}
