import { closedCandles } from './detect'
import type { AutoLevel, Candle, ClosedSpec } from './types'

const DAY = 86400
const WEEK = 7 * DAY
/** 1970-01-01 was a Thursday; Monday 1970-01-05 00:00 UTC anchors ISO weeks. */
const MONDAY_ANCHOR = 4 * DAY

/** Start (unix sec, UTC) of the ISO week (Mon 00:00) containing `t`. */
export function weekStart(t: number): number {
  return Math.floor((t - MONDAY_ANCHOR) / WEEK) * WEEK + MONDAY_ANCHOR
}

export interface AutoLevelsAtOptions {
  /** Also produce PWH/PWL from the previous full UTC week. Default false. */
  weekly?: boolean
  /**
   * Any moment (unix sec) inside the "current" day used to pick the previous ISO week.
   * Default: candles[index].time if that candle exists, otherwise candles[index-1].time + 1 day.
   */
  todaySec?: number
}

export type AutoLevelOptions = ClosedSpec & {
  /** Also produce PWH/PWL from the previous full UTC week. Default false. */
  weekly?: boolean
}

/**
 * Auto levels as they stood at the OPEN of daily candle `index` (0 < index <= length),
 * computed only from CLOSED daily candles before `index`:
 * - PDH/PDL = high/low of candle index-1; activeFrom = candles[index-1].time + 1 day.
 * - PWH/PWL (optional) = max high / min low of candles (< index) inside the ISO week
 *   (Mon-Sun, UTC) preceding the week of the current day; activeFrom = weekStart(current day).
 *   Omitted when no candle falls into that week.
 * `index = length` gives today's levels (the day after the last closed candle).
 * `index = length - 1` gives the levels that were in force on the last closed day — use this
 * to detect breaks ON a closed day (A4 "ЛП сегодня", see autoLevels docs).
 * Level ids equal the kind names ('PDH', 'PDL', 'PWH', 'PWL').
 */
export function autoLevelsAt(
  closedDaily: readonly Candle[],
  index: number,
  options: AutoLevelsAtOptions = {},
): AutoLevel[] {
  if (!Number.isInteger(index) || index > closedDaily.length) throw new RangeError(`index ${index} out of range`)
  const prev = index >= 1 ? closedDaily[index - 1] : undefined
  if (!prev) return []
  const dayFrom = prev.time + DAY
  const out: AutoLevel[] = [
    { id: 'PDH', kind: 'PDH', price: prev.high, activeFrom: dayFrom },
    { id: 'PDL', kind: 'PDL', price: prev.low, activeFrom: dayFrom },
  ]
  if (options.weekly) {
    const today = options.todaySec ?? closedDaily[index]?.time ?? dayFrom
    const weekFrom = weekStart(today)
    const from = weekFrom - WEEK
    let hi = -Infinity
    let lo = Infinity
    for (let k = 0; k < index; k++) {
      const c = closedDaily[k]!
      if (c.time >= from && c.time < weekFrom) {
        if (c.high > hi) hi = c.high
        if (c.low < lo) lo = c.low
      }
    }
    if (hi !== -Infinity) {
      out.push(
        { id: 'PWH', kind: 'PWH', price: hi, activeFrom: weekFrom },
        { id: 'PWL', kind: 'PWL', price: lo, activeFrom: weekFrom },
      )
    }
  }
  return out
}

/**
 * Today's auto levels from DAILY candles (sorted ascending, `time` = day open, UTC).
 * Unclosed candles are dropped first (closure spec is required), then
 * `autoLevelsAt(closed, closed.length)`. The current day is the day containing `nowSec`
 * if given, otherwise the day after the last closed candle.
 *
 * NOTE for A4 ("ЛП сегодня"): today's PDH/PDL only become active on the still-forming candle,
 * which rule 5 excludes, so detecting with them always yields nothing. To find a false break
 * on the LAST CLOSED day use:
 *   const closed = closedCandles(daily, '1d', { nowSec })
 *   const levels = autoLevelsAt(closed, closed.length - 1)
 *   detectFalseBreakouts(closed, levels, { tf: '1d', lastClosed: true })
 */
export function autoLevels(daily: readonly Candle[], options: AutoLevelOptions): AutoLevel[] {
  const closed = closedCandles(daily, '1d', options)
  return autoLevelsAt(closed, closed.length, { weekly: options.weekly, todaySec: options.nowSec })
}
