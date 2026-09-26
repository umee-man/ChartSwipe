import { describe, expect, it } from 'vitest'
import { backoffDelay, klineStream, MAX_LIVE_STREAMS, planSubscriptions, WsManager, type WsLike } from '../../lib/binance/ws'

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
}

function setup() {
  const sockets: FakeSocket[] = []
  const timers: (() => void)[] = []
  const m = new WsManager({
    createSocket: () => {
      const s = new FakeSocket()
      sockets.push(s)
      return s
    },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  })
  return { m, sockets, timers }
}

describe('WsManager', () => {
  it('never subscribes more than the cap on the wire', () => {
    const { m, sockets } = setup()
    m.setDesired(['a', 'b', 'c', 'd'])
    sockets[0]!.open()
    expect(m.activeStreams).toEqual(['a', 'b', 'c'])
    m.setDesired(['d', 'e', 'a', 'b'])
    expect(m.activeStreams).toEqual(['d', 'e', 'a'])
    // unsubscribe is sent before subscribe
    const [, unsub, sub] = sockets[0]!.sent
    expect(unsub).toMatchObject({ method: 'UNSUBSCRIBE', params: ['b', 'c'] })
    expect(sub).toMatchObject({ method: 'SUBSCRIBE', params: ['d', 'e'] })
    // replaying the wire log never has > 3 live streams
    const live = new Set<string>()
    for (const msg of sockets[0]!.sent) {
      for (const p of msg.params) {
        if (msg.method === 'SUBSCRIBE') live.add(p)
        else live.delete(p)
      }
      expect(live.size).toBeLessThanOrEqual(3)
    }
  })

  it('reconnects with backoff and resubscribes', () => {
    const { m, sockets, timers } = setup()
    m.setDesired(['a'])
    sockets[0]!.open()
    sockets[0]!.onclose?.({})
    expect(timers).toHaveLength(1)
    timers[0]!()
    expect(sockets).toHaveLength(2)
    sockets[1]!.open()
    expect(sockets[1]!.sent[0]).toMatchObject({ method: 'SUBSCRIBE', params: ['a'] })
  })

  it('dispatches kline events only for active streams', () => {
    const { m, sockets } = setup()
    const got: string[] = []
    m.onKline((e) => got.push(`${e.symbol}:${e.interval}:${e.candle.close}`))
    m.setDesired(['btcusdt@kline_5m'])
    sockets[0]!.open()
    const k = (stream: string, s: string) =>
      JSON.stringify({
        stream,
        data: { e: 'kline', E: 1, s, k: { t: 60_000, T: 0, s, i: '5m', o: '1', h: '2', l: '0.5', c: '1.5', v: '10', x: false } },
      })
    sockets[0]!.onmessage?.({ data: k('btcusdt@kline_5m', 'BTCUSDT') })
    sockets[0]!.onmessage?.({ data: k('ethusdt@kline_5m', 'ETHUSDT') })
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
