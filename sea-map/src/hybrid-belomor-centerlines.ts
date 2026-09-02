/**
 * Browser-safe Belomor relation centerlines for E2.15 hybrid pilot.
 * Uses a static JSON import (Vite) — no node:fs.
 * Geographic corridor detection only (not route-name gating).
 */

import { haversineKm, type LngLat } from './geo';
import type { CenterlineSource } from './water-graph-types';
import { classifyCenterlineKind } from './water-graph-ingest';
import belomorFullWays from './__fixtures__/belomor-recovery/osm-relation-9909116-full-ways.json';

export const HYBRID_BELOMOR_A: LngLat = { lon: 34.82, lat: 62.86 };
export const HYBRID_BELOMOR_B: LngLat = { lon: 34.77, lat: 64.52 };

type SnapMember = {
  osmId: number;
  role?: string;
  waterway?: string | null;
  name?: string | null;
  coords: Array<{ lon: number; lat: number }>;
};

type BelomorSnap = {
  relation?: { id?: number };
  members?: SnapMember[];
};

/** Geographic Belomor waterway-system overlap (±maxKm of corridor endpoints). */
export function isHybridBelomorCorridor(
  a: LngLat,
  b: LngLat,
  maxKm = 80,
): boolean {
  const nearA =
    haversineKm(a, HYBRID_BELOMOR_A) <= maxKm ||
    haversineKm(a, HYBRID_BELOMOR_B) <= maxKm;
  const nearB =
    haversineKm(b, HYBRID_BELOMOR_A) <= maxKm ||
    haversineKm(b, HYBRID_BELOMOR_B) <= maxKm;
  return nearA && nearB;
}

/** Relation 9909116 member ways as WaterGraph centerlines (snapshot). */
export function hybridBelomorRelationCenterlines(): CenterlineSource[] {
  const snap = belomorFullWays as BelomorSnap;
  const out: CenterlineSource[] = [];
  for (const m of snap.members ?? []) {
    if (!m.coords || m.coords.length < 2) continue;
    const coords = m.coords.map((p) => ({ lon: p.lon, lat: p.lat }));
    out.push({
      id: `osm:${m.osmId}`,
      kind: classifyCenterlineKind(m.waterway ?? null, m.name ?? null),
      coords,
      name: m.name ?? null,
      source: 'osm',
      sourceId: String(m.osmId),
      waterId: `ww:relation:${snap.relation?.id ?? 9909116}`,
    });
  }
  return out;
}
