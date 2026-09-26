// Magnet (arch §5.4): snap a long-press point to the nearest OHLC price of the bars around it.
import type { Candle } from '../binance/types'
import { roundToTick } from './model'

export const MAGNET_RADIUS_PX = 12
export const MAGNET_WINDOW_BARS = 3

export interface MagnetInput {
  candles: readonly Candle[]
  /** Bar index under the finger (data index; may be fractional or out of range). */
  barIndex: number
  /** Finger y, px in the pane. */
  y: number
  priceToY: (price: number) => number | null
  yToPrice: (y: number) => number | null
  tickSize: number
  radiusPx?: number
  windowBars?: number
}

export interface MagnetResult {
  price: number
  snapped: boolean
}

/**
 * Candidates = high/low/open/close of bars in [i-3, i+3]; convert to px via priceToY; take the nearest
 * one if within radius, otherwise the raw price at y. Result is rounded to tickSize. Null if the chart
 * cannot map y to a price (empty series).
 */
export function magnetPrice(p: MagnetInput): MagnetResult | null {
  const radius = p.radiusPx ?? MAGNET_RADIUS_PX
  const w = p.windowBars ?? MAGNET_WINDOW_BARS
  const center = Math.round(p.barIndex)
  let best: { price: number; dist: number } | null = null
  for (let i = center - w; i <= center + w; i++) {
    const c = p.candles[i]
    if (!c) continue
    for (const price of [c.high, c.low, c.open, c.close]) {
      const cy = p.priceToY(price)
      if (cy == null) continue
      const dist = Math.abs(cy - p.y)
      if (dist <= radius && (!best || dist < best.dist)) best = { price, dist }
    }
  }
  if (best) return { price: roundToTick(best.price, p.tickSize), snapped: true }
  const raw = p.yToPrice(p.y)
  if (raw == null || !(raw > 0)) return null
  return { price: roundToTick(raw, p.tickSize), snapped: false }
}
