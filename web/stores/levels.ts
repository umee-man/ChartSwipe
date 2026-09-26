// Levels store. For days 1–3 only the selected level type (right action column) exists;
// level CRUD, magnet and sync arrive in days 4–6 (arch §5.4–5.5).
import { defineStore } from 'pinia'
import { loadJson, saveJson } from '~/lib/storage'

export type LevelKind = 'support' | 'resistance' | 'zone'

export const LEVEL_KINDS: { kind: LevelKind; label: string; color: string }[] = [
  { kind: 'support', label: 'Поддержка', color: '#2E7D32' },
  { kind: 'resistance', label: 'Сопротивление', color: '#C62828' },
  { kind: 'zone', label: 'Зона', color: '#1565C0' },
]

const KEY = 'cs:levels:selectedKind'

function isKind(v: unknown): v is LevelKind {
  return v === 'support' || v === 'resistance' || v === 'zone'
}

export const useLevelsStore = defineStore('levels', {
  state: () => {
    const saved = loadJson<unknown>(KEY, 'support')
    return { selectedKind: (isKind(saved) ? saved : 'support') as LevelKind }
  },
  actions: {
    setKind(kind: LevelKind) {
      this.selectedKind = kind
      saveJson(KEY, kind)
    },
    cycleKind() {
      const i = LEVEL_KINDS.findIndex((k) => k.kind === this.selectedKind)
      this.setKind(LEVEL_KINDS[(i + 1) % LEVEL_KINDS.length]!.kind)
    },
  },
})
