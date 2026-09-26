// Feed sources computed on the client from public Binance data (ADR A4, arch §4).
import type { SymbolInfo, Ticker24h } from '../binance/types'

export type FeedSourceId = 'watchlist' | 'favorites' | 'top50' | 'movers'

export const FEED_SOURCES: { id: FeedSourceId; label: string }[] = [
  { id: 'watchlist', label: 'Вотчлист' },
  { id: 'favorites', label: 'Избранное' },
  { id: 'top50', label: 'Топ-50 по объёму' },
  { id: 'movers', label: 'Движение дня' },
]

/** Hardcoded default watchlist of majors until the watchlists screen exists (plan: дни 12–14). */
export const DEFAULT_WATCHLIST: readonly string[] = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT',
  'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'TONUSDT',
  'DOTUSDT', 'LTCUSDT', 'TRXUSDT', 'SUIUSDT', 'NEARUSDT',
]

export const TOP_N = 50
/** "Движение дня": |24h change| strictly greater than this many percent. */
export const MOVERS_MIN_ABS_CHANGE = 5

/**
 * True for USDT-margined perpetuals that are currently trading.
 * Without exchangeInfo we fall back to a name check that excludes dated futures (e.g. BTCUSDT_251226).
 */
export function isTradablePerp(symbol: string, info?: Record<string, SymbolInfo> | null): boolean {
  const meta = info?.[symbol]
  if (meta) return meta.contractType === 'PERPETUAL' && meta.status === 'TRADING' && meta.quoteAsset === 'USDT'
  return /^[A-Z0-9]+USDT$/.test(symbol)
}

export interface SourceInput {
  tickers: readonly Ticker24h[]
  exchangeInfo?: Record<string, SymbolInfo> | null
  watchlist?: readonly string[]
  favorites?: readonly string[]
  hidden?: ReadonlySet<string>
}

/** Top-N by 24h quote volume. */
export function topByQuoteVolume(input: SourceInput, n = TOP_N): string[] {
  const hidden = input.hidden ?? new Set<string>()
  return input.tickers
    .filter((t) => isTradablePerp(t.symbol, input.exchangeInfo) && !hidden.has(t.symbol))
    .slice()
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, n)
    .map((t) => t.symbol)
}

/** Symbols whose |priceChangePercent| > threshold, strongest move first. */
export function dayMovers(input: SourceInput, minAbs = MOVERS_MIN_ABS_CHANGE): string[] {
  const hidden = input.hidden ?? new Set<string>()
  return input.tickers
    .filter(
      (t) =>
        Math.abs(t.priceChangePercent) > minAbs &&
        isTradablePerp(t.symbol, input.exchangeInfo) &&
        !hidden.has(t.symbol),
    )
    .slice()
    .sort((a, b) => Math.abs(b.priceChangePercent) - Math.abs(a.priceChangePercent))
    .map((t) => t.symbol)
}

/** Watchlist in its own order, minus hidden and (when exchangeInfo is known) delisted symbols. */
export function watchlistSymbols(input: SourceInput, list: readonly string[] = input.watchlist ?? DEFAULT_WATCHLIST): string[] {
  const hidden = input.hidden ?? new Set<string>()
  const seen = new Set<string>()
  const out: string[] = []
  for (const s of list) {
    if (seen.has(s) || hidden.has(s)) continue
    if (input.exchangeInfo && !isTradablePerp(s, input.exchangeInfo)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export function symbolsForSource(source: FeedSourceId, input: SourceInput): string[] {
  switch (source) {
    case 'watchlist':
      return watchlistSymbols(input)
    case 'favorites':
      // Arch §5.7: only starred tickers, in the order they were starred.
      return watchlistSymbols(input, input.favorites ?? [])
    case 'top50':
      return topByQuoteVolume(input)
    case 'movers':
      return dayMovers(input)
  }
}
