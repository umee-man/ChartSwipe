// Watchlist / favorites / hidden symbols. localStorage for now; server sync (/v1/watchlists) comes in days 7–8.
import { defineStore } from 'pinia'
import { DEFAULT_WATCHLIST } from '~/lib/feed/sources'
import { addSymbol, removeSymbol, sanitizeSymbols, toggleSymbol } from '~/lib/lists/symbols'
import { loadJson, saveJson } from '~/lib/storage'

const KEY = 'cs:watchlists'

interface Persisted {
  watchlist: string[]
  favorites: string[]
  hidden: string[]
}

export const useWatchlistsStore = defineStore('watchlists', {
  state: () => {
    const p = loadJson<Partial<Persisted>>(KEY, {})
    const watchlist = sanitizeSymbols(p.watchlist)
    return {
      watchlist: watchlist.length ? watchlist : [...DEFAULT_WATCHLIST],
      favorites: sanitizeSymbols(p.favorites),
      hidden: sanitizeSymbols(p.hidden),
    }
  },
  getters: {
    hiddenSet: (s): Set<string> => new Set(s.hidden),
    isFavorite: (s) => (symbol: string) => s.favorites.includes(symbol),
  },
  actions: {
    toggleFavorite(symbol: string) {
      this.favorites = toggleSymbol(this.favorites, symbol)
      this.persist()
    },
    hide(symbol: string) {
      this.hidden = addSymbol(this.hidden, symbol)
      this.persist()
    },
    /** Bring one hidden ticker back into every feed source. */
    unhide(symbol: string) {
      this.hidden = removeSymbol(this.hidden, symbol)
      this.persist()
    },
    /** «Вернуть все». */
    unhideAll() {
      this.hidden = []
      this.persist()
    },
    persist() {
      saveJson(KEY, { watchlist: this.watchlist, favorites: this.favorites, hidden: this.hidden } satisfies Persisted)
    },
  },
})
