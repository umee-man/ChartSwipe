<script setup lang="ts">
// Candlestick chart for one ticker on lightweight-charts v5 (arch §5.1–5.2).
// setData from memory on TF switch, live update of the last bar, history paging to the left,
// chart.remove() on unmount (slide leaves the virtual window).
// Levels (F4, A16): amber 1 px price lines on every TF, plaques on the left edge (drag / swipe / tap
// handled by useGestures via FeedPager), magnet for long-press placement, levels included in the
// Д/Н autoscale.
import {
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  CrosshairMode,
  HistogramSeries,
  TickMarkType,
  TrackingModeExitMode,
  LineStyle,
  type AutoscaleInfo,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Logical,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { Candle, Interval } from '~/lib/binance/types'
import { tickDecimals } from '~/lib/binance/parse'
import { lastCandle } from '~/lib/candles/merge'
import { opensZoomedOut, tfLabel } from '~/lib/feed/tf'
import { hitTestLabels, LABEL_H, layoutLabels, type LabelRect } from '~/lib/levels/labels'
import { magnetPrice, magnetRadiusFor, type MagnetResult } from '~/lib/levels/magnet'
import { toOhlc, toVolume } from '~/lib/candles/series'
import type { ChartType } from '~/lib/chart/type'
import type { PlaqueSnapshot } from '~/lib/share/compose'
import { LEVEL_COLOR, levelsPriceRange, roundToTick, type Level } from '~/lib/levels/model'
import type { SeriesEvent, SeriesStatus } from '~/lib/candles/store'
import { useCandles } from '~/composables/useCandles'

const props = defineProps<{
  symbol: string
  tf: Interval
  showVolume: boolean
  tickSize: number
  /** Alive levels of this symbol (all TFs). */
  levels: Level[]
  /** Current slide: only it lays out plaques and answers hit tests. */
  active: boolean
  /** Level being dragged (highlighted) and its swipe-to-delete offset. */
  dragId?: string | null
  dragDx?: number
  /** Candles or OHLC bars (A18). */
  chartType?: ChartType
}>()

const UP = '#26a69a'
const DOWN = '#ef5350'
/** Start loading older history when fewer than this many bars remain to the left of the viewport. */
const HISTORY_THRESHOLD_BARS = 30
/** Right margin after the last bar, in bars (like TradingView's right offset). */
const RIGHT_OFFSET_BARS = 20
/** Range-change events fire every frame while panning; check for history at most this often. */
const HISTORY_CHECK_MS = 500

const { store } = useCandles()
const host = ref<HTMLDivElement | null>(null)
const status = ref<SeriesStatus>('idle')
const errorText = ref<string | null>(null)
const chart = shallowRef<IChartApi | null>(null)
/** Price series: CandlestickSeries or BarSeries (A18); both take the same OHLC data. */
let priceSeries: ISeriesApi<'Candlestick' | 'Bar'> | null = null
let volumeSeries: ISeriesApi<'Histogram'> | null = null
let offStore: (() => void) | null = null
let lastHistoryCheck = 0
/**
 * Д/Н open fully zoomed out (A15): fit every loaded bar until fresh network data has been drawn
 * (cache first, then the REST tail), then leave the view to the user.
 */
let fitPending = false
let historyTimer: ReturnType<typeof setTimeout> | null = null
/** id → price line on the candle series. */
const priceLines = new Map<string, IPriceLine>()
/** Plaque rectangles (pane px) for the active slide, recomputed every frame (price scale can move any time). */
const labelRects = ref<LabelRect[]>([])
let rafId: number | null = null
const MAGNET_RADIUS_DEFAULT = 24

// One series point per stored candle, same order → logical index == store index (magnet, A17).
const toBar = (c: Candle): CandlestickData<Time> => ({ ...toOhlc(c), time: c.time as UTCTimestamp })
const toVol = (c: Candle): HistogramData<Time> => ({ ...toVolume(c), time: c.time as UTCTimestamp })

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
  priceSeries?.applyOptions({ priceFormat: { type: 'price', precision: tickDecimals(tick), minMove: tick } })
}

/** Full redraw from memory. Cheap enough (< 100 ms for ~1–2k bars) for TF switches. */
function syncStatus() {
  const s = store.get(props.symbol, props.tf)
  status.value = s?.status ?? 'idle'
  errorText.value = s?.error ?? null
}

