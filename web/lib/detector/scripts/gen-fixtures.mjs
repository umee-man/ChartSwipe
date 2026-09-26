// Regenerate: node web/lib/detector/scripts/gen-fixtures.mjs
// Builds detector fixtures from compact OHLC tuples. Expectations are HAND-WRITTEN here,
// never computed by the detector (the fixtures are an independent contract).
import { writeFileSync } from 'node:fs'
// fixtures are written next to this script's parent dir

const OUT = new URL('../fixtures/', import.meta.url)
const T0 = 1790380800 // 2026-09-26 00:00:00 UTC (aligned to 5m/1h/1d)
const SPAN = { '5m': 300, '1h': 3600, '1d': 86400, '1w': 604800 }
const MON = 1789948800 // 2026-09-21 00:00:00 UTC, Monday (Binance weekly klines open Mon 00:00 UTC)

const build = (tf, rows, start = T0) =>
  rows.map(([o, h, l, c], k) => ({ time: start + k * SPAN[tf], open: o, high: h, low: l, close: c, volume: 1 }))

const ev = (direction, breakIndex, returnIndex, status, candles) => ({
  direction,
  breakIndex,
  returnIndex,
  status,
  breakTime: candles[breakIndex].time,
  returnTime: returnIndex == null ? null : candles[returnIndex].time,
})

const write = (file, obj) => writeFileSync(new URL(file, OUT), JSON.stringify(obj, null, 2) + '\n')

function detectFixture(file, { description, tf, params, lastClosed, nowSec, rows, levels, expected, expectedAtr, start }) {
  const candles = build(tf, rows, start)
  const fx = { kind: 'detect', name: file.replace(/\.json$/, ''), description, tf }
  if (params) fx.params = params
  // The closure spec is required by the API: exactly one of nowSec / lastClosed (default lastClosed=true).
  if (nowSec !== undefined) fx.nowSec = typeof nowSec === 'function' ? nowSec(candles) : nowSec
  else fx.lastClosed = lastClosed ?? true
  fx.levels = typeof levels === 'function' ? levels(candles) : levels
  fx.candles = candles
  const exp = expected(candles)
  fx.expected = exp.map((r) => ({ ...r, falseCount: r.events.filter((e) => e.status === 'false').length }))
  if (expectedAtr) fx.expectedAtr = expectedAtr
  write(file, fx)
}

// 1. False breakout up: break at 1, close back below at 3.
detectFixture('false_up.json', {
  description: 'Up-break at candle 1 (high 100.5 > 100.1), close back below the level at candle 3 -> false.',
  tf: '5m', params: { k: 0 },
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 100.5, 99.5, 100.3], [100.3, 100.6, 100.0, 100.2], [100.2, 100.3, 99.6, 99.8], [99.8, 99.9, 99.4, 99.5], [99.5, 99.9, 99.3, 99.7]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 1, 3, 'false', c)] }],
})

// 2. False breakout down (mirror).
detectFixture('false_down.json', {
  description: 'Down-break at candle 1 (low 99.5 < 99.9), close back above the level at candle 4 -> false.',
  tf: '5m', params: { k: 0 },
  rows: [[100.5, 100.7, 100.3, 100.4], [100.4, 100.5, 99.5, 99.7], [99.7, 99.9, 99.4, 99.8], [99.8, 99.9, 99.6, 99.85], [99.85, 100.4, 99.8, 100.3], [100.3, 100.5, 100.1, 100.4]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('down', 1, 4, 'false', c)] }],
})

// 3. True breakout on 1h (N=3); price stays above afterwards without re-triggering.
detectFixture('true_breakout.json', {
  description: '1h, N=3, X=0.15: break at 1, candles 1..3 close above -> true (resolved at 3). Candles 4-5 stay above: no new up-break because the previous close is above the level.',
  tf: '1h', params: { k: 0 },
  rows: [[99.5, 99.9, 99.4, 99.8], [99.8, 100.6, 99.7, 100.4], [100.4, 100.9, 100.2, 100.7], [100.7, 101.2, 100.5, 101.0], [101.0, 101.3, 100.8, 101.1], [101.1, 101.5, 100.9, 101.2]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 1, null, 'true', c)] }],
})

// 4. Pending: fewer than N candles after the break, no return.
detectFixture('pending.json', {
  description: 'Break at 1 with N=6 but only 3 closed candles (1..3), none closed back below -> pending.',
  tf: '5m', params: { k: 0 },
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 100.5, 99.5, 100.3], [100.3, 100.6, 100.1, 100.4], [100.4, 100.7, 100.2, 100.5]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 1, null, 'pending', c)] }],
})

