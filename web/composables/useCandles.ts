// App-wide market data singletons: candle repository + one WS manager (arch §4, §5.2).
import { onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { Interval } from '~/lib/binance/types'
import { binanceTransport } from '~/lib/binance/transport'
import { klineStream, WS_SILENT_MS, WsManager } from '~/lib/binance/ws'
import { lastCandle } from '~/lib/candles/merge'
import { CandleStore } from '~/lib/candles/store'

let candleStore: CandleStore | null = null
let wsManager: WsManager | null = null

function init(): { store: CandleStore; ws: WsManager } {
  if (!candleStore || !wsManager) {
    const store = new CandleStore()
    // Direct fstream first; a socket that never opens or stays silent moves REST+WS to the proxy (ADR A13).
    const route = () => binanceTransport.route
    let urlRoute = route()
    const ws = new WsManager({
      url: () => {
        urlRoute = route()
        return binanceTransport.endpoints(urlRoute).ws
      },
      silentTimeoutMs: WS_SILENT_MS,
      onUnhealthy: () => void binanceTransport.reportWsFailure(urlRoute),
    })
    ws.onKline((e) => store.applyLive(e.symbol, e.interval as Interval, e.candle))
    candleStore = store
    wsManager = ws
  }
  return { store: candleStore, ws: wsManager }
}

export function useCandles() {
  const { store, ws } = init()

  return {
    store,
    /** Live streams for `symbols` (priority order) on `tf`; the manager enforces the 3-stream cap. */
    setLive(symbols: readonly string[], tf: Interval) {
      ws.setDesired(symbols.map((s) => klineStream(s, tf)))
    },
    /** Load every TF for each symbol in parallel (arch §5.2). Errors are reflected in series status. */
    preload(symbols: readonly string[], tfs: readonly Interval[]) {
      for (const s of symbols) for (const tf of tfs) void store.ensure(s, tf)
    },
    retain(symbols: ReadonlySet<string>) {
      store.retain(symbols)
    },
  }
}

/** Reactive last close for (symbol, tf) — header price that ticks with the WS stream. */
export function useLastPrice(symbol: Ref<string | undefined>, tf: Ref<Interval>) {
  const { store } = useCandles()
  const price = ref<number | null>(null)

  const read = () => {
    const sym = symbol.value
    const last = sym ? lastCandle(store.get(sym, tf.value)?.candles) : undefined
    price.value = last ? last.close : null
  }
  const off = store.subscribe((e) => {
    if (e.symbol === symbol.value && e.tf === tf.value) read()
  })
  watch([symbol, tf], read, { immediate: true })
  onBeforeUnmount(off)
  return price
}
