<script setup lang="ts">
// Vertical virtual feed: only 3 slides (prev / current / next) live in the DOM (arch §5.2).
// Custom pager with CSS transforms instead of Swiper (ADR A11); every gesture decision is made
// by useGestures (arch §5.3), the pager just animates.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { domSlots } from '~/lib/feed/window'
import { rubberBand, type GestureTarget } from '~/lib/gestures/arbiter'
import { useGestures } from '~/composables/useGestures'
import { useFeedStore } from '~/stores/feed'
import { useSettingsStore } from '~/stores/settings'
import FeedSlide from './FeedSlide.vue'

const ANIM_MS = 220

const feed = useFeedStore()
const settings = useSettingsStore()

const root = ref<HTMLDivElement | null>(null)
const offset = ref(0)
const animating = ref(false)
let animTimer: ReturnType<typeof setTimeout> | null = null
/** Direction of the running settle animation, committed early if the user grabs the feed again. */
let pendingDir: -1 | 0 | 1 = 0

const slots = computed(() => domSlots(feed.symbols, feed.currentIndex))
const hasPrev = computed(() => feed.currentIndex > 0)
const hasNext = computed(() => feed.currentIndex < feed.symbols.length - 1)

type SlideApi = { resetView: () => void; priceAxisWidth: () => number; clearCrosshair: () => void }
const slideRefs = new Map<string, SlideApi>()
function setSlideRef(symbol: string, el: unknown) {
  if (el) slideRefs.set(symbol, el as SlideApi)
  else slideRefs.delete(symbol)
}
const currentSlide = () => (feed.currentSymbol ? slideRefs.get(feed.currentSymbol) : undefined)

function height(): number {
  return root.value?.clientHeight ?? window.innerHeight
}

function finishAnimation(dir: -1 | 0 | 1) {
  if (animTimer) clearTimeout(animTimer)
  animTimer = null
  animating.value = false
  offset.value = 0
  if (dir !== 0) feed.setIndex(feed.currentIndex + dir)
}

/** Animate to the neighbour (dir ±1) or back to rest (0), then commit the index. */
function settle(dir: -1 | 0 | 1) {
  if ((dir === 1 && !hasNext.value) || (dir === -1 && !hasPrev.value)) dir = 0
  const target = -dir * height()
  if (offset.value === target) {
    finishAnimation(dir)
    return
  }
  animating.value = true
  pendingDir = dir
  offset.value = target
  // transitionend is not guaranteed (e.g. tab hidden) — fall back to a timer.
  animTimer = setTimeout(() => finishAnimation(dir), ANIM_MS + 50)
}

/** A new gesture/key during the 220 ms settle animation completes it instantly instead of being dropped. */
function interruptAnimation() {
  if (animating.value) finishAnimation(pendingDir)
}

function go(dir: -1 | 1) {
  interruptAnimation()
  settle(dir)
}

useGestures(root, {
  height,
  onFeedMove(dy) {
    interruptAnimation()
    const atEdge = (dy < 0 && !hasNext.value) || (dy > 0 && !hasPrev.value)
    offset.value = atEdge ? rubberBand(dy) : dy
  },
  onFeedEnd(outcome) {
    interruptAnimation()
    // A long press before the swipe may have put the chart into crosshair tracking mode.
    currentSlide()?.clearCrosshair()
    settle(outcome)
  },
  onDoubleTap() {
    currentSlide()?.resetView()
  },
  hitTest(e): GestureTarget {
    // Vertical drag on the price axis scales price (arch §5.3 item 5) → chart owns it.
    const rect = root.value?.getBoundingClientRect()
    const slideEl = root.value?.querySelector<HTMLElement>('.slide.is-current .feed-slide')
    if (!rect || !slideEl) return 'none'
    const chartRight = slideEl.getBoundingClientRect().right
    const axis = currentSlide()?.priceAxisWidth() ?? 0
    if (e.clientX <= chartRight && e.clientX >= chartRight - axis) return 'priceAxis'
    // Days 4–6: return 'level' when the pointer is on a level label (item 1).
    return 'none'
  },
})

function onKey(e: KeyboardEvent) {
  // Desktop convenience for development.
  if (e.key === 'ArrowDown' || e.key === 'PageDown') go(1)
  else if (e.key === 'ArrowUp' || e.key === 'PageUp') go(-1)
}

onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  if (animTimer) clearTimeout(animTimer)
})

defineExpose({ go, resetCurrent: () => nextTick(() => currentSlide()?.resetView()) })
</script>

<template>
  <div ref="root" class="pager">
    <div
      class="track"
      :class="{ animating }"
      :style="{ transform: `translate3d(0, ${offset}px, 0)` }"
    >
      <div
        v-for="slot in slots"
        :key="slot.symbol"
        class="slide"
        :class="{ 'is-current': slot.offset === 0 }"
        :style="{ transform: `translate3d(0, ${slot.offset * 100}%, 0)` }"
      >
        <FeedSlide
          :ref="(el) => setSlideRef(slot.symbol, el)"
          :symbol="slot.symbol"
          :tf="settings.activeTf"
          :show-volume="settings.showVolume"
          :tick-size="feed.tickSize(slot.symbol)"
        />
      </div>
    </div>
    <div v-if="feed.symbols.length === 0" class="empty">
      {{ feed.source === 'movers' ? 'Сегодня нет монет с движением больше 5%' : 'Список пуст' }}
    </div>
    <slot />
  </div>
</template>

<style scoped>
.pager {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
  /* The arbiter owns every gesture: no browser scroll, zoom, or pull-to-refresh here. */
  touch-action: none;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.track {
  position: absolute;
  inset: 0;
  will-change: transform;
}
.track.animating {
  transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.slide {
  position: absolute;
  inset: 0;
  contain: strict;
}
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--text-dim);
  font-size: 15px;
}
</style>
