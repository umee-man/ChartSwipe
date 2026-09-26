// Settings store (Pinia + localStorage): TF buttons, active TF, volume toggle (arch §5.2, F3).
import { defineStore } from 'pinia'
import { INTERVALS, type Interval } from '~/lib/binance/types'
import { loadJson, saveJson } from '~/lib/storage'

const KEY = 'cs:settings'

export const DEFAULT_TF_BUTTONS: [Interval, Interval, Interval] = ['5m', '1h', '1d']

interface SettingsState {
  /** The three TF buttons in TfBar, configurable. */
  tfButtons: [Interval, Interval, Interval]
  /** Active TF; persists across tickers and sessions. */
  activeTf: Interval
  showVolume: boolean
}

function isInterval(v: unknown): v is Interval {
  return typeof v === 'string' && (INTERVALS as readonly string[]).includes(v)
}

function sanitize(raw: Partial<SettingsState>): SettingsState {
  const buttons =
    Array.isArray(raw.tfButtons) && raw.tfButtons.length === 3 && raw.tfButtons.every(isInterval)
      ? (raw.tfButtons as SettingsState['tfButtons'])
      : DEFAULT_TF_BUTTONS
  const activeTf = isInterval(raw.activeTf) && buttons.includes(raw.activeTf) ? raw.activeTf : buttons[0]
  return { tfButtons: [...buttons], activeTf, showVolume: raw.showVolume ?? true }
}

export const useSettingsStore = defineStore('settings', {
  state: (): SettingsState => sanitize(loadJson<Partial<SettingsState>>(KEY, {})),
  actions: {
    setActiveTf(tf: Interval) {
      if (!this.tfButtons.includes(tf)) return
      this.activeTf = tf
      this.persist()
    },
    setTfButtons(buttons: [Interval, Interval, Interval]) {
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
