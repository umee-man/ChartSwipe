import { describe, expect, it } from 'vitest'
import type { Candle } from '../../lib/binance/types'
import { mergeByUpdatedAt } from '../../lib/cache/levels'
import { exceedsLongPressSlop, isDeleteSwipe, isMouseClick, levelDragIntent } from '../../lib/gestures/arbiter'
import { hitTestLabels, LABEL_H, layoutLabels } from '../../lib/levels/labels'
import { barWindow, magnetPrice, magnetRadiusFor } from '../../lib/levels/magnet'
import { mergeCandles } from '../../lib/candles/merge'
import { candleAtLogical, toOhlc } from '../../lib/candles/series'
import {
  coerceLevel,
  createLevel,
  groupBySymbol,
  LevelValidationError,
  levelsForSymbol,
  levelsPriceRange,
  moveLevel,
  normalizeNote,
  NOTE_MAX,
  restoreLevel,
  roundToTick,
  setNote,
  softDelete,
  upsertLevel,
  UUID_RE,
  uuidv4,
} from '../../lib/levels/model'

const T0 = new Date('2026-09-26T10:00:00.000Z')
const T1 = new Date('2026-09-26T10:05:00.000Z')

describe('uuidv4', () => {
  it('uses randomUUID when available', () => {
    expect(uuidv4({ randomUUID: () => 'x' })).toBe('x')
  })
  it('falls back to getRandomValues (insecure context) with valid v4 format', () => {
    expect(uuidv4({ getRandomValues: (a) => a.fill(0xff) })).toMatch(UUID_RE)
  })
  it('falls back to Math.random without crypto', () => {
    const ids = new Set(Array.from({ length: 50 }, () => uuidv4(undefined)))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id).toMatch(UUID_RE)
  })
  it('survives randomUUID throwing', () => {
    const id = uuidv4({
      randomUUID: () => {
        throw new Error('insecure')
      },
      getRandomValues: (a) => a.fill(1),
    })
    expect(id).toMatch(UUID_RE)
  })
})

describe('roundToTick', () => {
  it('rounds without float noise', () => {
    expect(roundToTick(64200.04, 0.1)).toBe(64200)
    expect(roundToTick(0.30000000000000004, 0.1)).toBe(0.3)
    expect(roundToTick(1.23456, 0.001)).toBe(1.235)
    expect(roundToTick(0.00001234, 0.0000001)).toBe(0.0000123)
    expect(roundToTick(123, 0)).toBe(123)
  })
})

