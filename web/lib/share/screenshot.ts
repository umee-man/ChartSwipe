// Screenshot (F9 part in MVP, ADR A19): pure naming / header text. Canvas composition lives in compose.ts.
import { tfLabel } from '../feed/tf'

const pad = (n: number) => String(n).padStart(2, '0')

/** `chartswipe-<SYMBOL>-<tf>-YYYYMMDD-HHmm.png` in the device's local time. */
export function screenshotFilename(symbol: string, tf: string, d: Date = new Date()): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
  const safe = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return `chartswipe-${safe}-${tf}-${stamp}.png`
}

export interface HeaderInput {
  symbol: string
  tf: string
  price: number | null
  /** Decimals for the price (from tickSize). */
  decimals: number
  changePct: number | null
  date: Date
}

export interface HeaderText {
  /** e.g. "BTCUSDT · Д" */
  title: string
  /** e.g. "64 200,5" */
  price: string
  /** e.g. "+2,35%" or "" */
  change: string
  changeSign: 1 | -1 | 0
  /** e.g. "26.09.2026 14:05" */
  when: string
}

export function headerText(h: HeaderInput): HeaderText {
  const price =
    h.price == null
      ? '—'
      : h.price.toLocaleString('ru-RU', { minimumFractionDigits: h.decimals, maximumFractionDigits: h.decimals })
  const c = h.changePct
  const change = c == null || !Number.isFinite(c) ? '' : `${c > 0 ? '+' : ''}${c.toFixed(2).replace('.', ',')}%`
  const d = h.date
  return {
    title: `${h.symbol.toUpperCase()} · ${tfLabel(h.tf)}`,
    price,
    change,
    changeSign: c == null || c === 0 ? 0 : c > 0 ? 1 : -1,
    when: `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
  }
}
