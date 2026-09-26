// Shared types for the Binance USDⓈ-M Futures public API (arch §4, ADR A2).

/** Kline intervals supported by Binance futures. */
export const INTERVALS = [
  '1m', '3m', '5m', '15m', '30m',
  '1h', '2h', '4h', '6h', '8h', '12h',
  '1d', '3d', '1w', '1M',
] as const

export type Interval = (typeof INTERVALS)[number]

/** Normalised candle. `time` is the open time in UTC seconds (lightweight-charts UTCTimestamp). */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Raw kline row as returned by GET /fapi/v1/klines. */
export type RawKline = [
  number, // 0 open time (ms)
  string, // 1 open
  string, // 2 high
  string, // 3 low
  string, // 4 close
  string, // 5 volume (base asset)
  number, // 6 close time (ms)
  string, // 7 quote asset volume
  number, // 8 number of trades
  string, // 9 taker buy base volume
  string, // 10 taker buy quote volume
  string, // 11 ignore
]

/** Kline payload inside a `<symbol>@kline_<interval>` WS event (field `k`). */
export interface WsKline {
  t: number // open time ms
  T: number // close time ms
  s: string // symbol
  i: string // interval
  o: string
  c: string
  h: string
  l: string
  v: string
  x: boolean // is this kline closed
}

export interface WsKlineEvent {
  e: 'kline'
  E: number
  s: string
  k: WsKline
}

/** Subset of GET /fapi/v1/ticker/24hr row that we use. */
export interface Ticker24h {
  symbol: string
  lastPrice: number
  priceChangePercent: number
  quoteVolume: number
}

/** Per-symbol trading metadata derived from GET /fapi/v1/exchangeInfo. */
export interface SymbolInfo {
  symbol: string
  tickSize: number
  /** e.g. PERPETUAL, CURRENT_QUARTER */
  contractType: string
  quoteAsset: string
  status: string
}
