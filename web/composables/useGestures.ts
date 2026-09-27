// Gesture arbiter over pointer events (arch §5.3). Decides level drag / long press / feed swipe / chart
// pan so that neither the browser nor lightweight-charts steals the gesture. Resolution order:
//   1. pointer on a level plaque → 'level' (feed + pan locked; drag moves, swipe right deletes, tap edits)
//   2. long press 400 ms without > 8 px movement → new level ('longpress')
//   3. first 12 px: < 30° to vertical → feed swipe, else chart pan (LWC)
//   4. feed swipe commits at > 20 % height or > 0.5 px/ms
//   5. pinch / price-axis drag → chart; double tap → reset view
//   6. 20 px left-edge dead zone ignored (iOS back swipe)
import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue'
import {
  DEFAULT_GESTURE_CONFIG,
  exceedsLongPressSlop,
  isDoubleTap,
  isInEdgeDeadZone,
  isMouseClick,
  LONG_PRESS_MS,
  LONG_PRESS_SLOP,
  resolveDirection,
  swipeOutcome,
  VelocityTracker,
  type GestureConfig,
  type GestureMode,
  type GestureTarget,
  type Tap,
} from '~/lib/gestures/arbiter'

export interface GestureHandlers {
  /** Current viewport height of the feed, px (for the 20 % rule). */
  height(): number
  /** Feed drag in progress; `dy` is total vertical offset in px (negative = up). */
  onFeedMove(dy: number): void
  /** Feed drag released: +1 next, -1 previous, 0 snap back. */
  onFeedEnd(outcome: -1 | 0 | 1): void
  /** Item 5: double tap → reset chart. */
  onDoubleTap?(p: { x: number; y: number }): void
  /**
   * Classify the pointer-down target before anything else.
   * 'level' → the pointer is on a level plaque (item 1); 'priceAxis' → chart immediately (item 5).
   */
  hitTest?(e: PointerEvent): GestureTarget
  /** Item 2: long press on the chart (client coordinates of the finger; pointerType picks the magnet radius). */
  onLongPress?(p: { x: number; y: number; pointerType: string }): void
  /** Item 1: plaque drag in progress (offsets from the pointer-down point + current finger position). */
  onLevelMove?(dx: number, dy: number, p: { x: number; y: number; pointerType: string }): void
  /** Item 1: plaque released. `tap` = short press without movement (opens the level sheet). */
  onLevelEnd?(dx: number, dy: number, info: { tap: boolean; cancelled: boolean }): void
  /**
   * A21: mouse click on the chart (quick, < 4 px) → place a level. Fired after the double-click window so
   * a double-click stays "reset view" and never places two levels. Touch never fires this (long press).
   */
  onMouseClick?(p: { x: number; y: number }): void
}

/** Elements that handle their own taps (buttons, menus) never produce double-tap resets. */
const INTERACTIVE = 'button, a, input, select, textarea, [data-gesture-ignore]'

