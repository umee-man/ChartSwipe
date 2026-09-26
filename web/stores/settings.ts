// Settings store (Pinia + localStorage): TF buttons, active TF, volume toggle (arch §5.2, F3, ADR A15).
import { defineStore } from 'pinia'
import type { Interval } from '~/lib/binance/types'
import { DEFAULT_TF_BUTTONS, isInterval, migrateTfButtons } from '~/lib/feed/tf'
import { MAGNET_RADIUS_TOUCH_PX } from '~/lib/levels/magnet'
import { loadJson, saveJson } from '~/lib/storage'

const KEY = 'cs:settings'

export { DEFAULT_TF_BUTTONS }

interface SettingsState {
  /** The TF buttons in TfBar (4 since A15: 5м · 1ч · Д · Н), configurable. */
  tfButtons: Interval[]
  /** Active TF; persists across tickers and sessions. */
  activeTf: Interval
  showVolume: boolean
  /** Magnet vertical radius for touch, px (A17; mouse always uses 12 px). */
  magnetRadius: number
}

/** Clamp a persisted magnet radius to a sane range; default 24 px. */
export function sanitizeMagnetRadius(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(48, Math.max(8, Math.round(v))) : MAGNET_RADIUS_TOUCH_PX
}

function sanitize(raw: { tfButtons?: unknown; activeTf?: unknown; showVolume?: unknown; magnetRadius?: unknown }): SettingsState {
  // Old persisted 3-button configs are migrated here (1w appended).
  const buttons = migrateTfButtons(raw.tfButtons)
  const activeTf = isInterval(raw.activeTf) && buttons.includes(raw.activeTf) ? raw.activeTf : buttons[0]!
  return {
    tfButtons: buttons,
    activeTf,
    showVolume: typeof raw.showVolume === 'boolean' ? raw.showVolume : true,
    magnetRadius: sanitizeMagnetRadius(raw.magnetRadius),
  }
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
      const next = sanitize({ ...this.$state, tfButtons: buttons })
      this.tfButtons = next.tfButtons
      this.activeTf = next.activeTf
      this.persist()
    },
    setMagnetRadius(px: number) {
      this.magnetRadius = sanitizeMagnetRadius(px)
      this.persist()
    },
    toggleVolume() {
      this.showVolume = !this.showVolume
      this.persist()
    },
    persist() {
      saveJson(KEY, {
        tfButtons: this.tfButtons,
        activeTf: this.activeTf,
        showVolume: this.showVolume,
        magnetRadius: this.magnetRadius,
      })
    },
  },
})
