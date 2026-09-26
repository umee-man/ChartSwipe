// Level model + pure operations (F4, arch §5.3–5.5; ADR A16: one level type — a plain horizontal line).
// Local-first (ADR A10): the shape mirrors `public.levels` / the /v1/levels API so a later sync is a
// straight upload: id uuid, symbol, tf, kind ('level'), price, price_to (always null), color, note ≤ 140,
// created_at, updated_at, deleted_at (soft delete). `exchange` is client-side context.

export type LevelKind = 'level'

export interface Level {
  id: string
  exchange: 'binance'
  symbol: string
  kind: LevelKind
  price: number
  /** Kept for API/DB shape compatibility; always null since A16 (no zones). */
  price_to: null
  /** TF the level was placed on (shown small on the label; the level is visible on all TFs). */
  tf: string
  note: string | null
  /** #RRGGBB or null = default amber. */
  color: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export const NOTE_MAX = 140
/** Single level color (A16). */
export const LEVEL_COLOR = '#FFB300'

export class LevelValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LevelValidationError'
  }
}

// ---------- ids ----------

/**
 * RFC 4122 v4 uuid. `crypto.randomUUID` is missing in insecure contexts (plain-HTTP LAN dev) and older
 * Safari, so fall back to getRandomValues (available everywhere), then to Math.random as a last resort.
 */
export function uuidv4(
  rand: { getRandomValues?: (a: Uint8Array) => Uint8Array; randomUUID?: () => string } | undefined = globalThis.crypto,
): string {
  if (rand?.randomUUID) {
    try {
      return rand.randomUUID()
    } catch {
      // insecure context may throw — fall through
    }
  }
  const b = new Uint8Array(16)
  if (rand?.getRandomValues) rand.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6]! & 0x0f) | 0x40 // version 4
  b[8] = (b[8]! & 0x3f) | 0x80 // variant 10
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// ---------- numbers ----------

function decimalsOf(step: number): number {
  if (!(step > 0) || step >= 1) return 0
  const s = step.toFixed(12).replace(/0+$/, '')
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/** Round to the nearest multiple of tickSize without float noise (0.1 + 0.2 style). */
export function roundToTick(price: number, tickSize: number): number {
  if (!(tickSize > 0) || !Number.isFinite(price)) return price
  const n = Math.round(price / tickSize)
  return Number((n * tickSize).toFixed(decimalsOf(tickSize)))
}

// ---------- normalisation ----------

/** Trim; empty → null; hard limit NOTE_MAX characters (code points). */
export function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null
  const t = note.trim()
  if (!t) return null
  const chars = Array.from(t)
  return chars.length > NOTE_MAX ? chars.slice(0, NOTE_MAX).join('') : t
}

function assertPrice(price: number): void {
  if (!(price > 0) || !Number.isFinite(price)) throw new LevelValidationError('Цена должна быть больше 0')
}

// ---------- operations (all immutable; `now` injected for tests) ----------

export interface NewLevel {
  symbol: string
  price: number
  tf: string
  note?: string | null
}

export function createLevel(input: NewLevel, now: Date = new Date(), id: string = uuidv4()): Level {
  assertPrice(input.price)
  const ts = now.toISOString()
  return {
    id,
    exchange: 'binance',
    symbol: input.symbol.toUpperCase(),
    kind: 'level',
    price: input.price,
    price_to: null,
    tf: input.tf,
    note: normalizeNote(input.note),
    color: null,
    created_at: ts,
    updated_at: ts,
    deleted_at: null,
  }
}

export function moveLevel(l: Level, price: number, now: Date = new Date()): Level {
  assertPrice(price)
  return { ...l, price, updated_at: now.toISOString() }
}

export function setNote(l: Level, note: string | null, now: Date = new Date()): Level {
  return { ...l, note: normalizeNote(note), updated_at: now.toISOString() }
}

export function softDelete(l: Level, now: Date = new Date()): Level {
  const ts = now.toISOString()
  return { ...l, deleted_at: ts, updated_at: ts }
}

export function restoreLevel(l: Level, now: Date = new Date()): Level {
  return { ...l, deleted_at: null, updated_at: now.toISOString() }
}

/** Alive levels of one symbol (all TFs — levels are visible on every TF, arch §5.5). */
export function levelsForSymbol(all: readonly Level[], symbol: string): Level[] {
  return all.filter((l) => l.symbol === symbol && l.deleted_at === null)
}

/** Replace-or-append by id. */
export function upsertLevel(all: readonly Level[], l: Level): Level[] {
  const i = all.findIndex((x) => x.id === l.id)
  if (i === -1) return [...all, l]
  const next = all.slice()
  next[i] = l
  return next
}

/**
 * Validate a record read back from storage. Records written before A16 (support/resistance/zone) are
 * migrated to a plain level at `price` (a zone keeps its lower edge). Corrupt entries → null.
 */
export function coerceLevel(v: unknown): Level | null {
  const l = v as Partial<Level> & { kind?: string; price_to?: unknown }
  if (!l || typeof l !== 'object') return null
  if (typeof l.id !== 'string' || typeof l.symbol !== 'string' || typeof l.tf !== 'string') return null
  if (typeof l.price !== 'number' || !(l.price > 0) || typeof l.updated_at !== 'string') return null
  if (!['level', 'support', 'resistance', 'zone'].includes(String(l.kind))) return null
  return {
    id: l.id,
    exchange: 'binance',
    symbol: l.symbol,
    kind: 'level',
    price: l.price,
    price_to: null,
    tf: l.tf,
    note: typeof l.note === 'string' ? normalizeNote(l.note) : null,
    color: typeof l.color === 'string' ? l.color : null,
    created_at: typeof l.created_at === 'string' ? l.created_at : l.updated_at,
    updated_at: l.updated_at,
    deleted_at: typeof l.deleted_at === 'string' ? l.deleted_at : null,
  }
}

/** Levels grouped by symbol (alive only), symbols sorted, levels by price desc — for the levels list. */
export function groupBySymbol(all: readonly Level[], query = ''): { symbol: string; levels: Level[] }[] {
  const q = query.trim().toUpperCase()
  const map = new Map<string, Level[]>()
  for (const l of all) {
    if (l.deleted_at !== null) continue
    if (q && !l.symbol.includes(q) && !(l.note ?? '').toUpperCase().includes(q)) continue
    const arr = map.get(l.symbol) ?? []
    arr.push(l)
    map.set(l.symbol, arr)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([symbol, levels]) => ({ symbol, levels: levels.sort((a, b) => b.price - a.price) }))
}

/** Price range covering all levels (for including them in the Д/Н autoscale), or null. */
export function levelsPriceRange(levels: readonly Level[]): { min: number; max: number } | null {
  if (levels.length === 0) return null
  let min = Infinity
  let max = -Infinity
  for (const l of levels) {
    if (l.price < min) min = l.price
    if (l.price > max) max = l.price
  }
  return { min, max }
}