describe('level model (A16: one type, plain line)', () => {
  it('creates a level in the API/DB shape', () => {
    const l = createLevel({ symbol: 'btcusdt', price: 64200, tf: '1d', note: '  ' }, T0, 'id-1')
    expect(l).toEqual({
      id: 'id-1',
      exchange: 'binance',
      symbol: 'BTCUSDT',
      kind: 'level',
      price: 64200,
      price_to: null,
      tf: '1d',
      note: null,
      color: null,
      created_at: T0.toISOString(),
      updated_at: T0.toISOString(),
      deleted_at: null,
    })
  })
  it('rejects non-positive prices', () => {
    expect(() => createLevel({ symbol: 'X', price: 0, tf: '1d' })).toThrow(LevelValidationError)
    const l = createLevel({ symbol: 'X', price: 1, tf: '1d' })
    expect(() => moveLevel(l, -1)).toThrow(LevelValidationError)
  })
  it('limits notes to 140 characters', () => {
    expect(normalizeNote('x'.repeat(200))).toHaveLength(NOTE_MAX)
    expect(normalizeNote('😀'.repeat(141))).toBe('😀'.repeat(140))
    expect(normalizeNote('  hi ')).toBe('hi')
    expect(normalizeNote('')).toBeNull()
  })
  it('moves and annotates with a new updated_at, keeping created_at', () => {
    const l = createLevel({ symbol: 'X', price: 10, tf: '5m' }, T0)
    const m = moveLevel(l, 10.5, T1)
    expect(m).toMatchObject({ price: 10.5, created_at: T0.toISOString(), updated_at: T1.toISOString() })
    expect(setNote(m, ' пробой ', T1).note).toBe('пробой')
  })
  it('soft-deletes and restores', () => {
    const l = createLevel({ symbol: 'X', price: 1, tf: '1d' }, T0)
    const d = softDelete(l, T1)
    expect(d.deleted_at).toBe(T1.toISOString())
    expect(d.updated_at).toBe(T1.toISOString())
    expect(levelsForSymbol([d], 'X')).toEqual([])
    expect(levelsForSymbol([restoreLevel(d, T1)], 'X')).toHaveLength(1)
  })
  it('upserts by id', () => {
    const a = createLevel({ symbol: 'X', price: 1, tf: '1d' }, T0, 'a')
    const b = createLevel({ symbol: 'Y', price: 2, tf: '1d' }, T0, 'b')
    const list = upsertLevel(upsertLevel([], a), b)
    expect(list.map((l) => l.id)).toEqual(['a', 'b'])
    expect(upsertLevel(list, { ...a, price: 5 })[0]!.price).toBe(5)
    expect(levelsForSymbol(list, 'Y').map((l) => l.id)).toEqual(['b'])
  })
  it('coerces stored records, migrating pre-A16 kinds and dropping corrupt ones', () => {
    const zone = { id: 'z', symbol: 'X', kind: 'zone', price: 10, price_to: 12, tf: '1h', updated_at: T0.toISOString() }
    expect(coerceLevel(zone)).toMatchObject({ kind: 'level', price: 10, price_to: null, created_at: T0.toISOString() })
    expect(coerceLevel({ id: 'x' })).toBeNull()
    expect(coerceLevel(null)).toBeNull()
    expect(coerceLevel({ ...zone, kind: 'weird' })).toBeNull()
  })
  it('groups alive levels by ticker with search (levels list)', () => {
    const a = createLevel({ symbol: 'ETHUSDT', price: 3000, tf: '1d', note: 'неделя' }, T0, 'a')
    const b = createLevel({ symbol: 'BTCUSDT', price: 60000, tf: '1d' }, T0, 'b')
    const c = createLevel({ symbol: 'BTCUSDT', price: 70000, tf: '1h' }, T0, 'c')
    const d = softDelete(createLevel({ symbol: 'SOLUSDT', price: 1, tf: '1d' }, T0, 'd'), T1)
    const g = groupBySymbol([a, b, c, d])
    expect(g.map((x) => x.symbol)).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(g[0]!.levels.map((l) => l.id)).toEqual(['c', 'b'])
    expect(groupBySymbol([a, b, c], 'eth').map((x) => x.symbol)).toEqual(['ETHUSDT'])
    expect(groupBySymbol([a, b, c], 'НЕДЕ').map((x) => x.symbol)).toEqual(['ETHUSDT'])
  })
  it('computes the price range for the Д/Н autoscale', () => {
    const l = (p: number) => createLevel({ symbol: 'X', price: p, tf: '1d' }, T0)
    expect(levelsPriceRange([])).toBeNull()
    expect(levelsPriceRange([l(5), l(2), l(9)])).toEqual({ min: 2, max: 9 })
  })
})

describe('level persistence merge', () => {
  it('keeps the newest version of each level', () => {
    const a0 = createLevel({ symbol: 'X', price: 1, tf: '1d' }, T0, 'a')
    const a1 = moveLevel(a0, 2, T1)
    const b = createLevel({ symbol: 'Y', price: 3, tf: '1d' }, T0, 'b')
    const merged = mergeByUpdatedAt([a1, b], [a0])
    expect(merged.find((l) => l.id === 'a')!.price).toBe(2)
    expect(mergeByUpdatedAt([a0], [a1])[0]!.price).toBe(2)
    expect(merged).toHaveLength(2)
  })
})

// Linear price scale for tests: y = (200 - price) * 2  (price 100 → y 200, price 101 → y 198)
const priceToY = (p: number) => (200 - p) * 2
const yToPrice = (y: number) => 200 - y / 2
const bar = (o: number, h: number, l: number, c: number): Candle => ({ time: 0, open: o, high: h, low: l, close: c, volume: 1 })
const c5 = (time: number): Candle => ({ time, open: 1, high: 1, low: 1, close: 1, volume: 1 })

