<script setup lang="ts">
// Candlestick chart for one ticker on lightweight-charts v5 (arch §5.1–5.2).
// setData from memory on TF switch, live update of the last bar, history paging to the left,
// chart.remove() on unmount (slide leaves the virtual window).
import {
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  TickMarkType,
  TrackingModeExitMode,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Candle, Interval } from '~/lib/binance/types'
import { tickDecimals } from '~/lib/binance/parse'
import type { SeriesEvent, SeriesStatus } from '~/lib/candles/store'
import { useCandles } from '~/composables/useCandles'

const props = defineProps<{
  symbol: string
  tf: Interval
  showVolume: boolean
  tickSize: number
}>()

const UP = '#26a69a'
const DOWN = '#ef5350'
const UP_VOL = 'rgba(38,166,154,0.45)'
const DOWN_VOL = 'rgba(239,83,80,0.45)'
/** Start loading older history when fewer than this many bars remain to the left of the viewport. */
const HISTORY_THRESHOLD_BARS = 30
/** Range-change events fire every frame while panning; check for history at most this often. */
const HISTORY_CHECK_MS = 500

const { store } = useCandles()
const host = ref<HTMLDivElement | null>(null)
const status = ref<SeriesStatus>('idle')
const chart = shallowRef<IChartApi | null>(null)
let candleSeries: ISeriesApi<'Candlestick'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let offStore: (() => void) | null = null
let lastHistoryCheck = 0
let historyTimer: ReturnType<typeof setTimeout> | null = null

const toBar = (c: Candle): CandlestickData<Time> => ({
  time: c.time as UTCTimestamp,
  open: c.open,
  high: c.high,
  low: c.low,
  close: c.close,
})
const toVol = (c: Candle): HistogramData<Time> => ({
  time: c.time as UTCTimestamp,
  value: c.volume,
  color: c.close >= c.open ? UP_VOL : DOWN_VOL,
})

