// IndexedDB candle cache (arch §5.2): key `binance-f:<symbol>:<tf>`, show cache instantly then fetch tail.
// Also owns the shared `chartswipe` database handle (levels store: lib/cache/levels.ts).
import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Candle, SymbolInfo } from '../binance/types'
import type { Level } from '../levels/model'

const DB_NAME = 'chartswipe'
/** v2: + `levels` object store (keyPath id, index by symbol) for local-first levels (A10). */
const DB_VERSION = 2
/** Keep at most this many candles per key on disk (memory budget is handled separately). */
export const MAX_CACHED_CANDLES = 1500
/** exchangeInfo is cached for a day (arch §5.4). */
export const EXCHANGE_INFO_TTL_MS = 24 * 60 * 60 * 1000

export function candleCacheKey(symbol: string, tf: string): string {
  return `binance-f:${symbol}:${tf}`
}

interface CandleRecord {
  candles: Candle[]
  savedAt: number
}

interface MetaRecord<T = unknown> {
  value: T
  savedAt: number
}

export interface ChartSwipeDB extends DBSchema {
  candles: { key: string; value: CandleRecord }
  meta: { key: string; value: MetaRecord }
  levels: { key: string; value: Level; indexes: { symbol: string } }
}

/** iOS Safari can leave indexedDB.open() pending forever; give up after this long. */
export const DB_OPEN_TIMEOUT_MS = 500

/** Resolve to `p`'s value, or to null if it does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(null), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

let dbPromise: Promise<IDBPDatabase<ChartSwipeDB>> | null = null

/** Open (once) the database; resolves to null when unavailable or hanging. */
export async function db(): Promise<IDBPDatabase<ChartSwipeDB> | null> {
  if (typeof indexedDB === 'undefined') return null
  dbPromise ??= openDB<ChartSwipeDB>(DB_NAME, DB_VERSION, {
    upgrade(d) {
      if (!d.objectStoreNames.contains('candles')) d.createObjectStore('candles')
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta')
      if (!d.objectStoreNames.contains('levels')) {
        const store = d.createObjectStore('levels', { keyPath: 'id' })
        store.createIndex('symbol', 'symbol')
      }
    },
  }).catch((err) => {
    dbPromise = null
    throw err
  })
  return withTimeout(dbPromise, DB_OPEN_TIMEOUT_MS)
}

/** Cache failures must never break the feed: every call degrades to a no-op. */
export async function readCandles(symbol: string, tf: string): Promise<Candle[] | null> {
  try {
    const d = await db()
    const rec = await d?.get('candles', candleCacheKey(symbol, tf))
    return rec?.candles ?? null
  } catch {
    return null
  }
}

export async function writeCandles(symbol: string, tf: string, candles: readonly Candle[]): Promise<void> {
  try {
    const d = await db()
    if (!d) return
    const tail = candles.length > MAX_CACHED_CANDLES ? candles.slice(-MAX_CACHED_CANDLES) : [...candles]
    await d.put('candles', { candles: tail, savedAt: Date.now() }, candleCacheKey(symbol, tf))
  } catch {
    // quota / private mode — ignore
  }
}

export async function readExchangeInfo(now = Date.now()): Promise<Record<string, SymbolInfo> | null> {
  try {
    const d = await db()
    const rec = (await d?.get('meta', 'exchangeInfo')) as MetaRecord<Record<string, SymbolInfo>> | undefined
    if (!rec || now - rec.savedAt > EXCHANGE_INFO_TTL_MS) return null
    return rec.value
  } catch {
    return null
  }
}

export async function writeExchangeInfo(value: Record<string, SymbolInfo>): Promise<void> {
  try {
    const d = await db()
    await d?.put('meta', { value, savedAt: Date.now() }, 'exchangeInfo')
  } catch {
    // ignore
  }
}
