// Settings store (Pinia + localStorage): TF buttons, active TF, volume toggle (arch §5.2, F3, ADR A15).
import { defineStore } from 'pinia'
import type { Interval } from '~/lib/binance/types'
import { DEFAULT_TF_BUTTONS, isInterval, migrateTfButtons } from '~/lib/feed/tf'
import { loadJson, saveJson } from '~/lib/storage'

const KEY = 'cs:settings'

export { DEFAULT_TF_BUTTONS }

interface SettingsState {
  /** The TF buttons in TfBar (4 since A15: 5м · 1ч · Д · Н), configurable. */
  tfButtons: Interval[]
  /** Active TF; persists across tickers and sessions. */
  activeTf: Interval
  showVolume: boolean
}

function sanitize(raw: { tfButtons?: unknown; activeTf?: unknown; showVolume?: unknown }): SettingsState {
  // Old persisted 3-button configs are migrated here (1w appended).
  const buttons = migrateTfButtons(raw.tfButtons)
  const activeTf = isInterval(raw.activeTf) && buttons.includes(raw.activeTf) ? raw.activeTf : buttons[0]!
  return { tfButtons: buttons, activeTf, showVolume: typeof raw.showVolume === 'boolean' ? raw.showVolume : true }
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => sanitize(loadJson<Record<string, unknown>>(KEY, {})),
  actions: {
    setActiveTf(tf: Interval) {
      if (!this.tfButtons.includes(tf)) return
      this.activeTf = tf
      this.persist()
    },
    setTfButtons(buttons: Interval[]) {
      const next = sanitize({ tfButtons: buttons, activeTf: this.activeTf, showVolume: this.showVolume })
      this.tfButtons = next.tfButtons
      this.activeTf = next.activeTf
      this.persist()
    },
    toggleVolume() {
      this.showVolume = !this.showVolume
      this.persist()
    },
    persist() {
      saveJson(KEY, { tfButtons: this.tfButtons, activeTf: this.activeTf, showVolume: this.showVolume })
    },
  },
})
