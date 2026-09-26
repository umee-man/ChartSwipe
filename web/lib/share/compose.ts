// Screenshot composition + delivery (ADR A19). Browser-only (canvas, Blob, Web Share).
import type { HeaderText } from './screenshot'

export interface PlaqueSnapshot {
  /** CSS px within the chart host. */
  top: number
  height: number
  text: string
}

export interface ComposeInput {
  /** lightweight-charts `takeScreenshot()` canvas (bitmap px; includes price lines). */
  chart: HTMLCanvasElement
  /** CSS width of the chart host → pixel ratio = chart.width / cssWidth. */
  cssWidth: number
  header: HeaderText
  /** DOM level plaques (not part of the LWC canvas). */
  plaques: PlaqueSnapshot[]
}

const BG = '#0b0e11'
const TEXT = '#e8eaed'
const DIM = '#8a929c'
const UP = '#26a69a'
const DOWN = '#ef5350'
const AMBER = '#ffb300'
const HEADER_CSS_H = 56

export function composeScreenshot({ chart, cssWidth, header, plaques }: ComposeInput): HTMLCanvasElement {
  const r = cssWidth > 0 ? chart.width / cssWidth : 1
  const headerH = Math.round(HEADER_CSS_H * r)
  const out = document.createElement('canvas')
  out.width = chart.width
  out.height = chart.height + headerH
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D недоступен')
  const font = (px: number, weight = 400) => `${weight} ${Math.round(px * r)}px system-ui, -apple-system, Roboto, sans-serif`
  const pad = 12 * r

  ctx.fillStyle = BG
  ctx.fillRect(0, 0, out.width, out.height)

  // Top strip: ticker · TF, price + 24h %, date/time, watermark.
  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = TEXT
  ctx.font = font(17, 700)
  ctx.fillText(header.title, pad, 24 * r)
  ctx.font = font(15, 600)
  ctx.fillText(header.price, pad, 46 * r)
  if (header.change) {
    const w = ctx.measureText(header.price).width
    ctx.font = font(13, 600)
    ctx.fillStyle = header.changeSign < 0 ? DOWN : UP
    ctx.fillText(header.change, pad + w + 8 * r, 46 * r)
  }
  ctx.textAlign = 'right'
  ctx.fillStyle = DIM
  ctx.font = font(12)
  ctx.fillText(header.when, out.width - pad, 24 * r)
  ctx.fillStyle = AMBER
  ctx.font = font(12, 700)
  ctx.fillText('ChartSwipe', out.width - pad, 46 * r)
  ctx.textAlign = 'left'

  // Chart bitmap (same pixel ratio).
  ctx.drawImage(chart, 0, headerH)

  // Level plaques (DOM overlays in the app) redrawn on top.
  ctx.font = font(11)
  ctx.textBaseline = 'middle'
  for (const p of plaques) {
    const x = 4 * r
    const y = headerH + p.top * r
    const h = p.height * r
    const w = Math.min(146 * r, ctx.measureText(p.text).width + 12 * r)
    ctx.fillStyle = 'rgba(255,179,0,0.18)'
    ctx.strokeStyle = 'rgba(255,179,0,0.7)'
    ctx.lineWidth = Math.max(1, r)
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.fill()
    ctx.stroke()
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    ctx.fillStyle = '#ffcf57'
    ctx.fillText(p.text, x + 6 * r, y + h / 2)
    ctx.restore()
  }
  return out
}

export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось создать PNG'))), 'image/png')
  })
}

export type DeliverResult = 'shared' | 'downloaded' | 'cancelled'

/**
 * Share sheet when the browser can share files (Android Chrome, iOS Safari → Telegram etc.),
 * otherwise a Blob + <a download>. A dismissed share sheet (AbortError) is a silent 'cancelled'.
 */
export async function shareOrDownload(blob: Blob, filename: string): Promise<DeliverResult> {
  const file = new File([blob], filename, { type: 'image/png' })
  const nav = navigator as Navigator & { canShare?: (d: { files: File[] }) => boolean }
  if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
    try {
      await nav.share({ files: [file] })
      return 'shared'
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
      // NotAllowedError (e.g. lost user activation) → fall back to a download
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'downloaded'
}
