/**
 * Every mutation in the product is a JSON Patch. The UI, the AI, the CLI and
 * the file watcher all funnel through `applyPatch`, which is what makes undo,
 * history and the AI diff preview fall out for free.
 *
 * On top of RFC 6902 we allow id addressing: `/timeline/tracks/[id=main]/clips/[id=intro]/start`.
 * Positional paths break the moment the AI inserts a clip (§74); id paths do not.
 */

export type PatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: unknown }

export class PatchError extends Error {
  constructor(message: string, readonly op?: PatchOp) {
    super(message)
    this.name = 'PatchError'
  }
}

const ID_SEGMENT = /^\[id=(.+)\]$/

function unescape(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

export function parsePointer(path: string): string[] {
  if (path === '') return []
  if (!path.startsWith('/')) throw new PatchError(`Invalid JSON pointer: "${path}"`)
  return path.slice(1).split('/').map(unescape)
}

export function formatPointer(tokens: (string | number)[]): string {
  if (tokens.length === 0) return ''
  return '/' + tokens.map((t) => String(t).replace(/~/g, '~0').replace(/\//g, '~1')).join('/')
}

/** Turn `[id=x]` segments into array indices against a concrete document. */
function resolveToken(container: unknown, token: string, path: string): string | number {
  const idMatch = ID_SEGMENT.exec(token)
  if (idMatch) {
    if (!Array.isArray(container)) {
      throw new PatchError(`Id selector "${token}" used on a non-array at "${path}"`)
    }
    const idx = container.findIndex((item: any) => item && item.id === idMatch[1])
    if (idx === -1) throw new PatchError(`No element with id "${idMatch[1]}" at "${path}"`)
    return idx
  }
  if (Array.isArray(container)) {
    if (token === '-') return container.length
    const idx = Number(token)
    if (!Number.isInteger(idx)) throw new PatchError(`Invalid array index "${token}" at "${path}"`)
    return idx
  }
  return token
}

interface Located {
  parent: any
  key: string | number
  /** The chain of containers from root to parent, for structural cloning. */
  chain: { container: any; key: string | number }[]
}

function locate(root: any, path: string, { createMissing = false } = {}): Located {
  const tokens = parsePointer(path)
  if (tokens.length === 0) throw new PatchError(`Operations on the document root are not allowed`)

  let cursor = root
  const chain: { container: any; key: string | number }[] = []

  for (let i = 0; i < tokens.length - 1; i++) {
    const key = resolveToken(cursor, tokens[i], path)
    chain.push({ container: cursor, key })
    let next = cursor?.[key as any]
    if (next === undefined) {
      if (!createMissing) throw new PatchError(`Path not found: "${path}" (at "${tokens[i]}")`)
      next = /^\d+$/.test(tokens[i + 1]) || tokens[i + 1] === '-' ? [] : {}
      cursor[key as any] = next
    }
    cursor = next
  }

  const key = resolveToken(cursor, tokens[tokens.length - 1], path)
  return { parent: cursor, key, chain }
}

function shallowClone<T>(value: T): T {
  if (Array.isArray(value)) return value.slice() as unknown as T
  if (value && typeof value === 'object') return { ...(value as any) }
  return value
}

/** Clone only the containers along `path`, leaving every sibling shared. */
function cloneAlong(root: any, path: string, createMissing = false): Located & { root: any } {
  const nextRoot = shallowClone(root)
  const tokens = parsePointer(path)
  if (tokens.length === 0) throw new PatchError(`Operations on the document root are not allowed`)

  let cursor = nextRoot
  for (let i = 0; i < tokens.length - 1; i++) {
    const key = resolveToken(cursor, tokens[i], path)
    let child = cursor[key as any]
    if (child === undefined) {
      if (!createMissing) throw new PatchError(`Path not found: "${path}" (at "${tokens[i]}")`)
      child = /^\d+$/.test(tokens[i + 1]) || tokens[i + 1] === '-' || ID_SEGMENT.test(tokens[i + 1]) ? [] : {}
    } else {
      child = shallowClone(child)
    }
    cursor[key as any] = child
    cursor = child
  }
  const key = resolveToken(cursor, tokens[tokens.length - 1], path)
  return { root: nextRoot, parent: cursor, key, chain: [] }
}

function getAt(root: any, path: string): unknown {
  const { parent, key } = locate(root, path)
  return parent?.[key as any]
}

export function getValue(root: any, path: string): unknown {
  try {
    return getAt(root, path)
  } catch {
    return undefined
  }
}

/** Apply one operation, returning a new document. The input is never mutated. */
function applyOne(doc: any, op: PatchOp): any {
  switch (op.op) {
    case 'add': {
      const { root, parent, key } = cloneAlong(doc, op.path, true)
      if (Array.isArray(parent)) parent.splice(Number(key), 0, op.value)
      else parent[key as any] = op.value
      return root
    }
    case 'replace': {
      const { root, parent, key } = cloneAlong(doc, op.path, true)
      parent[key as any] = op.value
      return root
    }
    case 'remove': {
      const { root, parent, key } = cloneAlong(doc, op.path)
      if (Array.isArray(parent)) parent.splice(Number(key), 1)
      else delete parent[key as any]
      return root
    }
    case 'move': {
      const value = structuredCloneSafe(getAt(doc, op.from))
      const removed = applyOne(doc, { op: 'remove', path: op.from })
      return applyOne(removed, { op: 'add', path: op.path, value })
    }
    case 'copy': {
      const value = structuredCloneSafe(getAt(doc, op.from))
      return applyOne(doc, { op: 'add', path: op.path, value })
    }
    case 'test': {
      const actual = getAt(doc, op.path)
      if (JSON.stringify(actual) !== JSON.stringify(op.value)) {
        throw new PatchError(`Test failed at "${op.path}"`, op)
      }
      return doc
    }
    default:
      throw new PatchError(`Unknown operation "${(op as any).op}"`, op as PatchOp)
  }
}

function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T)
}

/** Apply a patch atomically: either every op lands, or the document is untouched. */
export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  let next: any = doc
  for (const op of ops) next = applyOne(next, op)
  return next as T
}

