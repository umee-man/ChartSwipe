// Pure parsers for Binance futures payloads. No I/O here so they can be unit-tested.
import type { Candle, RawKline, SymbolInfo, Ticker24h, WsKline } from './types'

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
  return Number.isFinite(n) ? n : Number.NaN
}

function isValidCandle(c: Candle): boolean {
  return (
    Number.isFinite(c.time) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume)
  )
}

/** Parse one REST kline row into a Candle (time in UTC seconds). Returns null for malformed rows. */
export function parseKline(row: unknown): Candle | null {
  if (!Array.isArray(row) || row.length < 6) return null
  const r = row as RawKline
  const c: Candle = {
    time: Math.floor(num(r[0]) / 1000),
    open: num(r[1]),
    high: num(r[2]),
    low: num(r[3]),
    close: num(r[4]),
    volume: num(r[5]),
  }
  return isValidCandle(c) ? c : null
}

/** Parse a klines response: drops malformed rows, sorts ascending and removes duplicate times. */
export function parseKlines(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return []
  const out: Candle[] = []
  for (const row of rows) {
    const c = parseKline(row)
    if (c) out.push(c)
  }
  out.sort((a, b) => a.time - b.time)
  return dedupeSorted(out)
}

function dedupeSorted(sorted: Candle[]): Candle[] {
  const out: Candle[] = []
  for (const c of sorted) {
    const last = out[out.length - 1]
    if (last && last.time === c.time) out[out.length - 1] = c
    else out.push(c)
  }
  return out
}

/** Parse the `k` object of a WS kline event. */
export function parseWsKline(k: WsKline): Candle | null {
  const c: Candle = {
    time: Math.floor(num(k.t) / 1000),
    open: num(k.o),
    high: num(k.h),
    low: num(k.l),
    close: num(k.c),
    volume: num(k.v),
  }
  return isValidCandle(c) ? c : null
}

/** Parse GET /fapi/v1/ticker/24hr (array form). */
export function parseTickers(rows: unknown): Ticker24h[] {
  if (!Array.isArray(rows)) return []
  const out: Ticker24h[] = []
  for (const r of rows as Record<string, unknown>[]) {
    if (!r || typeof r.symbol !== 'string') continue
    const t: Ticker24h = {
      symbol: r.symbol,
      lastPrice: num(r.lastPrice),
      priceChangePercent: num(r.priceChangePercent),
      quoteVolume: num(r.quoteVolume),
    }
    if (Number.isFinite(t.lastPrice) && Number.isFinite(t.priceChangePercent) && Number.isFinite(t.quoteVolume)) {
      out.push(t)
    }
  }
  return out
}

interface RawFilter {
  filterType?: string
  tickSize?: string
}

interface RawSymbol {
  symbol?: string
  contractType?: string
  quoteAsset?: string
  status?: string
  filters?: RawFilter[]
}

/** Parse GET /fapi/v1/exchangeInfo into a symbol -> SymbolInfo map. */
export function parseExchangeInfo(body: unknown): Record<string, SymbolInfo> {
  const out: Record<string, SymbolInfo> = {}
  const symbols = (body as { symbols?: RawSymbol[] } | null)?.symbols
  if (!Array.isArray(symbols)) return out
  for (const s of symbols) {
    if (!s.symbol) continue
    const pf = s.filters?.find((f) => f.filterType === 'PRICE_FILTER')
    const tickSize = num(pf?.tickSize)
    out[s.symbol] = {
      symbol: s.symbol,
      tickSize: Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01,
      contractType: s.contractType ?? '',
      quoteAsset: s.quoteAsset ?? '',
      status: s.status ?? '',
    }
  }
  return out
}

/** Number of decimals implied by a tick size, e.g. 0.001 -> 3, 0.5 -> 1, 10 -> 0. */
export function tickDecimals(tickSize: number): number {
  if (!(tickSize > 0) || tickSize >= 1) return 0
  // toFixed avoids exponent notation for tiny ticks like 1e-7.
  const s = tickSize.toFixed(12).replace(/0+$/, '')
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}