function renderAll() {
  const s = store.get(props.symbol, props.tf)
  syncStatus()
  const candles = s?.candles ?? []
  priceSeries?.setData(candles.map(toBar))
  volumeSeries?.setData(candles.map(toVol))
  if (fitPending && candles.length) {
    fitAll()
    if (s?.fetchedAt) fitPending = false
  }
}

/** All loaded candles fit the width, price scale auto-fits the visible range. */
function fitAll() {
  const c = chart.value
  if (!c) return
  c.priceScale('right').applyOptions({ autoScale: true })
  // fitContent() drops the right offset; fit explicitly so the gap before the price scale stays.
  const n = store.get(props.symbol, props.tf)?.candles.length ?? 0
  if (n) c.timeScale().setVisibleLogicalRange({ from: 0, to: n - 1 + RIGHT_OFFSET_BARS })
  else c.timeScale().fitContent()
}

function renderLive() {
  const last = lastCandle(store.get(props.symbol, props.tf)?.candles)
  if (!last || !priceSeries || !volumeSeries) return
  priceSeries.update(toBar(last))
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
  else syncStatus()
}

function checkHistory() {
  lastHistoryCheck = Date.now()
  const range = chart.value?.timeScale().getVisibleLogicalRange()
  if (!range || range.from >= HISTORY_THRESHOLD_BARS) return
  // Fully zoomed-out Д/Н view already shows everything loaded: don't page history just because the
  // left edge is visible (it would immediately break "all candles fit"). Paging resumes once zoomed in.
  const count = store.get(props.symbol, props.tf)?.candles.length ?? 0
  if (opensZoomedOut(props.tf) && range.from <= 0 && range.to >= count - 1) return
  void store.loadOlder(props.symbol, props.tf)
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
  fitPending = opensZoomedOut(props.tf)
  renderAll() // instant from memory/cache if present
  void store.ensure(props.symbol, props.tf)
}

/**
 * Double tap (arch §5.3 item 5): Д/Н → the fully zoomed-out view (A15);
 * 5м/1ч → back to the latest bars with auto price scale.
 */
