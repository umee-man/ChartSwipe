// Levels store (F4, arch §5.3–5.5; ADR A16: one level type — a plain horizontal line; local-first A10).
// Levels live in IndexedDB (lib/cache/levels.ts) in the /v1/levels shape; a later sync uploads them as-is.
// Pure rules live in lib/levels/*.
import { defineStore } from 'pinia'
import { readAllLevels, saveLevel } from '~/lib/cache/levels'
import {
  createLevel,
  LevelValidationError,
  levelsForSymbol,
  moveLevel,
  restoreLevel,
  setNote,
  softDelete,
  upsertLevel,
  type Level,
} from '~/lib/levels/model'
import { loadJson, saveJson } from '~/lib/storage'

const HINT_KEY = 'cs:hint:longpress'

/** Live drag of a plaque (UI only; committed to storage on release). */
export interface LevelDrag {
  id: string
  intent: 'move' | 'swipe' | null
  /** Horizontal offset of the plaque during a swipe-to-delete, px. */
  dx: number
  /** Level before the drag started (to cancel / to know whether anything changed). */
  original: Level
}

export const useLevelsStore = defineStore('levels', {
  state: () => ({
    /** All levels incl. soft-deleted (kept so a later sync can propagate deletions). */
    all: [] as Level[],
    loaded: false,
    drag: null as LevelDrag | null,
    editingId: null as string | null,
    lastDeleted: null as Level | null,
    /** First-run hint «Удерживайте палец…» already dismissed. */
    hintSeen: loadJson<boolean>(HINT_KEY, false),
  }),
  getters: {
    forSymbol: (s) => (symbol: string) => levelsForSymbol(s.all, symbol),
    alive: (s) => s.all.filter((l) => l.deleted_at === null),
    byId: (s) => (id: string) => s.all.find((l) => l.id === id),
  },
  actions: {
    async init() {
      if (this.loaded) return
      const stored = await readAllLevels()
      // Keep anything created before storage answered.
      let all = stored
      for (const l of this.all) all = upsertLevel(all, l)
      this.all = all
      this.loaded = true
    },

    dismissHint() {
      if (this.hintSeen) return
      this.hintSeen = true
      saveJson(HINT_KEY, true)
    },

    persist(l: Level) {
      this.all = upsertLevel(this.all, l)
      void saveLevel(l)
    },

    /** Long press (arch §5.3 item 2): new level at the magnet price. */
    add(symbol: string, price: number, tf: string): Level | null {
      try {
        const l = createLevel({ symbol, price, tf })
        this.persist(l)
        this.dismissHint()
        return l
      } catch (e) {
        if (e instanceof LevelValidationError) return null
        throw e
      }
    },

    // ----- plaque drag (move / swipe to delete), arch §5.3 item 1 -----

    startDrag(id: string) {
      const l = this.byId(id)
      if (l) this.drag = { id, intent: null, dx: 0, original: l }
    },
    /** Live move (memory only, persisted on release). */
    dragTo(price: number) {
      const d = this.drag
      const l = d && this.byId(d.id)
      if (!d || !l) return
      try {
        this.all = upsertLevel(this.all, moveLevel(l, price))
      } catch (e) {
        if (!(e instanceof LevelValidationError)) throw e
      }
    },
    endDrag(commit: boolean) {
      const d = this.drag
      this.drag = null
      if (!d) return
      const cur = this.byId(d.id)
      if (!cur) return
      if (commit && cur.price !== d.original.price) this.persist(cur)
      else this.all = upsertLevel(this.all, d.original)
    },

    // ----- edit / delete -----

    remove(id: string) {
      const l = this.byId(id)
      if (!l || l.deleted_at) return
      if (this.editingId === id) this.editingId = null
      this.persist(softDelete(l))
      this.lastDeleted = l
    },
    undoDelete() {
      const l = this.lastDeleted
      this.lastDeleted = null
      const cur = l && this.byId(l.id)
      if (cur) this.persist(restoreLevel(cur))
    },
    clearUndo() {
      this.lastDeleted = null
    },
    setNote(id: string, note: string) {
      const l = this.byId(id)
      if (l) this.persist(setNote(l, note))
    },
  },
})