// 5. Return on the break candle itself (wick through, close back).
detectFixture('return_on_break_candle.json', {
  description: 'Candle 1 wicks to 100.8 (> 100.1) but closes at 99.7 < 100 -> false with returnIndex = breakIndex = 1.',
  tf: '5m', params: { k: 0 },
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 100.8, 99.5, 99.7], [99.7, 99.9, 99.4, 99.5]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 1, 1, 'false', c)] }],
})

// 6. Daily defaults: pct only, N=1; unclosed last candle ignored via lastClosed=false.
detectFixture('daily_defaults.json', {
  description: '1d defaults (pct 0.3% -> X=0.3, N=1, no ATR). 1: wick up, close below -> false on itself. 2: outside candle (100.9 / 99.6): up penetration 0.6 > down 0.1 -> up-break closing above -> true. 3: down-break closing below -> true. 4 is unclosed (lastClosed=false) and ignored.',
  tf: '1d', lastClosed: false,
  rows: [[99, 99.8, 98.5, 99.5], [99.5, 101, 99.2, 99.8], [99.8, 100.9, 99.6, 100.6], [100.2, 100.25, 99.1, 99.3], [99.3, 101.5, 99.2, 101.0]],
  levels: [{ id: 'PDH', price: 100 }],
  expected: (c) => [{ levelId: 'PDH', events: [ev('up', 1, 1, 'false', c), ev('up', 2, null, 'true', c), ev('down', 3, null, 'true', c)] }],
})

// 6b. Weekly defaults (pct 0.5% -> X=0.5, N=1, no ATR); closure via nowSec checks TF_SECONDS['1w'].
detectFixture('weekly_defaults.json', {
  description: '1w defaults (pct 0.5% -> X=0.5, N=1, no ATR), weeks from Mon 2026-09-21. 0: no break. 1: high 100.4 is inside X (would break on 1d, X=0.3) -> no break. 2: up-break, weekly close 99.9 below -> false on itself. 3: up-break closing above -> true. 4: down-break (low 99.2), weekly close 100.3 back above -> false. 5 is the forming week (nowSec = its open + 3 days) and is dropped although it would break.',
  tf: '1w', start: MON,
  nowSec: (c) => c[5].time + 3 * 86400,
  rows: [[99, 99.8, 98.6, 99.4], [99.4, 100.4, 99.0, 100.2], [100.2, 101.2, 99.8, 99.9], [99.9, 100.9, 99.7, 100.8], [100.8, 101.0, 99.2, 100.3], [100.3, 103, 100.1, 102.8]],
  levels: [{ id: 'W', price: 100 }],
  expected: (c) => [{ levelId: 'W', events: [ev('up', 2, 2, 'false', c), ev('up', 3, null, 'true', c), ev('down', 4, 4, 'false', c)] }],
})

// 7/8. ATR vs pct. 14 candles with TR=10 -> ATR14[13]=10, ATR14[14]=(10*13+13)/14.
const atrRows = [
  ...Array.from({ length: 14 }, () => [990, 995, 985, 990]),
  [990, 1002, 989, 999], // 14: high 1002; pct X=1 -> break, ATR X=3 -> no break
  [999, 1004, 998, 1002], // 15: X(ATR)=0.3*143/14=3.0643 -> 1004 breaks
  [1002, 1003, 998.5, 999.5], // 16: close back below -> false
]
const expectedAtr = { 13: 10, 14: 143 / 14 }
detectFixture('atr_dominates.json', {
  description: 'Level 1000, pct X=1, k*ATR=3 dominates: candle 14 (high 1002) is NOT a break; candle 15 (high 1004 > 1003.064) breaks, candle 16 closes below -> false.',
  tf: '5m',
  rows: atrRows,
  levels: [{ id: 'L', price: 1000 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 15, 16, 'false', c)] }],
  expectedAtr,
})
detectFixture('pct_dominates.json', {
  description: 'Same candles, k=0.05 -> k*ATR=0.5 < pct X=1: candle 14 (high 1002 > 1001) breaks and closes below -> false on itself; candle 15 breaks again, false at 16.',
  tf: '5m', params: { k: 0.05 },
  rows: atrRows,
  levels: [{ id: 'L', price: 1000 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 14, 14, 'false', c), ev('up', 15, 16, 'false', c)] }],
  expectedAtr,
})

