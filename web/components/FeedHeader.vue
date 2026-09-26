<script setup lang="ts">
// 48 px header: ticker, last price, 24h %, exchange label, feed source menu.
import { computed, ref, toRef } from 'vue'
import { tickDecimals } from '~/lib/binance/parse'
import { FEED_SOURCES, type FeedSourceId } from '~/lib/feed/sources'
import { CHART_TYPE_LABELS } from '~/lib/chart/type'
import { useLastPrice } from '~/composables/useCandles'
import { useFeedStore } from '~/stores/feed'
import { useSettingsStore } from '~/stores/settings'
import { useWatchlistsStore } from '~/stores/watchlists'

const emit = defineEmits<{ 'open-favorites': []; 'open-hidden': [] }>()

const feed = useFeedStore()
const settings = useSettingsStore()
const watchlists = useWatchlistsStore()
const menuOpen = ref(false)

function openFavorites() {
  menuOpen.value = false
  emit('open-favorites')
}

function openHidden() {
  menuOpen.value = false
  emit('open-hidden')
}

const symbol = toRef(feed, 'currentSymbol')
const livePrice = useLastPrice(symbol, toRef(settings, 'activeTf'))

const ticker = computed(() => (feed.currentSymbol ? feed.tickers[feed.currentSymbol] : undefined))
const baseAsset = computed(() => feed.currentSymbol?.replace(/USDT$/, '') ?? '—')

const priceText = computed(() => {
  const sym = feed.currentSymbol
  const p = livePrice.value ?? ticker.value?.lastPrice
  if (!sym || p == null) return '—'
  const d = tickDecimals(feed.tickSize(sym))
  return p.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })
})

const change = computed(() => ticker.value?.priceChangePercent)
const changeText = computed(() => {
  const c = change.value
  if (c == null) return ''
  return `${c > 0 ? '+' : ''}${c.toFixed(2)}%`
})

async function pick(id: FeedSourceId) {
  menuOpen.value = false
  await feed.setSource(id)
}
</script>

<template>
  <header class="header">
    <div class="ticker">
      <span class="sym">{{ baseAsset }}</span>
      <span class="exchange">Binance · Perp</span>
    </div>
    <div class="price">
      <span class="last">{{ priceText }}</span>
      <span v-if="changeText" class="chg" :class="{ up: (change ?? 0) >= 0, down: (change ?? 0) < 0 }">{{ changeText }}</span>
    </div>
    <button type="button" class="source" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">
      {{ feed.sourceLabel }}
      <span class="pos">{{ feed.symbols.length ? `${feed.currentIndex + 1}/${feed.symbols.length}` : '' }}</span>
    </button>

    <div v-if="menuOpen" class="backdrop" @click="menuOpen = false" />
    <div v-if="menuOpen" class="menu" role="menu">
      <button
        v-for="s in FEED_SOURCES"
        :key="s.id"
        type="button"
        role="menuitemradio"
        :aria-checked="feed.source === s.id"
        class="item"
        :class="{ checked: feed.source === s.id }"
        @click="pick(s.id)"
      >
        {{ s.label }}
      </button>
      <hr />
      <button type="button" role="menuitem" class="item" @click="openFavorites">
        Список избранного ({{ watchlists.favorites.length }})…
      </button>
      <button type="button" role="menuitem" class="item" @click="openHidden">
        Скрытые ({{ watchlists.hidden.length }})…
      </button>
      <button type="button" role="menuitemcheckbox" :aria-checked="settings.showVolume" class="item" @click="settings.toggleVolume()">
        Объём: {{ settings.showVolume ? 'вкл' : 'выкл' }}
      </button>
      <button type="button" role="menuitem" class="item" @click="settings.toggleChartType()">
        Вид: {{ CHART_TYPE_LABELS[settings.chartType] }}
        <small class="alt">→ {{ CHART_TYPE_LABELS[settings.chartType === 'candles' ? 'bars' : 'candles'] }}</small>
      </button>
    </div>
  </header>
</template>

<style scoped>
.header {
  position: relative;
  z-index: 10;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  height: calc(var(--header-h) + env(safe-area-inset-top));
  padding: env(safe-area-inset-top) max(12px, env(safe-area-inset-right)) 0 max(12px, env(safe-area-inset-left));
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  touch-action: manipulation;
}
.ticker {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
  min-width: 0;
}
.sym {
  font-size: 17px;
  font-weight: 700;
}
.exchange {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.price {
  display: flex;
  flex-direction: column;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.last {
  font-size: 15px;
  font-weight: 600;
}
.chg {
  font-size: 12px;
}
.up {
  color: var(--up);
}
.down {
  color: var(--down);
}
.source {
  margin-left: auto;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--surface-2);
  font-size: 13px;
  line-height: 1.1;
  max-width: 45vw;
}
.pos {
  font-size: 10px;
  color: var(--text-dim);
}
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
}
.menu {
  position: absolute;
  z-index: 21;
  top: calc(100% + 4px);
  right: 8px;
  min-width: 220px;
  padding: 6px;
  border-radius: 14px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
}
.item {
  display: block;
  width: 100%;
  padding: 12px;
  border-radius: 10px;
  text-align: left;
  font-size: 15px;
}
.item.checked {
  color: var(--accent);
}
.item:active {
  background: var(--surface);
}
.alt {
  margin-left: 6px;
  color: var(--text-dim);
  font-size: 12px;
}
hr {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}
</style>
