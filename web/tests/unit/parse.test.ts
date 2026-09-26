import { describe, expect, it } from 'vitest'
import { parseExchangeInfo, parseKline, parseKlines, parseTickers, parseWsKline, tickDecimals } from '../../lib/binance/parse'
import { buildUrl } from '../../lib/binance/rest'
import { applyLiveCandle, intervalSeconds, mergeCandles, mergeFreshTail } from '../../lib/candles/merge'

const row = (tMs: number, c = '100.5') => [tMs, '100.0', '101.25', '99.5', c, '1234.5', tMs + 299_999, '0', 10, '0', '0', '0']

describe('klines parsing', () => {
  it('parses a REST row into a candle with seconds', () => {
    expect(parseKline(row(1_700_000_100_000))).toEqual({
      time: 1_700_000_100,
      open: 100,
      high: 101.25,
      low: 99.5,
      close: 100.5,
      volume: 1234.5,
    })
  })
  it('drops malformed rows, sorts and dedupes', () => {
    const out = parseKlines([row(600_000), 'junk', [1, 'x'], row(0), row(300_000), row(300_000, '7')])
    expect(out.map((c) => c.time)).toEqual([0, 300, 600])
    expect(out[1]!.close).toBe(7)
    expect(parseKline([0, 'NaN', '1', '1', '1', '1'])).toBeNull()
    expect(parseKlines({})).toEqual([])
  })
  it('parses WS kline payload', () => {
    expect(parseWsKline({ t: 60_000, T: 0, s: 'X', i: '1m', o: '1', h: '2', l: '0.5', c: '1.5', v: '3', x: true })).toMatchObject({
      time: 60,
      close: 1.5,
    })
  })
})

describe('tickers & exchangeInfo', () => {
  it('parses ticker/24hr rows', () => {
    const t = parseTickers([{ symbol: 'BTCUSDT', lastPrice: '65000.1', priceChangePercent: '-2.5', quoteVolume: '1e9' }, { foo: 1 }])
    expect(t).toEqual([{ symbol: 'BTCUSDT', lastPrice: 65000.1, priceChangePercent: -2.5, quoteVolume: 1e9 }])
  })
  it('extracts tickSize from PRICE_FILTER', () => {
    const info = parseExchangeInfo({
      symbols: [
        {
          symbol: 'BTCUSDT',
          contractType: 'PERPETUAL',
          quoteAsset: 'USDT',
          status: 'TRADING',
          filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.10' }],
        },
        { symbol: 'NOFILTER', filters: [] },
      ],
    })
    expect(info.BTCUSDT!.tickSize).toBe(0.1)
    expect(info.NOFILTER!.tickSize).toBe(0.01)
  })
  it('derives decimals from tick size', () => {
    expect(tickDecimals(0.1)).toBe(1)
    expect(tickDecimals(0.0001)).toBe(4)
    expect(tickDecimals(0.0000001)).toBe(7)
    expect(tickDecimals(1)).toBe(0)
    expect(tickDecimals(0.5)).toBe(1)
  })
  it('builds query strings without undefined params', () => {
    expect(buildUrl('/fapi/v1/klines', { symbol: 'BTCUSDT', interval: '5m', limit: 300, endTime: undefined })).toBe(
      'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=300',
    )
  })
})

const c = (time: number, close = 1) => ({ time, open: 1, high: 1, low: 1, close, volume: 1 })

describe('candle merging', () => {
  it('merges with incoming winning on equal time', () => {
    const out = mergeCandles([c(1), c(2, 5), c(3)], [c(2, 9), c(4)])
    expect(out.map((x) => [x.time, x.close])).toEqual([
      [1, 1],
      [2, 9],
      [3, 1],
      [4, 1],
    ])
  })
  it('discards the cache when the fresh tail leaves a gap', () => {
    expect(mergeFreshTail([c(0), c(60)], [c(600), c(660)], 60).map((x) => x.time)).toEqual([600, 660])
    expect(mergeFreshTail([c(0), c(60)], [c(120), c(180)], 60).map((x) => x.time)).toEqual([0, 60, 120, 180])
  })
  it('applies live candles', () => {
    const arr = [c(0), c(60)]
    expect(applyLiveCandle(arr, c(60, 2), 60)).toBe('update')
    expect(arr[1]!.close).toBe(2)
    expect(applyLiveCandle(arr, c(120), 60)).toBe('append')
    expect(applyLiveCandle(arr, c(0), 60)).toBe('stale')
    expect(applyLiveCandle(arr, c(600), 60)).toBe('gap')
  })
  it('converts intervals to seconds', () => {
    expect(intervalSeconds('5m')).toBe(300)
    expect(intervalSeconds('1h')).toBe(3600)
    expect(intervalSeconds('1d')).toBe(86_400)
    expect(() => intervalSeconds('7x')).toThrow()
  })
})
