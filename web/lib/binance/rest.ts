// Typed REST client for Binance USDⓈ-M Futures public endpoints (arch §4). No API keys.
import { parseExchangeInfo, parseKlines, parseTickers } from './parse'
import type { Candle, Interval, SymbolInfo, Ticker24h } from './types'

export const FAPI_BASE = 'https://fapi.binance.com'
/** Default history page size (arch §4: limit=300, weight 2). */
export const KLINES_LIMIT = 300

export class BinanceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly body: string,
  ) {
    super(`Binance ${status} on ${path}`)
    this.name = 'BinanceHttpError'
  }

  /** 429 = rate limited, 418 = IP banned after ignoring 429s. */
  get isRateLimited(): boolean {
    return this.status === 429 || this.status === 418
  }
}

type Query = Record<string, string | number | undefined>

export function buildUrl(path: string, query: Query = {}, base = FAPI_BASE): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined) params.set(k, String(v))
  }
  const qs = params.toString()
  return `${base}${path}${qs ? `?${qs}` : ''}`
}

async function getJson(path: string, query?: Query, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(buildUrl(path, query), { signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new BinanceHttpError(res.status, path, body)
  }
  return res.json()
}

export interface KlinesParams {
  symbol: string
  interval: Interval
  limit?: number
  /** Inclusive end time in ms; used to page history to the left. */
  endTime?: number
  signal?: AbortSignal
}

/** GET /fapi/v1/klines — latest `limit` candles, or the page ending at `endTime`. */
export async function fetchKlines(p: KlinesParams): Promise<Candle[]> {
  const body = await getJson(
    '/fapi/v1/klines',
    { symbol: p.symbol, interval: p.interval, limit: p.limit ?? KLINES_LIMIT, endTime: p.endTime },
    p.signal,
  )
  return parseKlines(body)
}

/** GET /fapi/v1/ticker/24hr for all symbols (weight 40, poll ≤ once per 60 s). */
export async function fetchTickers24h(signal?: AbortSignal): Promise<Ticker24h[]> {
  return parseTickers(await getJson('/fapi/v1/ticker/24hr', undefined, signal))
}

/** GET /fapi/v1/exchangeInfo — tickSize etc. Callers should cache for 24 h (see lib/cache). */
export async function fetchExchangeInfo(signal?: AbortSignal): Promise<Record<string, SymbolInfo>> {
  return parseExchangeInfo(await getJson('/fapi/v1/exchangeInfo', undefined, signal))
}
