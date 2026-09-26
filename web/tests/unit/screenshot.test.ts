import { describe, expect, it } from 'vitest'
import { headerText, screenshotFilename } from '../../lib/share/screenshot'

const D = new Date(2026, 8, 6, 9, 5) // 06.09.2026 09:05 local

describe('screenshot naming (A19)', () => {
  it('builds chartswipe-<SYMBOL>-<tf>-YYYYMMDD-HHmm.png', () => {
    expect(screenshotFilename('btcusdt', '1d', D)).toBe('chartswipe-BTCUSDT-1d-20260906-0905.png')
    expect(screenshotFilename('1000PEPEUSDT', '5m', D)).toBe('chartswipe-1000PEPEUSDT-5m-20260906-0905.png')
    expect(screenshotFilename('bad/name', '1w', D)).toBe('chartswipe-BADNAME-1w-20260906-0905.png')
  })
})

describe('screenshot header text', () => {
  it('formats ticker, TF, price, 24h % and time', () => {
    const h = headerText({ symbol: 'BTCUSDT', tf: '1d', price: 64200.5, decimals: 1, changePct: 2.345, date: D })
    expect(h.title).toBe('BTCUSDT · Д')
    expect(h.price.replace(/\s/g, ' ')).toBe('64 200,5')
    expect(h.change).toBe('+2,35%')
    expect(h.changeSign).toBe(1)
    expect(h.when).toBe('06.09.2026 09:05')
  })
  it('handles missing price/change and negatives', () => {
    const h = headerText({ symbol: 'x', tf: '1w', price: null, decimals: 2, changePct: -1.5, date: D })
    expect(h).toMatchObject({ title: 'X · Н', price: '—', change: '-1,50%', changeSign: -1 })
    expect(headerText({ symbol: 'x', tf: '5m', price: 1, decimals: 0, changePct: null, date: D })).toMatchObject({ change: '', changeSign: 0 })
  })
})