function resetView() {
  const c = chart.value
  if (!c) return
  if (opensZoomedOut(props.tf)) {
    fitAll()
    return
  }
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

// ---------------- chart type (A18) ----------------

function addPriceSeries(c: IChartApi, type: ChartType): ISeriesApi<'Candlestick' | 'Bar'> {
  const common = { upColor: UP, downColor: DOWN, autoscaleInfoProvider: autoscaleWithLevels }
  const series =
    type === 'bars'
      ? c.addSeries(BarSeries, { ...common, thinBars: false, openVisible: true })
      : c.addSeries(CandlestickSeries, { ...common, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false })
  return series as ISeriesApi<'Candlestick' | 'Bar'>
}

/**
 * Swap candles <-> bars in place: no data reload (setData from memory), same visible range, price
 * format, levels (price lines are per series, so they are re-created), autoscale provider.
 */
function switchChartType(type: ChartType) {
  const c = chart.value
  if (!c || !priceSeries) return
  const range = c.timeScale().getVisibleLogicalRange()
  c.removeSeries(priceSeries)
  priceLines.clear()
  priceSeries = addPriceSeries(c, type)
  applyPriceFormat()
  const candles = store.get(props.symbol, props.tf)?.candles ?? []
  priceSeries.setData(candles.map(toBar))
  syncPriceLines()
  if (range) c.timeScale().setVisibleLogicalRange(range)
}

// ---------------- levels ----------------

const levelById = computed(() => new Map(props.levels.map((l) => [l.id, l])))

function syncPriceLines() {
  const series = priceSeries
  if (!series) return
  const seen = new Set<string>()
  for (const l of props.levels) {
    seen.add(l.id)
    const opts = {
      price: l.price,
      color: l.color ?? LEVEL_COLOR,
      lineWidth: (l.id === props.dragId ? 2 : 1) as 1 | 2,
      lineStyle: LineStyle.Solid,
      axisLabelVisible: true,
      title: '',
    }
    const line = priceLines.get(l.id)
    if (line) line.applyOptions(opts)
    else priceLines.set(l.id, series.createPriceLine(opts))
  }
  for (const [id, line] of priceLines) {
    if (seen.has(id)) continue
    series.removePriceLine(line)
    priceLines.delete(id)
  }
}

/** Pane height without the time axis. */
function paneHeight(): number {
  const h = host.value?.clientHeight ?? 0
  return Math.max(0, h - (chart.value?.timeScale().height() ?? 0))
}

/** Recompute plaque positions; only commit to Vue state when something actually moved. */
function layoutPlaques() {
  const series = priceSeries
  if (!series || !props.active || props.levels.length === 0) {
    if (labelRects.value.length) labelRects.value = []
    return
  }
  const next = layoutLabels(
    props.levels.map((l) => ({ levelId: l.id, y: series.priceToCoordinate(l.price) })),
    paneHeight(),
  )
  const prev = labelRects.value
  const changed =
    next.length !== prev.length ||
    next.some((r, i) => r.levelId !== prev[i]!.levelId || Math.abs(r.top - prev[i]!.top) > 0.5)
  if (changed) labelRects.value = next
}

function frame() {
  rafId = null
  layoutPlaques()
  if (props.active && props.levels.length) rafId = requestAnimationFrame(frame)
}
function startLayoutLoop() {
  if (rafId === null && props.active && props.levels.length) rafId = requestAnimationFrame(frame)
  else if (!props.active || !props.levels.length) layoutPlaques()
}
function stopLayoutLoop() {
  if (rafId !== null) cancelAnimationFrame(rafId)
  rafId = null
}

/** Д/Н (A15): the auto price range also covers every level so none is off-screen in the overview. */
function autoscaleWithLevels(original: () => AutoscaleInfo | null): AutoscaleInfo | null {
  const res = original()
  if (!opensZoomedOut(props.tf)) return res
  const range = levelsPriceRange(props.levels)
  if (!res?.priceRange || !range) return res
  return {
    ...res,
    priceRange: {
      minValue: Math.min(res.priceRange.minValue, range.min),
      maxValue: Math.max(res.priceRange.maxValue, range.max),
    },
  }
}

function toLocal(clientX: number, clientY: number): { x: number; y: number } | null {
  const r = host.value?.getBoundingClientRect()
  if (!r) return null
  return { x: clientX - r.left, y: clientY - r.top }
}

/** Plaque under a client point (arch §5.3 item 1), or null. */
function hitLevel(clientX: number, clientY: number): string | null {
  if (!props.active) return null
  const p = toLocal(clientX, clientY)
  if (!p) return null
  layoutPlaques()
  return hitTestLabels(labelRects.value, p.x, p.y)?.levelId ?? null
}

/** Snap feedback (A17): a ring on the wick the level locked to, shown ~600 ms. */
const SNAP_MARKER_MS = 600
const snapMarker = ref<{ x: number; y: number; key: string } | null>(null)
let snapTimer: ReturnType<typeof setTimeout> | null = null
function showSnapMarker(res: MagnetResult) {
  const c = chart.value
  const series = priceSeries
  if (!c || !series || !res.snapped || res.barIndex === undefined) return
  const x = c.timeScale().logicalToCoordinate(res.barIndex as Logical)
  const y = series.priceToCoordinate(res.price)
  if (x === null || y === null) return
  // A new key per snap target re-mounts the ring so its pop animation replays.
  snapMarker.value = { x, y, key: `${res.barIndex}:${res.price}` }
  if (snapTimer) clearTimeout(snapTimer)
  snapTimer = setTimeout(() => (snapMarker.value = null), SNAP_MARKER_MS)
}

/** Run the magnet (arch §5.4, A17) at pane point (x, y). */
function magnetAtLocal(x: number, y: number, pointerType: string, touchRadius: number): MagnetResult | null {
  const series = priceSeries
  const c = chart.value
  if (!series || !c) return null
  const ts = c.timeScale()
  const logical = ts.coordinateToLogical(x)
  const res = magnetPrice({
    candles: store.get(props.symbol, props.tf)?.candles ?? [],
    logical: logical ?? Number.NaN,
    barSpacing: ts.options().barSpacing,
    y,
    priceToY: (price) => series.priceToCoordinate(price),
    yToPrice: (py) => series.coordinateToPrice(py),
    tickSize: props.tickSize,
    radiusPx: magnetRadiusFor(pointerType, touchRadius),
  })
  if (res?.snapped) showSnapMarker(res)
  return res
}

/** Magnet result for a long press at a client point, or null outside the price pane. */
function magnetAt(clientX: number, clientY: number, pointerType = 'touch', touchRadius?: number): MagnetResult | null {
  const p = toLocal(clientX, clientY)
  if (!p || p.y < 0 || p.y > paneHeight()) return null
  const plotWidth = (host.value?.clientWidth ?? 0) - priceAxisWidth()
  if (p.x < 0 || p.x > plotWidth) return null
  return magnetAtLocal(p.x, p.y, pointerType, touchRadius ?? MAGNET_RADIUS_DEFAULT)
}

/**
 * New price while a plaque is dragged: the line follows `dy` from its start price, and the magnet snaps
 * it to a wick within the radius of the bars around the finger's x (A17). Null if unmappable.
 */
function priceForDrag(
  startPrice: number,
  dy: number,
  clientX?: number,
  pointerType = 'touch',
  touchRadius?: number,
): MagnetResult | null {
  const series = priceSeries
  if (!series) return null
  const y0 = series.priceToCoordinate(startPrice)
  if (y0 === null) return null
  const y = Math.min(Math.max(0, y0 + dy), paneHeight())
  if (clientX !== undefined) {
    const p = toLocal(clientX, 0)
    if (p) {
      const res = magnetAtLocal(p.x, y, pointerType, touchRadius ?? MAGNET_RADIUS_DEFAULT)
      if (res) return res
    }
  }
  const price = series.coordinateToPrice(y)
  if (price === null || !(price > 0)) return null
  return { price: roundToTick(price, props.tickSize), snapped: false }
}

const priceDecimals = computed(() => tickDecimals(props.tickSize > 0 ? props.tickSize : 0.01))
function formatPrice(p: number): string {
  return p.toLocaleString('ru-RU', { minimumFractionDigits: priceDecimals.value, maximumFractionDigits: priceDecimals.value })
}
function plaqueStyle(r: LabelRect): Record<string, string> {
  const style: Record<string, string> = { top: `${r.top}px`, height: `${LABEL_H}px` }
  const dx = r.levelId === props.dragId ? (props.dragDx ?? 0) : 0
  if (dx) {
    style.transform = `translateX(${dx}px)`
    style.opacity = String(Math.max(0.25, 1 - dx / 120))
  }
  return style
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
      // Empty space between the last bar and the price scale, in bars (user request).
      rightOffset: RIGHT_OFFSET_BARS,
      // Д/Н fit all loaded bars (A15): allow very narrow bars.
      minBarSpacing: 0.5,
      tickMarkFormatter: formatTick,
    },
    localization: { locale: 'ru-RU', timeFormatter: formatTime },
    // Feed swipes are decided by useGestures, which never forwards feed-mode moves to the chart.
    // vertTouchDrag must stay on: LWC locks a touch drag as horizontal only when 0.5·|dx| > |dy|, so with
    // it off every 30°–63° "chart" gesture would be dropped. Vertical pan is a no-op while autoScale is on.
    handleScroll: { horzTouchDrag: true, vertTouchDrag: true, pressedMouseMove: true, mouseWheel: true },
    handleScale: { pinch: true, mouseWheel: true, axisPressedMouseMove: { time: true, price: true } },
  })
  priceSeries = addPriceSeries(c, props.chartType ?? 'candles')
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
  syncPriceLines()
  startLayoutLoop()
})

