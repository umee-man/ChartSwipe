import { describe, expect, it } from 'vitest'
import type { Candle } from '../../lib/binance/types'
import { mergeByUpdatedAt } from '../../lib/cache/levels'
import { exceedsLongPressSlop, isDeleteSwipe, levelDragIntent } from '../../lib/gestures/arbiter'
import { hitTestLabels, LABEL_H, layoutLabels } from '../../lib/levels/labels'
import { magnetPrice } from '../../lib/levels/magnet'
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

describe('magnet (±3 bars, 12 px, tickSize)', () => {
  const candles = [bar(100, 105, 99, 104), bar(104, 110, 103, 108), bar(108, 109, 101, 102), bar(102, 103, 95, 96)]
  it('snaps to the nearest OHLC within 12 px', () => {
    // y for 110 = 180, for 108 = 184; finger at 181 → nearest is high 110 (1 px)
    expect(magnetPrice({ candles, barIndex: 1, y: 181, priceToY, yToPrice, tickSize: 0.1 })).toEqual({ price: 110, snapped: true })
    // finger at 186 → close 108 (2 px) beats high 110 (6 px)
    expect(magnetPrice({ candles, barIndex: 1, y: 186, priceToY, yToPrice, tickSize: 0.1 })).toEqual({ price: 108, snapped: true })
  })
  it('uses the raw price (rounded to tick) when nothing is within the radius', () => {
    expect(magnetPrice({ candles, barIndex: 1, y: 150.3, priceToY, yToPrice, tickSize: 0.5 })).toEqual({ price: 125, snapped: false })
  })
  it('only considers bars within ±3 of the finger', () => {
    const many = [bar(50, 50, 50, 50), ...Array.from({ length: 10 }, () => bar(10, 10, 10, 10))]
    expect(magnetPrice({ candles: many, barIndex: 8, y: 301, priceToY, yToPrice, tickSize: 1 })!.snapped).toBe(false)
    expect(magnetPrice({ candles: many, barIndex: 3, y: 301, priceToY, yToPrice, tickSize: 1 })).toEqual({ price: 50, snapped: true })
  })
  it('handles out-of-range bar indices and an unmapped scale', () => {
    expect(magnetPrice({ candles, barIndex: 99, y: 150, priceToY, yToPrice, tickSize: 1 })).toEqual({ price: 125, snapped: false })
    expect(magnetPrice({ candles: [], barIndex: 0, y: 10, priceToY, yToPrice: () => null, tickSize: 1 })).toBeNull()
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