/**
 * The inverse patch of `ops` against `doc`. Applying `ops` then `invertPatch`
 * returns the original document — this is the whole of undo.
 */
export function invertPatch<T>(doc: T, ops: PatchOp[]): PatchOp[] {
  const inverse: PatchOp[] = []
  let cursor: any = doc

  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        // Resolve `-` and id selectors against the document as it stands now.
        const concrete = concretePath(cursor, op.path, true)
        const parentPath = concrete.slice(0, concrete.lastIndexOf('/'))
        const parent = parentPath === '' ? cursor : getValue(cursor, parentPath)
        if (Array.isArray(parent)) {
          inverse.unshift({ op: 'remove', path: concrete })
        } else {
          const existing = getValue(cursor, concrete)
          inverse.unshift(
            existing === undefined
              ? { op: 'remove', path: concrete }
              : { op: 'replace', path: concrete, value: structuredCloneSafe(existing) },
          )
        }
        break
      }
      case 'replace': {
        const concrete = concretePath(cursor, op.path, false)
        const existing = getValue(cursor, concrete)
        inverse.unshift(
          existing === undefined
            ? { op: 'remove', path: concrete }
            : { op: 'replace', path: concrete, value: structuredCloneSafe(existing) },
        )
        break
      }
      case 'remove': {
        const concrete = concretePath(cursor, op.path, false)
        const existing = structuredCloneSafe(getValue(cursor, concrete))
        inverse.unshift({ op: 'add', path: concrete, value: existing })
        break
      }
      case 'move': {
        const fromConcrete = concretePath(cursor, op.from, false)
        const toConcrete = concretePath(cursor, op.path, true)
        inverse.unshift({ op: 'move', from: toConcrete, path: fromConcrete })
        break
      }
      case 'copy': {
        const concrete = concretePath(cursor, op.path, true)
        inverse.unshift({ op: 'remove', path: concrete })
        break
      }
      case 'test':
        break
    }
    cursor = applyOne(cursor, op)
  }
  return inverse
}

/**
 * Rewrite id selectors and `-` into concrete indices against `doc`, so the
 * inverse patch stays valid even after the document changes shape.
 */
export function concretePath(doc: any, path: string, forInsert = false): string {
  const tokens = parsePointer(path)
  const out: (string | number)[] = []
  let cursor = doc
  for (let i = 0; i < tokens.length; i++) {
    const isLast = i === tokens.length - 1
    if (isLast && forInsert && Array.isArray(cursor) && tokens[i] === '-') {
      out.push(cursor.length)
      break
    }
    const key = resolveToken(cursor, tokens[i], path)
    out.push(key)
    cursor = cursor?.[key as any]
  }
  return formatPointer(out)
}

/** Convenience: build a replace op, used everywhere by the UI. */
export function replaceOp(path: string, value: unknown): PatchOp {
  return { op: 'replace', path, value }
}
