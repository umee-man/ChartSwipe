// Gesture arbiter over pointer events (arch §5.3). Decides feed swipe vs chart pan so that neither
// the browser nor lightweight-charts steals the gesture. Items 3–6 are implemented; items 1–2
// (level drag, long press → new level) plug in through `hitTest` returning 'level' and `onLongPress`.
import { onBeforeUnmount, onMounted, readonly, ref, type Ref } from 'vue'
import {
  DEFAULT_GESTURE_CONFIG,
  isDoubleTap,
  isInEdgeDeadZone,
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
   * Classify the pointer-down target before direction locking.
   * 'priceAxis' → chart immediately (vertical drag scales price, item 5).
   * 'level' → reserved for item 1 (level label drag), feed and pan are blocked.
   */
  hitTest?(e: PointerEvent): GestureTarget
  /** Reserved for item 2 (long press 400 ms → new level). Not wired yet. */
  onLongPress?(p: { x: number; y: number }): void
}

/** Elements that handle their own taps (buttons, menus) never produce double-tap resets. */
const INTERACTIVE = 'button, a, input, select, textarea, [data-gesture-ignore]'

export function useGestures(el: Ref<HTMLElement | null>, h: GestureHandlers, cfg: GestureConfig = DEFAULT_GESTURE_CONFIG) {
  const mode = ref<GestureMode>('idle')
  const pointers = new Map<number, { x: number; y: number }>()
  const velocity = new VelocityTracker(cfg.velocityWindowMs)
  let start = { x: 0, y: 0, t: 0 }
  let startTarget: EventTarget | null = null
  let lastTap: Tap | null = null

  function reset() {
    mode.value = 'idle'
    velocity.reset()
    startTarget = null
  }

  function onPointerDown(e: PointerEvent) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.size > 1) {
      // Second finger → pinch belongs to the chart. Abort any feed drag in progress.
      if (mode.value === 'feed') h.onFeedEnd(0)
      if (mode.value !== 'ignored') mode.value = 'multi'
      return
    }

    start = { x: e.clientX, y: e.clientY, t: e.timeStamp }
    startTarget = e.target
    velocity.reset()
    velocity.add(e.timeStamp, e.clientY)

    if (isInEdgeDeadZone(e.clientX, cfg)) {
      mode.value = 'ignored' // item 6: leave the edge to the browser's back swipe
      return
    }
    const target = h.hitTest?.(e) ?? 'none'
    if (target === 'level') mode.value = 'level'
    else if (target === 'priceAxis') mode.value = 'chart'
    else mode.value = 'pending'
  }

  function onPointerMove(e: PointerEvent) {
    const p = pointers.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (pointers.size > 1) return

    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    velocity.add(e.timeStamp, e.clientY)

    if (mode.value === 'pending') {
      const dir = resolveDirection(dx, dy, cfg) // item 3
      if (dir) mode.value = dir
    }
    if (mode.value === 'feed') h.onFeedMove(dy)
    blockIfOwned(e)
  }

  function onPointerEnd(e: PointerEvent) {
    if (!pointers.has(e.pointerId)) return
    pointers.delete(e.pointerId)
    if (pointers.size > 0) return // wait for the last finger

    const dy = e.clientY - start.y
    const dx = e.clientX - start.x
    if (mode.value === 'feed') {
      const outcome = e.type === 'pointercancel' ? 0 : swipeOutcome(dy, velocity.velocity(), h.height(), cfg) // item 4
      h.onFeedEnd(outcome)
    } else if (mode.value === 'pending' && e.type === 'pointerup') {
      const isTap = e.timeStamp - start.t <= cfg.tapMaxMs && Math.hypot(dx, dy) < cfg.lockDistance
      const interactive = startTarget instanceof Element && startTarget.closest(INTERACTIVE)
      if (isTap && !interactive) {
        const tap: Tap = { t: e.timeStamp, x: e.clientX, y: e.clientY }
        if (isDoubleTap(lastTap, tap, cfg)) {
          lastTap = null
          h.onDoubleTap?.({ x: tap.x, y: tap.y })
        } else {
          lastTap = tap
        }
      }
    }
    reset()
  }

  /**
   * While we own the gesture (undecided, feed, edge zone, level), stop move events in the capture
   * phase so lightweight-charts (which listens on its own canvas) never starts panning.
   */
  function owned(): boolean {
    return mode.value === 'pending' || mode.value === 'feed' || mode.value === 'ignored' || mode.value === 'level'
  }
  function blockIfOwned(e: Event) {
    if (owned()) e.stopPropagation()
  }

  const listeners: [string, (e: never) => void][] = [
    ['pointerdown', onPointerDown],
    ['pointermove', onPointerMove],
    ['pointerup', onPointerEnd],
    ['pointercancel', onPointerEnd],
    ['touchmove', blockIfOwned],
    ['mousemove', blockIfOwned],
  ]

  onMounted(() => {
    const node = el.value
    if (!node) return
    for (const [type, fn] of listeners) node.addEventListener(type, fn as EventListener, { capture: true, passive: true })
  })
  onBeforeUnmount(() => {
    const node = el.value
    if (!node) return
    for (const [type, fn] of listeners) node.removeEventListener(type, fn as EventListener, { capture: true })
  })

  return { mode: readonly(mode) }
}
