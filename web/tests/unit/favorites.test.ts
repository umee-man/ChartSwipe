import { describe, expect, it } from 'vitest'
import { favoritesFilename, formatTvWatchlist, parseTvWatchlist, toTvSymbol } from '../../lib/favorites/export'

describe('TradingView watchlist export', () => {
  it('formats perps as BINANCE:<SYMBOL>.P, comma separated', () => {
    expect(formatTvWatchlist(['BTCUSDT', 'ETHUSDT'])).toBe('BINANCE:BTCUSDT.P,BINANCE:ETHUSDT.P')
  })
  it('keeps order, drops blanks and duplicates, uppercases', () => {
    expect(formatTvWatchlist(['solusdt', ' ', 'BTCUSDT', 'SOLUSDT'])).toBe('BINANCE:SOLUSDT.P,BINANCE:BTCUSDT.P')
  })
  it('returns an empty string for no favorites', () => {
    expect(formatTvWatchlist([])).toBe('')
  })
  it('maps a single symbol', () => {
    expect(toTvSymbol('1000PEPEUSDT')).toBe('BINANCE:1000PEPEUSDT.P')
  })
  it('names the file with the local date', () => {
    expect(favoritesFilename(new Date(2026, 8, 6))).toBe('chartswipe-favorites-2026-09-06.txt')
  })
  it('round-trips through the import parser', () => {
    const text = formatTvWatchlist(['BTCUSDT', 'ETHUSDT'])
    expect(parseTvWatchlist(text)).toEqual(['BTCUSDT', 'ETHUSDT'])
  })
  it('parses TradingView exports with sections and other exchanges', () => {
    expect(parseTvWatchlist('###Crypto,BINANCE:BTCUSDT.P,BYBIT:ETHUSDT.P\nsolusdt,BINANCE:BTCUSDT.P')).toEqual([
      'BTCUSDT',
      'ETHUSDT',
      'SOLUSDT',
    ])
  })
})
