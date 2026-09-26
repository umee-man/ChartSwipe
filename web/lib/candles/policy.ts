// Candle loading policy (ADR A20): how many bars to request per TF, request weights, tail refresh size,
// and paging back to the listing start for the daily chart.
import type { Candle } from '../binance/types'
import { mergeCandles } from './merge'

/** Binance fapi klines hard maximum. */
export const KLINES_MAX_LIMIT = 1500
export const KLINES_DEFAULT_LIMIT = 300

/** Д/Н load a big first page (1w × 1500 covers every perp's whole life); 5м/1ч keep 300. */
export function initialLimit(tf: string): number {
  return tf === '1d' || tf === '1w' ? KLINES_MAX_LIMIT : KLINES_DEFAULT_LIMIT
}

/** Д pages back to the listing start (> 1500 days for BTC/ETH); Н never needs it. */
export function pagesToListingStart(tf: string): boolean {
  return tf === '1d'
}

/** GET /fapi/v1/klines weight by limit: [1,100) 1 · [100,500) 2 · [500,1000] 5 · > 1000 10. */
export function klinesWeight(limit: number): number {
  if (limit < 100) return 1
  if (limit < 500) return 2
  if (limit <= 1000) return 5
  return 10
}

/**
 * Bars to request to refresh the tail after a cache hit: the bars since the cached last bar plus 2 of
 * overlap (the last cached bar was probably still open), clamped to [2, maxLimit].
 */
export function tailLimit(cachedLastSec: number, nowSec: number, intervalSec: number, maxLimit: number): number {
  const missing = Math.ceil(Math.max(0, nowSec - cachedLastSec) / intervalSec)
  return Math.min(maxLimit, Math.max(2, missing + 2))
}

export interface PagingResult {
  candles: Candle[]
  /** Listing start reached (a page came back short or empty). */
  complete: boolean
  pages: number
}

/**
 * Page back with endTime until the listing start: sequential requests, each `limit` bars ending just
 * before the current first bar; stops when a page is shorter than `limit` (or adds nothing), or after
 * `maxPages`. Errors (incl. the local 429 gate) propagate to the caller.
 */
export async function pageUntilStart(
  fetchOlder: (endTimeMs: number) => Promise<Candle[]>,
  candles: readonly Candle[],
  limit: number,
  maxPages = 5,
): Promise<PagingResult> {
  let all = [...candles]
  let pages = 0
  while (pages < maxPages) {
    const first = all[0]
    if (!first) return { candles: all, complete: true, pages }
    const page = await fetchOlder(first.time * 1000 - 1)
    pages++
    const older = page.filter((c) => c.time < first.time)
    if (older.length) all = mergeCandles(older, all)
    if (page.length < limit || older.length === 0) return { candles: all, complete: true, pages }
  }
  return { candles: all, complete: false, pages }
}

/**
 * Which TFs to preload for a feed neighbour at `offset` (0 = current). Current and next get every TF
 * button (incl. the big Д/Н pages); the one after only the light TFs plus the active one, which keeps a
 * fast swipe streak under the 2400/min weight budget.
 */
export function preloadTfs<T extends string>(offset: number, buttons: readonly T[], active: T): T[] {
  if (offset <= 1) return [...buttons]
  return buttons.filter((tf) => initialLimit(tf) === KLINES_DEFAULT_LIMIT || tf === active)
}