const pad = (n: number) => String(n).padStart(2, '0')
/** lightweight-charts works in UTC; render labels in the device's local time. */
function formatTick(time: Time, type: TickMarkType): string {
  const d = new Date((time as number) * 1000)
  switch (type) {
    case TickMarkType.Year:
      return String(d.getFullYear())
    case TickMarkType.Month:
      return d.toLocaleString('ru-RU', { month: 'short' })
    case TickMarkType.DayOfMonth:
      return String(d.getDate())
    default:
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}
function formatTime(time: Time): string {
  const d = new Date((time as number) * 1000)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function applyPriceFormat() {
  const tick = props.tickSize > 0 ? props.tickSize : 0.01
  candleSeries?.applyOptions({ priceFormat: { type: 'price', precision: tickDecimals(tick), minMove: tick } })
}

/** Full redraw from memory. Cheap enough (< 100 ms for ~1–2k bars) for TF switches. */
function renderAll() {
  const s = store.get(props.symbol, props.tf)
  status.value = s?.status ?? 'idle'
  const candles = s?.candles ?? []
  candleSeries?.setData(candles.map(toBar))
  volumeSeries?.setData(candles.map(toVol))
}

function renderLive() {
  const last = store.get(props.symbol, props.tf)?.candles.at(-1)
  if (!last || !candleSeries || !volumeSeries) return
  candleSeries.update(toBar(last))
  volumeSeries.update(toVol(last))
}

/** Prepend history while keeping the same bars on screen (logical indices shift by `added`). */
function renderPrepend(added: number) {
  const ts = chart.value?.timeScale()
  const range = ts?.getVisibleLogicalRange()
  renderAll()
  if (ts && range) ts.setVisibleLogicalRange({ from: range.from + added, to: range.to + added })
}

function onStoreEvent(e: SeriesEvent) {
  if (e.symbol !== props.symbol || e.tf !== props.tf) return
  if (e.kind === 'live') renderLive()
  else if (e.kind === 'prepend') renderPrepend(e.added ?? 0)
  else if (e.kind === 'reset') renderAll()
  else status.value = store.get(props.symbol, props.tf)?.status ?? 'idle'
}

function checkHistory() {
  lastHistoryCheck = Date.now()
  const range = chart.value?.timeScale().getVisibleLogicalRange()
  if (range && range.from < HISTORY_THRESHOLD_BARS) void store.loadOlder(props.symbol, props.tf)
}

/** Throttled (leading + trailing) so panning never turns into a request per frame. */
function onRangeChange(_range: LogicalRange | null) {
  if (historyTimer) return
  const wait = HISTORY_CHECK_MS - (Date.now() - lastHistoryCheck)
  if (wait <= 0) {
    checkHistory()
    return
  }
  historyTimer = setTimeout(() => {
    historyTimer = null
    checkHistory()
  }, wait)
}

function load() {
  renderAll() // instant from memory/cache if present
  void store.ensure(props.symbol, props.tf)
}

/** Double tap (arch §5.3 item 5): back to the latest bars with auto price scale. */
function resetView() {
  const c = chart.value
  if (!c) return
  c.priceScale('right').applyOptions({ autoScale: true })
  c.timeScale().resetTimeScale()
}

/** Hide the crosshair / leave tracking mode (after a feed swipe started on this chart). */
function clearCrosshair() {
  chart.value?.clearCrosshairPosition()
}

/** Width of the right price axis, px (gesture hit-test: vertical drag there scales price). */
function priceAxisWidth(): number {
  return chart.value?.priceScale('right').width() ?? 0
}

function retry() {
  void store.ensure(props.symbol, props.tf, 0)
}

onMounted(() => {
  if (!host.value) return
  const c = createChart(host.value, {
    autoSize: true,
    layout: {
      background: { type: ColorType.Solid, color: '#0b0e11' },
      textColor: '#8a929c',
      fontSize: 11,
    },
    grid: {
      vertLines: { color: 'rgba(255,255,255,0.04)' },
      horzLines: { color: 'rgba(255,255,255,0.04)' },
    },
    crosshair: { mode: CrosshairMode.Normal },
    // Long-press crosshair must not stick after the finger is lifted (e.g. a swipe that turned into a feed swipe).
    trackingMode: { exitMode: TrackingModeExitMode.OnTouchEnd },
    rightPriceScale: { borderVisible: false },
    timeScale: {
      borderVisible: false,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      tickMarkFormatter: formatTick,
    },
    localization: { locale: 'ru-RU', timeFormatter: formatTime },
    // Feed swipes are decided by useGestures, which never forwards feed-mode moves to the chart.
    // vertTouchDrag must stay on: LWC locks a touch drag as horizontal only when 0.5·|dx| > |dy|, so with
    // it off every 30°–63° "chart" gesture would be dropped. Vertical pan is a no-op while autoScale is on.
    handleScroll: { horzTouchDrag: true, vertTouchDrag: true, pressedMouseMove: true, mouseWheel: true },
    handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: { time: true, price: true } },
  })
  candleSeries = c.addSeries(CandlestickSeries, {
    upColor: UP,
    downColor: DOWN,
    wickUpColor: UP,
    wickDownColor: DOWN,
    borderVisible: false,
  })
  volumeSeries = c.addSeries(HistogramSeries, {
    priceScaleId: 'vol',
    priceFormat: { type: 'volume' },
    lastValueVisible: false,
    priceLineVisible: false,
    visible: props.showVolume,
  })
  c.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
  c.timeScale().subscribeVisibleLogicalRangeChange(onRangeChange)
  chart.value = c
  applyPriceFormat()
  offStore = store.subscribe(onStoreEvent)
  load()
})

watch(
  () => props.tf,
  () => {
    load()
    chart.value?.timeScale().scrollToRealTime()
  },
)
watch(
  () => props.showVolume,
  (v) => volumeSeries?.applyOptions({ visible: v }),
)
watch(() => props.tickSize, applyPriceFormat)

onBeforeUnmount(() => {
  offStore?.()
  if (historyTimer) clearTimeout(historyTimer)
  chart.value?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
  chart.value?.remove() // free canvas + listeners (memory budget, arch §5.2)
  chart.value = null
  candleSeries = null
  volumeSeries = null
})

defineExpose({ resetView, priceAxisWidth, clearCrosshair })
</script>

<template>
  <div class="chart-view">
    <div ref="host" class="chart-host" />
    <div v-if="status === 'loading'" class="chart-overlay">Загрузка…</div>
    <div v-else-if="status === 'error'" class="chart-overlay">
      <span>Не удалось загрузить свечи</span>
      <button type="button" class="retry" @click="retry">Повторить</button>
    </div>
  </div>
</template>

<style scoped>
.chart-view {
  position: relative;
  width: 100%;
  height: 100%;
}
.chart-host {
  position: absolute;
  inset: 0;
}
.chart-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-dim);
  font-size: 14px;
  pointer-events: none;
}
.retry {
  pointer-events: auto;
  padding: 10px 18px;
  border-radius: 10px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
}
</style>