export function useGestures(el: Ref<HTMLElement | null>, h: GestureHandlers, cfg: GestureConfig = DEFAULT_GESTURE_CONFIG) {
  const mode = ref<GestureMode>('idle')
  const pointers = new Map<number, { x: number; y: number }>()
  const velocity = new VelocityTracker(cfg.velocityWindowMs)
  let start = { x: 0, y: 0, t: 0 }
  let last = { x: 0, y: 0 }
  let startTarget: EventTarget | null = null
  let startIsTouch = false
  let startPointerType = 'touch'
  let lastTap: Tap | null = null
  let longPressTimer: ReturnType<typeof setTimeout> | null = null
  let clickTimer: ReturnType<typeof setTimeout> | null = null
  function clearClick() {
    if (clickTimer) clearTimeout(clickTimer)
    clickTimer = null
  }

  function clearLongPress() {
    if (longPressTimer) clearTimeout(longPressTimer)
    longPressTimer = null
  }

  function reset() {
    clearLongPress()
    mode.value = 'idle'
    velocity.reset()
    startTarget = null
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.size > 1) {
      // Second finger → pinch belongs to the chart. Abort feed drag / pending long press / plaque drag.
      clearLongPress()
      if (mode.value === 'feed') h.onFeedEnd(0)
      if (mode.value === 'level') h.onLevelEnd?.(0, 0, { tap: false, cancelled: true })
      if (mode.value !== 'ignored' && mode.value !== 'longpress') mode.value = 'multi'
      return
    }

    start = { x: e.clientX, y: e.clientY, t: e.timeStamp }
    last = { x: e.clientX, y: e.clientY }
    startTarget = e.target
    startIsTouch = e.pointerType === 'touch'
    startPointerType = e.pointerType || 'touch'
    velocity.reset()
    velocity.add(e.timeStamp, e.clientY)

    if (isInEdgeDeadZone(e.clientX, cfg)) {
      mode.value = 'ignored' // item 6: leave the edge to the browser's back swipe
      return
    }
    // Buttons/toasts over the chart: a plain tap must stay a click — no plaque grab, no long press.
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) {
      mode.value = 'pending'
      return
    }
    const target = h.hitTest?.(e) ?? 'none'
    if (target === 'level') {
      mode.value = 'level'
      return
    }
    if (target === 'priceAxis') {
      mode.value = 'chart'
      return
    }
    mode.value = 'pending'
    if (h.onLongPress && e.pointerType !== 'mouse') {
      longPressTimer = setTimeout(() => {
        longPressTimer = null
        if (mode.value !== 'pending' || pointers.size !== 1) return
        mode.value = 'longpress' // item 2
        h.onLongPress?.({ x: last.x, y: last.y, pointerType: startPointerType })
      }, LONG_PRESS_MS)
    }
  }

  function onPointerMove(e: PointerEvent) {
    const p = pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (pointers.size > 1) return

    last = { x: e.clientX, y: e.clientY }
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    velocity.add(e.timeStamp, e.clientY)

    if (longPressTimer && exceedsLongPressSlop(dx, dy, LONG_PRESS_SLOP)) clearLongPress()

    if (mode.value === 'pending') {
      const dir = resolveDirection(dx, dy, cfg) // item 3
      if (dir) {
        clearLongPress()
        clearClick() // click then immediately pan/swipe → that click was not a placement
        mode.value = dir
      }
      if (dir === 'feed') cancelChartLongTap()
    }
    if (mode.value === 'feed') h.onFeedMove(dy)
    else if (mode.value === 'level') h.onLevelMove?.(dx, dy, { x: e.clientX, y: e.clientY, pointerType: startPointerType })
    blockIfOwned(e)
  }

  function onPointerEnd(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    if (pointers.size > 0) return // wait for the last finger

    const dy = e.clientY - start.y
    const dx = e.clientX - start.x
    const cancelled = e.type === 'pointercancel'
    const isTap = !cancelled && e.timeStamp - start.t <= cfg.tapMaxMs && Math.hypot(dx, dy) < LONG_PRESS_SLOP
    if (mode.value === 'feed') {
      h.onFeedEnd(cancelled ? 0 : swipeOutcome(dy, velocity.velocity(), h.height(), cfg)) // item 4
    } else if (mode.value === 'level') {
      h.onLevelEnd?.(dx, dy, { tap: isTap, cancelled })
    } else if (mode.value === 'pending' && isTap) {
      const interactive = startTarget instanceof Element && startTarget.closest(INTERACTIVE)
      if (!interactive) {
        const tap: Tap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
        if (isDoubleTap(lastTap, tap, cfg)) {
          lastTap = null
          clearClick() // the first click of a double-click must not place a level
          h.onDoubleTap?.({ x: tap.x, y: tap.y })
        } else {
          lastTap = tap
          if (startPointerType === 'mouse' && h.onMouseClick && isMouseClick(e.timeStamp - start.t, dx, dy)) {
            clearClick()
            clickTimer = setTimeout(() => {
              clickTimer = null
              h.onMouseClick?.({ x: tap.x, y: tap.y })
            }, cfg.doubleTapMs)
          }
        }
      }
    }
    reset()
  }

  /**
   * lightweight-charts arms a 240 ms long-tap timer on touchstart (→ crosshair tracking mode) and
   * clears it only on its own touchmove/touchcancel. We block its touchmoves while we own the gesture,
   * so send it a touchcancel (its handler only clears that timer). touchend is deliberately NOT
   * swallowed: LWC resets its active-touch id there and would ignore every later touch otherwise.
   */
  function cancelChartLongTap() {
    if (startIsTouch && startTarget) startTarget.dispatchEvent(new Event('touchcancel', { bubbles: true }))
  }

  function onTouchStart(e: Event) {
    // Edge zone and plaque touches never reach the chart, so LWC arms nothing.
    if (mode.value === 'ignored' || mode.value === 'level') {
      e.stopPropagation()
      return
    }
    // Long press belongs to levels (item 2): disarm LWC's 240 ms long-tap crosshair right after its
    // touchstart handler ran, so our 400 ms long press is never pre-empted by tracking mode.
    if (mode.value === 'pending' && h.onLongPress) setTimeout(cancelChartLongTap, 0)
  }

  /**
   * While we own the gesture (undecided, feed, edge zone, level, long press), stop move events in the
   * capture phase so lightweight-charts (which listens on its own canvas / document) never pans.
   */
  function owned(): boolean {
    const m = mode.value
    return m === 'pending' || m === 'feed' || m === 'ignored' || m === 'level' || m === 'longpress'
  }
  function blockIfOwned(e: Event) {
    if (owned()) e.stopPropagation()
  }

  const listeners: [string, (e: never) => void][] = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerEnd],
    ['pointercancel', onPointerEnd],
    ['touchstart', onTouchStart],
    ['touchmove', blockIfOwned],
    ['mousemove', blockIfOwned],
  ]

  onMounted(() => {
    const node = el.value
    if (!node) return
    for (const [type, fn] of listeners) node.addEventListener(type, fn as EventListener, { capture: true, passive: true })
  })
  onBeforeUnmount(() => {
    clearLongPress()
    clearClick()
    const node = el.value
    if (!node) return
    for (const [type, fn] of listeners) node.removeEventListener(type, fn as EventListener, { capture: true })
  })

  return { mode: readonly(mode) }
}
