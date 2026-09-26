// Level plaques (labels) on the left edge of the chart: pure layout + hit-testing (arch §5.3 item 1).

export const LABEL_H = 22
export const LABEL_GAP = 2
/** Plaques live in this strip from the chart's left edge; touches there grab a level. */
export const LABEL_ZONE_W = 150
/** Extra vertical slop around a plaque for fat fingers. */
export const LABEL_HIT_SLOP = 8

export interface LabelInput {
  levelId: string
  /** Line y in the pane (px), or null when the price is off-screen. */
  y: number | null
}

export interface LabelRect {
  levelId: string
  /** Line y (where the plaque points). */
  lineY: number
  top: number
  bottom: number
}

/**
 * Center each plaque on its line, then push overlapping ones down (and back up at the bottom edge)
 * so they never cover each other. Off-screen levels get no plaque.
 */
export function layoutLabels(items: readonly LabelInput[], paneHeight: number, h = LABEL_H, gap = LABEL_GAP): LabelRect[] {
  const vis = items
    .filter((i): i is LabelInput & { y: number } => i.y !== null && i.y >= 0 && i.y <= paneHeight)
    .sort((a, b) => a.y - b.y)
  const out: LabelRect[] = []
  let prevBottom = -Infinity
  for (const it of vis) {
    let top = Math.max(0, it.y - h / 2)
    if (top < prevBottom + gap) top = prevBottom + gap
    out.push({ levelId: it.levelId, lineY: it.y, top, bottom: top + h })
    prevBottom = top + h
  }
  // Overflow at the bottom: shift the stack up from the end.
  let limit = paneHeight
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i]!
    if (r.bottom > limit) {
      r.top = limit - h
      r.bottom = limit
    }
    limit = r.top - gap
  }
  return out
}

/** Which plaque (if any) is at pane point (x, y). Nearest to its center wins when slops overlap. */
export function hitTestLabels(
  rects: readonly LabelRect[],
  x: number,
  y: number,
  zoneW = LABEL_ZONE_W,
  slop = LABEL_HIT_SLOP,
): LabelRect | null {
  if (x < 0 || x > zoneW) return null
  let best: LabelRect | null = null
  let bestDist = Infinity
  for (const r of rects) {
    if (y < r.top - slop || y > r.bottom + slop) continue
    const d = Math.abs(y - (r.top + r.bottom) / 2)
    if (d < bestDist) {
      best = r
      bestDist = d
    }
  }
  return best
}
