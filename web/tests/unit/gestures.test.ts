import { describe, expect, it } from 'vitest'
import {
  angleFromVertical,
  DEFAULT_GESTURE_CONFIG as C,
  isDoubleTap,
  isInEdgeDeadZone,
  resolveDirection,
  swipeOutcome,
  VelocityTracker,
} from '../../lib/gestures/arbiter'

describe('resolveDirection (12 px / 30°)', () => {
  it('stays undecided below 12 px', () => {
    expect(resolveDirection(0, 11.9)).toBeNull()
    expect(resolveDirection(8, 8)).toBeNull() // hypot ≈ 11.3
  })
  it('locks feed for near-vertical movement', () => {
    expect(resolveDirection(0, 12)).toBe('feed')
    expect(resolveDirection(0, -40)).toBe('feed')
    const a = (29 * Math.PI) / 180 // 29° from vertical
    expect(resolveDirection(20 * Math.sin(a), -20 * Math.cos(a))).toBe('feed')
  })
  it('locks chart at 30° and beyond', () => {
    const a = (30.5 * Math.PI) / 180
    expect(resolveDirection(20 * Math.sin(a), 20 * Math.cos(a))).toBe('chart')
    expect(resolveDirection(12, 0)).toBe('chart')
    expect(resolveDirection(-15, 5)).toBe('chart')
  })
  it('computes angle to vertical', () => {
    expect(angleFromVertical(0, 10)).toBe(0)
    expect(angleFromVertical(10, 0)).toBe(90)
    expect(angleFromVertical(10, -10)).toBeCloseTo(45)
  })
})

describe('swipeOutcome (20 % height or 0.5 px/ms)', () => {
  const h = 600
  it('commits by distance', () => {
    expect(swipeOutcome(-121, 0, h)).toBe(1) // up → next
    expect(swipeOutcome(121, 0, h)).toBe(-1) // down → prev
    expect(swipeOutcome(-120, 0, h)).toBe(0) // exactly 20 % is not enough
  })
  it('commits by velocity', () => {
    expect(swipeOutcome(-30, -0.6, h)).toBe(1)
    expect(swipeOutcome(30, 0.51, h)).toBe(-1)
    expect(swipeOutcome(-30, -0.5, h)).toBe(0)
  })
  it('ignores a flick opposite to the drag', () => {
    expect(swipeOutcome(-60, 0.9, h)).toBe(0)
  })
})

describe('edge dead zone (20 px)', () => {
  it('ignores touches near the left edge', () => {
    expect(isInEdgeDeadZone(0)).toBe(true)
    expect(isInEdgeDeadZone(19.9)).toBe(true)
    expect(isInEdgeDeadZone(20)).toBe(false)
  })
})

describe('VelocityTracker', () => {
  it('measures px/ms over the trailing window', () => {
    const v = new VelocityTracker(100)
    v.add(0, 0)
    v.add(50, -50)
    v.add(100, -100)
    expect(v.velocity()).toBeCloseTo(-1)
  })
  it('drops samples older than the window', () => {
    const v = new VelocityTracker(100)
    v.add(0, 0)
    v.add(500, -10) // long pause, then slow move
    v.add(560, -16)
    v.add(600, -20)
    expect(v.velocity()).toBeCloseTo(-0.1)
  })
  it('returns 0 without enough samples', () => {
    const v = new VelocityTracker()
    expect(v.velocity()).toBe(0)
    v.add(1, 1)
    expect(v.velocity()).toBe(0)
  })
})

describe('isDoubleTap', () => {
  it('detects two close taps', () => {
    expect(isDoubleTap({ t: 0, x: 100, y: 100 }, { t: 250, x: 110, y: 105 })).toBe(true)
  })
  it('rejects slow or distant taps', () => {
    expect(isDoubleTap({ t: 0, x: 100, y: 100 }, { t: C.doubleTapMs + 1, x: 100, y: 100 })).toBe(false)
    expect(isDoubleTap({ t: 0, x: 100, y: 100 }, { t: 100, x: 160, y: 100 })).toBe(false)
    expect(isDoubleTap(null, { t: 0, x: 0, y: 0 })).toBe(false)
  })
})
