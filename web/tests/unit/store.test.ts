import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Candle } from '../../lib/binance/types'

// Network is mocked; the rest of lib/binance/rest (incl. the real rate-limit gate) stays real.
const fetchKlines = vi.fn()
vi.mock('../../lib/binance/rest', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../lib/binance/rest')>()
  return { ...orig, fetchKlines: (...args: unknown[]) => fetchKlines(...args) }
})

const { CandleStore, olderRetryDelay } = await import('../../lib/candles/store')
const { rateLimitGate } = await import('../../lib/binance/rest')

const c = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
const series = (from: number, n: number, step = 300) => Array.from({ length: n }, (_, i) => c(from + i * step))

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  fetchKlines.mockReset()
  rateLimitGate.reset()
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('CandleStore retain / inflight', () => {
  it('does not evict a series whose load is in flight (no blank chart after fast swipe back)', async () => {
    const store = new CandleStore()
    const d = deferred<Candle[]>()
    fetchKlines.mockReturnValueOnce(d.promise)
    const p1 = store.ensure('BTCUSDT', '5m')
    store.retain(new Set(['ETHUSDT'])) // user swiped far away while loading
    const p2 = store.ensure('BTCUSDT', '5m') // …and back
    d.resolve(series(0, 3))
    const [s1, s2] = await Promise.all([p1, p2])
    expect(s1).toBe(s2)
    expect(store.get('BTCUSDT', '5m')).toBe(s1)
    expect(store.get('BTCUSDT', '5m')!.candles).toHaveLength(3)
    expect(fetchKlines).toHaveBeenCalledTimes(1)
  })

  it('evicts idle series outside the window', async () => {
    const store = new CandleStore()
    fetchKlines.mockResolvedValue(series(0, 3))
    await store.ensure('BTCUSDT', '5m')
    await store.ensure('ETHUSDT', '5m')
    store.retain(new Set(['ETHUSDT']))
    expect(store.get('BTCUSDT', '5m')).toBeUndefined()
    expect(store.get('ETHUSDT', '5m')).toBeDefined()
  })
})

describe('CandleStore history paging backoff', () => {
  it('computes an exponential, capped retry delay', () => {
    expect(olderRetryDelay(1)).toBe(2000)
    expect(olderRetryDelay(2)).toBe(4000)
    expect(olderRetryDelay(10)).toBe(60_000)
  })

  it('does not refire history requests after a failure until the backoff passes', async () => {
    const store = new CandleStore()
    fetchKlines.mockResolvedValueOnce(series(1_000_000, 300)) // full page → history may continue
    await store.ensure('BTCUSDT', '5m')

    fetchKlines.mockRejectedValue(new Error('boom'))
    expect(await store.loadOlder('BTCUSDT', '5m')).toBe(0)
    expect(fetchKlines).toHaveBeenCalledTimes(2)
    // Chart fires range changes constantly — none of these may hit the network.
    for (let i = 0; i < 50; i++) await store.loadOlder('BTCUSDT', '5m')
    expect(fetchKlines).toHaveBeenCalledTimes(2)

    vi.setSystemTime(1_000_000 + 2000)
    fetchKlines.mockResolvedValueOnce(series(0, 3))
    expect(await store.loadOlder('BTCUSDT', '5m')).toBe(3)
    expect(fetchKlines).toHaveBeenCalledTimes(3)
  })

  it('waits at least until the global 429 gate opens', async () => {
    const store = new CandleStore()
    fetchKlines.mockResolvedValueOnce(series(1_000_000, 300)) // full page → history may continue
    await store.ensure('BTCUSDT', '5m')
    rateLimitGate.record(429, '120')
    fetchKlines.mockRejectedValueOnce(new Error('429'))
    await store.loadOlder('BTCUSDT', '5m')
    vi.setSystemTime(1_000_000 + 60_000)
    await store.loadOlder('BTCUSDT', '5m')
    expect(fetchKlines).toHaveBeenCalledTimes(2)
  })
})

describe('CandleStore Д full history (A20)', () => {
  const DAY = 86_400
  it('loads 1500 bars for Д/Н and 300 for 5м', async () => {
    const store = new CandleStore()
    fetchKlines.mockResolvedValue(series(0, 3))
    await store.ensure('BTCUSDT', '1d')
    await store.ensure('BTCUSDT', '5m')
    expect(fetchKlines.mock.calls[0]![0]).toMatchObject({ interval: '1d', limit: 1500 })
    expect(fetchKlines.mock.calls[1]![0]).toMatchObject({ interval: '5m', limit: 300 })
  })
  it('marks a short first page as the listing start (no paging needed)', async () => {
    const store = new CandleStore()
    fetchKlines.mockResolvedValueOnce(series(0, 400, DAY))
    await store.ensure('NEWUSDT', '1d')
    expect(store.get('NEWUSDT', '1d')!.historyExhausted).toBe(true)
    expect(await store.completeHistory('NEWUSDT', '1d')).toBe(true)
    expect(fetchKlines).toHaveBeenCalledTimes(1)
  })
  it('pages Д back to the listing start and emits "full"', async () => {
    const store = new CandleStore()
    const events: string[] = []
    store.subscribe((e) => events.push(e.kind))
    fetchKlines.mockResolvedValueOnce(series(1000 * DAY, 1500, DAY)) // days 1000..2499
    await store.ensure('BTCUSDT', '1d')
    expect(store.get('BTCUSDT', '1d')!.historyExhausted).toBe(false)
    fetchKlines.mockResolvedValueOnce(series(0, 1000, DAY)) // days 0..999 → short page = start
    expect(await store.completeHistory('BTCUSDT', '1d')).toBe(true)
    const s = store.get('BTCUSDT', '1d')!
    expect(s.candles).toHaveLength(2500)
    expect(s.candles[0]!.time).toBe(0)
    expect(fetchKlines.mock.calls[1]![0]).toMatchObject({ limit: 1500, endTime: 1000 * DAY * 1000 - 1 })
    expect(events).toContain('full')
    // Already complete: no further requests.
    expect(await store.completeHistory('BTCUSDT', '1d')).toBe(true)
    expect(fetchKlines).toHaveBeenCalledTimes(2)
  })
  it('does not page 1w or 5m', async () => {
    const store = new CandleStore()
    fetchKlines.mockResolvedValue(series(0, 1500, 7 * DAY))
    await store.ensure('BTCUSDT', '1w')
    expect(await store.completeHistory('BTCUSDT', '1w')).toBe(false)
    expect(fetchKlines).toHaveBeenCalledTimes(1)
  })
})
