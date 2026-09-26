import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fallbackPrecision, fallbackTickSize, tickDecimals } from '../../lib/binance/parse'
import { BinanceHttpError, DEFAULT_RATE_LIMIT_BLOCK_MS, fetchKlines, RateLimitGate, rateLimitGate } from '../../lib/binance/rest'
import { withTimeout } from '../../lib/cache/candles'

describe('RateLimitGate', () => {
  it('blocks for Retry-After seconds on 429/418', () => {
    const g = new RateLimitGate()
    g.record(429, '5', 1000)
    expect(g.remaining(1000)).toBe(5000)
    expect(g.remaining(6000)).toBe(0)
    g.record(418, '120', 0)
    expect(g.remaining(0)).toBe(120_000)
  })
  it('defaults to 60 s without a usable Retry-After', () => {
    const g = new RateLimitGate()
    g.record(429, null, 0)
    expect(g.remaining(0)).toBe(DEFAULT_RATE_LIMIT_BLOCK_MS)
    const g2 = new RateLimitGate()
    g2.record(429, 'garbage', 0)
    expect(g2.remaining(0)).toBe(60_000)
  })
  it('ignores other statuses and never shortens an existing block', () => {
    const g = new RateLimitGate()
    g.record(500, '999', 0)
    expect(g.remaining(0)).toBe(0)
    g.record(429, '100', 0)
    g.record(429, '1', 0)
    expect(g.remaining(0)).toBe(100_000)
  })
})

describe('fapi calls behind the gate', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    rateLimitGate.reset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rateLimitGate.reset()
  })

  it('refuses all further requests locally after a 429 until Retry-After', async () => {
    fetchMock.mockResolvedValueOnce(new Response('too many', { status: 429, headers: { 'Retry-After': '30' } }))
    await expect(fetchKlines({ symbol: 'BTCUSDT', interval: '5m' })).rejects.toBeInstanceOf(BinanceHttpError)
    const err = await fetchKlines({ symbol: 'ETHUSDT', interval: '1h' }).catch((e: BinanceHttpError) => e)
    expect(err).toBeInstanceOf(BinanceHttpError)
    expect((err as BinanceHttpError).isRateLimited).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1) // second call never hit the network
  })

  it('never sends a Referer (Binance WAF 403s *.sslip.io referers → CORS error, no charts)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('[]', { status: 200 }))
    await fetchKlines({ symbol: 'BTCUSDT', interval: '5m' })
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.referrerPolicy).toBe('no-referrer')
    expect(init.credentials).toBe('omit')
  })
})

describe('price precision fallback (no exchangeInfo)', () => {
  it('derives decimals from the price magnitude', () => {
    expect(fallbackPrecision(65_000)).toBe(2)
    expect(fallbackPrecision(150)).toBe(2)
    expect(fallbackPrecision(1.5)).toBe(4)
    expect(fallbackPrecision(0.05)).toBe(6)
    expect(fallbackPrecision(0.0000123)).toBe(9)
    expect(fallbackPrecision(1e-12)).toBe(10)
  })
  it('falls back to 2 decimals for unknown prices', () => {
    expect(fallbackPrecision(undefined)).toBe(2)
    expect(fallbackPrecision(0)).toBe(2)
    expect(fallbackPrecision(Number.NaN)).toBe(2)
  })
  it('gives a tick size that round-trips through tickDecimals', () => {
    expect(fallbackTickSize(0.05)).toBe(0.000001)
    expect(tickDecimals(fallbackTickSize(0.0000123))).toBe(9)
    expect(fallbackTickSize(65_000)).toBe(0.01)
  })
})

describe('withTimeout (IndexedDB open guard)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves null when the promise hangs', async () => {
    const p = withTimeout(new Promise<number>(() => {}), 500)
    vi.advanceTimersByTime(500)
    await expect(p).resolves.toBeNull()
  })
  it('passes through a value that arrives in time', async () => {
    await expect(withTimeout(Promise.resolve(7), 500)).resolves.toBe(7)
  })
})

describe('describeError', () => {
  afterEach(() => rateLimitGate.reset())
  it('explains HTTP failures in Russian', async () => {
    const { describeError } = await import('../../lib/binance/rest')
    expect(describeError(new BinanceHttpError(451, '/fapi/v1/klines', ''))).toContain('региона')
    expect(describeError(new BinanceHttpError(503, '/x', ''))).toContain('сбой на стороне Binance')
    rateLimitGate.record(429, '30', Date.now())
    expect(describeError(new BinanceHttpError(429, '/x', ''))).toMatch(/лимит запросов.*30 с/)
    expect(describeError(new TypeError('Load failed'))).toBe('нет сети или запрос заблокирован (Load failed)')
    expect(describeError('x')).toBe('x')
  })
})
