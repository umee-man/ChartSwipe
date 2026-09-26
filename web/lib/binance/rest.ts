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

/** Default block after a 429/418 when the server sends no Retry-After, ms. */
export const DEFAULT_RATE_LIMIT_BLOCK_MS = 60_000

/**
 * Module-wide gate: after a 429 (rate limited) or 418 (IP ban) every fapi call is refused locally
 * until Retry-After passes, so a misbehaving loop can never escalate a 429 into a ban.
 */
export class RateLimitGate {
  private blockedUntil = 0

  /** ms remaining in the block, 0 if open. */
  remaining(now = Date.now()): number {
    return Math.max(0, this.blockedUntil - now)
  }

  /** Record a response. `retryAfter` is the raw Retry-After header (seconds). */
  record(status: number, retryAfter: string | null, now = Date.now()): void {
    if (status !== 429 && status !== 418) return
    const sec = retryAfter == null ? Number.NaN : Number.parseInt(retryAfter, 10)
    const ms = Number.isFinite(sec) && sec > 0 ? sec * 1000 : DEFAULT_RATE_LIMIT_BLOCK_MS
    this.blockedUntil = Math.max(this.blockedUntil, now + ms)
  }

  reset(): void {
    this.blockedUntil = 0
  }
}

export const rateLimitGate = new RateLimitGate()

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
  const wait = rateLimitGate.remaining()
  if (wait > 0) throw new BinanceHttpError(429, path, `blocked locally for ${Math.ceil(wait / 1000)} s`)
  const res = await fetch(buildUrl(path, query), { signal })
  rateLimitGate.record(res.status, res.headers.get('Retry-After'))
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

/** Human-readable (RU) reason for a failed Binance request, shown on screen for diagnostics. */
export function describeError(err: unknown): string {
  if (err instanceof BinanceHttpError) {
    if (err.isRateLimited) return `лимит запросов Binance (HTTP ${err.status}), пауза ~${Math.ceil(rateLimitGate.remaining() / 1000)} с`
    if (err.status === 451 || err.status === 403) return `доступ к Binance из этой сети/региона закрыт (HTTP ${err.status})`
    if (err.status >= 500) return `сбой на стороне Binance (HTTP ${err.status})`
    return `ответ Binance HTTP ${err.status} (${err.path})`
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'запрос отменён'
    // fetch network failures: Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError…"
    if (err.name === 'TypeError') return `нет сети или запрос заблокирован (${err.message})`
    return err.message
  }
  return String(err)
}
