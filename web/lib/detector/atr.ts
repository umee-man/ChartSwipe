import type { Candle } from './types'

/** True range of candle `i` (first candle: high - low). */
export function trueRange(candles: readonly Candle[], i: number): number {
  const c = candles[i]
  if (!c) throw new RangeError(`candle index ${i} out of range`)
  const prev = i > 0 ? candles[i - 1] : undefined
  if (!prev) return c.high - c.low
  return Math.max(
    c.high - c.low,
    Math.abs(c.high - prev.close),
    Math.abs(c.low - prev.close),
  )
}

/**
 * Wilder ATR. Result has the same length as `candles`:
 * - indices < period-1 are null (not enough data);
 * - index period-1 is the simple mean of TR[0..period-1];
 * - after that: ATR[i] = (ATR[i-1] * (period-1) + TR[i]) / period.
 */
export function wilderAtr(candles: readonly Candle[], period = 14): (number | null)[] {
  if (!Number.isInteger(period) || period < 1) throw new RangeError('period must be a positive integer')
  const out: (number | null)[] = new Array(candles.length).fill(null)
  if (candles.length < period) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += trueRange(candles, i)
  let atr = sum / period
  out[period - 1] = atr
  for (let i = period; i < candles.length; i++) {
    atr = (atr * (period - 1) + trueRange(candles, i)) / period
    out[i] = atr
  }
  return out
}
