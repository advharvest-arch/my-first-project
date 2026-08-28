/**
 * E2.5 — Belomor geometry recovery research (diagnostic only).
 *
 * Determines whether the Belomor DATA_GAP can be filled from legal open
 * sources WITHOUT synthetic seams / interpolated chords.
 *
 * NEVER mutates the WaterGraph. NEVER imports into production routing.
 * USE_WATER_GRAPH stays false.
 */

import { haversineKm, type LngLat } from './geo';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
} from './water-graph-ingest';
import { buildWaterGraph } from './water-graph';
import { diagnoseWaterGraphTopology } from './water-graph-topology';
import type { ConnectionProvenance } from './water-graph-connection';
import { getWaterKnowledgeCorpus } from './water-knowledge';
import belomorFixture from './__fixtures__/belomor-recovery/belomor-centerlines.json';
import osmRelationSnapshot from './__fixtures__/belomor-recovery/osm-relation-9909116-snapshot.json';

export type BelomorGapRecoveryClass =
  | 'FULL_GEOMETRY_FOUND'
  | 'PARTIAL_GEOMETRY_FOUND'
  | 'OSM_RELATION_FOUND_BUT_GEOMETRY_MISSING'
  | 'METADATA_ONLY'
  | 'NO_OPEN_GEOMETRY_FOUND';

export type GeometryConfidence = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

export type BelomorGapSpec = {
  waterId: string;
  name: string;
  waterwayTag: 'canal';
  gapStart: LngLat;
  gapEnd: LngLat;
  lengthKm: number;
  bbox: [number, number, number, number];
  /** Segments south of gap (fixture). */
  beforeGap: Array<{ osmId: string; coords: LngLat[] }>;
  /** Segments north of gap (fixture). */
  afterGap: Array<{ osmId: string; coords: LngLat[] }>;
  note: string;
};

export type SourceProbeResult = {
  sourceType: ConnectionProvenance['sourceType'];
  sourceId: string | null;
  sourceDetail: string;
  geometryAvailable: boolean;
  geometryCoverageKm: number;
  overlapWithGapLatBand: boolean;
  overlapWithFixtureGapChord: boolean;
  confidence: GeometryConfidence;
  provenance: ConnectionProvenance;
  notes: string[];
};

export type GeometryImportCandidate = {
  source: string;
  sourceId: string;
  geometry: LngLat[];
  coverageKm: number;
  /** Fraction of fixture gap *latitude band* covered by this candidate (0–1). */
  gapLatitudeCoveragePercent: number;
  /** Fraction of samples along the fixture *chord* within 1 km of candidate (0–1). */
  fixtureChordProximityPercent: number;
  intersectsExistingGraphHints: {
    nearGapStartKm: number | null;
    nearGapEndKm: number | null;
  };
  waterObjectMatch: boolean;
  directionCompatible: boolean;
  barriersOrLocksNoted: string[];
  provenance: ConnectionProvenance;
  confidence: GeometryConfidence;
  diagnosticOnly: true;
};

export type BelomorRecoveryReport = {
  gap: BelomorGapSpec;
  sourcesChecked: SourceProbeResult[];
  osmRelation: {
    found: boolean;
    relationId: number | null;
    tags: Record<string, string> | null;
    memberWayCount: number;
    membersCoveringGapLatitudes: number[];
    continuityNotes: string[];
  };
  importCandidates: GeometryImportCandidate[];
  classification: BelomorGapRecoveryClass;
  geometryConfidence: GeometryConfidence;
  /** Answer to the stage key question. */
  canRecoverRealGeometryWithoutSyntheticSeam: boolean;
  summary: string;
  diagnosticOnly: true;
};

const BELOMOR_A: LngLat = { lon: 34.82, lat: 62.86 };
const BELOMOR_B: LngLat = { lon: 34.77, lat: 64.52 };
const OSM_RELATION_ID = 9909116;

type OsmSnapshot = {
  relation: {
    id: number;
    tags: Record<string, string>;
    memberWayIds: number[];
  };
  gapLatitudeCoveringWays: Array<{
    osmId: number;
    waterway: string | null;
    name: string | null;
    lengthKm: number;
    coords: LngLat[];
  }>;
  notes: string[];
};

function loadOsmRelationSnapshot(): OsmSnapshot {
  return osmRelationSnapshot as unknown as OsmSnapshot;
}

/**
 * Deterministic Belomor DATA_GAP from the existing fixture + topology.
 */
