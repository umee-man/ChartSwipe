import { describe, expect, it } from 'vitest'
import { DEFAULT_TF_BUTTONS, migrateTfButtons, opensZoomedOut, tfLabel } from '../../lib/feed/tf'

describe('TF buttons (A15)', () => {
  it('defaults to 5м · 1ч · Д · Н', () => {
    expect(DEFAULT_TF_BUTTONS).toEqual(['5m', '1h', '1d', '1w'])
    expect(DEFAULT_TF_BUTTONS.map(tfLabel)).toEqual(['5м', '1ч', 'Д', 'Н'])
  })
  it('migrates the old persisted 3-button config by adding 1w', () => {
    expect(migrateTfButtons(['5m', '1h', '1d'])).toEqual(['5m', '1h', '1d', '1w'])
    expect(migrateTfButtons(['15m', '4h', '1d'])).toEqual(['15m', '4h', '1d', '1w'])
  })
  it('fills gaps from defaults, dedupes, drops junk and caps at 4', () => {
    expect(migrateTfButtons(['1w', '1w', 'x', 5])).toEqual(['1w', '5m', '1h', '1d'])
    expect(migrateTfButtons(['1m', '3m', '5m', '15m', '30m'])).toEqual(['1m', '3m', '5m', '15m'])
    expect(migrateTfButtons(undefined)).toEqual(['5m', '1h', '1d', '1w'])
    expect(migrateTfButtons([])).toEqual(['5m', '1h', '1d', '1w'])
  })
  it('opens Д and Н fully zoomed out only', () => {
    expect(['5m', '1h', '1d', '1w'].map(opensZoomedOut)).toEqual([false, false, true, true])
  })
})
