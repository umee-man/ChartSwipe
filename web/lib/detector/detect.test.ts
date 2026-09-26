import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  autoLevels,
  autoLevelsAt,
  closedCandles,
  detectFalseBreakouts,
  resolveParams,
  weekStart,
  wilderAtr,
} from './index'
import type { AutoLevel, Candle, ClosedSpec, DetectorLevel, DetectorParams, DetectorTf, LevelResult } from './index'

interface DetectFixture {
  kind: 'detect'
  name: string
  description: string
  tf: DetectorTf
  params?: Partial<DetectorParams>
  lastClosed?: boolean
  nowSec?: number
  levels: DetectorLevel[]
  candles: Candle[]
  expected: Omit<LevelResult, 'price'>[]
  expectedAtr?: Record<string, number>
}

interface AutoLevelsFixture {
  kind: 'autoLevels'
  name: string
  description: string
  nowSec?: number
  lastClosed?: boolean
  weekly?: boolean
  /** When set: autoLevelsAt(closedCandles(candles), asOfIndex) instead of autoLevels(candles). */
  asOfIndex?: number
  candles: Candle[]
  expected: AutoLevel[]
}

/** Fixtures carry exactly one of nowSec / lastClosed (the API requires a closure spec). */
const specOf = (fx: { nowSec?: number; lastClosed?: boolean }): ClosedSpec => {
  if (fx.nowSec !== undefined) return { nowSec: fx.nowSec }
  if (typeof fx.lastClosed !== 'boolean') throw new Error('fixture lacks nowSec/lastClosed')
  return { lastClosed: fx.lastClosed }
}

type Fixture = DetectFixture | AutoLevelsFixture

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')) as Fixture)

const detectFixtures = fixtures.filter((f): f is DetectFixture => f.kind === 'detect')
const autoFixtures = fixtures.filter((f): f is AutoLevelsFixture => f.kind === 'autoLevels')

describe('fixtures (shared contract with the Python port)', () => {
  it('covers every required scenario', () => {
    const names = fixtures.map((f) => f.name)
    for (const required of [
      'false_up',
      'false_down',
      'true_breakout',
      'pending',
      'return_on_break_candle',
      'atr_dominates',
      'pct_dominates',
      'multiple_events',
      'unclosed_last_nowsec',
      'unclosed_last_flag',
      'daily_defaults',
      'auto_levels',
      'auto_levels_as_of',
      'creep_then_wick',
      'outside_candle_below',
      'level_far_below',
      'h1_default_atr',
      'atr_prev_candle',
      'active_from',
    ]) {
      expect(names).toContain(required)
    }
  })

  describe.each(detectFixtures.map((f) => [f.name, f] as const))('detect: %s', (_name, fx) => {
    it('matches expected events and falseCount', () => {
      const result = detectFalseBreakouts(fx.candles, fx.levels, { ...specOf(fx), tf: fx.tf, params: fx.params })
      const actual = result.map(({ levelId, events, falseCount }) => ({ levelId, events, falseCount }))
      expect(actual).toEqual(fx.expected)
    })

    if (fx.expectedAtr) {
      it('matches expected Wilder ATR values', () => {
        const atr = wilderAtr(fx.candles, 14)
        for (const [idx, value] of Object.entries(fx.expectedAtr!)) {
          expect(atr[Number(idx)]).toBeCloseTo(value, 10)
        }
      })
    }
  })

  describe.each(autoFixtures.map((f) => [f.name, f] as const))('autoLevels: %s', (_name, fx) => {
    it('matches expected levels', () => {
      const actual =
        fx.asOfIndex !== undefined
          ? autoLevelsAt(closedCandles(fx.candles, '1d', specOf(fx)), fx.asOfIndex, { weekly: fx.weekly })
          : autoLevels(fx.candles, { ...specOf(fx), weekly: fx.weekly })
      expect(actual).toEqual(fx.expected)
    })
  })
})

const mk = (rows: [number, number, number, number][], tf = 300, t0 = 0): Candle[] =>
  rows.map(([open, high, low, close], k) => ({ time: t0 + k * tf, open, high, low, close, volume: 0 }))

describe('params', () => {
  it('exports the architecture §5.6 defaults', () => {
    expect(DEFAULT_PARAMS['5m']).toMatchObject({ pct: 0.001, k: 0.3, n: 6 })
    expect(DEFAULT_PARAMS['1h']).toMatchObject({ pct: 0.0015, k: 0.3, n: 3 })
    expect(DEFAULT_PARAMS['1d']).toMatchObject({ pct: 0.003, k: 0, n: 1 })
  })

  it('merges overrides and forces k = 0 on 1d', () => {
    expect(resolveParams('5m', { n: 2 })).toEqual({ pct: 0.001, k: 0.3, n: 2, atrPeriod: 14 })
    expect(resolveParams('1d', { k: 5 }).k).toBe(0)
  })

  it('rejects invalid params', () => {
    expect(() => resolveParams('5m', { n: 0 })).toThrow(RangeError)
    expect(() => resolveParams('5m', { pct: -1 })).toThrow(RangeError)
  })
})

describe('wilderAtr', () => {
  it('returns nulls until the period is filled, then SMA seed and Wilder smoothing', () => {
    const c = mk([
      [10, 12, 9, 11], // TR 3
      [11, 13, 10, 12], // TR 3
      [12, 16, 11, 15], // TR 5
      [15, 15, 12, 13], // TR 3
    ])
    const atr = wilderAtr(c, 3)
    expect(atr[0]).toBeNull()
    expect(atr[1]).toBeNull()
    expect(atr[2]).toBeCloseTo(11 / 3, 12)
    expect(atr[3]).toBeCloseTo(((11 / 3) * 2 + 3) / 3, 12)
  })

  it('uses gaps against the previous close in the true range', () => {
    const c = mk([
      [10, 11, 9, 10],
      [15, 16, 14.5, 15.5], // TR = |16 - 10| = 6
    ])
    expect(wilderAtr(c, 2)[1]).toBeCloseTo((2 + 6) / 2, 12)
  })
})

