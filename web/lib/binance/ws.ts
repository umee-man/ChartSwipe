// Single combined-stream WebSocket manager for live klines (arch §4, §10: ≤ 3 live subscriptions).
import { parseWsKline } from './parse'
import { DIRECT_ENDPOINTS } from './transport'
import type { Candle, WsKlineEvent } from './types'

/** Direct combined-stream route. The legacy `/stream` path accepts SUBSCRIBE but never sends klines any more. */
export const FSTREAM_URL = DIRECT_ENDPOINTS.ws
/** No kline within this long after connecting → the route counts as unhealthy (see WsManagerOptions.onUnhealthy). */
export const WS_SILENT_MS = 5_000
/** Hard cap on live subscriptions: current ticker + 2 neighbours (arch §4, §10). */
export const MAX_LIVE_STREAMS = 3
/**
 * Coalesce rapid setDesired() calls (fast swipes) into one UNSUBSCRIBE + one SUBSCRIBE.
 * fstream accepts at most 10 incoming messages per second per connection.
 */
export const SYNC_DEBOUNCE_MS = 150
/** A connection counts as stable (backoff resets) after this long or on its first kline. */
export const STABLE_AFTER_MS = 10_000

export function klineStream(symbol: string, interval: string): string {
  return `${symbol.toLowerCase()}@kline_${interval}`
}

export interface SubscriptionPlan {
  /** Streams that will be active after applying the plan (≤ cap, priority order). */
  next: string[]
  subscribe: string[]
  unsubscribe: string[]
}

/**
 * Pure diff between currently active streams and the desired ones.
 * `desired` is in priority order (current slide first); anything beyond `cap` is dropped.
 */
export function planSubscriptions(
  active: Iterable<string>,
  desired: readonly string[],
  cap: number = MAX_LIVE_STREAMS,
): SubscriptionPlan {
  const next: string[] = []
  for (const s of desired) {
    if (next.length >= cap) break
    if (!next.includes(s)) next.push(s)
  }
  const activeSet = new Set(active)
  const nextSet = new Set(next)
  return {
    next,
    subscribe: next.filter((s) => !activeSet.has(s)),
    unsubscribe: [...activeSet].filter((s) => !nextSet.has(s)),
  }
}

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped at `max`. */
export function backoffDelay(attempt: number, base = 1000, max = 30_000, rand: () => number = Math.random): number {
  const exp = Math.min(max, base * 2 ** Math.max(0, attempt))
  // ±20 % jitter so several tabs do not reconnect in lockstep.
  return Math.round(exp * (0.8 + 0.4 * rand()))
}

export type KlineListener = (e: { stream: string; symbol: string; interval: string; candle: Candle; closed: boolean }) => void

/** Minimal WebSocket surface we rely on (lets tests inject a fake). */
export interface WsLike {
  readyState: number
  send(data: string): void
  close(): void
  onopen: ((ev: unknown) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
}

export interface WsManagerOptions {
  /** Fixed URL, or a getter re-read on every (re)connect so a route switch takes effect. */
  url?: string | (() => string)
  cap?: number
  createSocket?: (url: string) => WsLike
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (id: unknown) => void
  /**
   * Opt-in silence watchdog, ms: a socket that delivers no kline within this long after opening is closed
   * and reconnected (and reported via onUnhealthy). Off by default.
   */
  silentTimeoutMs?: number
  /** A socket closed or went silent before delivering any kline (blocked network, dead route). */
  onUnhealthy?: (url: string) => void
}

const OPEN = 1

export class WsManager {
  private readonly url: () => string
  private readonly silentTimeoutMs: number | null
  private readonly onUnhealthy: ((url: string) => void) | null
  private readonly cap: number
  private readonly createSocket: (url: string) => WsLike
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (id: unknown) => void

  private socket: WsLike | null = null
  /** Streams confirmed as subscribed on the current socket. */
  private active: string[] = []
  /** Streams the app wants (already capped). */
  private desired: string[] = []
  private listeners = new Set<KlineListener>()
  private reqId = 1
  private attempt = 0
  private reconnectTimer: unknown = null
  private syncTimer: unknown = null
  private stableTimer: unknown = null
  private silentTimer: unknown = null
  /** The current socket has delivered at least one kline. */
  private gotKline = false
  private disposed = false

