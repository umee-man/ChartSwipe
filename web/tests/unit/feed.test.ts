import { describe, expect, it } from 'vitest'
import type { SymbolInfo, Ticker24h } from '../../lib/binance/types'
import {
  dayMovers,
  DEFAULT_WATCHLIST,
  isTradablePerp,
  symbolsForSource,
  topByQuoteVolume,
  watchlistSymbols,
} from '../../lib/feed/sources'
import { clampIndex, domSlots, liveSymbols, memorySymbols, preloadSymbols } from '../../lib/feed/window'

const t = (symbol: string, quoteVolume: number, priceChangePercent = 0): Ticker24h => ({
  symbol,
  lastPrice: 1,
  quoteVolume,
  priceChangePercent,
})
const perp = (symbol: string, over: Partial<SymbolInfo> = {}): SymbolInfo => ({
  symbol,
  tickSize: 0.01,
  contractType: 'PERPETUAL',
  quoteAsset: 'USDT',
  status: 'TRADING',
  ...over,
})

describe('feed sources', () => {
  it('top-50 sorts by quoteVolume and skips dated futures', () => {
    const tickers = [t('AUSDT', 10), t('BUSDT', 30), t('BTCUSDT_251226', 99), t('CUSDT', 20)]
    expect(topByQuoteVolume({ tickers })).toEqual(['BUSDT', 'CUSDT', 'AUSDT'])
  })
  it('top-50 caps at 50', () => {
    const tickers = Array.from({ length: 80 }, (_, i) => t(`S${i}USDT`, i))
    const out = topByQuoteVolume({ tickers })
    expect(out).toHaveLength(50)
    expect(out[0]).toBe('S79USDT')
  })
  it('uses exchangeInfo to drop non-perp, non-trading and non-USDT', () => {
    const info = {
      AUSDT: perp('AUSDT'),
      BUSDT: perp('BUSDT', { status: 'SETTLING' }),
      CUSDC: perp('CUSDC', { quoteAsset: 'USDC' }),
      DUSDT: perp('DUSDT', { contractType: 'CURRENT_QUARTER' }),
    }
    const tickers = [t('AUSDT', 1), t('BUSDT', 2), t('CUSDC', 3), t('DUSDT', 4)]
    expect(topByQuoteVolume({ tickers, exchangeInfo: info })).toEqual(['AUSDT'])
    expect(isTradablePerp('ZUSDT', info)).toBe(true) // unknown to info → name heuristic
  })
  it('day movers: |change| > 5 %, strongest first', () => {
    const tickers = [t('AUSDT', 1, 5), t('BUSDT', 1, -7.5), t('CUSDT', 1, 12), t('DUSDT', 1, 5.01), t('EUSDT', 1, -4)]
    expect(dayMovers({ tickers })).toEqual(['CUSDT', 'BUSDT', 'DUSDT'])
  })
  it('excludes hidden symbols in every source', () => {
    const hidden = new Set(['BUSDT', 'ETHUSDT'])
    const tickers = [t('AUSDT', 1, 9), t('BUSDT', 2, 9)]
    expect(topByQuoteVolume({ tickers, hidden })).toEqual(['AUSDT'])
    expect(dayMovers({ tickers, hidden })).toEqual(['AUSDT'])
    expect(watchlistSymbols({ tickers, hidden })).not.toContain('ETHUSDT')
  })
  it('watchlist keeps order, dedupes and defaults to majors', () => {
    expect(watchlistSymbols({ tickers: [] })).toEqual([...DEFAULT_WATCHLIST])
    expect(DEFAULT_WATCHLIST.length).toBeGreaterThanOrEqual(15)
    expect(watchlistSymbols({ tickers: [], watchlist: ['B', 'A', 'B'] })).toEqual(['B', 'A'])
    expect(symbolsForSource('watchlist', { tickers: [], watchlist: ['X'] })).toEqual(['X'])
  })
  it('favorites source lists only starred tickers, minus hidden', () => {
    const input = { tickers: [], favorites: ['SOLUSDT', 'BTCUSDT', 'XUSDT'], hidden: new Set(['XUSDT']) }
    expect(symbolsForSource('favorites', input)).toEqual(['SOLUSDT', 'BTCUSDT'])
    expect(symbolsForSource('favorites', { tickers: [] })).toEqual([])
  })
})

describe('virtual window', () => {
  const list = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
  it('keeps 3 slides in the DOM', () => {
    expect(domSlots(list, 0).map((s) => s.symbol)).toEqual(['A', 'B'])
    expect(domSlots(list, 3).map((s) => [s.offset, s.symbol])).toEqual([
      [-1, 'C'],
      [0, 'D'],
      [1, 'E'],
    ])
  })
  it('preloads the 2 next tickers', () => {
    expect(preloadSymbols(list, 3)).toEqual(['E', 'F'])
    expect(preloadSymbols(list, 7)).toEqual([])
  })
  it('keeps memory for ±3 tickers', () => {
    expect([...memorySymbols(list, 4)]).toEqual(['B', 'C', 'D', 'E', 'F', 'G', 'H'])
  })
  it('prioritises live streams: current, next, prev', () => {
    expect(liveSymbols(list, 3)).toEqual(['D', 'E', 'C'])
    expect(liveSymbols(list, 0)).toEqual(['A', 'B'])
  })
  it('clamps indices', () => {
    expect(clampIndex(10, 3)).toBe(2)
    expect(clampIndex(-1, 3)).toBe(0)
    expect(clampIndex(5, 0)).toBe(0)
  })
})
