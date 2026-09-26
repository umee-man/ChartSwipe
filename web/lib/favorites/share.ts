// Browser helpers for exporting favorites (arch §5.7). Blob + <a download> works in mobile
// Safari/Chrome tabs without install (ADR A9).

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke later: Safari may still be reading the blob right after click().
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** Legacy synchronous copy via a hidden textarea. Must run inside the user gesture (iOS). */
export function copyTextSync(text: string): boolean {
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  ta.setSelectionRange(0, text.length) // iOS
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  return ok
}

/**
 * Copy text to the clipboard. Call directly from a click handler.
 * - Insecure context (plain-HTTP LAN dev URL): the Clipboard API is absent, so the synchronous
 *   execCommand path runs first, before any await, while the user gesture is still active.
 * - Secure context: async Clipboard API; if it rejects, a best-effort synchronous fallback
 *   (may be refused on iOS because the gesture has ended by then).
 */
export function copyText(text: string): Promise<boolean> {
  if (!(navigator.clipboard && window.isSecureContext)) return Promise.resolve(copyTextSync(text))
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => copyTextSync(text),
  )
}
