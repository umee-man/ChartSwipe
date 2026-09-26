/**
 * Types for the false-breakout detector (architecture §5.6, F7).
 * Pure data shapes only; shared 1:1 with the JSON fixtures in ./fixtures,
 * which are the contract for the future server-side Python port.
 */

/** OHLCV candle. `time` is the candle OPEN time in unix seconds (UTC). */
export interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Timeframes that have built-in defaults (architecture §5.6 table). */
export type DetectorTf = '5m' | '1h' | '1d'

export interface DetectorParams {
  /** Threshold as a fraction of the level price (0.001 = 0.1%). */
  pct: number
  /** ATR multiplier; 0 disables the ATR component (1d uses pct only). */
  k: number
  /** Confirmation window in candles, counted from the break candle (i..i+N-1). */
  n: number
  /** ATR period (Wilder). Defaults to 14. */
  atrPeriod?: number
}

/** Level to evaluate. */
export interface DetectorLevel {
  id: string
  price: number
  /**
   * Unix sec (UTC). Candles with `time < activeFrom` are never break candidates:
   * a level does not exist before it was placed (user levels: created_at) or
   * before its reference period ended (PDH/PDL: next day, PWH/PWL: next ISO week).
   * ATR is still computed over all candles. Omitted = active over the whole history.
   */
  activeFrom?: number
}

export type BreakDirection = 'up' | 'down'

/**
 * pending — break found, fewer than N closed candles so far and no return yet ("пробой идёт");
 * false   — a close back beyond the level within i..i+N-1 ("ложный");
 * true    — N candles closed on the break side ("настоящий").
 */
export type BreakStatus = 'pending' | 'false' | 'true'

export interface BreakEvent {
  direction: BreakDirection
  /** Index of the break candle `i` in the evaluated (closed) candle array. */
  breakIndex: number
  /** Index `j` of the first candle that closed back beyond the level; null unless status='false'. */
  returnIndex: number | null
  status: BreakStatus
  breakTime: number
  returnTime: number | null
}

export interface LevelResult {
  levelId: string
  price: number
  events: BreakEvent[]
  /** Number of events with status 'false'. */
  falseCount: number
}

/**
 * How to decide which candles are closed. Only closed candles are evaluated;
 * trailing unclosed candles are dropped (architecture §5.6 rule 5).
 * REQUIRED (exactly one form): Binance klines always end with the forming candle,
 * so there is no safe default.
 * - `nowSec` + tf: a candle is closed when `time + tfSeconds <= nowSec`.
 * - `lastClosed`: explicit flag for the LAST candle only (earlier candles are assumed closed).
 */
export type ClosedSpec = { nowSec: number; lastClosed?: never } | { lastClosed: boolean; nowSec?: never }

export type DetectOptions = ClosedSpec & {
  tf: DetectorTf
  /** Partial override of the per-TF defaults. */
  params?: Partial<DetectorParams>
}

export type AutoLevelKind = 'PDH' | 'PDL' | 'PWH' | 'PWL'

export interface AutoLevel extends DetectorLevel {
  kind: AutoLevelKind
}
