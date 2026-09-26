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
    fetchKlines.mockResolvedValueOnce(series(3000, 3))
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
    fetchKlines.mockResolvedValueOnce(series(3000, 3))
    await store.ensure('BTCUSDT', '5m')
    rateLimitGate.record(429, '120')
    fetchKlines.mockRejectedValueOnce(new Error('429'))
    await store.loadOlder('BTCUSDT', '5m')
    vi.setSystemTime(1_000_000 + 60_000)
    await store.loadOlder('BTCUSDT', '5m')
    expect(fetchKlines).toHaveBeenCalledTimes(2)
  })
})