  constructor(opts: WsManagerOptions = {}) {
    const url = opts.url ?? FSTREAM_URL
    this.url = typeof url === 'string' ? () => url : url
    this.silentTimeoutMs = opts.silentTimeoutMs ?? null
    this.onUnhealthy = opts.onUnhealthy ?? null
    this.cap = opts.cap ?? MAX_LIVE_STREAMS
    this.createSocket = opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WsLike)
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = opts.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>))
  }

  /** Streams currently subscribed on the wire. Never longer than the cap. */
  get activeStreams(): readonly string[] {
    return this.active
  }

  onKline(fn: KlineListener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Declare which streams should be live, in priority order. Extra streams beyond the cap are ignored. */
  setDesired(streams: readonly string[]): void {
    if (this.disposed) return
    this.desired = planSubscriptions([], streams, this.cap).next
    if (this.desired.length === 0) {
      this.closeSocket()
      return
    }
    if (!this.socket) {
      this.connect()
      return
    }
    if (this.socket.readyState === OPEN) this.scheduleSync()
    // If still CONNECTING, onopen will sync.
  }

  /** Current backoff attempt counter (exposed for tests/diagnostics). */
  get reconnectAttempt(): number {
    return this.attempt
  }

  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.closeSocket()
  }

  private scheduleSync(): void {
    if (this.syncTimer !== null) return
    this.syncTimer = this.setTimer(() => {
      this.syncTimer = null
      if (this.socket?.readyState === OPEN) this.sync()
    }, SYNC_DEBOUNCE_MS)
  }

  private clearTimers(): void {
    for (const id of [this.syncTimer, this.stableTimer, this.silentTimer]) if (id !== null) this.clearTimer(id)
    this.syncTimer = null
    this.stableTimer = null
    this.silentTimer = null
  }

  private markStable(): void {
    this.attempt = 0
    if (this.stableTimer !== null) this.clearTimer(this.stableTimer)
    this.stableTimer = null
  }

  private sync(): void {
    const plan = planSubscriptions(this.active, this.desired, this.cap)
    // Unsubscribe first so the server-side count never exceeds the cap.
    if (plan.unsubscribe.length) this.send('UNSUBSCRIBE', plan.unsubscribe)
    if (plan.subscribe.length) this.send('SUBSCRIBE', plan.subscribe)
    this.active = plan.next
  }

  private send(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', params: string[]): void {
    this.socket?.send(JSON.stringify({ method, params, id: this.reqId++ }))
  }

  private connect(): void {
    if (this.disposed || this.socket) return
    const url = this.url()
    const ws = this.createSocket(url)
    this.socket = ws
    this.active = []
    this.gotKline = false
    ws.onopen = () => {
      if (this.silentTimeoutMs !== null) {
        if (this.silentTimer !== null) this.clearTimer(this.silentTimer)
        this.silentTimer = this.setTimer(() => {
          this.silentTimer = null
          if (this.socket !== ws || this.gotKline) return
          this.onUnhealthy?.(url)
          this.dropSocket(ws)
        }, this.silentTimeoutMs)
      }
      // Do not reset the backoff yet: a server that accepts and immediately drops would otherwise
      // cause a tight 1 s reconnect loop. Reset after STABLE_AFTER_MS or on the first kline.
      if (this.stableTimer !== null) this.clearTimer(this.stableTimer)
      this.stableTimer = this.setTimer(() => this.markStable(), STABLE_AFTER_MS)
      if (this.syncTimer !== null) this.clearTimer(this.syncTimer)
      this.syncTimer = null
      this.sync()
    }
    ws.onmessage = (ev) => this.handleMessage(ev.data)
    ws.onerror = () => {
      // onclose follows; reconnect is handled there.
    }
    ws.onclose = () => {
      if (this.socket !== ws) return
      if (!this.gotKline) this.onUnhealthy?.(url)
      this.dropSocket(ws)
    }
  }

  /** Forget `ws` (closing it if still open) and reconnect with backoff; the URL is re-read then. */
  private dropSocket(ws: WsLike): void {
    ws.onclose = null
    ws.onmessage = null
    try {
      ws.close() // no-op when already closed
    } catch {
      // ignore
    }
    this.socket = null
    this.active = []
    this.clearTimers()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.desired.length === 0 || this.reconnectTimer !== null) return
    const delay = backoffDelay(this.attempt++)
    this.reconnectTimer = this.setTimer(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private closeSocket(): void {
    this.clearTimers()
    if (this.reconnectTimer !== null) {
      this.clearTimer(this.reconnectTimer)
      this.reconnectTimer = null
    }
    const ws = this.socket
    this.socket = null
    this.active = []
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return
    let msg: { stream?: string; data?: WsKlineEvent }
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    const data = msg.data
    if (!msg.stream || !data || data.e !== 'kline' || !data.k) return
    // Ignore late messages for streams we already dropped.
    if (!this.active.includes(msg.stream)) return
    const candle = parseWsKline(data.k)
    if (!candle) return
    this.gotKline = true
    if (this.silentTimer !== null) {
      this.clearTimer(this.silentTimer)
      this.silentTimer = null
    }
    if (this.stableTimer !== null) this.markStable()
    const evt = { stream: msg.stream, symbol: data.k.s, interval: data.k.i, candle, closed: data.k.x }
    for (const fn of this.listeners) fn(evt)
  }
}
