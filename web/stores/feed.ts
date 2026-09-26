// Feed store: current source, ordered ticker list, position, 24h tickers and exchangeInfo (arch §4, ADR A4).
import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import { fallbackTickSize } from '~/lib/binance/parse'
import { describeError, fetchExchangeInfo, fetchTickers24h } from '~/lib/binance/rest'
import type { SymbolInfo, Ticker24h } from '~/lib/binance/types'
import { readExchangeInfo, writeExchangeInfo } from '~/lib/cache/candles'
import { FEED_SOURCES, symbolsForSource, type FeedSourceId } from '~/lib/feed/sources'
import { clampIndex, withFocused } from '~/lib/feed/window'
import { loadJson, saveJson } from '~/lib/storage'
import { useWatchlistsStore } from './watchlists'

const SOURCE_KEY = 'cs:feed:source'
/** ticker/24hr (weight 40) is polled at most once per minute (arch §4). */
export const TICKERS_POLL_MS = 60_000

function isSource(v: unknown): v is FeedSourceId {
  return FEED_SOURCES.some((s) => s.id === v)
}

let pollTimer: ReturnType<typeof setInterval> | null = null
let exchangeInfoLoading: Promise<void> | null = null

export const useFeedStore = defineStore('feed', {
  state: () => {
    const saved = loadJson<unknown>(SOURCE_KEY, 'watchlist')
    return {
      source: (isSource(saved) ? saved : 'watchlist') as FeedSourceId,
      /**
       * Snapshot of the source list taken when the source is (re)selected, so the order does not
       * jump under the user's finger when tickers refresh every 60 s. Hidden symbols are filtered live.
       */
      baseList: [] as string[],
      index: 0,
      tickers: {} as Record<string, Ticker24h>,
      tickersAt: 0,
      exchangeInfo: null as Record<string, SymbolInfo> | null,
      error: null as string | null,
      initialized: false,
      /** First ticker/exchangeInfo round finished (success or failure) — drives the loading text. */
      ready: false,
      /** Tickers opened from the levels list that the current source does not contain (reset on source change). */
      focused: [] as string[],
    }
  },
  getters: {
    symbols(): string[] {
      const wl = useWatchlistsStore()
      const hidden = wl.hiddenSet
      // Favorites (arch §5.7) track stars live; other sources use the snapshot.
      const base =
        this.source === 'favorites'
          ? symbolsForSource('favorites', { tickers: [], favorites: wl.favorites, exchangeInfo: this.exchangeInfo })
          : this.baseList
      return withFocused(
        base.filter((s) => !hidden.has(s)),
        this.focused,
      )
    },
    currentIndex(): number {
      return clampIndex(this.index, this.symbols.length)
    },
    currentSymbol(): string | undefined {
      return this.symbols[this.currentIndex]
    },
    sourceLabel: (s) => FEED_SOURCES.find((x) => x.id === s.source)?.label ?? '',
  },
  actions: {
    async init() {
      if (this.initialized) return
      this.initialized = true
      // Watchlist can render immediately, before any network.
      if (this.source === 'watchlist') this.rebuild()
      try {
        await Promise.all([this.loadExchangeInfo(), this.refreshTickers()])
        if (this.baseList.length === 0 || this.source === 'watchlist') this.rebuild()
      } finally {
        this.ready = true
        this.startPolling()
      }
    },

    /** Cached (24 h) exchangeInfo, else network. Concurrent calls share one request. */
    loadExchangeInfo(): Promise<void> {
      exchangeInfoLoading ??= (async () => {
        const cached = await readExchangeInfo()
        if (cached) {
          this.exchangeInfo = markRaw(cached)
          return
        }
        try {
          const info = await fetchExchangeInfo()
          this.exchangeInfo = markRaw(info)
          void writeExchangeInfo(info)
        } catch (err) {
          this.error = describeError(err)
        }
      })().finally(() => {
        exchangeInfoLoading = null
      })
      return exchangeInfoLoading
    },

    async refreshTickers() {
      try {
        const list = await fetchTickers24h()
        const map: Record<string, Ticker24h> = {}
        for (const t of list) map[t.symbol] = t
        this.tickers = markRaw(map)
        this.tickersAt = Date.now()
        this.error = null
        // exchangeInfo failed earlier (network/429) — retry piggy-backed on the ticker poll.
        if (!this.exchangeInfo && this.initialized) void this.loadExchangeInfo()
      } catch (err) {
        this.error = describeError(err)
      }
    },

    startPolling() {
      if (pollTimer || typeof window === 'undefined') return
      pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') void this.refreshTickers()
      }, TICKERS_POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && Date.now() - this.tickersAt > TICKERS_POLL_MS) {
          void this.refreshTickers()
        }
      })
    },

    /** Recompute the snapshot list for the current source. */
    rebuild() {
      const wl = useWatchlistsStore()
      this.baseList = symbolsForSource(this.source, {
        tickers: Object.values(this.tickers),
        exchangeInfo: this.exchangeInfo,
        watchlist: wl.watchlist,
        favorites: wl.favorites,
        // Hidden symbols are filtered live in the `symbols` getter.
      })
    },

    /** Jump to a ticker (levels list). If the current source lacks it, it is put in front of the feed. */
    focusSymbol(symbol: string) {
      if (!this.symbols.includes(symbol)) this.focused = [symbol]
      this.setIndex(this.symbols.indexOf(symbol))
    },

    async setSource(id: FeedSourceId) {
      this.focused = []
      this.source = id
      saveJson(SOURCE_KEY, id)
      this.index = 0
      // Movers/top-50 need fresh tickers; reuse them if recent.
      if ((id === 'top50' || id === 'movers') && Date.now() - this.tickersAt > TICKERS_POLL_MS) await this.refreshTickers()
      this.rebuild()
    },

    setIndex(i: number) {
      this.index = clampIndex(i, this.symbols.length)
    },

    /** Real tickSize from exchangeInfo, else a precision derived from the last price (low-priced coins). */
    tickSize(symbol: string): number {
      return this.exchangeInfo?.[symbol]?.tickSize ?? fallbackTickSize(this.tickers[symbol]?.lastPrice)
    },
  },
})
