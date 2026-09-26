// Favorites export in TradingView watchlist format (arch §5.7): `BINANCE:BTCUSDT.P,BINANCE:ETHUSDT.P`.
// Binance USDⓈ-M perpetuals are listed on TradingView as `BINANCE:<SYMBOL>.P` (see also arch §9).

export const TV_EXCHANGE_PREFIX = 'BINANCE:'
export const TV_PERP_SUFFIX = '.P'

/** `BTCUSDT` → `BINANCE:BTCUSDT.P` */
export function toTvSymbol(symbol: string): string {
  return `${TV_EXCHANGE_PREFIX}${symbol.trim().toUpperCase()}${TV_PERP_SUFFIX}`
}

/** Comma-separated TradingView watchlist line; duplicates and blanks removed, order preserved. */
export function formatTvWatchlist(symbols: readonly string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of symbols) {
    const s = raw.trim().toUpperCase()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(toTvSymbol(s))
  }
  return out.join(',')
}

/** `chartswipe-favorites-YYYY-MM-DD.txt` using the device's local date. */
export function favoritesFilename(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `chartswipe-favorites-${y}-${m}-${d}.txt`
}

/**
 * Parse a TradingView watchlist export (same format, F6 import): comma/newline separated,
 * `###Section` headers ignored, exchange prefix and `.P` suffix stripped. Returns unique symbols.
 */
export function parseTvWatchlist(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const token of text.split(/[\s,]+/)) {
    if (!token || token.startsWith('###')) continue
    const noPrefix = token.includes(':') ? token.slice(token.lastIndexOf(':') + 1) : token
    const sym = noPrefix.toUpperCase().replace(/\.P$/, '')
    if (!/^[A-Z0-9]+$/.test(sym) || seen.has(sym)) continue
    seen.add(sym)
    out.push(sym)
  }
  return out
}