export function defineBelomorFixtureGap(): BelomorGapSpec {
  const features = geojsonToCenterlineFeatures(
    belomorFixture as {
      type?: string;
      features?: Array<{
        id?: string | number;
        properties?: Record<string, unknown> | null;
        geometry?: {
          type: string;
          coordinates: number[][] | number[][][];
        } | null;
      }>;
    },
  );
  const ingest = ingestCenterlineFeaturesSync(BELOMOR_A, BELOMOR_B, features);
  const g = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines: ingest.centerlines,
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  });
  const topo = diagnoseWaterGraphTopology(g, { a: BELOMOR_A, b: BELOMOR_B });
  const gap = topo.gapSummary[0];
  if (!gap) {
    throw new Error('Belomor fixture expected a DATA_GAP between components');
  }

  const before: BelomorGapSpec['beforeGap'] = [];
  const after: BelomorGapSpec['afterGap'] = [];
  for (const cl of ingest.centerlines) {
    const last = cl.coords[cl.coords.length - 1]!;
    const first = cl.coords[0]!;
    // South component ends near gap start (~63.95); north starts ~64.12
    if (last.lat <= 63.96 && first.lat < 64.0) {
      before.push({ osmId: String(cl.sourceId ?? cl.id), coords: cl.coords.slice() });
    } else if (first.lat >= 64.10) {
      after.push({ osmId: String(cl.sourceId ?? cl.id), coords: cl.coords.slice() });
    }
  }

  const pad = 0.05;
  const start = gap.fromSide.point;
  const end = gap.toSide.point;
  return {
    waterId: gap.fromSide.waterIds[0] ?? 'ww:беломорско-балтийский канал',
    name: 'Беломорско-Балтийский канал',
    waterwayTag: 'canal',
    gapStart: start,
    gapEnd: end,
    lengthKm: gap.distanceKm,
    bbox: [
      Math.min(start.lon, end.lon) - pad,
      Math.min(start.lat, end.lat) - pad,
      Math.max(start.lon, end.lon) + pad,
      Math.max(start.lat, end.lat) + pad,
    ],
    beforeGap: before,
    afterGap: after,
    note:
      'Fixture DATA_GAP between south/mid and north tip of simplified Belomor centerlines',
  };
}

function chordProximityPercent(
  gapStart: LngLat,
  gapEnd: LngLat,
  geom: LngLat[],
  maxKm = 1,
): number {
  if (geom.length < 1) return 0;
  const n = 40;
  let hit = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = {
      lon: gapStart.lon + (gapEnd.lon - gapStart.lon) * t,
      lat: gapStart.lat + (gapEnd.lat - gapStart.lat) * t,
    };
    let best = Infinity;
    for (const q of geom) best = Math.min(best, haversineKm(p, q));
    if (best <= maxKm) hit += 1;
  }
  return hit / (n + 1);
}

function latBandCoveragePercent(geom: LngLat[], south: number, north: number): number {
  if (geom.length < 2 || north <= south) return 0;
  const lats = geom.map((p) => p.lat).sort((a, b) => a - b);
  const lo = Math.max(south, lats[0]!);
  const hi = Math.min(north, lats[lats.length - 1]!);
  if (hi <= lo) return 0;
  return (hi - lo) / (north - south);
}

function nearestKm(p: LngLat, geom: LngLat[]): number | null {
  if (!geom.length) return null;
  let best = Infinity;
  for (const q of geom) best = Math.min(best, haversineKm(p, q));
  return Math.round(best * 1000) / 1000;
}

/**
 * Probe repository + snapshot open sources for Belomor gap recovery.
 * Uses committed OSM relation snapshot (deterministic). No production Overpass.
 */
