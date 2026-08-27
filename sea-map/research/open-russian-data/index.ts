/**
 * E1.5 OPEN RUSSIAN WATER DATA — research entry.
 */

export { SCHEMA_VERSION } from './types.ts';
export type {
  NavigationEvent,
  OpenDataSource,
  Provenance,
  RouteTraceExternalFactRef,
  SourceQuality,
  WaterFact,
  WaterGraphMetadataHint,
} from './types.ts';

export {
  assertProvenance,
  dedupeEvents,
  dedupeFacts,
  kamaRowsToFacts,
  parseClosureFromBulletin,
  parseDimensionLine,
} from './normalize.ts';

export { extractFromPdfText } from './pdf-extract.ts';
export { scoreSource } from './source-quality.ts';
export {
  AI_READY_SIGNALS,
  eventsToWaterGraphHints,
  factsToWaterGraphHints,
} from './water-graph-hints.ts';
