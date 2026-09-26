// Public API of the false-breakout detector (architecture §5.6, F7).
export * from './types'
export { trueRange, wilderAtr } from './atr'
export {
  DEFAULT_PARAMS,
  TF_SECONDS,
  resolveParams,
  closedCandles,
  thresholdAt,
  detectLevel,
  detectFalseBreakouts,
} from './detect'
export { autoLevels, autoLevelsAt, weekStart } from './autoLevels'
export type { AutoLevelOptions, AutoLevelsAtOptions } from './autoLevels'
