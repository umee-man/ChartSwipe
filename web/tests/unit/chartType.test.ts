import { describe, expect, it } from 'vitest'
import { CHART_TYPE_LABELS, nextChartType, sanitizeChartType } from '../../lib/chart/type'

describe('chart type setting (A18)', () => {
  it('defaults to candles and sanitises persisted values', () => {
    expect(sanitizeChartType(undefined)).toBe('candles')
    expect(sanitizeChartType('bars')).toBe('bars')
    expect(sanitizeChartType('line')).toBe('candles')
  })
  it('toggles and labels in Russian', () => {
    expect(nextChartType('candles')).toBe('bars')
    expect(nextChartType('bars')).toBe('candles')
    expect(CHART_TYPE_LABELS).toEqual({ candles: 'Свечи', bars: 'Бары' })
  })
})
