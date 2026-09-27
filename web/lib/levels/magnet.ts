// Magnet (arch §5.4, ADR A17): snap a level to the nearest candle wick around the finger.
//  - Horizontal window in PIXELS (±32 px of the finger, at least ±3 bars): on zoomed-out Д/Н a bar is
//    1–3 px wide, so a fixed ±3-bar window was narrower than a fingertip.
//  - Vertical radius 24 px for touch (finger error), 16 px for mouse (A21); touch configurable (settings.magnetRadius).
//  - Wicks first: highs and lows; open/close only if no wick is within the radius. On equal distance
//    the more extreme wick wins (highest high / lowest low).
import type { Candle } from '../binance/types'
import { roundToTick } from './model'

export const MAGNET_WINDOW_PX = 32
export const MAGNET_MIN_BARS = 3
export const MAGNET_RADIUS_TOUCH_PX = 24
/** Mouse (A21): 16 px — a hovering cursor is less precise than it looks on a dense chart. */
export const MAGNET_RADIUS_MOUSE_PX = 16
/** Distances closer than this are treated as equal (then the more extreme wick wins). */
const TIE_PX = 0.5

export function magnetRadiusFor(pointerType: string, touchRadius = MAGNET_RADIUS_TOUCH_PX): number {
  return pointerType === 'mouse' ? MAGNET_RADIUS_MOUSE_PX : touchRadius
}

/**
 * Bar-index window [from, to] around the finger: every bar within ±windowPx, never fewer than ±minBars,
 * clamped to the data. `logical` is the (fractional) logical index under the finger; `barSpacing` px/bar.
 * Null when the window does not touch the data at all.
 */
export function barWindow(
  logical: number,
  barSpacing: number,
  count: number,
  windowPx = MAGNET_WINDOW_PX,
  minBars = MAGNET_MIN_BARS,
): { from: number; to: number } | null {
  if (!Number.isFinite(logical) || count <= 0) return null
  const half = Math.max(minBars, barSpacing > 0 ? Math.ceil(windowPx / barSpacing) : minBars)
  const center = Math.round(logical)
  const from = Math.max(0, center - half)
  const to = Math.min(count - 1, center + half)
  return from > to ? null : { from, to }
}

export type SnapKind = 'high' | 'low' | 'open' | 'close'

export interface MagnetInput {
  candles: readonly Candle[]
  /** Logical (= data) index under the finger; may be fractional or out of range. */
  logical: number
  /** Current bar spacing, px per bar. */
  barSpacing: number
  /** Target y, px in the pane (finger, or the dragged line). */
  y: number
  priceToY: (price: number) => number | null
  yToPrice: (y: number) => number | null
  tickSize: number
  radiusPx?: number
  windowPx?: number
  minBars?: number
}

export interface MagnetResult {
  price: number
  snapped: boolean
  /** Which OHLC value was snapped to, and on which bar (for the feedback marker). */
  kind?: SnapKind
  barIndex?: number
}

interface Candidate {
  price: number
  kind: SnapKind
  barIndex: number
  dist: number
}

/** Extremeness for tie-breaks: higher highs and lower lows are "more extreme". */
function extremeness(c: Candidate): number {
  return c.kind === 'high' ? c.price : c.kind === 'low' ? -c.price : 0
}

function better(a: Candidate, b: Candidate | null): boolean {
  if (!b) return true
  if (a.dist < b.dist - TIE_PX) return true
  if (a.dist > b.dist + TIE_PX) return false
  return a.kind === b.kind && extremeness(a) > extremeness(b)
}

export function magnetPrice(p: MagnetInput): MagnetResult | null {
  const radius = p.radiusPx ?? MAGNET_RADIUS_TOUCH_PX
  const win = barWindow(p.logical, p.barSpacing, p.candles.length, p.windowPx, p.minBars)
  if (win) {
    let wick: Candidate | null = null
    let body: Candidate | null = null
    for (let i = win.from; i <= win.to; i++) {
      const c = p.candles[i]!
      const cands: [number, SnapKind][] = [
        [c.high, 'high'],
        [c.low, 'low'],
        [c.open, 'open'],
        [c.close, 'close'],
      ]
      for (const [price, kind] of cands) {
        const cy = p.priceToY(price)
        if (cy == null) continue
        const dist = Math.abs(cy - p.y)
        if (dist > radius) continue
        const cand: Candidate = { price, kind, barIndex: i, dist }
        if (kind === 'high' || kind === 'low') {
          if (better(cand, wick)) wick = cand
        } else if (better(cand, body)) {
          body = cand
        }
      }
    }
    const best = wick ?? body // wicks first; open/close only as a fallback
    if (best) return { price: roundToTick(best.price, p.tickSize), snapped: true, kind: best.kind, barIndex: best.barIndex }
  }
  const raw = p.yToPrice(p.y)
  if (raw == null || !(raw > 0)) return null
  return { price: roundToTick(raw, p.tickSize), snapped: false }
}
