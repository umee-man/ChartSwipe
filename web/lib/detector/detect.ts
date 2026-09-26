import { wilderAtr } from './atr'
import type {
  BreakDirection,
  BreakEvent,
  Candle,
  ClosedSpec,
  DetectOptions,
  DetectorLevel,
  DetectorParams,
  DetectorTf,
  LevelResult,
} from './types'

/** Per-TF defaults from architecture §5.6. 1d uses pct only (k = 0). */
export const DEFAULT_PARAMS: Readonly<Record<DetectorTf, Readonly<Required<DetectorParams>>>> = Object.freeze({
  '5m': Object.freeze({ pct: 0.001, k: 0.3, n: 6, atrPeriod: 14 }),
  '1h': Object.freeze({ pct: 0.0015, k: 0.3, n: 3, atrPeriod: 14 }),
  '1d': Object.freeze({ pct: 0.003, k: 0, n: 1, atrPeriod: 14 }),
})

export const TF_SECONDS: Readonly<Record<DetectorTf, number>> = Object.freeze({
  '5m': 300,
  '1h': 3600,
  '1d': 86400,
})

/** Merge per-TF defaults with overrides. For 1d the ATR component is always off. */
export function resolveParams(tf: DetectorTf, overrides?: Partial<DetectorParams>): Required<DetectorParams> {
  const base = DEFAULT_PARAMS[tf]
  if (!base) throw new RangeError(`unsupported timeframe: ${String(tf)}`)
  const merged: Required<DetectorParams> = {
    pct: overrides?.pct ?? base.pct,
    k: overrides?.k ?? base.k,
    n: overrides?.n ?? base.n,
    atrPeriod: overrides?.atrPeriod ?? base.atrPeriod,
  }
  if (tf === '1d') merged.k = 0
  if (!(merged.pct >= 0) || !(merged.k >= 0)) throw new RangeError('pct and k must be >= 0')
  if (!Number.isInteger(merged.n) || merged.n < 1) throw new RangeError('n must be an integer >= 1')
  return merged
}

/**
 * Drop trailing unclosed candles (architecture §5.6 rule 5).
 * Candles must be sorted by time ascending. `spec` is required (see ClosedSpec);
 * a runtime check also guards untyped (JS) callers.
 */
export function closedCandles(candles: readonly Candle[], tf: DetectorTf, spec: ClosedSpec): Candle[] {
  const nowSec = spec?.nowSec
  const lastClosed = spec?.lastClosed
  if (nowSec === undefined && typeof lastClosed !== 'boolean') {
    throw new TypeError('closed-candle spec required: pass { nowSec } or { lastClosed }')
  }
  let end = candles.length
  if (nowSec !== undefined) {
    const span = TF_SECONDS[tf]
    while (end > 0 && candles[end - 1]!.time + span > nowSec) end--
  } else if (lastClosed === false && end > 0) {
    end--
  }
  return candles.slice(0, end)
}

/**
 * Breakout threshold X for candle `i`: max(level * pct, k * ATR).
 * ATR is taken as of the previous candle (i-1) so the break candle's own range
 * does not inflate its threshold. While ATR is undefined (fewer than atrPeriod
 * candles before `i`) only the pct component is used.
 */
export function thresholdAt(
  level: number,
  i: number,
  atr: readonly (number | null)[],
  p: Required<DetectorParams>,
): number {
  const pctX = level * p.pct
  if (p.k <= 0 || i < 1) return pctX
  const a = atr[i - 1]
  return a == null ? pctX : Math.max(pctX, p.k * a)
}

