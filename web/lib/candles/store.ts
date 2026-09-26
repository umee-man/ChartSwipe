// In-memory candle repository (framework-free). Holds candles for the ±3 ticker window (arch §5.2),
// hydrates from IndexedDB first, then fetches the fresh tail; pages history to the left on demand.
import { fetchKlines, KLINES_LIMIT } from '../binance/rest'
import type { Candle, Interval } from '../binance/types'
import { readCandles, writeCandles } from '../cache/candles'
import { applyLiveCandle, intervalSeconds, mergeCandles, mergeFreshTail } from './merge'

export type SeriesStatus = 'idle' | 'loading' | 'ready' | 'error'

export interface SeriesState {
  symbol: string
  tf: Interval
  candles: Candle[]
  status: SeriesStatus
  error: string | null
  loadingOlder: boolean
  historyExhausted: boolean
  /** ms timestamp of the last successful network fetch of the tail; 0 = only cache so far. */
  fetchedAt: number
}

export type SeriesEventKind = 'reset' | 'live' | 'prepend' | 'status'

export interface SeriesEvent {
  symbol: string
  tf: Interval
  kind: SeriesEventKind
  /** For 'prepend': number of candles added on the left. */
  added?: number
}

export function seriesKey(symbol: string, tf: string): string {
  return `${symbol}:${tf}`
}

/** Tail is considered fresh for this long; after that `ensure` refetches in the background. */
const DEFAULT_MAX_AGE_MS = 30_000

export class CandleStore {
  private readonly map = new Map<string, SeriesState>()
  private readonly inflight = new Map<string, Promise<SeriesState>>()
  private readonly listeners = new Set<(e: SeriesEvent) => void>()

  get(symbol: string, tf: Interval): SeriesState | undefined {
    return this.map.get(seriesKey(symbol, tf))
  }

  subscribe(fn: (e: SeriesEvent) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(s: SeriesState, kind: SeriesEventKind, added?: number): void {
    const e: SeriesEvent = { symbol: s.symbol, tf: s.tf, kind, added }
    for (const fn of this.listeners) fn(e)
  }

  private state(symbol: string, tf: Interval): SeriesState {
    const key = seriesKey(symbol, tf)
    let s = this.map.get(key)
    if (!s) {
      s = {
        symbol,
        tf,
        candles: [],
        status: 'idle',
        error: null,
        loadingOlder: false,
        historyExhausted: false,
        fetchedAt: 0,
      }
      this.map.set(key, s)
    }
    return s
  }

  /**
   * Make sure candles for (symbol, tf) are in memory and reasonably fresh.
   * Emits 'reset' as soon as cached data is available and again after the network tail arrives.
   */
  ensure(symbol: string, tf: Interval, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<SeriesState> {
    const key = seriesKey(symbol, tf)
    const existing = this.map.get(key)
    if (existing && existing.fetchedAt && Date.now() - existing.fetchedAt < maxAgeMs) {
      return Promise.resolve(existing)
    }
    const running = this.inflight.get(key)
    if (running) return running
    const p = this.load(symbol, tf).finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private async load(symbol: string, tf: Interval): Promise<SeriesState> {
    const s = this.state(symbol, tf)
    if (s.candles.length === 0) {
      s.status = 'loading'
      this.emit(s, 'status')
      const cached = await readCandles(symbol, tf)
      if (cached?.length && s.candles.length === 0) {
        s.candles = cached
        s.status = 'ready'
        this.emit(s, 'reset')
      }
    }
    try {
      const fresh = await fetchKlines({ symbol, interval: tf, limit: KLINES_LIMIT })
      s.candles = mergeFreshTail(s.candles, fresh, intervalSeconds(tf))
      s.fetchedAt = Date.now()
      s.status = 'ready'
      s.error = null
      this.emit(s, 'reset')
      void writeCandles(symbol, tf, s.candles)
    } catch (err) {
      s.error = err instanceof Error ? err.message : String(err)
      // Keep showing cached candles if we have them.
      s.status = s.candles.length ? 'ready' : 'error'
      this.emit(s, 'status')
    }
    return s
  }

  /** Load one page of history to the left. Resolves to the number of candles prepended. */
  async loadOlder(symbol: string, tf: Interval): Promise<number> {
    const s = this.map.get(seriesKey(symbol, tf))
    if (!s || s.loadingOlder || s.historyExhausted || s.candles.length === 0) return 0
    s.loadingOlder = true
    try {
      const first = s.candles[0]!.time
      const page = await fetchKlines({ symbol, interval: tf, limit: KLINES_LIMIT, endTime: first * 1000 - 1 })
      const older = page.filter((c) => c.time < first)
      if (older.length === 0) {
        s.historyExhausted = true
        return 0
      }
      const before = s.candles.length
      s.candles = mergeCandles(older, s.candles)
      const added = s.candles.length - before
      this.emit(s, 'prepend', added)
      void writeCandles(symbol, tf, s.candles)
      return added
    } catch {
      return 0
    } finally {
      s.loadingOlder = false
    }
  }

  /** Apply a live candle from the WS stream. Ignored if the series is not in memory. */
  applyLive(symbol: string, tf: Interval, candle: Candle): void {
    const s = this.map.get(seriesKey(symbol, tf))
    if (!s || s.candles.length === 0) return
    const res = applyLiveCandle(s.candles, candle, intervalSeconds(tf))
    if (res === 'stale') return
    if (res === 'gap') {
      // Missed bars (e.g. tab was asleep) — refetch the tail, then redraw.
      void this.ensure(symbol, tf, 0)
      return
    }
    // A live stream keeps the tail fresh, so avoid redundant REST refetches on TF switch.
    if (s.fetchedAt) s.fetchedAt = Date.now()
    this.emit(s, 'live')
  }

  /** Drop every series whose symbol is not in `keep` (memory budget, arch §5.2). Persists them first. */
  retain(keep: ReadonlySet<string>): void {
    for (const [key, s] of this.map) {
      if (keep.has(s.symbol)) continue
      if (s.candles.length) void writeCandles(s.symbol, s.tf, s.candles)
      this.map.delete(key)
    }
  }
}
