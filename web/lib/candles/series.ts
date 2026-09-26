// Pure candle → lightweight-charts data mapping. The series gets exactly one point per stored candle, in
// store order, so the chart's logical index i IS store index i (also after history prepends: setData is
// always called with the full merged array). The magnet relies on this (ADR A17).
import type { Candle } from '../binance/types'

export const UP_VOL = 'rgba(38,166,154,0.45)'
export const DOWN_VOL = 'rgba(239,83,80,0.45)'

export interface OhlcPoint {
  time: number
  open: number
  high: number
  low: number
  close: number
}

export interface VolumePoint {
  time: number
  value: number
  color: string
}

export const toOhlc = (c: Candle): OhlcPoint => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })

export const toVolume = (c: Candle): VolumePoint => ({
  time: c.time,
  value: c.volume,
  color: c.close >= c.open ? UP_VOL : DOWN_VOL,
})

/** Store index of the bar at a logical index, or null outside the data. */
export function candleAtLogical(candles: readonly Candle[], logical: number): Candle | null {
  const i = Math.round(logical)
  return i >= 0 && i < candles.length ? candles[i]! : null
}
