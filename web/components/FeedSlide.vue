<script setup lang="ts">
// One slide of the vertical feed: the chart area of a single ticker, with its levels (plaques are
// drawn by ChartView; gestures are resolved by FeedPager/useGestures).
import { ref } from 'vue'
import type { Interval } from '~/lib/binance/types'
import type { Level } from '~/lib/levels/model'
import type { MagnetResult } from '~/lib/levels/magnet'
import type { ChartType } from '~/lib/chart/type'
import ChartView from './ChartView.vue'

defineProps<{
  symbol: string
  tf: Interval
  showVolume: boolean
  tickSize: number
  levels: Level[]
  active: boolean
  dragId?: string | null
  dragDx?: number
  chartType?: ChartType
}>()

const chart = ref<InstanceType<typeof ChartView> | null>(null)

defineExpose({
  resetView: () => chart.value?.resetView(),
  priceAxisWidth: () => chart.value?.priceAxisWidth() ?? 0,
  clearCrosshair: () => chart.value?.clearCrosshair(),
  hitLevel: (x: number, y: number) => chart.value?.hitLevel(x, y) ?? null,
  magnetAt: (x: number, y: number, pointerType: string, touchRadius: number): MagnetResult | null =>
    chart.value?.magnetAt(x, y, pointerType, touchRadius) ?? null,
  priceForDrag: (startPrice: number, dy: number, x: number, pointerType: string, touchRadius: number): MagnetResult | null =>
    chart.value?.priceForDrag(startPrice, dy, x, pointerType, touchRadius) ?? null,
})
</script>

<template>
  <div class="feed-slide">
    <ChartView
      ref="chart"
      :symbol="symbol"
      :tf="tf"
      :show-volume="showVolume"
      :tick-size="tickSize"
      :levels="levels"
      :active="active"
      :drag-id="dragId"
      :drag-dx="dragDx"
      :chart-type="chartType"
    />
  </div>
</template>

<style scoped>
.feed-slide {
  position: absolute;
  inset: 0; /* full width: actions live in the bottom row (ADR A14) */
}
</style>