// 9. Multiple events on one level + levels far from price (no events).
detectFixture('multiple_events.json', {
  description: 'N=3, X=0.1. Level 100: false (1->1), false (3->4), true (5, resolved 7), down false (8->9). Candle 10 cannot re-break up (previous close above). Levels 95/105 are never crossed -> no events.',
  tf: '5m', params: { k: 0, n: 3 },
  rows: [
    [99.5, 99.8, 99.3, 99.6], [99.6, 100.4, 99.5, 99.8], [99.8, 99.9, 99.6, 99.7], [99.7, 100.5, 99.6, 100.3],
    [100.3, 100.4, 99.7, 99.9], [99.9, 100.6, 99.8, 100.4], [100.4, 100.8, 100.2, 100.6], [100.6, 100.9, 100.3, 100.7],
    [100.7, 100.8, 99.8, 99.9], [99.9, 100.3, 99.7, 100.2], [100.2, 100.3, 100.0, 100.1],
  ],
  levels: [{ id: 'L100', price: 100 }, { id: 'L95', price: 95 }, { id: 'L105', price: 105 }],
  expected: (c) => [
    { levelId: 'L100', events: [ev('up', 1, 1, 'false', c), ev('up', 3, 4, 'false', c), ev('up', 5, null, 'true', c), ev('down', 8, 9, 'false', c)] },
    { levelId: 'L95', events: [] },
    { levelId: 'L105', events: [] },
  ],
})

// 10. Unclosed last candle ignored (nowSec).
detectFixture('unclosed_last_nowsec.json', {
  description: 'Candle 2 opened at T0+600 and is still open at nowSec=T0+700 -> ignored, so its break does not count.',
  tf: '5m', params: { k: 0 }, nowSec: T0 + 700,
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 99.9, 99.4, 99.7], [99.7, 100.8, 99.6, 100.5]],
  levels: [{ id: 'L', price: 100 }],
  expected: () => [{ levelId: 'L', events: [] }],
})

// 11. Unclosed last candle ignored (lastClosed=false): would have been the return candle.
detectFixture('unclosed_last_flag.json', {
  description: 'Break at 1; candle 2 would close back below but is unclosed (lastClosed=false) -> event stays pending.',
  tf: '5m', params: { k: 0 }, lastClosed: false,
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 100.5, 99.5, 100.3], [100.3, 100.4, 99.5, 99.6]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 1, null, 'pending', c)] }],
})

// 13. Crossing rule is measured against the threshold, not the level: a close just above the
// level (inside X) must not switch off up-break detection.
detectFixture('creep_then_wick.json', {
  description: 'X=0.1. Candle 1 closes at 100.05 (above the level, inside X; high 100.08 is no break). Candle 2 wicks to 100.6 and to 99.7 and closes at 99.8. Both thresholds are crossed; up penetration 0.5 > down 0.2 -> up, false on the break candle itself.',
  tf: '5m', params: { k: 0 },
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 100.08, 99.55, 100.05], [100.05, 100.6, 99.7, 99.8]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 2, 2, 'false', c)] }],
})

// 14. Outside candle, mirror of creep_then_wick: the larger penetration (down) wins.
detectFixture('outside_candle_below.json', {
  description: 'X=0.1. Ref 99.95 (inside the band). Candle 1 wicks to 100.3 (up penetration 0.2) and 99.4 (down penetration 0.5), closes at 100.2 -> down, close back above -> false on itself.',
  tf: '5m', params: { k: 0 },
  rows: [[99.5, 99.8, 99.3, 99.95], [99.95, 100.3, 99.4, 100.2]],
  levels: [{ id: 'L', price: 100 }],
  expected: (c) => [{ levelId: 'L', events: [ev('down', 1, 1, 'false', c)] }],
})

// 15. Levels far from price are never crossed -> no events (pins the crossing rule itself).
detectFixture('level_far_below.json', {
  description: '20 candles oscillating around 110 (close 110). Level 100 is far below and level 120 far above: every candle is beyond the threshold on one side but never crosses it -> no events.',
  tf: '5m', params: { k: 0 },
  rows: Array.from({ length: 20 }, (_, k) => [110, 110.5 + (k % 3) * 0.1, 109.5 - (k % 2) * 0.1, 110]),
  levels: [{ id: 'BELOW', price: 100 }, { id: 'ABOVE', price: 120 }],
  expected: () => [{ levelId: 'BELOW', events: [] }, { levelId: 'ABOVE', events: [] }],
})

// 16. 1h with NO params override: default pct 0.15% and k*ATR14 = 0.3 * ATR.
detectFixture('h1_default_atr.json', {
  description: '1h defaults (pct 0.15% -> 1.5, k=0.3, N=3), level 1000. Candle 14 (high 1002) is above the pct threshold but below the ATR threshold 1003 -> no break. Candle 15 breaks (1004 > 1003.064); 15..17 close above -> true.',
  tf: '1h',
  rows: [
    ...Array.from({ length: 14 }, () => [990, 995, 985, 990]), // TR 10 -> ATR14[13] = 10
    [990, 1002, 989, 999], // 14: pct X=1.5 would break (1002 > 1001.5), ATR X=3 does not (1002 < 1003)
    [999, 1004, 998, 1002], // 15: X = 0.3 * 143/14 = 3.0643 -> 1004 breaks up
    [1002, 1005, 1001, 1003], // 16: holds
    [1003, 1006, 1002, 1004], // 17: holds -> N=3 reached -> true
  ],
  levels: [{ id: 'L', price: 1000 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 15, null, 'true', c)] }],
  expectedAtr: { 13: 10, 14: 143 / 14 },
})

