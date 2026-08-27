/**
 * E2 DATA_PILOT — research entry (no production imports).
 */

export { ADAPTER_VERSION, S57_TO_AQUAROUTE } from './types.ts';
export type {
  EncAiLearningSignal,
  NormalizedWaterObject,
  S57Collection,
  S57Feature,
  S57ObjectClass,
  WaterGraphLayerBundle,
} from './types.ts';

export {
  PILOT_REQUIRED_CLASSES,
  coverageReport,
  normalizeFeatures,
  parseS57Collection,
} from './parse-s57-json.ts';

export {
  adaptObject,
  draftAiLearningSignal,
  proofSummary,
  toWaterGraph,
  toWaterGraphFromUnknown,
} from './water-graph-adapter.ts';
