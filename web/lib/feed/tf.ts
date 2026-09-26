// Timeframe buttons (F3, ADR A15): defaults, labels, persisted-config migration, zoom policy.
import { INTERVALS, type Interval } from '../binance/types'

/** Default TF bar (A15): 5м · 1ч · Д · Н. */
export const DEFAULT_TF_BUTTONS: readonly Interval[] = ['5m', '1h', '1d', '1w']
export const TF_BUTTON_COUNT = DEFAULT_TF_BUTTONS.length

export const TF_LABELS: Partial<Record<Interval, string>> = {
  '1m': '1м', '3m': '3м', '5m': '5м', '15m': '15м', '30m': '30м',
  '1h': '1ч', '2h': '2ч', '4h': '4ч', '6h': '6ч', '8h': '8ч', '12h': '12ч',
  '1d': 'Д', '3d': '3Д', '1w': 'Н', '1M': 'М',
}

export function tfLabel(tf: string): string {
  return TF_LABELS[tf as Interval] ?? tf
}

export function isInterval(v: unknown): v is Interval {
  return typeof v === 'string' && (INTERVALS as readonly string[]).includes(v)
}

/**
 * Normalise a persisted TF-button config to exactly TF_BUTTON_COUNT unique intervals.
 * Old 3-button configs (days 1–3) get '1w' appended; gaps are filled from the defaults.
 */
export function migrateTfButtons(raw: unknown): Interval[] {
  const out: Interval[] = []
  if (Array.isArray(raw)) for (const v of raw) if (isInterval(v) && !out.includes(v)) out.push(v)
  if (out.length === 0) return [...DEFAULT_TF_BUTTONS]
  if (out.length < TF_BUTTON_COUNT && !out.includes('1w')) out.push('1w')
  for (const d of DEFAULT_TF_BUTTONS) if (out.length < TF_BUTTON_COUNT && !out.includes(d)) out.push(d)
  return out.slice(0, TF_BUTTON_COUNT)
}

/** Д and Н open fully zoomed out (all loaded candles fit the width, price auto-fits) — A15. */
export function opensZoomedOut(tf: string): boolean {
  return tf === '1d' || tf === '1w'
}