describe('closedCandles', () => {
  const c = mk([
    [1, 1, 1, 1],
    [1, 1, 1, 1],
    [1, 1, 1, 1],
  ])
  it('keeps everything when lastClosed=true', () => {
    expect(closedCandles(c, '5m', { lastClosed: true })).toHaveLength(3)
  })
  it('throws when no closure spec is given (no unsafe default)', () => {
    // Untyped JS caller: the forming Binance candle must never be treated as closed silently.
    expect(() => closedCandles(c, '5m', {} as unknown as ClosedSpec)).toThrow(TypeError)
    expect(() => detectFalseBreakouts(c, [], { tf: '5m' } as unknown as Parameters<typeof detectFalseBreakouts>[2])).toThrow(
      TypeError,
    )
  })
  it('drops the last candle when lastClosed=false', () => {
    expect(closedCandles(c, '5m', { lastClosed: false })).toHaveLength(2)
  })
  it('uses nowSec + tf span (a candle closes exactly at time + span)', () => {
    expect(closedCandles(c, '5m', { nowSec: 900 })).toHaveLength(3)
    expect(closedCandles(c, '5m', { nowSec: 899 })).toHaveLength(2)
  })
})

describe('detector edge cases', () => {
  it('treats a close exactly at the level as NOT a return (pending Team Lead decision, see §5.6)', () => {
    const c = mk([
      [99.5, 99.8, 99.3, 99.6],
      [99.6, 100.5, 99.5, 100],
    ])
    const [r] = detectFalseBreakouts(c, [{ id: 'L', price: 100 }], { tf: '1d', params: { n: 1 }, lastClosed: true })
    expect(r!.events).toEqual([
      { direction: 'up', breakIndex: 1, returnIndex: null, status: 'true', breakTime: 300, returnTime: null },
    ])
  })

  it('requires strictly more than X beyond the level', () => {
    const c = mk([
      [99, 99.5, 98.5, 99],
      [99, 100.3, 98.9, 100.2], // 1d X = 0.3 -> high must be > 100.3
    ])
    const [r] = detectFalseBreakouts(c, [{ id: 'L', price: 100 }], { tf: '1d', lastClosed: true })
    expect(r!.events).toEqual([])
  })

  it('returns empty results for empty input', () => {
    expect(detectFalseBreakouts([], [{ id: 'L', price: 1 }], { tf: '5m', lastClosed: true })).toEqual([
      { levelId: 'L', price: 1, events: [], falseCount: 0 },
    ])
    expect(autoLevels([], { lastClosed: true })).toEqual([])
  })
})

describe('autoLevels', () => {
  it('computes ISO week starts on Monday 00:00 UTC', () => {
    // 2026-09-26 (Sat) -> Monday 2026-09-21 = day 20717
    expect(weekStart(20722 * 86400 + 5)).toBe(20717 * 86400)
    expect(weekStart(20717 * 86400)).toBe(20717 * 86400)
  })

  it('returns only PDH/PDL unless weekly is requested', () => {
    const daily = mk(
      [
        [1, 5, 0.5, 2],
        [2, 6, 1.5, 3],
      ],
      86400,
      20717 * 86400,
    )
    expect(autoLevels(daily, { lastClosed: true })).toEqual([
      { id: 'PDH', kind: 'PDH', price: 6, activeFrom: 20719 * 86400 },
      { id: 'PDL', kind: 'PDL', price: 1.5, activeFrom: 20719 * 86400 },
    ])
  })

  it("today's PDH/PDL cannot break on the last closed day (it defines them)", () => {
    const daily = mk(
      [
        [100, 105, 95, 100],
        [100, 110, 99, 101],
      ],
      86400,
      20717 * 86400,
    )
    const levels = autoLevels(daily, { lastClosed: true })
    const res = detectFalseBreakouts(daily, levels, { tf: '1d', lastClosed: true })
    expect(res.flatMap((r) => r.events)).toEqual([])
  })

  it('A4 recipe: levels as of the last closed day detect a false break of PDH on that day', () => {
    // Day 0: PDH source (high 110). Day 1 (last closed): wicks to 111 > 110.33, closes 108 -> false.
    // Day 2 is still forming and dropped by lastClosed=false.
    const daily = mk(
      [
        [100, 110, 95, 105],
        [105, 111, 104, 108],
        [108, 120, 107, 119],
      ],
      86400,
      20717 * 86400,
    )
    const closed = closedCandles(daily, '1d', { lastClosed: false })
    const levels = autoLevelsAt(closed, closed.length - 1)
    expect(levels.map((l) => [l.id, l.price, l.activeFrom])).toEqual([
      ['PDH', 110, 20718 * 86400],
      ['PDL', 95, 20718 * 86400],
    ])
    const [pdh, pdl] = detectFalseBreakouts(closed, levels, { tf: '1d', lastClosed: true })
    expect(pdh!.events).toEqual([
      { direction: 'up', breakIndex: 1, returnIndex: 1, status: 'false', breakTime: 20718 * 86400, returnTime: 20718 * 86400 },
    ])
    expect(pdl!.events).toEqual([])
  })

  it('rejects an out-of-range index', () => {
    expect(() => autoLevelsAt([], 1)).toThrow(RangeError)
    expect(autoLevelsAt([], 0)).toEqual([])
  })
})
