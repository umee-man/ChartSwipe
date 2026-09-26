<script setup lang="ts">
// Favorites bottom sheet (arch §5.7): list with remove, «Скачать список» (TradingView .txt), «Скопировать».
import { computed, ref } from 'vue'
import { favoritesFilename, formatTvWatchlist } from '~/lib/favorites/export'
import { copyText, downloadText } from '~/lib/favorites/share'
import { useFeedStore } from '~/stores/feed'
import { useWatchlistsStore } from '~/stores/watchlists'

const emit = defineEmits<{ close: [] }>()

const watchlists = useWatchlistsStore()
const feed = useFeedStore()
const status = ref('')

const text = computed(() => formatTvWatchlist(watchlists.favorites))
const empty = computed(() => watchlists.favorites.length === 0)

function download() {
  downloadText(favoritesFilename(), text.value)
  status.value = 'Файл сохранён'
}

async function copy() {
  status.value = (await copyText(text.value)) ? 'Скопировано' : 'Не удалось скопировать'
}

async function openFeed() {
  await feed.setSource('favorites')
  emit('close')
}
</script>

<template>
  <div class="sheet-backdrop" data-gesture-ignore @click.self="emit('close')">
    <section class="sheet" role="dialog" aria-label="Избранное">
      <header class="sheet-head">
        <h2>Избранное · {{ watchlists.favorites.length }}</h2>
        <button type="button" class="close" aria-label="Закрыть" @click="emit('close')">✕</button>
      </header>

      <p v-if="empty" class="hint">Отмечайте тикеры звёздочкой справа — они появятся здесь.</p>
      <ul v-else class="list">
        <li v-for="s in watchlists.favorites" :key="s">
          <span class="sym">{{ s.replace(/USDT$/, '') }}<small>USDT</small></span>
          <button type="button" class="remove" :aria-label="`Убрать ${s}`" @click="watchlists.toggleFavorite(s)">Убрать</button>
        </li>
      </ul>

      <div class="buttons">
        <button type="button" class="primary" :disabled="empty" @click="download">Скачать список</button>
        <button type="button" :disabled="empty" @click="copy">Скопировать</button>
        <button type="button" :disabled="empty" @click="openFeed">Листать избранное</button>
      </div>
      <p class="hint small">Формат TradingView: импортируйте файл в список наблюдения.</p>
      <p v-if="status" class="status" role="status">{{ status }}</p>
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
  /* Scroll container: only the list scrolls, no chaining to the page. */
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
.remove {
  padding: 10px 12px;
  color: var(--down);
  font-size: 14px;
}
.buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  margin-top: 12px;
}
.buttons button {
  min-height: 48px;
  border-radius: 12px;
  background: var(--surface-2);
  font-size: 15px;
}
.buttons .primary {
  grid-column: 1 / -1;
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
.hint.small {
  margin: 10px 0 0;
  font-size: 12px;
}
.status {
  margin: 6px 0 0;
  color: var(--accent);
  font-size: 13px;
}
</style>