/**
 * Run the detector for one level over CLOSED candles.
 *
 * Scan (candle i, threshold X = thresholdAt(i), ref = previous close, or open[i] for i = 0):
 * - candles with `time < level.activeFrom` are skipped as break candidates;
 * - up-break:   `ref <= level + X && high[i] > level + X`;
 * - down-break: `ref >= level - X && low[i]  < level - X`.
 *   The ref condition means the threshold must actually be CROSSED during candle i: a level
 *   far below/above price (ref beyond the threshold on every candle) yields no events, while a
 *   close just past the level but inside X does not block a break.
 * - both qualify (outside candle, ref inside the ±X band): the dominant move wins -> the direction
 *   with the larger penetration beyond its threshold (`high - (level + X)` vs `(level - X) - low`);
 *   on an exact tie, 'up' if `ref >= level`, otherwise 'down'.
 * Resolution over j = i..i+N-1: the first close back beyond the level (close < level for up,
 * close > level for down; a close exactly at the level is NOT a return) gives 'false' at j;
 * all N closed without a return gives 'true'; running out of candles gives 'pending'
 * (and scanning stops). The next break search starts after the resolution candle
 * (j for false, i+N-1 for true).
 */
export function detectLevel(
  candles: readonly Candle[],
  level: DetectorLevel,
  params: Required<DetectorParams>,
  atr: readonly (number | null)[] = params.k > 0 ? wilderAtr(candles, params.atrPeriod) : [],
): LevelResult {
  const price = level.price
  const activeFrom = level.activeFrom
  const events: BreakEvent[] = []
  let i = 0
  while (i < candles.length) {
    const c = candles[i]!
    if (activeFrom !== undefined && c.time < activeFrom) {
      i++
      continue
    }
    const x = thresholdAt(price, i, atr, params)
    // Reference price "before" candle i: previous close (or own open for the first candle).
    const ref = i > 0 ? candles[i - 1]!.close : c.open
    const upBy = c.high - (price + x) // penetration beyond the upper threshold
    const downBy = price - x - c.low // penetration beyond the lower threshold
    const up = ref <= price + x && upBy > 0
    const down = ref >= price - x && downBy > 0
    let direction: BreakDirection | null = null
    if (up && down) direction = upBy > downBy ? 'up' : downBy > upBy ? 'down' : ref >= price ? 'up' : 'down'
    else if (up) direction = 'up'
    else if (down) direction = 'down'
    if (!direction) {
      i++
      continue
    }
    let event: BreakEvent | null = null
    let resolvedAt = -1
    for (let m = 0; m < params.n; m++) {
      const j = i + m
      const cj = candles[j]
      if (!cj) break
      const returned = direction === 'up' ? cj.close < price : cj.close > price
      if (returned) {
        event = { direction, breakIndex: i, returnIndex: j, status: 'false', breakTime: c.time, returnTime: cj.time }
        resolvedAt = j
        break
      }
    }
    if (!event) {
      const last = i + params.n - 1
      if (last < candles.length) {
        event = { direction, breakIndex: i, returnIndex: null, status: 'true', breakTime: c.time, returnTime: null }
        resolvedAt = last
      } else {
        event = { direction, breakIndex: i, returnIndex: null, status: 'pending', breakTime: c.time, returnTime: null }
        resolvedAt = candles.length - 1
      }
    }
    events.push(event)
    i = resolvedAt + 1
  }
  return {
    levelId: level.id,
    price,
    events,
    falseCount: events.filter((e) => e.status === 'false').length,
  }
}

/**
 * Main entry point: evaluate all levels on the candles of timeframe `tf`.
 * Unclosed trailing candles are removed first (see ClosedSpec); event indices
 * refer to the input array (the closed prefix keeps the same indices).
 */
export function detectFalseBreakouts(
  candles: readonly Candle[],
  levels: readonly DetectorLevel[],
  options: DetectOptions,
): LevelResult[] {
  const params = resolveParams(options.tf, options.params)
  const closed = closedCandles(candles, options.tf, options)
  const atr = params.k > 0 ? wilderAtr(closed, params.atrPeriod) : []
  return levels.map((lvl) => detectLevel(closed, lvl, params, atr))
}
