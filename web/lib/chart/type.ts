// Chart type setting (ADR A18): Japanese candles or OHLC bars; one setting for all tickers and TFs.
export type ChartType = 'candles' | 'bars'

export const DEFAULT_CHART_TYPE: ChartType = 'candles'

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  candles: 'Свечи',
  bars: 'Бары',
}

export function sanitizeChartType(v: unknown): ChartType {
  return v === 'bars' || v === 'candles' ? v : DEFAULT_CHART_TYPE
}

export function nextChartType(t: ChartType): ChartType {
  return t === 'candles' ? 'bars' : 'candles'
}
