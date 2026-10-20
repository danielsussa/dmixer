import {
  Document, isMap, isSeq, parseDocument, parse as parseYaml, stringify as stringifyYaml,
  type Node, type Pair,
} from 'yaml'
import { Project, SCHEMA_VERSION } from './schema.js'

export interface ParseResult {
  ok: boolean
  project?: Project
  errors: string[]
}

/** YAML in → validated Project out. Never throws; failures come back as errors. */
export function parseProject(source: string): ParseResult {
  let raw: unknown
  try {
    raw = parseYaml(source) ?? {}
  } catch (err) {
    return { ok: false, errors: [`YAML syntax error: ${(err as Error).message}`] }
  }

  const migrated = migrate(raw)
  const result = Project.safeParse(migrated)
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  return { ok: true, project: result.data, errors: [] }
}

/**
 * Schema evolution lives here. `version` is written on every save so old
 * projects can always be lifted forward without the user noticing.
 */
export function migrate(raw: any): any {
  if (!raw || typeof raw !== 'object') return { version: SCHEMA_VERSION }
  const out = { ...raw }
  if (typeof out.version !== 'number') out.version = SCHEMA_VERSION
  return out
}

/** Canonical key order — the file has to stay diffable across saves. */
const KEY_ORDER: Record<string, string[]> = {
  root: ['version', 'project', 'media', 'assets', 'markers', 'lanes', 'regions', 'master', 'tracks'],
  region: ['id', 'start', 'end', 'label', 'lane', 'color', 'note'],
  project: ['id', 'name', 'sample_rate', 'bpm', 'meter', 'grid_offset', 'duration'],
  track: ['id', 'type', 'name', 'color', 'volume', 'pan', 'muted', 'solo', 'output', 'note', 'effects', 'automation', 'clips'],
  clip: ['id', 'type', 'asset', 'start', 'in', 'out', 'duration', 'gain', 'fade_in', 'fade_out', 'fill', 'transform', 'crop', 'opacity', 'effects', 'transition', 'transition_out', 'params', 'label', 'color', 'muted', 'note'],
  asset: ['src', 'label', 'body', 'meta'],
  marker: ['id', 'at', 'label', 'color'],
  master: ['volume', 'loudness', 'effects', 'automation'],
}

function ordered(obj: any, order?: string[]): any {
  if (Array.isArray(obj)) return obj.map((v) => ordered(v))
  if (obj === null || typeof obj !== 'object') return obj
  const keys = Object.keys(obj)
  const sorted = order
    ? [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))]
    : keys
  const out: any = {}
  for (const k of sorted) {
    const v = obj[k]
    if (v === undefined) continue
    out[k] = ordered(v)
  }
  return out
}

/**
 * Arrays of clips are ordered lists, so `ordered()` above maps them with the
 * clip key order; records like `assets` need their values ordered instead.
 */
function orderRecords(project: Project): any {
  const out: any = ordered(project, KEY_ORDER.root)
  if (out.project) out.project = ordered(out.project, KEY_ORDER.project)
  if (out.master) out.master = ordered(out.master, KEY_ORDER.master)
  if (out.assets) {
    for (const k of Object.keys(out.assets)) out.assets[k] = ordered(out.assets[k], KEY_ORDER.asset)
  }
  if (out.markers) out.markers = out.markers.map((m: any) => ordered(m, KEY_ORDER.marker))
  if (out.regions) out.regions = out.regions.map((g: any) => ordered(g, KEY_ORDER.region))
  if (out.tracks) {
    out.tracks = out.tracks.map((t: any) => {
      const track = ordered(t, KEY_ORDER.track)
      if (track.clips) track.clips = track.clips.map((c: any) => ordered(c, KEY_ORDER.clip))
      return track
    })
  }
  return out
}

const STRINGIFY_OPTIONS = { indent: 2, lineWidth: 0, nullStr: 'null' } as const

/**
 * Serialize the project back to YAML.
 *
 * `previous` is the text currently on disk. When given, comments are carried
 * across onto the matching nodes: the file is the thing the user reads and
 * annotates, so an edit in the UI must not silently delete their notes.
 */
export function serializeProject(project: Project, previous?: string): string {
  const plain = orderRecords(stripEmpty(project))
  if (!previous) return stringifyYaml(plain, STRINGIFY_OPTIONS)

  try {
    const oldDoc = parseDocument(previous)
    if (oldDoc.errors.length) return stringifyYaml(plain, STRINGIFY_OPTIONS)

    const newDoc = new Document(plain)
    newDoc.commentBefore = oldDoc.commentBefore ?? null
    newDoc.comment = oldDoc.comment ?? null
    carryComments(oldDoc.contents as Node | null, newDoc.contents as Node | null)
    return newDoc.toString(STRINGIFY_OPTIONS)
  } catch {
    // Comment preservation is a nicety; never let it block a save.
    return stringifyYaml(plain, STRINGIFY_OPTIONS)
  }
}

/** Identity of a sequence item: its `id` if it has one, else its position. */
function itemKey(node: unknown, index: number): string {
  if (isMap(node)) {
    const id = node.get('id')
    if (typeof id === 'string') return `id:${id}`
  }
  return `#${index}`
}

function carryComments(from: Node | null, to: Node | null): void {
  if (!from || !to) return

  /**
   * ⚠️ O `yaml` prende o comentário que vem antes do PRIMEIRO item de uma lista
   *   à LISTA, e não ao item. Enquanto a ordem não muda ninguém dá por isso —
   *   mas basta trocar duas trilhas de lugar para o comentário ficar para trás,
   *   a descrever quem calhou ficar em primeiro. Passa-se para o item antes de
   *   casar por id, e assim ele viaja com o que descreve.
   */
  if (isSeq(from) && isSeq(to) && from.commentBefore) {
    const primeiro = from.items[0] as Node | undefined
    if (primeiro && !primeiro.commentBefore) {
      primeiro.commentBefore = from.commentBefore
      from.commentBefore = null
    }
  }

  if (from.commentBefore && !to.commentBefore) to.commentBefore = from.commentBefore
  if (from.comment && !to.comment) to.comment = from.comment

  if (isMap(from) && isMap(to)) {
    for (const oldPair of from.items as Pair<Node, Node>[]) {
      const key = String((oldPair.key as any)?.value ?? oldPair.key)
      const newPair = (to.items as Pair<Node, Node>[]).find(
        (p) => String((p.key as any)?.value ?? p.key) === key,
      )
      if (!newPair) continue
      carryComments(oldPair.key, newPair.key)
      carryComments(oldPair.value, newPair.value)
    }
    return
  }

  if (isSeq(from) && isSeq(to)) {
    const oldItems = new Map<string, Node>()
    from.items.forEach((item, i) => oldItems.set(itemKey(item, i), item as Node))
    to.items.forEach((item, i) => {
      const match = oldItems.get(itemKey(item, i))
      if (match) carryComments(match, item as Node)
    })
  }
}

/** Drop undefined and empty containers so the file stays small and readable. */
function stripEmpty<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripEmpty(v)) as unknown as T
  if (value && typeof value === 'object') {
    const out: any = {}
    for (const [k, v] of Object.entries(value as any)) {
      if (v === undefined) continue
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
      out[k] = stripEmpty(v)
    }
    return out
  }
  return value
}
