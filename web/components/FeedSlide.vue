<script setup lang="ts">
// One slide of the vertical feed: the chart area of a single ticker.
// Level labels (LevelLabel) will be layered here in days 4–6.
import { ref } from 'vue'
import type { Interval } from '~/lib/binance/types'
import ChartView from './ChartView.vue'

defineProps<{
  symbol: string
  tf: Interval
  showVolume: boolean
  tickSize: number
}>()

const chart = ref<InstanceType<typeof ChartView> | null>(null)

defineExpose({
  resetView: () => chart.value?.resetView(),
  priceAxisWidth: () => chart.value?.priceAxisWidth() ?? 0,
  clearCrosshair: () => chart.value?.clearCrosshair(),
})
</script>

<template>
  <div class="feed-slide">
    <ChartView ref="chart" :symbol="symbol" :tf="tf" :show-volume="showVolume" :tick-size="tickSize" />
  </div>
</template>

<style scoped>
.feed-slide {
  position: absolute;
  inset: 0; /* full width: actions live in the bottom row (ADR A14) */
}
</style>