describe('magnet (A17: px window, wicks first, 24/12 px radius)', () => {
  const candles = [bar(100, 105, 99, 104), bar(104, 110, 103, 108), bar(108, 109, 101, 102), bar(102, 103, 95, 96)]
  const base = { priceToY, yToPrice, tickSize: 0.1, barSpacing: 20 }
  it('prefers wicks over nearer open/close, ties → the more extreme wick', () => {
    // finger y 186 (price 107): close/open 108 are 2 px away, but wicks win; highs 109 and 105 are both
    // 4 px away → the higher high (109, bar 2) wins.
    expect(magnetPrice({ ...base, candles, logical: 1, y: 186 })).toEqual({ price: 109, snapped: true, kind: 'high', barIndex: 2 })
  })
  it('falls back to open/close only when no wick is within the radius', () => {
    const tall = [bar(100, 150, 50, 101)]
    expect(magnetPrice({ ...base, candles: tall, logical: 0, y: 199 })).toMatchObject({ price: 100, snapped: true, kind: 'open' })
  })
  it('uses a 24 px touch radius and 12 px for mouse', () => {
    expect(magnetRadiusFor('touch')).toBe(24)
    expect(magnetRadiusFor('pen')).toBe(24)
    expect(magnetRadiusFor('mouse')).toBe(16) // A21
    expect(magnetRadiusFor('touch', 30)).toBe(30)
    // high 110 is 20 px from y 200 → snaps with the touch radius, not with the mouse radius
    const one = [bar(90, 110, 89, 91)] // high y 180, low y 222; body far
    expect(magnetPrice({ ...base, candles: one, logical: 0, y: 200, radiusPx: 24 })).toMatchObject({ price: 110, kind: 'high' })
    expect(magnetPrice({ ...base, candles: one, logical: 0, y: 200, radiusPx: 12 })!.snapped).toBe(false)
  })
  it('searches ±32 px horizontally: many narrow bars on zoomed-out Д/Н, at least ±3 bars', () => {
    const many = Array.from({ length: 40 }, () => bar(10, 10, 10, 10))
    many[10] = bar(10, 50, 10, 10) // spike 10 bars left of the finger
    // barSpacing 2 px → ±16 bars → the spike is found
    expect(magnetPrice({ ...base, candles: many, barSpacing: 2, logical: 20, y: 301, tickSize: 1 })).toMatchObject({ price: 50, barIndex: 10 })
    // barSpacing 20 px → ±3 bars (min) → not found
    expect(magnetPrice({ ...base, candles: many, barSpacing: 20, logical: 20, y: 301, tickSize: 1 })!.snapped).toBe(false)
  })
  it('uses the raw price (rounded to tick) when nothing is within the radius', () => {
    expect(magnetPrice({ ...base, candles, logical: 1, y: 150.3, tickSize: 0.5 })).toEqual({ price: 125, snapped: false })
  })
  it('handles out-of-range / unmapped fingers', () => {
    expect(magnetPrice({ ...base, candles, logical: 99, y: 150, tickSize: 1 })).toEqual({ price: 125, snapped: false })
    expect(magnetPrice({ ...base, candles, logical: Number.NaN, y: 150, tickSize: 1 })).toEqual({ price: 125, snapped: false })
    expect(magnetPrice({ ...base, candles: [], logical: 0, y: 10, yToPrice: () => null })).toBeNull()
  })
})

describe('barWindow (px → bars)', () => {
  it('covers ±windowPx, never fewer than ±3 bars, clamped to the data', () => {
    expect(barWindow(50, 100, 100)).toEqual({ from: 47, to: 53 }) // wide bars → min ±3
    expect(barWindow(50, 2, 100)).toEqual({ from: 34, to: 66 }) // 32 px / 2 px = ±16
    expect(barWindow(50.4, 1.5, 100)).toEqual({ from: 28, to: 72 }) // ceil(32/1.5) = 22
    expect(barWindow(0, 2, 10)).toEqual({ from: 0, to: 9 })
    expect(barWindow(-50, 2, 10)).toBeNull() // far left of the data
    expect(barWindow(Number.NaN, 2, 10)).toBeNull()
    expect(barWindow(1, 2, 0)).toBeNull()
  })
})

