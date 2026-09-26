import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BinanceHttpError, fetchKlines, rateLimitGate, setRestTransport } from '../../lib/binance/rest'
import {
  BinanceTransport,
  binanceTransport,
  DIRECT_ENDPOINTS,
  isRouteFailure,
  proxyEndpoints,
  REPROBE_DIRECT_MS,
  ROUTE_STORAGE_KEY,
  type StorageLike,
} from '../../lib/binance/transport'
import { FSTREAM_URL, WS_SILENT_MS, WsManager, type WsLike } from '../../lib/binance/ws'

const ORIGIN = 'https://chartswipe.195-20-249-42.sslip.io'

class MemStorage implements StorageLike {
  map = new Map<string, string>()
  getItem(k: string) {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string) {
    this.map.set(k, v)
  }
}

describe('endpoints', () => {
  it('uses the /market route on fstream (legacy /stream is silent)', () => {
    expect(DIRECT_ENDPOINTS.ws).toBe('wss://fstream.binance.com/market/stream')
    expect(FSTREAM_URL).toBe(DIRECT_ENDPOINTS.ws)
  })
  it('maps the page origin to the same-origin proxy', () => {
    expect(proxyEndpoints(ORIGIN)).toEqual({ rest: ORIGIN, ws: 'wss://chartswipe.195-20-249-42.sslip.io/bnc-ws/market/stream' })
    expect(proxyEndpoints('http://localhost:3000/').ws).toBe('ws://localhost:3000/bnc-ws/market/stream')
  })
})

describe('isRouteFailure', () => {
  it('treats network/CORS failures and 403/451 as route failures', () => {
    expect(isRouteFailure(new TypeError('Failed to fetch'))).toBe(true)
    expect(isRouteFailure(new TypeError('Load failed'))).toBe(true)
    expect(isRouteFailure(new BinanceHttpError(451, '/x', ''))).toBe(true)
    expect(isRouteFailure(new BinanceHttpError(403, '/x', ''))).toBe(true)
  })
  it('keeps rate limits, server errors and aborts on the current route', () => {
    expect(isRouteFailure(new BinanceHttpError(429, '/x', ''))).toBe(false)
    expect(isRouteFailure(new BinanceHttpError(418, '/x', ''))).toBe(false)
    expect(isRouteFailure(new BinanceHttpError(503, '/x', ''))).toBe(false)
    expect(isRouteFailure(new DOMException('aborted', 'AbortError'))).toBe(false)
    expect(isRouteFailure(new SyntaxError('bad json'))).toBe(false)
  })
})

describe('BinanceTransport', () => {
  it('starts direct and switches to the proxy once, persisting the choice', () => {
    const storage = new MemStorage()
    const t = new BinanceTransport({ origin: ORIGIN, storage, now: () => 1000 })
    const seen: string[] = []
    t.onChange((r) => seen.push(r))
    expect(t.route).toBe('direct')
    expect(t.endpoints().rest).toBe('https://fapi.binance.com')
    expect(t.reportRestFailure('direct', new BinanceHttpError(429, '/x', ''))).toBe(false)
    expect(t.route).toBe('direct')
    expect(t.reportRestFailure('direct', new TypeError('Failed to fetch'))).toBe(true)
    expect(t.route).toBe('proxy')
    expect(t.endpoints().rest).toBe(ORIGIN)
    // a concurrent request that also failed on direct just retries; no second change event
    expect(t.reportRestFailure('direct', new TypeError('Failed to fetch'))).toBe(true)
    // failures on the proxy never loop
    expect(t.reportRestFailure('proxy', new TypeError('Failed to fetch'))).toBe(false)
    expect(t.reportWsFailure('proxy')).toBe(false)
    expect(seen).toEqual(['proxy'])
    expect(JSON.parse(storage.getItem(ROUTE_STORAGE_KEY)!)).toEqual({ route: 'proxy', at: 1000 })
  })

  it('remembers the proxy on the next load and re-probes direct after a day', () => {
    const storage = new MemStorage()
    storage.setItem(ROUTE_STORAGE_KEY, JSON.stringify({ route: 'proxy', at: 0 }))
    expect(new BinanceTransport({ origin: ORIGIN, storage, now: () => REPROBE_DIRECT_MS - 1 }).route).toBe('proxy')
    expect(new BinanceTransport({ origin: ORIGIN, storage, now: () => REPROBE_DIRECT_MS }).route).toBe('direct')
  })

  it('ignores garbage in storage and throwing storage', () => {
    const storage = new MemStorage()
    storage.setItem(ROUTE_STORAGE_KEY, '{nope')
    expect(new BinanceTransport({ origin: ORIGIN, storage }).route).toBe('direct')
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const t = new BinanceTransport({ origin: ORIGIN, storage: throwing })
    expect(t.reportWsFailure('direct')).toBe(true)
    expect(t.route).toBe('proxy')
  })

  it('has no proxy without a page origin (node/tests)', () => {
    const t = new BinanceTransport()
    expect(t.canUseProxy).toBe(false)
    expect(t.reportRestFailure('direct', new TypeError('Failed to fetch'))).toBe(false)
    expect(t.route).toBe('direct')
  })
})

