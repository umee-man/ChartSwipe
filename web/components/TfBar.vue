<script setup lang="ts">
// Bottom timeframe bar, 64 px in the thumb zone (F3). Switching only changes the active TF;
// ChartView redraws from memory (arch §5.2, < 100 ms).
import type { Interval } from '~/lib/binance/types'
import { useSettingsStore } from '~/stores/settings'

const settings = useSettingsStore()

const LABELS: Partial<Record<Interval, string>> = {
  '1m': '1м', '3m': '3м', '5m': '5м', '15m': '15м', '30m': '30м',
  '1h': '1ч', '2h': '2ч', '4h': '4ч', '6h': '6ч', '8h': '8ч', '12h': '12ч',
  '1d': 'Д', '3d': '3Д', '1w': 'Н', '1M': 'М',
}
const label = (tf: Interval) => LABELS[tf] ?? tf
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
  grid-template-columns: repeat(3, 1fr);
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
