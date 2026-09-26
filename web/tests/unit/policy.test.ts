import { describe, expect, it } from 'vitest'
import type { Candle } from '../../lib/binance/types'
import { initialLimit, klinesWeight, pageUntilStart, pagesToListingStart, preloadTfs, tailLimit } from '../../lib/candles/policy'

const DAY = 86_400
const c = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })
/** Fake exchange: daily bars from `listed` to `last`, answering like /fapi/v1/klines with endTime. */
function exchange(listed: number, last: number) {
  const all: Candle[] = []
  for (let t = listed; t <= last; t += DAY) all.push(c(t))
  const calls: number[] = []
  const fetchOlder = async (endTimeMs: number, limit = 1500) => {
    calls.push(endTimeMs)
    const upTo = all.filter((x) => x.time * 1000 <= endTimeMs)
    return upTo.slice(-limit)
  }
  return { all, calls, fetchOlder }
}

describe('load policy (A20)', () => {
  it('uses 1500 for Д/Н and 300 for 5м/1ч; only Д pages back', () => {
    expect(['5m', '1h', '1d', '1w'].map(initialLimit)).toEqual([300, 300, 1500, 1500])
    expect(['5m', '1h', '1d', '1w'].map(pagesToListingStart)).toEqual([false, false, true, false])
  })
  it('knows the klines weight table', () => {
    expect([1, 99, 100, 300, 499, 500, 1000, 1001, 1500].map(klinesWeight)).toEqual([1, 1, 2, 2, 2, 5, 5, 10, 10])
  })
  it('sizes the tail refresh from the cached last bar', () => {
    expect(tailLimit(1000 * DAY, 1000 * DAY + 3600, DAY, 1500)).toBe(3) // same day: 1 + 2 overlap
    expect(tailLimit(1000 * DAY, 1010 * DAY, DAY, 1500)).toBe(12)
    expect(tailLimit(0, 5000 * DAY, DAY, 1500)).toBe(1500)
    expect(tailLimit(1000 * DAY, 999 * DAY, DAY, 1500)).toBe(2)
  })
  it('preloads big Д/Н pages only for the current and next ticker', () => {
    const b = ['5m', '1h', '1d', '1w'] as const
    expect(preloadTfs(0, b, '5m')).toEqual(['5m', '1h', '1d', '1w'])
    expect(preloadTfs(1, b, '5m')).toEqual(['5m', '1h', '1d', '1w'])
    expect(preloadTfs(2, b, '5m')).toEqual(['5m', '1h'])
    expect(preloadTfs(2, b, '1d')).toEqual(['5m', '1h', '1d'])
  })
})

describe('pageUntilStart', () => {
  it('pages back sequentially until the listing start (BTC-like: ~2500 days)', async () => {
    const ex = exchange(0, 2499 * DAY)
    const first = ex.all.slice(-1500)
    const r = await pageUntilStart((t) => ex.fetchOlder(t), first, 1500)
    expect(r).toMatchObject({ complete: true, pages: 1 })
    expect(r.candles).toHaveLength(2500)
    expect(r.candles[0]!.time).toBe(0)
    expect(ex.calls[0]).toBe(first[0]!.time * 1000 - 1)
  })
  it('stops after an empty page when the first page ended exactly at the start', async () => {
    const ex = exchange(0, 2999 * DAY)
    const r = await pageUntilStart((t) => ex.fetchOlder(t), ex.all.slice(-1500), 1500)
    expect(r).toMatchObject({ complete: true, pages: 2 }) // 2nd call returns 0 bars
    expect(r.candles).toHaveLength(3000)
  })
  it('respects maxPages and reports incomplete', async () => {
    const ex = exchange(0, 9999 * DAY)
    const r = await pageUntilStart((t) => ex.fetchOlder(t), ex.all.slice(-1500), 1500, 2)
    expect(r).toMatchObject({ complete: false, pages: 2 })
    expect(r.candles).toHaveLength(4500)
  })
  it('propagates errors (e.g. the local 429 gate)', async () => {
    await expect(pageUntilStart(() => Promise.reject(new Error('429')), [c(DAY)], 1500)).rejects.toThrow('429')
  })
})