describe('store ↔ series index alignment (magnet reads store candles by logical index)', () => {
  it('maps one series point per candle in store order, also after a history prepend', () => {
    const tail = [c5(300), c5(600), c5(900)]
    const older = [c5(0)]
    const merged = mergeCandles(older, tail)
    const series = merged.map(toOhlc)
    expect(series.map((p) => p.time)).toEqual(merged.map((c) => c.time))
    // the bar that was logical 0 before the prepend is logical 1 after it — same candle object
    expect(candleAtLogical(merged, 1)).toBe(tail[0])
    expect(candleAtLogical(merged, 2.4)).toBe(tail[1])
    expect(candleAtLogical(merged, -1)).toBeNull()
    expect(candleAtLogical(merged, 4)).toBeNull()
  })
})

describe('plaque layout & hit-testing', () => {
  it('centers plaques on lines and hides off-screen ones', () => {
    const r = layoutLabels(
      [
        { levelId: 'a', y: 100 },
        { levelId: 'b', y: null },
        { levelId: 'c', y: 900 },
      ],
      500,
    )
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ levelId: 'a', top: 100 - LABEL_H / 2 })
  })
  it('stacks overlapping plaques without overlap, also at the bottom edge', () => {
    const r = layoutLabels(
      [
        { levelId: 'a', y: 495 },
        { levelId: 'b', y: 496 },
        { levelId: 'c', y: 497 },
      ],
      500,
    )
    for (let i = 1; i < r.length; i++) expect(r[i]!.top).toBeGreaterThanOrEqual(r[i - 1]!.bottom)
    expect(r.at(-1)!.bottom).toBeLessThanOrEqual(500)
    expect(r[0]!.top).toBeGreaterThanOrEqual(0)
  })
  it('hits a plaque only inside the left strip, with slop, nearest first', () => {
    const r = layoutLabels(
      [
        { levelId: 'a', y: 100 },
        { levelId: 'b', y: 130 },
      ],
      500,
    )
    expect(hitTestLabels(r, 20, 100)?.levelId).toBe('a')
    expect(hitTestLabels(r, 20, 130)?.levelId).toBe('b')
    expect(hitTestLabels(r, 20, 113)?.levelId).toBe('a') // in both slops, closer to a
    expect(hitTestLabels(r, 300, 100)).toBeNull() // outside the label strip → chart gesture
    expect(hitTestLabels(r, 20, 300)).toBeNull()
  })
})

describe('level gestures', () => {
  it('cancels long press beyond 8 px', () => {
    expect(exceedsLongPressSlop(6, 6)).toBe(true) // hypot ≈ 8.5
    expect(exceedsLongPressSlop(4, 4)).toBe(false)
    expect(exceedsLongPressSlop(0, 8)).toBe(false)
    expect(exceedsLongPressSlop(0, 8.1)).toBe(true)
  })
  it('decides move vs swipe-to-delete for plaque drags', () => {
    expect(levelDragIntent(3, 3)).toBeNull()
    expect(levelDragIntent(0, 20)).toBe('move')
    expect(levelDragIntent(20, 2)).toBe('swipe')
    expect(levelDragIntent(-20, 2)).toBe('move') // leftward never deletes
    expect(levelDragIntent(10, 10)).toBe('move') // 45° is a move
  })
  it('deletes only past 60 px', () => {
    expect(isDeleteSwipe(60)).toBe(false)
    expect(isDeleteSwipe(61)).toBe(true)
  })
})

describe('mouse click placement (A21)', () => {
  it('is a click only when quick and still (not a pan)', () => {
    expect(isMouseClick(120, 1, 2)).toBe(true)
    expect(isMouseClick(250, 3, 0)).toBe(true)
    expect(isMouseClick(251, 0, 0)).toBe(false) // held → not a click
    expect(isMouseClick(100, 4, 0)).toBe(false) // moved 4 px → pan
    expect(isMouseClick(100, 3, 3)).toBe(false) // hypot 4.2
  })
})
