import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  backoffDelay,
  klineStream,
  MAX_LIVE_STREAMS,
  planSubscriptions,
  STABLE_AFTER_MS,
  SYNC_DEBOUNCE_MS,
  WsManager,
  type WsLike,
} from '../../lib/binance/ws'

describe('planSubscriptions', () => {
  it('caps the desired set at 3 in priority order', () => {
    const p = planSubscriptions([], ['a', 'b', 'c', 'd', 'e'])
    expect(MAX_LIVE_STREAMS).toBe(3)
    expect(p.next).toEqual(['a', 'b', 'c'])
    expect(p.subscribe).toEqual(['a', 'b', 'c'])
    expect(p.unsubscribe).toEqual([])
  })
  it('diffs against active streams', () => {
    const p = planSubscriptions(['a', 'b', 'c'], ['b', 'c', 'd'])
    expect(p.subscribe).toEqual(['d'])
    expect(p.unsubscribe).toEqual(['a'])
  })
  it('dedupes desired streams', () => {
    expect(planSubscriptions([], ['a', 'a', 'b']).next).toEqual(['a', 'b'])
  })
  it('builds lowercase kline stream names', () => {
    expect(klineStream('BTCUSDT', '5m')).toBe('btcusdt@kline_5m')
  })
})

describe('backoffDelay', () => {
  it('grows exponentially and is capped', () => {
    const mid = () => 0.5 // no jitter
    expect(backoffDelay(0, 1000, 30_000, mid)).toBe(1000)
    expect(backoffDelay(3, 1000, 30_000, mid)).toBe(8000)
    expect(backoffDelay(20, 1000, 30_000, mid)).toBe(30_000)
  })
  it('stays within ±20 % jitter', () => {
    expect(backoffDelay(2, 1000, 30_000, () => 0)).toBe(3200)
    expect(backoffDelay(2, 1000, 30_000, () => 1)).toBe(4800)
  })
})

class FakeSocket implements WsLike {
  readyState = 0
  sent: { method: string; params: string[] }[] = []
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
  }
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  drop() {
    this.readyState = 3
    this.onclose?.({})
  }
  kline(stream: string, s: string) {
    const k = { t: 60_000, T: 0, s, i: '5m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x: false }
    this.onmessage?.({ data: JSON.stringify({ stream, data: { e: 'kline', E: 1, s, k } }) })
  }
}

function setup() {
  const sockets: FakeSocket[] = []
  const m = new WsManager({
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
  })
  return { m, sockets }
}

describe('WsManager', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('never subscribes more than the cap on the wire', () => {
    const { m, sockets } = setup()
    m.setDesired(['a', 'b', 'c', 'd'])
    sockets[0]!.open()
    expect(m.activeStreams).toEqual(['a', 'b', 'c'])
    m.setDesired(['d', 'e', 'a', 'b'])
    vi.advanceTimersByTime(SYNC_DEBOUNCE_MS)
    expect(m.activeStreams).toEqual(['d', 'e', 'a'])
    const [, unsub, sub] = sockets[0]!.sent
    expect(unsub).toMatchObject({ method: 'UNSUBSCRIBE', params: ['b', 'c'] })
    expect(sub).toMatchObject({ method: 'SUBSCRIBE', params: ['d', 'e'] })
    const live = new Set<string>()
    for (const msg of sockets[0]!.sent) {
      for (const p of msg.params) {
        if (msg.method === 'SUBSCRIBE') live.add(p)
        else live.delete(p)
      }
      expect(live.size).toBeLessThanOrEqual(3)
    }
  })

  it('coalesces rapid setDesired calls into one UNSUBSCRIBE + one SUBSCRIBE', () => {
    const { m, sockets } = setup()
    m.setDesired(['a', 'b', 'c'])
    sockets[0]!.open()
    const before = sockets[0]!.sent.length
    // fast swipes: 5 changes within the debounce window
    m.setDesired(['b', 'c', 'd'])
    m.setDesired(['c', 'd', 'e'])
    m.setDesired(['d', 'e', 'f'])
    m.setDesired(['e', 'f', 'g'])
    m.setDesired(['f', 'g', 'h'])
    expect(sockets[0]!.sent.length).toBe(before) // nothing sent yet
    vi.advanceTimersByTime(SYNC_DEBOUNCE_MS)
    const msgs = sockets[0]!.sent.slice(before)
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toMatchObject({ method: 'UNSUBSCRIBE', params: ['a', 'b', 'c'] })
    expect(msgs[1]).toMatchObject({ method: 'SUBSCRIBE', params: ['f', 'g', 'h'] })
  })

  it('reconnects with backoff and resubscribes', () => {
    const { m, sockets } = setup()
    m.setDesired(['a'])
    sockets[0]!.open()
    sockets[0]!.drop()
    expect(sockets).toHaveLength(1)
    vi.advanceTimersByTime(1200) // attempt 0: ≤ 1.2 s with jitter
    expect(sockets).toHaveLength(2)
    sockets[1]!.open()
    expect(sockets[1]!.sent[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['a'] })
  })

  it('keeps backing off when connections open and drop immediately', () => {
    const { m, sockets } = setup()
    m.setDesired(['a'])
    for (let i = 0; i < 4; i++) {
      sockets[i]!.open()
      sockets[i]!.drop()
      vi.advanceTimersByTime(60_000)
    }
    expect(m.reconnectAttempt).toBe(4) // not reset by onopen
  })

  it('resets the backoff after a stable period or the first kline', () => {
    const { m, sockets } = setup()
    m.setDesired(['btcusdt@kline_5m'])
    sockets[0]!.open()
    sockets[0]!.drop()
    vi.advanceTimersByTime(60_000)
    sockets[1]!.open()
    expect(m.reconnectAttempt).toBe(1)
    vi.advanceTimersByTime(STABLE_AFTER_MS)
    expect(m.reconnectAttempt).toBe(0)

    sockets[1]!.drop()
    vi.advanceTimersByTime(60_000)
    sockets[2]!.open()
    expect(m.reconnectAttempt).toBe(1)
    sockets[2]!.kline('btcusdt@kline_5m', 'BTCUSDT')
    expect(m.reconnectAttempt).toBe(0)
  })

  it('dispatches kline events only for active streams', () => {
    const { m, sockets } = setup()
    const got: string[] = []
    m.onKline((e) => got.push(`${e.symbol}:${e.interval}:${e.candle.close}`))
    m.setDesired(['btcusdt@kline_5m'])
    sockets[0]!.open()
    sockets[0]!.kline('btcusdt@kline_5m', 'BTCUSDT')
    sockets[0]!.kline('ethusdt@kline_5m', 'ETHUSDT')
    expect(got).toEqual(['BTCUSDT:5m:1.5'])
  })

  it('closes the socket when nothing is desired', () => {
    const { m, sockets } = setup()
    m.setDesired(['a'])
    sockets[0]!.open()
    m.setDesired([])
    expect(sockets[0]!.closed).toBe(true)
  })
})
