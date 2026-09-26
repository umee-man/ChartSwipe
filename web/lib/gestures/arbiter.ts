// Pure gesture math for the feed/chart arbiter (arch §5.3 items 3–6).
// Items 1–2 (level drag, long-press to add a level) plug in via `GestureTarget` / long-press hooks later.

export interface GestureConfig {
  /** Direction is locked after this much movement, px (item 3). */
  lockDistance: number
  /** Max angle from vertical, degrees, for a movement to count as a feed swipe (item 3). */
  lockAngleDeg: number
  /** Feed swipe commits past this fraction of the viewport height (item 4). */
  swipeDistanceRatio: number
  /** …or when released faster than this, px/ms (item 4). */
  swipeVelocity: number
  /** Gestures starting this close to the left screen edge are ignored (item 6, iOS back swipe). */
  edgeDeadZone: number
  /** Max interval between taps for a double tap, ms (item 5). */
  doubleTapMs: number
  /** Max distance between the two taps of a double tap, px. */
  doubleTapSlop: number
  /** Max press duration for a tap, ms. */
  tapMaxMs: number
  /** Velocity is measured over this trailing window, ms. */
  velocityWindowMs: number
}

export const DEFAULT_GESTURE_CONFIG: Readonly<GestureConfig> = Object.freeze({
  lockDistance: 12,
  lockAngleDeg: 30,
  swipeDistanceRatio: 0.2,
  swipeVelocity: 0.5,
  edgeDeadZone: 20,
  doubleTapMs: 300,
  doubleTapSlop: 24,
  tapMaxMs: 250,
  velocityWindowMs: 100,
})

/** What the pointer landed on; 'level' (a plaque) takes priority over the feed/chart decision (item 1). */
export type GestureTarget = 'none' | 'priceAxis' | 'level'

/** Gesture mode after arbitration. */
export type GestureMode =
  | 'idle'
  | 'pending' // pointer down, direction not locked yet
  | 'feed' // vertical swipe drives the feed
  | 'chart' // horizontal pan / axis scale handled by lightweight-charts
  | 'multi' // pinch (≥ 2 pointers) → chart
  | 'level' // finger on a level plaque: drag moves it / swipe right deletes (item 1)
  | 'longpress' // long press fired a new level (item 2); rest of the gesture is swallowed
  | 'ignored' // started in the left-edge dead zone (item 6)

/** Angle of a movement vector from the vertical axis, degrees in [0, 90]. */
export function angleFromVertical(dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0
  return (Math.atan2(Math.abs(dx), Math.abs(dy)) * 180) / Math.PI
}

/**
 * Lock the gesture direction (item 3). Returns null while movement is below `lockDistance`.
 * Angle to vertical < lockAngleDeg → 'feed', otherwise 'chart'.
 */
export function resolveDirection(
  dx: number,
  dy: number,
  cfg: Pick<GestureConfig, 'lockDistance' | 'lockAngleDeg'> = DEFAULT_GESTURE_CONFIG,
): 'feed' | 'chart' | null {
  if (Math.hypot(dx, dy) < cfg.lockDistance) return null
  return angleFromVertical(dx, dy) < cfg.lockAngleDeg ? 'feed' : 'chart'
}

/** Item 6: starts within the left-edge dead zone. */
export function isInEdgeDeadZone(clientX: number, cfg: Pick<GestureConfig, 'edgeDeadZone'> = DEFAULT_GESTURE_CONFIG): boolean {
  return clientX < cfg.edgeDeadZone
}

/**
 * Item 4: decide whether a released feed drag changes slide.
 * `dy` is total vertical displacement (negative = finger moved up), `vy` px/ms (negative = up).
 * Returns +1 for next ticker (swipe up), -1 for previous (swipe down), 0 to snap back.
 */
export function swipeOutcome(
  dy: number,
  vy: number,
  height: number,
  cfg: Pick<GestureConfig, 'swipeDistanceRatio' | 'swipeVelocity'> = DEFAULT_GESTURE_CONFIG,
): -1 | 0 | 1 {
  if (height > 0 && Math.abs(dy) > cfg.swipeDistanceRatio * height) return dy < 0 ? 1 : -1
  // A fast flick counts only if it goes the same way as the drag (no flick-back reversal).
  if (Math.abs(vy) > cfg.swipeVelocity && (dy === 0 || Math.sign(vy) === Math.sign(dy))) return vy < 0 ? 1 : -1
  return 0
}

/** Rubber-band resistance for dragging past the first/last slide. */
export function rubberBand(offset: number, factor = 0.3): number {
  return offset * factor
}

export interface Sample {
  t: number
  y: number
}

/** Tracks recent vertical positions to estimate release velocity (px/ms). */
export class VelocityTracker {
  private samples: Sample[] = []

  constructor(private readonly windowMs: number = DEFAULT_GESTURE_CONFIG.velocityWindowMs) {}

  reset(): void {
    this.samples = []
  }

  add(t: number, y: number): void {
    this.samples.push({ t, y })
    const cutoff = t - this.windowMs
    while (this.samples.length > 2 && this.samples[0]!.t < cutoff) this.samples.shift()
  }

  /** px/ms over the trailing window; 0 with < 2 samples. */
  velocity(): number {
    if (this.samples.length < 2) return 0
    const a = this.samples[0]!
    const b = this.samples[this.samples.length - 1]!
    const dt = b.t - a.t
    return dt > 0 ? (b.y - a.y) / dt : 0
  }
}

export interface Tap {
  t: number
  x: number
  y: number
}

/** Item 5: second tap within `doubleTapMs` and `doubleTapSlop` px of the previous one. */
export function isDoubleTap(
  prev: Tap | null,
  cur: Tap,
  cfg: Pick<GestureConfig, 'doubleTapMs' | 'doubleTapSlop'> = DEFAULT_GESTURE_CONFIG,
): boolean {
  if (!prev) return false
  const dt = cur.t - prev.t
  return dt >= 0 && dt <= cfg.doubleTapMs && Math.hypot(cur.x - prev.x, cur.y - prev.y) <= cfg.doubleTapSlop
}

// ---------- levels (arch §5.3 items 1–2) ----------

/** Item 2: long press duration that creates a level, ms. */
export const LONG_PRESS_MS = 400
/** Item 2: movement that cancels a long press, px. */
export const LONG_PRESS_SLOP = 8
/** Item 1: swipe a plaque right by more than this to delete the level, px. */
export const LEVEL_DELETE_SWIPE = 60
/** Movement before a plaque drag decides between "move" and "swipe to delete", px. */
export const LEVEL_LOCK_DISTANCE = 8

/** True once the finger moved too far for a long press. */
export function exceedsLongPressSlop(dx: number, dy: number, slop = LONG_PRESS_SLOP): boolean {
  return Math.hypot(dx, dy) > slop
}

export type LevelDragIntent = 'move' | 'swipe'

/**
 * Plaque drag intent: rightward and within 30° of horizontal → 'swipe' (delete gesture),
 * anything else → 'move' (vertical price drag). Null until LEVEL_LOCK_DISTANCE.
 */
export function levelDragIntent(dx: number, dy: number, lock = LEVEL_LOCK_DISTANCE): LevelDragIntent | null {
  if (Math.hypot(dx, dy) < lock) return null
  return dx > 0 && angleFromVertical(dx, dy) >= 60 ? 'swipe' : 'move'
}

/** Release of a plaque swipe deletes the level. */
export function isDeleteSwipe(dx: number, threshold = LEVEL_DELETE_SWIPE): boolean {
  return dx > threshold
}
