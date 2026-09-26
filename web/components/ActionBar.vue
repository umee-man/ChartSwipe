<script setup lang="ts">
// Bottom action row under the TF bar (ADR A14, arch §5.8): favorite, hide, levels list, favorites list,
// screenshot (A19). Since A16 there is a single level type, so the type selector is gone; levels are
// placed by a long press on the chart. Lives outside the feed pager, so touches here never reach the
// gesture arbiter — taps are plain clicks and swipes do nothing.
import { computed } from 'vue'
import { useLevelsStore } from '~/stores/levels'
import { useWatchlistsStore } from '~/stores/watchlists'

const props = defineProps<{ symbol: string | undefined; busy?: boolean }>()
const emit = defineEmits<{ hidden: [symbol: string]; 'open-favorites': []; 'open-levels': []; screenshot: [] }>()

const watchlists = useWatchlistsStore()
const levels = useLevelsStore()

const isFav = computed(() => (props.symbol ? watchlists.isFavorite(props.symbol) : false))
const levelCount = computed(() => levels.alive.length)

function hide() {
  if (!props.symbol) return
  watchlists.hide(props.symbol)
  emit('hidden', props.symbol)
}
</script>

<template>
  <nav class="action-bar" aria-label="Действия">
    <button
      type="button"
      class="act"
      :class="{ on: isFav }"
      :disabled="!symbol"
      :aria-pressed="isFav"
      :aria-label="isFav ? 'Убрать из избранного' : 'В избранное'"
      @click="symbol && watchlists.toggleFavorite(symbol)"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"
          :fill="isFav ? 'currentColor' : 'none'"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
      <span>Избранное</span>
    </button>

    <button type="button" class="act" :disabled="!symbol" aria-label="Скрыть тикер" @click="hide">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" />
        <circle cx="12" cy="12" r="2.5" />
        <path d="M4 4l16 16" />
      </svg>
      <span>Скрыть</span>
    </button>

    <button
      type="button"
      class="act levels"
      :aria-label="`Уровни: ${levelCount}. Чтобы поставить уровень, удерживайте палец на графике`"
      @click="emit('open-levels')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M3 8h18" />
        <path d="M3 16h18" stroke-dasharray="3 3" />
      </svg>
      <span>Уровни{{ levelCount ? ` ${levelCount}` : '' }}</span>
    </button>

    <button type="button" class="act" aria-label="Список избранного" @click="emit('open-favorites')">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">
        <path d="M8 6h12M8 12h12M8 18h12" />
        <circle cx="4" cy="6" r="1" fill="currentColor" />
        <circle cx="4" cy="12" r="1" fill="currentColor" />
        <circle cx="4" cy="18" r="1" fill="currentColor" />
      </svg>
      <span>Список</span>
    </button>

    <button
      type="button"
      class="act"
      :disabled="!symbol || busy"
      aria-label="Скриншот графика: поделиться или сохранить PNG"
      @click="emit('screenshot')"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
        <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
        <circle cx="12" cy="13" r="3.5" />
      </svg>
      <span>Скрин</span>
    </button>
  </nav>
</template>

<style scoped>
.action-bar {
  flex: 0 0 auto;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  align-items: stretch;
  /* Bottom-most row owns the home-indicator safe area (the TF bar above no longer does). */
  height: calc(var(--actions-h) + env(safe-area-inset-bottom));
  padding: 0 max(4px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(4px, env(safe-area-inset-left));
  background: var(--surface);
  /* Taps only: no browser pan/zoom, no double-tap delay; not part of the feed gesture area. */
  touch-action: manipulation;
  overscroll-behavior: none;
  user-select: none;
  -webkit-user-select: none;
}
.act {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  min-width: 0;
  min-height: 44px;
  color: var(--text);
  font-size: 10px;
  line-height: 1.1;
  -webkit-touch-callout: none;
}
.act span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.act svg {
  width: 22px;
  height: 22px;
}
.act:active:not(:disabled) {
  background: var(--surface-2);
  border-radius: 10px;
}
.act.levels {
  color: #ffb300;
}
.act.on {
  color: #f5c518;
}
.act:disabled {
  opacity: 0.35;
}
</style>
