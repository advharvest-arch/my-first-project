/**
 * E2.10 — Relation-aware OSM geometry provider (diagnostic / shadow).
 *
 * Returns real OSM relation member geometry with provenance.
 * Does not invent coordinates. Live Overpass fetch is NOT enabled here —
 * Belomor uses the committed E2.7 full-ways snapshot (explicitly labeled).
 */

import { pathLengthKm, type LngLat } from './geo';
import {
  BELOMOR_RELATION_ID,
  loadBelomorRelation9909116,
  memberProvenance,
  processOsmWaterwayRelation,
  type DiagnosticGeometryProvenance,
  type RelationMemberWay,
  type OsmWaterwayRelationSnapshot,
} from './relation-aware-ingest';
import type { CenterlineSource } from './water-graph-types';
import { classifyCenterlineKind } from './water-graph-ingest';

export type RelationAwareGeometryProviderResult = {
  relationId: number;
  relationTags: Record<string, string>;
  memberWayIds: number[];
  members: RelationMemberWay[];
  geometryByWayId: Record<string, LngLat[]>;
  memberRoles: Record<string, string>;
  sourceKind: 'snapshot' | 'live';
  sourceDetail: string;
  snapshotPath: string | null;
  provenance: DiagnosticGeometryProvenance[];
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  diagnosticOnly: true;
  geometryCoverageKm: number;
  mainStreamCount: number;
};

const BELOMOR_SNAPSHOT_PATH =
  'src/__fixtures__/belomor-recovery/osm-relation-9909116-full-ways.json';

/**
 * Belomor canal relation 9909116 — deterministic snapshot provider.
 * Explicitly NOT live production fetch.
 */
export function provideBelomorRelation9909116Geometry(): RelationAwareGeometryProviderResult {
  const snap: OsmWaterwayRelationSnapshot = loadBelomorRelation9909116();
  const processed = processOsmWaterwayRelation(snap);
  const geometryByWayId: Record<string, LngLat[]> = {};
  const memberRoles: Record<string, string> = {};
  const provenance: DiagnosticGeometryProvenance[] = [];

  for (const m of processed.relevantMembers) {
    // Copy only — no interpolation / densify across gaps.
    geometryByWayId[String(m.osmId)] = m.coords.map((c) => ({ lon: c.lon, lat: c.lat }));
    memberRoles[String(m.osmId)] = m.role;
    provenance.push(memberProvenance(snap.relation.id, m));
  }

  return {
    relationId: BELOMOR_RELATION_ID,
    relationTags: { ...processed.tags },
    memberWayIds: processed.memberIdsInOrder.slice(),
    members: processed.relevantMembers,
    geometryByWayId,
    memberRoles,
    sourceKind: 'snapshot',
    sourceDetail: `OSM relation ${BELOMOR_RELATION_ID} full-ways snapshot (E2.7/E2.10); not live Overpass`,
    snapshotPath: BELOMOR_SNAPSHOT_PATH,
    provenance,
    confidence: 'HIGH',
    diagnosticOnly: true,
    geometryCoverageKm: processed.geometryCoverageKm,
    mainStreamCount: processed.mainStreamMembers.length,
  };
}

/** Convert provider result → WaterGraph centerlines (real OSM way ids only). */
export function providerToCenterlines(
  provider: RelationAwareGeometryProviderResult,
): CenterlineSource[] {
  return provider.members
    .filter((m) => m.coords.length >= 2)
    .map((m) => ({
      id: `osm:way/${m.osmId}`,
      kind: classifyCenterlineKind(m.waterway, m.name),
      coords: m.coords.slice(),
      name: m.name,
      source: 'osm',
      sourceId: `way/${m.osmId}`,
      waterId: `ww:relation:${provider.relationId}`,
    }));
}

export function providerGeometryKm(provider: RelationAwareGeometryProviderResult): number {
  return (
    Math.round(
      Object.values(provider.geometryByWayId).reduce((s, c) => s + pathLengthKm(c), 0) * 1000,
    ) / 1000
  );
}
