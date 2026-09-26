// Pure helpers for the virtual feed window (arch §5.2: 3 slides in DOM, preload 2 next, memory ±3).

/** Offsets of slides kept in the DOM relative to the current one. */
export const DOM_OFFSETS = [-1, 0, 1] as const
/** How many next tickers are preloaded (all TFs) once the user stops on a slide. */
export const PRELOAD_AHEAD = 2
/** Candles are kept in memory for tickers within ±this many positions. */
export const MEMORY_RADIUS = 3

export interface WindowSlot {
  offset: number
  index: number
  symbol: string
}

/** Slots rendered in the DOM around `index` (skips out-of-range positions). */
export function domSlots(list: readonly string[], index: number): WindowSlot[] {
  const out: WindowSlot[] = []
  for (const offset of DOM_OFFSETS) {
    const i = index + offset
    const symbol = list[i]
    if (symbol !== undefined) out.push({ offset, index: i, symbol })
  }
  return out
}

/** Next tickers to preload. */
export function preloadSymbols(list: readonly string[], index: number, ahead = PRELOAD_AHEAD): string[] {
  return list.slice(index + 1, index + 1 + ahead)
}

/** Symbols whose candles stay in memory. */
export function memorySymbols(list: readonly string[], index: number, radius = MEMORY_RADIUS): Set<string> {
  return new Set(list.slice(Math.max(0, index - radius), index + radius + 1))
}

/** Live-stream priority: current first, then the next and previous neighbours (arch §4: current + 2 neighbours). */
export function liveSymbols(list: readonly string[], index: number): string[] {
  return [list[index], list[index + 1], list[index - 1]].filter((s): s is string => s !== undefined)
}

/** Clamp an index into [0, length-1] (0 for an empty list). */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(Math.max(0, index), length - 1)
}
