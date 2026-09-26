<script setup lang="ts">
// Bottom timeframe bar, 64 px in the thumb zone (F3). 4 buttons by default: 5м · 1ч · Д · Н (A15).
// Switching only changes the active TF; ChartView redraws from memory (arch §5.2, < 100 ms).
import { tfLabel as label } from '~/lib/feed/tf'
import { useSettingsStore } from '~/stores/settings'

const settings = useSettingsStore()
</script>

<template>
  <nav class="tf-bar" aria-label="Таймфрейм">
    <button
      v-for="tf in settings.tfButtons"
      :key="tf"
      type="button"
      class="tf"
      :class="{ active: tf === settings.activeTf }"
      :aria-pressed="tf === settings.activeTf"
      @click="settings.setActiveTf(tf)"
    >
      {{ label(tf) }}
    </button>
  </nav>
</template>

<style scoped>
.tf-bar {
  flex: 0 0 auto;
  display: grid;
  grid-auto-columns: 1fr;
  grid-auto-flow: column;
  gap: 8px;
  height: var(--tfbar-h);
  padding: 8px max(12px, env(safe-area-inset-right)) 8px max(12px, env(safe-area-inset-left));
  background: var(--surface);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  touch-action: manipulation;
}
.tf {
  border-radius: 12px;
  background: var(--surface-2);
  color: var(--text-dim);
  font-size: 17px;
  font-weight: 600;
}
.tf.active {
  background: var(--accent);
  color: #0b0e11;
}
</style>