describe('REST fallback to the same-origin proxy', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    rateLimitGate.reset()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    rateLimitGate.reset()
    setRestTransport(binanceTransport)
  })

  it('retries once via the proxy when direct Binance is blocked, then stays there', async () => {
    const t = new BinanceTransport({ origin: ORIGIN, storage: new MemStorage() })
    setRestTransport(t)
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }))
    await expect(fetchKlines({ symbol: 'BTCUSDT', interval: '5m' })).resolves.toEqual([])
    expect(fetchMock.mock.calls.map((c) => String(c[0]).split('?')[0])).toEqual([
      'https://fapi.binance.com/fapi/v1/klines',
      `${ORIGIN}/fapi/v1/klines`,
    ])
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }))
    await fetchKlines({ symbol: 'ETHUSDT', interval: '1h' })
    expect(String(fetchMock.mock.calls[2]![0])).toMatch(`${ORIGIN}/fapi/v1/klines?symbol=ETHUSDT`)
    // every attempt (direct and proxy) goes out without a Referer
    for (const c of fetchMock.mock.calls) expect((c[1] as RequestInit).referrerPolicy).toBe('no-referrer')
  })

  it('does not switch routes on a 429 (rate-limit gate semantics kept)', async () => {
    const t = new BinanceTransport({ origin: ORIGIN, storage: new MemStorage() })
    setRestTransport(t)
    fetchMock.mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'Retry-After': '10' } }))
    await expect(fetchKlines({ symbol: 'BTCUSDT', interval: '5m' })).rejects.toMatchObject({ status: 429 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(t.route).toBe('direct')
    expect(rateLimitGate.remaining()).toBeGreaterThan(0)
  })
})

class FakeSocket implements WsLike {
  readyState = 0
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  constructor(readonly url: string) {}
  send() {}
  close() {
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  fail() {
    this.readyState = 3
    this.onclose?.({})
  }
  kline(stream: string, s: string) {
    const k = { t: 60_000, T: 0, s, i: '5m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x: false }
    this.onmessage?.({ data: JSON.stringify({ stream, data: { e: 'kline', E: 1, s, k } }) })
  }
}

describe('WsManager route fallback', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function setup() {
    const t = new BinanceTransport({ origin: ORIGIN, storage: new MemStorage() })
    const sockets: FakeSocket[] = []
    let used = t.route
    const m = new WsManager({
      url: () => {
        used = t.route
        return t.endpoints(used).ws
      },
      silentTimeoutMs: WS_SILENT_MS,
      onUnhealthy: () => void t.reportWsFailure(used),
      createSocket: (u) => {
        const s = new FakeSocket(u)
        sockets.push(s)
        return s
      },
    })
    return { t, m, sockets }
  }

  it('moves to the proxy when the direct socket never opens', () => {
    const { t, m, sockets } = setup()
    m.setDesired(['btcusdt@kline_5m'])
    expect(sockets[0]!.url).toBe('wss://fstream.binance.com/market/stream')
    sockets[0]!.fail()
    expect(t.route).toBe('proxy')
    vi.advanceTimersByTime(1200)
    expect(sockets[1]!.url).toBe('wss://chartswipe.195-20-249-42.sslip.io/bnc-ws/market/stream')
  })

  it('moves to the proxy when the direct socket opens but stays silent', () => {
    const { t, m, sockets } = setup()
    m.setDesired(['btcusdt@kline_5m'])
    sockets[0]!.open()
    vi.advanceTimersByTime(WS_SILENT_MS - 1)
    expect(t.route).toBe('direct')
    vi.advanceTimersByTime(1)
    expect(t.route).toBe('proxy')
    expect(sockets[0]!.closed).toBe(true)
    vi.advanceTimersByTime(1200)
    expect(sockets[1]!.url).toContain('/bnc-ws/market/stream')
  })

  it('stays direct once klines flow', () => {
    const { t, m, sockets } = setup()
    m.setDesired(['btcusdt@kline_5m'])
    sockets[0]!.open()
    sockets[0]!.kline('btcusdt@kline_5m', 'BTCUSDT')
    vi.advanceTimersByTime(60_000)
    expect(t.route).toBe('direct')
    expect(sockets).toHaveLength(1)
  })
})
