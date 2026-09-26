// Local-first level persistence (ADR A10): IndexedDB `levels` store (keyPath id, index symbol), with a
// localStorage mirror used whenever IndexedDB is unavailable or hangs (iOS private mode / open() stall).
// Soft-deleted levels are kept (deleted_at) so a later /v1/levels sync can propagate deletions.
import { coerceLevel, type Level } from '../levels/model'
import { loadJson, saveJson } from '../storage'
import { db } from './candles'

const LS_KEY = 'cs:levels'

/** Merge two level sets by id; the newer `updated_at` wins (ISO strings compare lexicographically). */
export function mergeByUpdatedAt(a: readonly Level[], b: readonly Level[]): Level[] {
  const map = new Map<string, Level>()
  for (const l of [...a, ...b]) {
    const cur = map.get(l.id)
    if (!cur || l.updated_at > cur.updated_at) map.set(l.id, l)
  }
  return [...map.values()]
}

function readLocal(): Level[] {
  const raw = loadJson<unknown>(LS_KEY, [])
  return Array.isArray(raw) ? raw.map(coerceLevel).filter((l): l is Level => l !== null) : []
}

/** All levels (including soft-deleted), merged from IndexedDB and the localStorage mirror. */
export async function readAllLevels(): Promise<Level[]> {
  const local = readLocal()
  try {
    const d = await db()
    if (!d) return local
    const stored = (await d.getAll('levels')).map(coerceLevel).filter((l): l is Level => l !== null)
    const merged = mergeByUpdatedAt(stored, local)
    // Anything only in the mirror (written while IDB was unavailable) is moved into IDB.
    if (local.length) {
      const tx = d.transaction('levels', 'readwrite')
      await Promise.all([...merged.map((l) => tx.store.put(l)), tx.done])
      saveJson(LS_KEY, [])
    }
    return merged
  } catch {
    return local
  }
}

/** Persist one level (create / update / soft delete). Falls back to the localStorage mirror. */
export async function saveLevel(level: Level): Promise<void> {
  try {
    const d = await db()
    if (d) {
      await d.put('levels', level)
      return
    }
  } catch {
    // fall through to the mirror
  }
  saveJson(LS_KEY, mergeByUpdatedAt(readLocal(), [level]))
}
