/**
 * E1.5 — open facts → future WaterGraph metadata hints (no production wiring).
 */

import type { NavigationEvent, WaterFact, WaterGraphMetadataHint } from './types.ts';

export function factsToWaterGraphHints(facts: WaterFact[]): WaterGraphMetadataHint[] {
  const hints: WaterGraphMetadataHint[] = [];
  for (const f of facts) {
    if (f.factKind === 'lock' || f.lock) {
      hints.push({
        kind: 'lock_portal',
        factId: f.id,
        summary: `lock metadata: ${f.lock ?? f.segment ?? f.waterway}`,
        soft: true,
      });
    }
    if (f.factKind === 'barrier' || f.barrier) {
      hints.push({
        kind: 'barrier',
        factId: f.id,
        summary: `barrier: ${f.barrier}`,
        soft: false,
      });
    }
    if (f.factKind === 'dimension' && (f.depthCm != null || f.guaranteedDepthCm != null)) {
      hints.push({
        kind: 'edge_constraint',
        factId: f.id,
        summary: `depth/width fact ${f.actualDepthCm ?? f.guaranteedDepthCm} cm on ${f.segment}`,
        soft: true,
      });
    }
    if (f.factKind === 'segment') {
      hints.push({
        kind: 'fairway_prior',
        factId: f.id,
        summary: `named segment ${f.waterway}: ${f.segment}`,
        soft: true,
      });
    }
  }
  return hints;
}

export function eventsToWaterGraphHints(events: NavigationEvent[]): WaterGraphMetadataHint[] {
  return events.map((e) => ({
    kind: e.eventType === 'closure' ? 'edge_availability' : 'advisory',
    factId: e.id,
    summary: `${e.eventType}: ${e.locationText} (${e.restriction ?? ''})`,
    soft: e.eventType !== 'closure',
  }));
}

/** Future AI feature list — documentation helper, no ML. */
export const AI_READY_SIGNALS = [
  'route_rejected',
  'route_accepted',
  'user_correction',
  'deviation_from_known_fairway',
  'navigation_restriction',
  'lock_or_barrier',
  'seasonal_restriction',
  'osm_brouter_disagreement',
  'official_open_data_disagreement',
  'coverage_gap',
  'source_confidence',
] as const;