watch(
  () => [props.levels, props.dragId] as const,
  () => {
    syncPriceLines()
    startLayoutLoop()
  },
)
watch(
  () => props.active,
  (a) => (a ? startLayoutLoop() : stopLayoutLoop()),
)

watch(
  () => props.tf,
  () => {
    load()
    if (!opensZoomedOut(props.tf)) chart.value?.timeScale().scrollToRealTime()
  },
)
watch(
  () => props.showVolume,
  (v) => volumeSeries?.applyOptions({ visible: v }),
)
watch(() => props.tickSize, applyPriceFormat)
watch(
  () => props.chartType,
  (t) => switchChartType(t ?? 'candles'),
)

onBeforeUnmount(() => {
  if (snapTimer) clearTimeout(snapTimer)
  stopLayoutLoop()
  priceLines.clear()
  offStore?.()
  if (historyTimer) clearTimeout(historyTimer)
  chart.value?.timeScale().unsubscribeVisibleLogicalRangeChange(onRangeChange)
  chart.value?.remove() // free canvas + listeners (memory budget, arch §5.2)
  chart.value = null
  priceSeries = null
  volumeSeries = null
})

/**
 * Screenshot source (A19): LWC canvas (candles, volume, level price lines, axes; no crosshair) plus the
 * DOM plaques, which are not part of that canvas and are redrawn by lib/share/compose.ts.
 */
