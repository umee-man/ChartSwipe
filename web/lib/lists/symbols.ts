// Pure, immutable operations on persisted symbol lists (favorites, hidden). Used by stores/watchlists.

/** Add `symbol` if absent (appended, order preserved). Returns the same array when unchanged. */
export function addSymbol(list: readonly string[], symbol: string): string[] {
  return list.includes(symbol) ? [...list] : [...list, symbol]
}

/** Remove every occurrence of `symbol`. */
export function removeSymbol(list: readonly string[], symbol: string): string[] {
  return list.filter((s) => s !== symbol)
}

/** Toggle membership. */
export function toggleSymbol(list: readonly string[], symbol: string): string[] {
  return list.includes(symbol) ? removeSymbol(list, symbol) : addSymbol(list, symbol)
}

/** Sanitise a list loaded from storage: strings only, trimmed, uppercase, unique, order preserved. */
export function sanitizeSymbols(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim().toUpperCase()
    if (s && !out.includes(s)) out.push(s)
  }
  return out
}
