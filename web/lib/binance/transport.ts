// Binance route selection: direct (fapi/fstream) first, same-origin Caddy proxy as fallback (ADR A13, arch §4).
// Framework-free: storage, clock and origin are injected so the logic is unit-testable.

export type BinanceRoute = 'direct' | 'proxy'

export interface BinanceEndpoints {
  /** REST base; paths like `/fapi/v1/klines` are appended. */
  rest: string
  /** Combined-stream WebSocket URL (SUBSCRIBE/UNSUBSCRIBE protocol). */
  ws: string
}

/** Binance moved USDⓈ-M market streams to /market/*; the legacy /stream route accepts SUBSCRIBE but stays silent. */
export const DIRECT_ENDPOINTS: BinanceEndpoints = {
  rest: 'https://fapi.binance.com',
  ws: 'wss://fstream.binance.com/market/stream',
}

/** Same-origin proxy paths (Caddy on srv2 in production, Nitro devProxy in `nuxt dev`). */
export const PROXY_WS_PATH = '/bnc-ws/market/stream'

export function proxyEndpoints(origin: string): BinanceEndpoints {
  const base = origin.replace(/\/+$/, '')
  return { rest: base, ws: `${base.replace(/^http/, 'ws')}${PROXY_WS_PATH}` }
}

export const ROUTE_STORAGE_KEY = 'cs.binance-route'
/** Once on the proxy, try direct again after this long (the blocking network may have changed). */
export const REPROBE_DIRECT_MS = 24 * 60 * 60 * 1000

/**
 * Should a failed request move us off the direct route?
 * - network-level failures (`TypeError`: Chrome "Failed to fetch", Safari "Load failed", Firefox "NetworkError…"),
 *   which is also what a CORS-blocked response looks like to page code;
 * - HTTP 403/451 (region/WAF block).
 * Rate limits (429/418) and 5xx are NOT route failures: they keep the rate-limit gate semantics.
 * Aborts are never failures.
 */
export function isRouteFailure(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  if (err instanceof TypeError) return true
  const status = (err as { status?: unknown } | null)?.status
  return status === 403 || status === 451
}

interface StoredRoute {
  route: BinanceRoute
  at: number
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export interface TransportOptions {
  /** Page origin for the proxy route; without one (tests/SSR) only the direct route exists. */
  origin?: string | null
  storage?: StorageLike | null
  now?: () => number
}

export class BinanceTransport {
  private current: BinanceRoute = 'direct'
  private readonly origin: string | null
  private readonly storage: StorageLike | null
  private readonly now: () => number
  private listeners = new Set<(route: BinanceRoute) => void>()

  constructor(opts: TransportOptions = {}) {
    this.origin = opts.origin ?? null
    this.storage = opts.storage ?? null
    this.now = opts.now ?? Date.now
    const saved = this.load()
    if (saved?.route === 'proxy' && this.origin && this.now() - saved.at < REPROBE_DIRECT_MS) this.current = 'proxy'
  }

  get route(): BinanceRoute {
    return this.current
  }

  get canUseProxy(): boolean {
    return this.origin !== null
  }

  endpoints(route: BinanceRoute = this.current): BinanceEndpoints {
    return route === 'proxy' && this.origin ? proxyEndpoints(this.origin) : DIRECT_ENDPOINTS
  }

  onChange(fn: (route: BinanceRoute) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * A request made on `usedRoute` failed with `err`. Returns true when the route switched to the proxy,
   * i.e. the caller should retry once on the new route.
   */
  reportRestFailure(usedRoute: BinanceRoute, err: unknown): boolean {
    if (!isRouteFailure(err)) return false
    return this.fallBack(usedRoute)
  }

  /** The WebSocket on `usedRoute` could not connect or stayed silent. Returns true if the route switched. */
  reportWsFailure(usedRoute: BinanceRoute): boolean {
    return this.fallBack(usedRoute)
  }

  private fallBack(usedRoute: BinanceRoute): boolean {
    if (usedRoute !== 'direct' || !this.origin) return false
    if (this.current === 'proxy') return true // already switched by a concurrent request: just retry
    this.current = 'proxy'
    this.save({ route: 'proxy', at: this.now() })
    for (const fn of this.listeners) fn(this.current)
    return true
  }

  private load(): StoredRoute | null {
    try {
      const raw = this.storage?.getItem(ROUTE_STORAGE_KEY)
      if (!raw) return null
      const v = JSON.parse(raw) as Partial<StoredRoute>
      return (v.route === 'direct' || v.route === 'proxy') && typeof v.at === 'number' ? (v as StoredRoute) : null
    } catch {
      return null
    }
  }

  private save(v: StoredRoute): void {
    try {
      this.storage?.setItem(ROUTE_STORAGE_KEY, JSON.stringify(v))
    } catch {
      // private mode / quota: the choice just is not remembered
    }
  }
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // access itself can throw when site data is blocked
  }
}

/** App-wide instance. In the browser it can fall back to the same-origin proxy; in node (tests) it is direct-only. */
export const binanceTransport = new BinanceTransport({
  origin: typeof location === 'undefined' ? null : location.origin,
  storage: browserStorage(),
})
