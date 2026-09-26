// Watchlist / favorites / hidden symbols. localStorage for now; server sync (/v1/watchlists) comes in days 7–8.
import { defineStore } from 'pinia'
import { DEFAULT_WATCHLIST } from '~/lib/feed/sources'
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
    return {
      watchlist: Array.isArray(p.watchlist) && p.watchlist.length ? p.watchlist : [...DEFAULT_WATCHLIST],
      favorites: Array.isArray(p.favorites) ? p.favorites : [],
      hidden: Array.isArray(p.hidden) ? p.hidden : [],
    }
  },
  getters: {
    hiddenSet: (s): Set<string> => new Set(s.hidden),
    isFavorite: (s) => (symbol: string) => s.favorites.includes(symbol),
  },
  actions: {
    toggleFavorite(symbol: string) {
      const i = this.favorites.indexOf(symbol)
      if (i === -1) this.favorites.push(symbol)
      else this.favorites.splice(i, 1)
      this.persist()
    },
    hide(symbol: string) {
      if (!this.hidden.includes(symbol)) this.hidden.push(symbol)
      this.persist()
    },
    unhide(symbol: string) {
      this.hidden = this.hidden.filter((s) => s !== symbol)
      this.persist()
    },
    persist() {
      saveJson(KEY, { watchlist: this.watchlist, favorites: this.favorites, hidden: this.hidden } satisfies Persisted)
    },
  },
})
