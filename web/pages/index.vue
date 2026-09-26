<script setup lang="ts">
// Feed screen: `/` opens straight into the feed, no login or setup (ADR A9, A10).
// Orchestrates preloading, the memory window and live WS streams (arch §4, §5.2).
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { liveSymbols, memorySymbols, preloadSymbols } from '~/lib/feed/window'
import { useCandles } from '~/composables/useCandles'
import { useFeedStore } from '~/stores/feed'
import { useSettingsStore } from '~/stores/settings'
import { useWatchlistsStore } from '~/stores/watchlists'

/** "Stopped on a slide" = index unchanged for this long; then preload neighbours. */
const SETTLE_MS = 250
const UNDO_MS = 4000

const feed = useFeedStore()
const settings = useSettingsStore()
const watchlists = useWatchlistsStore()
const candles = useCandles()

let settleTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => [feed.symbols, feed.currentIndex, settings.activeTf] as const,
  ([list, index, tf]) => {
    // Live candle for current + 2 neighbours only (≤ 3 streams, arch §10).
    candles.setLive(liveSymbols(list, index), tf)
    // Memory budget: keep candles for ±3 tickers only.
    candles.retain(memorySymbols(list, index))

    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => {
      const cur = list[index]
      // Current ticker: all 3 TFs in parallel so TF switches are instant (F3).
      if (cur) candles.preload([cur], settings.tfButtons)
      // Then the 2 next tickers, all TFs.
      candles.preload(preloadSymbols(list, index), settings.tfButtons)
    }, SETTLE_MS)
  },
  { immediate: true },
)

const favoritesOpen = ref(false)
const hiddenOpen = ref(false)

// Hide with undo toast.
const lastHidden = ref<string | null>(null)
let undoTimer: ReturnType<typeof setTimeout> | null = null
function onHidden(symbol: string) {
  lastHidden.value = symbol
  if (undoTimer) clearTimeout(undoTimer)
  undoTimer = setTimeout(() => (lastHidden.value = null), UNDO_MS)
}
function undoHide() {
  if (lastHidden.value) watchlists.unhide(lastHidden.value)
  lastHidden.value = null
}

onMounted(() => void feed.init())
onBeforeUnmount(() => {
  if (settleTimer) clearTimeout(settleTimer)
  if (undoTimer) clearTimeout(undoTimer)
})
</script>

<template>
  <main class="feed">
    <FeedHeader @open-favorites="favoritesOpen = true" @open-hidden="hiddenOpen = true" />
    <FeedPager>
      <div v-if="lastHidden" class="toast" data-gesture-ignore>
        <span>{{ lastHidden }} скрыт</span>
        <button type="button" @click="undoHide">Вернуть</button>
      </div>
      <div v-if="feed.error && feed.symbols.length > 0" class="toast error" data-gesture-ignore>Binance: {{ feed.error }}</div>
    </FeedPager>
    <TfBar />
    <ActionBar :symbol="feed.currentSymbol" @hidden="onHidden" @open-favorites="favoritesOpen = true" />
    <FavoritesSheet v-if="favoritesOpen" @close="favoritesOpen = false" />
    <HiddenSheet v-if="hiddenOpen" @close="hiddenOpen = false" />
  </main>
</template>

<style scoped>
.feed {
  display: flex;
  flex-direction: column;
  height: 100vh; /* fallback for browsers without dvh */
  height: 100dvh;
  width: 100%;
  overflow: hidden;
}
.toast {
  position: absolute;
  left: 50%;
  bottom: 16px;
  transform: translateX(-50%);
  z-index: 6;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  font-size: 14px;
  white-space: nowrap;
}
.toast button {
  color: var(--accent);
  font-weight: 600;
}
.toast.error {
  color: var(--down);
  white-space: normal;
  width: max-content;
  max-width: calc(100% - 32px);
  font-size: 12px;
}
</style>
