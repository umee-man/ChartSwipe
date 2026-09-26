<script setup lang="ts">
// «Уровни» list (F4): all levels grouped by ticker with search; tap a ticker/level → jump to that
// ticker in the feed; per-level delete (undo toast on the feed).
import { computed, ref } from 'vue'
import { tickDecimals } from '~/lib/binance/parse'
import { tfLabel } from '~/lib/feed/tf'
import { groupBySymbol } from '~/lib/levels/model'
import { useFeedStore } from '~/stores/feed'
import { useLevelsStore } from '~/stores/levels'

const emit = defineEmits<{ close: [] }>()
const levels = useLevelsStore()
const feed = useFeedStore()
const query = ref('')

const groups = computed(() => groupBySymbol(levels.all, query.value))

function fmt(symbol: string, price: number): string {
  const d = tickDecimals(feed.tickSize(symbol))
  return price.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })
}

function open(symbol: string) {
  feed.focusSymbol(symbol)
  emit('close')
}
</script>

<template>
  <div class="sheet-backdrop" data-gesture-ignore @click.self="emit('close')">
    <section class="sheet" role="dialog" aria-label="Уровни">
      <header class="sheet-head">
        <h2>Уровни · {{ levels.alive.length }}</h2>
        <button type="button" class="close" aria-label="Закрыть" @click="emit('close')">✕</button>
      </header>
      <input v-model="query" class="search" type="search" placeholder="Поиск: тикер или заметка" autocomplete="off" />

      <p v-if="levels.alive.length === 0" class="hint">
        Уровней пока нет. Удерживайте палец на графике ~0,5 с — появится уровень у ближайшего хая/лоя.
      </p>
      <p v-else-if="groups.length === 0" class="hint">Ничего не найдено.</p>
      <div v-else class="list">
        <section v-for="g in groups" :key="g.symbol" class="group">
          <button type="button" class="ticker" @click="open(g.symbol)">
            {{ g.symbol.replace(/USDT$/, '') }}<small>USDT · {{ g.levels.length }}</small>
            <span class="go">Открыть ›</span>
          </button>
          <div v-for="l in g.levels" :key="l.id" class="row">
            <button type="button" class="level" @click="open(g.symbol)">
              <span class="price">{{ fmt(l.symbol, l.price) }}</span>
              <span class="tf">{{ tfLabel(l.tf) }}</span>
              <span v-if="l.note" class="note">{{ l.note }}</span>
            </button>
            <button type="button" class="remove" :aria-label="`Удалить уровень ${fmt(l.symbol, l.price)}`" @click="levels.remove(l.id)">
              ✕
            </button>
          </div>
        </section>
      </div>
    </section>
  </div>
</template>

<style scoped>
.sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: flex-end;
  background: rgba(0, 0, 0, 0.55);
}
.sheet {
  width: 100%;
  max-height: 85vh;
  max-height: 85dvh;
  display: flex;
  flex-direction: column;
  padding: 12px 16px calc(16px + env(safe-area-inset-bottom));
  border-radius: 18px 18px 0 0;
  background: var(--surface);
  border-top: 1px solid var(--border);
}
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
h2 {
  margin: 4px 0 8px;
  font-size: 17px;
}
.close {
  width: 44px;
  height: 44px;
  font-size: 18px;
  color: var(--text-dim);
}
.search {
  width: 100%;
  min-height: 44px;
  margin-bottom: 8px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  font: 16px system-ui, sans-serif; /* 16 px avoids iOS zoom-on-focus */
}
.list {
  overflow-y: auto;
  touch-action: pan-y;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.group {
  padding: 4px 0 8px;
  border-bottom: 1px solid var(--border);
}
.ticker {
  display: flex;
  align-items: baseline;
  gap: 6px;
  width: 100%;
  min-height: 40px;
  font-weight: 700;
  font-size: 15px;
  text-align: left;
}
.ticker small {
  color: var(--text-dim);
  font-weight: 400;
  font-size: 12px;
}
.go {
  margin-left: auto;
  color: var(--accent);
  font-size: 13px;
  font-weight: 600;
}
.row {
  display: flex;
  align-items: center;
}
.level {
  flex: 1;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  min-height: 40px;
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.price {
  color: #ffcf57;
}
.tf {
  color: var(--text-dim);
  font-size: 11px;
}
.note {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 13px;
}
.remove {
  width: 44px;
  height: 40px;
  color: var(--down);
}
.hint {
  color: var(--text-dim);
  font-size: 14px;
}
</style>
