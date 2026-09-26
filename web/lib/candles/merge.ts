// Pure helpers for combining candle arrays (cache + REST tail + history pages + live WS).
import type { Candle } from '../binance/types'

/**
 * Merge two ascending candle arrays; on equal `time` the `incoming` candle wins.
 * Returns a new array, inputs are not mutated.
 */
export function mergeCandles(existing: readonly Candle[], incoming: readonly Candle[]): Candle[] {
  const out: Candle[] = []
  let i = 0
  let j = 0
  while (i < existing.length || j < incoming.length) {
    const a = existing[i]
    const b = incoming[j]
    if (a && (!b || a.time < b.time)) {
      out.push(a)
      i++
    } else if (b && (!a || b.time < a.time)) {
      out.push(b)
      j++
    } else if (a && b) {
      out.push(b)
      i++
      j++
    }
  }
  return out
}

/**
 * Combine cached candles with a freshly fetched tail.
 * If the fresh page does not overlap/touch the cache (we were offline too long),
 * the cache is discarded so the chart never shows a silent gap.
 */
export function mergeFreshTail(cached: readonly Candle[], fresh: readonly Candle[], intervalSec: number): Candle[] {
  if (cached.length === 0) return [...fresh]
  if (fresh.length === 0) return [...cached]
  const cachedLast = cached[cached.length - 1]!.time
  const freshFirst = fresh[0]!.time
  if (freshFirst > cachedLast + intervalSec) return [...fresh]
  return mergeCandles(cached, fresh)
}

export type LiveApplyResult = 'update' | 'append' | 'gap' | 'stale'

/**
 * Apply a live WS candle in place.
 * - same time as last → 'update' (replaces last)
 * - exactly the next bar → 'append'
 * - further in the future → 'gap' (appended, caller should refetch the tail)
 * - older than last → 'stale' (ignored)
 */
export function applyLiveCandle(arr: Candle[], candle: Candle, intervalSec: number): LiveApplyResult {
  const last = arr[arr.length - 1]
  if (!last) {
    arr.push(candle)
    return 'append'
  }
  if (candle.time === last.time) {
    arr[arr.length - 1] = candle
    return 'update'
  }
  if (candle.time < last.time) return 'stale'
  arr.push(candle)
  return candle.time - last.time > intervalSec ? 'gap' : 'append'
}

const UNIT_SEC: Record<string, number> = { m: 60, h: 3600, d: 86_400, w: 604_800 }

/** Interval length in seconds ('5m' → 300). Months are approximated as 31 days (only used for gap checks). */
export function intervalSeconds(interval: string): number {
  if (interval === '1M') return 31 * 86_400
  const m = /^(\d+)([mhdw])$/.exec(interval)
  if (!m) throw new Error(`Unknown interval ${interval}`)
  return Number(m[1]) * UNIT_SEC[m[2]!]!
}

/** Last element without Array.prototype.at (missing before iOS Safari 15.4). */
export function lastCandle(arr: readonly Candle[] | undefined): Candle | undefined {
  return arr && arr.length ? arr[arr.length - 1] : undefined
}