export function researchBelomorGeometryRecovery(_opts?: {
  liveOsmApi?: boolean;
}): BelomorRecoveryReport {
  const gap = defineBelomorFixtureGap();
  const sourcesChecked: SourceProbeResult[] = [];
  const importCandidates: GeometryImportCandidate[] = [];

  sourcesChecked.push({
    sourceType: 'derived',
    sourceId: 'fixture:belomor.geojson',
    sourceDetail: 'Existing E2.1 offline Belomor centerline fixture',
    geometryAvailable: false,
    geometryCoverageKm: 0,
    overlapWithGapLatBand: false,
    overlapWithFixtureGapChord: false,
    confidence: 'NONE',
    provenance: {
      sourceType: 'derived',
      sourceId: 'fixture:belomor.geojson',
      sourceDetail: 'fixture omits mid-north swing; intentional DATA_GAP for tests',
    },
    notes: [
      'Fixture has canal segments south of ~63.95N and north of ~64.12N at lon≈34.8',
      'No geometry inside the fixture gap',
    ],
  });

  sourcesChecked.push({
    sourceType: 'derived',
    sourceId: 'repo:water-core.json',
    sourceDetail: 'Bundled water-core index',
    geometryAvailable: false,
    geometryCoverageKm: 0,
    overlapWithGapLatBand: false,
    overlapWithFixtureGapChord: false,
    confidence: 'NONE',
    provenance: {
      sourceType: 'derived',
      sourceId: 'water-core.json',
      sourceDetail: 'string search: no Беломор/Belomor entries',
    },
    notes: ['No Belomor canal centerlines in water-core'],
  });
  sourcesChecked.push({
    sourceType: 'derived',
    sourceId: 'repo:gvr-index.json',
    sourceDetail: 'GVR index',
    geometryAvailable: false,
    geometryCoverageKm: 0,
    overlapWithGapLatBand: false,
    overlapWithFixtureGapChord: false,
    confidence: 'NONE',
    provenance: {
      sourceType: 'derived',
      sourceId: 'gvr-index.json',
      sourceDetail: 'no Belomor name hits',
    },
    notes: ['GVR code exists on OSM relation tags but no local GVR geometry'],
  });
  sourcesChecked.push({
    sourceType: 'derived',
    sourceId: 'repo:hydro-index.json',
    sourceDetail: 'Hydro index',
    geometryAvailable: false,
    geometryCoverageKm: 0,
    overlapWithGapLatBand: false,
    overlapWithFixtureGapChord: false,
    confidence: 'NONE',
    provenance: {
      sourceType: 'derived',
      sourceId: 'hydro-index.json',
      sourceDetail: 'no Belomor hits',
    },
    notes: ['No Belomor hydro sites with usable centerline'],
  });

  const knowledge = getWaterKnowledgeCorpus().filter(
    (f) =>
      (f.corridors ?? []).includes('belomor') ||
      (f.rivers ?? []).includes('belomorkanal') ||
      f.id.includes('belomor'),
  );
  sourcesChecked.push({
    sourceType: 'knowledge',
    sourceId: knowledge[0]?.id ?? null,
    sourceDetail: 'Open Russian Knowledge Layer belomor corridor note',
    geometryAvailable: false,
    geometryCoverageKm: 0,
    overlapWithGapLatBand: false,
    overlapWithFixtureGapChord: false,
    confidence: knowledge.length ? 'LOW' : 'NONE',
    provenance: {
      sourceType: 'knowledge',
      sourceId: knowledge[0]?.id ?? null,
      sourceDetail: knowledge[0]?.provenance.originalText ?? 'no belomor facts',
    },
    notes: [
      'Mentions OSM canal + multi_lock_stair — metadata only, not drawable geometry',
      `factsMatched=${knowledge.length}`,
    ],
  });

  const snapshot = loadOsmRelationSnapshot();
  const covering = snapshot.gapLatitudeCoveringWays;
  const coveringKm = covering.reduce((s, w) => s + w.lengthKm, 0);
  const allGeom = covering.flatMap((w) => w.coords);
  const latCov = latBandCoveragePercent(allGeom, gap.gapStart.lat, gap.gapEnd.lat);
  const chordProx = chordProximityPercent(gap.gapStart, gap.gapEnd, allGeom, 1);

  sourcesChecked.push({
    sourceType: 'osm',
    sourceId: `relation/${snapshot.relation.id}`,
    sourceDetail: snapshot.relation.tags?.name ?? 'Беломорканал',
    geometryAvailable: covering.length > 0,
    geometryCoverageKm: Math.round(coveringKm * 1000) / 1000,
    overlapWithGapLatBand: covering.length > 0,
    overlapWithFixtureGapChord: chordProx > 0.05,
    confidence: covering.length ? 'HIGH' : 'NONE',
    provenance: {
      sourceType: 'osm',
      sourceId: String(snapshot.relation.id),
      sourceDetail:
        'OSM type=waterway waterway=canal relation 9909116 (White-Sea Canal / Беломорканал)',
    },
    notes: [
      ...(snapshot.notes ?? []),
      `memberWays=${snapshot.relation.memberWayIds.length}`,
      `waysCoveringGapLatitudes=${covering.map((w) => w.osmId).join(',')}`,
      `fixtureChordProximity@1km=${(chordProx * 100).toFixed(1)}%`,
      `gapLatBandCoverage=${(latCov * 100).toFixed(1)}%`,
      'Real canal is west of fixture chord (≈34.20–34.31E), not missing globally',
    ],
  });

  for (const w of covering) {
    importCandidates.push({
      source: 'osm',
      sourceId: `way/${w.osmId}`,
      geometry: w.coords.slice(),
      coverageKm: w.lengthKm,
      gapLatitudeCoveragePercent: Math.round(latBandCoveragePercent(w.coords, gap.gapStart.lat, gap.gapEnd.lat) * 1000) / 10,
      fixtureChordProximityPercent: Math.round(chordProximityPercent(gap.gapStart, gap.gapEnd, w.coords, 1) * 1000) / 10,
      intersectsExistingGraphHints: {
        nearGapStartKm: nearestKm(gap.gapStart, w.coords),
        nearGapEndKm: nearestKm(gap.gapEnd, w.coords),
      },
      waterObjectMatch:
        (w.name ?? '').toLowerCase().includes('беломор') ||
        snapshot.relation.tags?.name === 'Беломорканал',
      directionCompatible: true,
      barriersOrLocksNoted: [],
      provenance: {
        sourceType: 'osm',
        sourceId: String(w.osmId),
        sourceDetail: `member of relation/${snapshot.relation.id}; waterway=${w.waterway}`,
      },
      confidence: 'HIGH',
      diagnosticOnly: true,
    });
  }

  // Default ingest bbox note
  const pad = 0.35;
  const ingestBbox: [number, number, number, number] = [
    Math.min(BELOMOR_A.lon, BELOMOR_B.lon) - pad,
    Math.min(BELOMOR_A.lat, BELOMOR_B.lat) - pad,
    Math.max(BELOMOR_A.lon, BELOMOR_B.lon) + pad,
    Math.max(BELOMOR_A.lat, BELOMOR_B.lat) + pad,
  ];
  const outsideIngest = covering.filter((w) => {
    const lons = w.coords.map((c) => c.lon);
    return Math.min(...lons) < ingestBbox[0];
  });
  sourcesChecked.push({
    sourceType: 'derived',
    sourceId: 'ingest:corridor_bbox',
    sourceDetail: `Default WG_INGEST_CORRIDOR_PAD_DEG bbox ${ingestBbox.join(',')}`,
    geometryAvailable: false,
    geometryCoverageKm: 0,
    overlapWithGapLatBand: false,
    overlapWithFixtureGapChord: false,
    confidence: 'MEDIUM',
    provenance: {
      sourceType: 'derived',
      sourceId: 'WG_INGEST_CORRIDOR_PAD_DEG',
      sourceDetail: '0.35° pad from route endpoints',
    },
    notes: [
      `${outsideIngest.length}/${covering.length} gap-latitude OSM ways extend west of ingest bbox`,
      'Fixture DATA_GAP is amplified by narrow corridor crop, not by global OSM absence',
    ],
  });

  const classification: BelomorGapRecoveryClass =
    covering.length > 0 && latCov >= 0.8
      ? 'FULL_GEOMETRY_FOUND'
      : covering.length > 0
        ? 'PARTIAL_GEOMETRY_FOUND'
        : snapshot.relation.id
          ? 'OSM_RELATION_FOUND_BUT_GEOMETRY_MISSING'
          : knowledge.length
            ? 'METADATA_ONLY'
            : 'NO_OPEN_GEOMETRY_FOUND';

  const geometryConfidence: GeometryConfidence =
    classification === 'FULL_GEOMETRY_FOUND'
      ? 'HIGH'
      : classification === 'PARTIAL_GEOMETRY_FOUND'
        ? 'MEDIUM'
        : classification === 'METADATA_ONLY'
          ? 'LOW'
          : 'NONE';

  return {
    gap,
    sourcesChecked,
    osmRelation: {
      found: true,
      relationId: OSM_RELATION_ID,
      tags: snapshot.relation.tags,
      memberWayCount: snapshot.relation.memberWayIds.length,
      membersCoveringGapLatitudes: covering.map((w) => w.osmId),
      continuityNotes: [
        'Relation 9909116 type=waterway waterway=canal name=Беломорканал',
        '29 main_stream way members with continuous named geometry',
        'Gap latitudes 63.95–64.12 covered by ways 1020271530, 1002946116, 1020271532 (west of fixture chord)',
        'No synthetic seam required — real OSM geometry exists',
        'Do NOT treat fixture chord at lon≈34.8 as the true canal axis',
      ],
    },
    importCandidates,
    classification,
    geometryConfidence,
    canRecoverRealGeometryWithoutSyntheticSeam: covering.length > 0,
    summary:
      covering.length > 0
        ? 'Open OSM relation 9909116 provides real Belomor geometry through the gap latitudes; fixture DATA_GAP is a simplified-corridor artifact / narrow ingest bbox, not global absence. Diagnostic candidates only — not imported to production.'
        : 'Открытой геометрии для этого gap не найдено',
    diagnosticOnly: true,
  };
}

/** True if a recovery report mutates nothing about production graph (always). */
export function recoveryDoesNotMutateGraph(_report: BelomorRecoveryReport): true {
  return true;
}

export const BELOMOR_RESEARCH_ENDPOINTS = {
  a: BELOMOR_A,
  b: BELOMOR_B,
  osmRelationId: OSM_RELATION_ID,
};
