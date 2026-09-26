<script setup lang="ts">
// Tap on a level plaque → this sheet (F4): price/TF info, note ≤ 140 characters, delete (with undo toast).
import { computed, ref, watch } from 'vue'
import { tickDecimals } from '~/lib/binance/parse'
import { tfLabel } from '~/lib/feed/tf'
import { NOTE_MAX } from '~/lib/levels/model'
import { useFeedStore } from '~/stores/feed'
import { useLevelsStore } from '~/stores/levels'

const levels = useLevelsStore()
const feed = useFeedStore()

const level = computed(() => (levels.editingId ? levels.byId(levels.editingId) : undefined))
const note = ref('')
watch(
  level,
  (l) => {
    note.value = l?.note ?? ''
  },
  { immediate: true },
)

const remaining = computed(() => NOTE_MAX - Array.from(note.value).length)
const priceText = computed(() => {
  const l = level.value
  if (!l) return ''
  const d = tickDecimals(feed.tickSize(l.symbol))
  return l.price.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d })
})

function close() {
  const l = level.value
  // Save on close; the model trims and caps the note at 140 characters.
  if (l && (note.value.trim() || null) !== l.note) levels.setNote(l.id, note.value)
  levels.editingId = null
}

function remove() {
  const l = level.value
  if (l) levels.remove(l.id)
  levels.editingId = null
}
</script>

<template>
  <div v-if="level" class="sheet-backdrop" data-gesture-ignore @click.self="close">
    <section class="sheet" role="dialog" aria-label="Уровень">
      <header class="sheet-head">
        <h2>
          <span class="dot" />{{ level.symbol.replace(/USDT$/, '') }} · {{ priceText }}
          <small>поставлен на {{ tfLabel(level.tf) }}</small>
        </h2>
        <button type="button" class="close" aria-label="Закрыть" @click="close">✕</button>
      </header>

      <label class="field">
        <span>Заметка</span>
        <textarea v-model="note" rows="3" :maxlength="NOTE_MAX" placeholder="Например: ретест, ложный пробой…" />
        <span class="counter" :class="{ warn: remaining < 10 }">{{ remaining }}</span>
      </label>

      <div class="buttons">
        <button type="button" class="danger" @click="remove">Удалить уровень</button>
        <button type="button" class="primary" @click="close">Готово</button>
      </div>
      <p class="hint">Перетащите плашку уровня вверх/вниз, чтобы сдвинуть; смахните вправо — удалить.</p>
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
  font-variant-numeric: tabular-nums;
}
h2 small {
  display: block;
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 400;
}
.dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  margin-right: 8px;
  border-radius: 50%;
  background: #ffb300;
}
.close {
  width: 44px;
  height: 44px;
  font-size: 18px;
  color: var(--text-dim);
}
.field {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-dim);
}
textarea {
  width: 100%;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  /* 16 px avoids iOS zoom-on-focus */
  font: 16px/1.35 system-ui, sans-serif;
  resize: none;
  touch-action: manipulation;
}
.counter {
  position: absolute;
  right: 8px;
  bottom: 6px;
  font-size: 11px;
}
.counter.warn {
  color: var(--down);
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
  font-size: 15px;
}
.danger {
  background: var(--surface-2);
  color: var(--down);
}
.primary {
  background: var(--accent);
  color: #0b0e11;
  font-weight: 600;
}
.hint {
  margin: 10px 0 0;
  color: var(--text-dim);
  font-size: 12px;
}
</style>