function screenshot(): { canvas: HTMLCanvasElement; cssWidth: number; plaques: PlaqueSnapshot[] } | null {
  const c = chart.value
  if (!c || !host.value) return null
  layoutPlaques()
  const plaques = labelRects.value.map((r) => {
    const l = levelById.value.get(r.levelId)
    const text = l ? [formatPrice(l.price), tfLabel(l.tf), l.note ?? ''].filter(Boolean).join(' · ') : ''
    return { top: r.top, height: r.bottom - r.top, text }
  })
  return { canvas: c.takeScreenshot(true, false), cssWidth: host.value.clientWidth, plaques }
}

defineExpose({ resetView, priceAxisWidth, clearCrosshair, hitLevel, magnetAt, priceForDrag, screenshot })
</script>

<template>
  <div class="chart-view">
    <div ref="host" class="chart-host" />
    <div
      v-if="snapMarker"
      :key="snapMarker.key"
      class="snap-marker"
      aria-hidden="true"
      :style="{ left: `${snapMarker.x}px`, top: `${snapMarker.y}px` }"
    />
    <div v-if="active && labelRects.length" class="plaques" aria-hidden="true">
      <div
        v-for="r in labelRects"
        :key="r.levelId"
        class="plaque"
        :class="{ dragging: r.levelId === dragId }"
        :style="plaqueStyle(r)"
      >
        <span class="price">{{ formatPrice(levelById.get(r.levelId)?.price ?? 0) }}</span>
        <span class="tf">{{ tfLabel(levelById.get(r.levelId)?.tf ?? '') }}</span>
        <span v-if="levelById.get(r.levelId)?.note" class="note">{{ levelById.get(r.levelId)?.note }}</span>
      </div>
    </div>
    <div v-if="status === 'loading' || status === 'idle'" class="chart-overlay">Загрузка свечей {{ symbol }}…</div>
    <div v-else-if="status === 'error'" class="chart-overlay">
      <span>Не удалось загрузить свечи {{ symbol }}</span>
      <span class="reason">Binance недоступен: {{ errorText ?? 'неизвестная ошибка' }}</span>
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
.snap-marker {
  position: absolute;
  width: 16px;
  height: 16px;
  margin: -8px 0 0 -8px;
  border: 2px solid #ffb300;
  border-radius: 50%;
  box-shadow: 0 0 0 3px rgba(255, 179, 0, 0.25);
  pointer-events: none;
  animation: snap-pop 600ms ease-out forwards;
}
@keyframes snap-pop {
  0% {
    transform: scale(0.4);
    opacity: 1;
  }
  70% {
    transform: scale(1.1);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 0;
  }
}
.plaques {
  position: absolute;
  inset: 0;
  pointer-events: none; /* hit-testing is geometric (lib/levels/labels.ts) via useGestures */
  overflow: hidden;
}
.plaque {
  position: absolute;
  left: 4px;
  max-width: 146px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  border-radius: 6px;
  background: rgba(255, 179, 0, 0.16);
  border: 1px solid rgba(255, 179, 0, 0.55);
  color: #ffcf57;
  font-size: 11px;
  line-height: 1;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.plaque.dragging {
  background: rgba(255, 179, 0, 0.32);
  border-color: #ffb300;
}
.plaque .tf {
  font-size: 9px;
  opacity: 0.75;
}
.plaque .note {
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  opacity: 0.85;
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
.reason {
  max-width: 90%;
  text-align: center;
  font-size: 12px;
  word-break: break-word;
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
