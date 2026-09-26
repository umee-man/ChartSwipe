<script setup lang="ts">
// «Скрытые» sheet: hidden tickers with per-ticker «Вернуть» and «Вернуть все».
// Hidden tickers are excluded from every feed source until returned here.
import { useWatchlistsStore } from '~/stores/watchlists'

const emit = defineEmits<{ close: [] }>()
const watchlists = useWatchlistsStore()
</script>

<template>
  <div class="sheet-backdrop" data-gesture-ignore @click.self="emit('close')">
    <section class="sheet" role="dialog" aria-label="Скрытые тикеры">
      <header class="sheet-head">
        <h2>Скрытые · {{ watchlists.hidden.length }}</h2>
        <button type="button" class="close" aria-label="Закрыть" @click="emit('close')">✕</button>
      </header>

      <p v-if="watchlists.hidden.length === 0" class="hint">Скрытых тикеров нет.</p>
      <ul v-else class="list">
        <li v-for="s in watchlists.hidden" :key="s">
          <span class="sym">{{ s.replace(/USDT$/, '') }}<small>USDT</small></span>
          <button type="button" class="restore" :aria-label="`Вернуть ${s}`" @click="watchlists.unhide(s)">Вернуть</button>
        </li>
      </ul>

      <div class="buttons">
        <button type="button" class="primary" :disabled="watchlists.hidden.length === 0" @click="watchlists.unhideAll()">
          Вернуть все
        </button>
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
  touch-action: none;
}
.sheet {
  width: 100%;
  max-height: 80vh;
  max-height: 80dvh;
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
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  touch-action: pan-y;
  overscroll-behavior: contain;
  -webkit-overflow-scrolling: touch;
}
.list li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  border-bottom: 1px solid var(--border);
}
.sym {
  font-weight: 600;
}
.sym small {
  margin-left: 2px;
  color: var(--text-dim);
  font-weight: 400;
}
.restore {
  padding: 10px 12px;
  color: var(--accent);
  font-size: 14px;
  font-weight: 600;
}
.buttons {
  margin-top: 12px;
}
.buttons button {
  width: 100%;
  min-height: 48px;
  border-radius: 12px;
  font-size: 15px;
}
.buttons .primary {
  background: var(--accent);
  color: #0b0e11;
  font-weight: 600;
}
.buttons button:disabled {
  opacity: 0.4;
}
.hint {
  color: var(--text-dim);
  font-size: 14px;
}
</style>
