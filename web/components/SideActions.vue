<script setup lang="ts">
// Right action column: favorite, hide, level type selector (state only for now), screenshot stub.
import { computed } from 'vue'
import { LEVEL_KINDS, useLevelsStore } from '~/stores/levels'
import { useWatchlistsStore } from '~/stores/watchlists'

const props = defineProps<{ symbol: string | undefined }>()
const emit = defineEmits<{ hidden: [symbol: string] }>()

const watchlists = useWatchlistsStore()
const levels = useLevelsStore()

const isFav = computed(() => (props.symbol ? watchlists.isFavorite(props.symbol) : false))
const kind = computed(() => LEVEL_KINDS.find((k) => k.kind === levels.selectedKind) ?? LEVEL_KINDS[0]!)

function hide() {
  if (!props.symbol) return
  watchlists.hide(props.symbol)
  emit('hidden', props.symbol)
}
</script>

<template>
  <aside class="actions" aria-label="Действия">
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
      <span>Избр.</span>
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
      class="act"
      :aria-label="`Тип уровня: ${kind.label}`"
      :style="{ color: kind.color }"
      @click="levels.cycleKind()"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <template v-if="kind.kind === 'zone'">
          <rect x="3" y="8" width="18" height="8" rx="1.5" fill="currentColor" fill-opacity="0.3" />
        </template>
        <path v-else d="M3 12h18" />
      </svg>
      <span>{{ kind.label }}</span>
    </button>

    <button type="button" class="act" disabled aria-label="Скриншот (скоро)">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">
        <path d="M4 8h3l2-2.5h6L17 8h3v11H4z" />
        <circle cx="12" cy="13" r="3.5" />
      </svg>
      <span>Скрин</span>
    </button>
  </aside>
</template>

<style scoped>
.actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: var(--actions-w);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  align-items: center;
  gap: 14px;
  padding: 12px 0 20px;
  padding-right: env(safe-area-inset-right);
  z-index: 5;
}
.act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  width: 48px;
  min-height: 48px;
  color: var(--text);
  font-size: 9px;
  line-height: 1.1;
  text-align: center;
}
.act svg {
  width: 26px;
  height: 26px;
}
.act.on {
  color: #f5c518;
}
.act:disabled {
  opacity: 0.35;
}
</style>
