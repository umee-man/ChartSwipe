import { describe, expect, it } from 'vitest'
import { addSymbol, removeSymbol, sanitizeSymbols, toggleSymbol } from '../../lib/lists/symbols'

describe('symbol list ops (favorites / hidden)', () => {
  it('adds without duplicates, keeping order', () => {
    expect(addSymbol(['A'], 'B')).toEqual(['A', 'B'])
    expect(addSymbol(['A', 'B'], 'A')).toEqual(['A', 'B'])
  })
  it('removes a symbol (unhide one)', () => {
    expect(removeSymbol(['A', 'B', 'C'], 'B')).toEqual(['A', 'C'])
    expect(removeSymbol(['A'], 'X')).toEqual(['A'])
  })
  it('toggles membership', () => {
    expect(toggleSymbol(['A'], 'B')).toEqual(['A', 'B'])
    expect(toggleSymbol(['A', 'B'], 'A')).toEqual(['B'])
  })
  it('never mutates the input', () => {
    const src = ['A']
    addSymbol(src, 'B')
    removeSymbol(src, 'A')
    toggleSymbol(src, 'A')
    expect(src).toEqual(['A'])
  })
  it('sanitises persisted data', () => {
    expect(sanitizeSymbols([' btcusdt', 'BTCUSDT', 3, null, '', 'ETHUSDT'])).toEqual(['BTCUSDT', 'ETHUSDT'])
    expect(sanitizeSymbols('nope')).toEqual([])
  })
})