// 17. ATR of the PREVIOUS candle is used: the break candle's own huge TR must not raise its threshold.
detectFixture('atr_prev_candle.json', {
  description: '5m defaults, level 1000. ATR14[13]=10 -> X=3. Candle 14 (high 1003.5, low 900, TR 103.5) would get ATR14[14]=233.5/14 -> X=5.0 and NOT break, but with ATR[i-1] X=3 it breaks. Candle 15 closes below -> false.',
  tf: '5m',
  rows: [
    ...Array.from({ length: 14 }, () => [990, 995, 985, 990]),
    [990, 1003.5, 900, 1002],
    [1002, 1002.5, 998, 999],
  ],
  levels: [{ id: 'L', price: 1000 }],
  expected: (c) => [{ levelId: 'L', events: [ev('up', 14, 15, 'false', c)] }],
  expectedAtr: { 13: 10, 14: 233.5 / 14 },
})

// 18. activeFrom: breaks before the level existed are ignored.
detectFixture('active_from.json', {
  description: 'X=0.1. Candle 1 wicks above and closes back (false), candle 4 breaks, candle 5 closes back (false). LATE is active from candle 3 -> only the second event; ALWAYS has no activeFrom -> both.',
  tf: '5m', params: { k: 0 },
  rows: [[99.5, 99.8, 99.3, 99.6], [99.6, 100.5, 99.5, 99.7], [99.7, 99.9, 99.5, 99.6], [99.6, 99.9, 99.4, 99.7], [99.7, 100.6, 99.6, 100.3], [100.3, 100.4, 99.5, 99.6]],
  levels: (c) => [{ id: 'LATE', price: 100, activeFrom: c[3].time }, { id: 'ALWAYS', price: 100 }],
  expected: (c) => [
    { levelId: 'LATE', events: [ev('up', 4, 5, 'false', c)] },
    { levelId: 'ALWAYS', events: [ev('up', 1, 1, 'false', c), ev('up', 4, 5, 'false', c)] },
  ],
})

// 12. Auto levels PDH/PDL/PWH/PWL. Day 20710 = Mon 2026-09-14.
const DAY = 86400
const hl = [[110, 100], [112, 101], [115, 104], [111, 99], [108, 97], [109, 98], [110, 99], [118, 105], [116, 106], [117, 108], [119, 110], [120, 111], [125, 90]]
const daily = hl.map(([h, l], k) => ({ time: (20710 + k) * DAY, open: (h + l) / 2, high: h, low: l, close: (h + l) / 2, volume: 1 }))
write('auto_levels.json', {
  kind: 'autoLevels',
  name: 'auto_levels',
  description: 'Daily candles Mon 2026-09-14 .. Sat 2026-09-26; nowSec = Sat 26 01:00 UTC so the last candle is unclosed. PDH/PDL from Fri 25; PWH/PWL from Mon 14..Sun 20.',
  nowSec: 20722 * DAY + 3600,
  weekly: true,
  candles: daily,
  expected: [
    { id: 'PDH', kind: 'PDH', price: 120, activeFrom: 20722 * DAY },
    { id: 'PDL', kind: 'PDL', price: 111, activeFrom: 20722 * DAY },
    { id: 'PWH', kind: 'PWH', price: 115, activeFrom: 20717 * DAY },
    { id: 'PWL', kind: 'PWL', price: 97, activeFrom: 20717 * DAY },
  ],
})

// 19. Levels in force on the last CLOSED day (A4 recipe: autoLevelsAt(closed, closed.length - 1)).
write('auto_levels_as_of.json', {
  kind: 'autoLevels',
  name: 'auto_levels_as_of',
  description: 'Same candles, last one unclosed (lastClosed=false) -> 12 closed (Mon 14 .. Fri 25). asOfIndex=11 (Fri 25): PDH/PDL from Thu 24 (119/110), active from Fri 25; PWH/PWL from Mon 14..Sun 20, active from Mon 21.',
  lastClosed: false,
  weekly: true,
  asOfIndex: 11,
  candles: daily,
  expected: [
    { id: 'PDH', kind: 'PDH', price: 119, activeFrom: 20721 * DAY },
    { id: 'PDL', kind: 'PDL', price: 110, activeFrom: 20721 * DAY },
    { id: 'PWH', kind: 'PWH', price: 115, activeFrom: 20717 * DAY },
    { id: 'PWL', kind: 'PWL', price: 97, activeFrom: 20717 * DAY },
  ],
})
console.log('ok')
