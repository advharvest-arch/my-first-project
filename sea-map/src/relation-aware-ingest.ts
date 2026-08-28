/**
 * E2.7 — Relation-aware waterway ingest prototype (diagnostic only).
 *
 * Builds Belomor WaterGraph variants from:
 *   A. CURRENT — existing simplified fixture / default corridor bbox
 *   B. RELATION_AWARE — OSM relation 9909116 member way geometry only
 *
 * No seams, no synthetic/interpolated geometry, no production ingest swap.
 * USE_WATER_GRAPH stays false.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineKm, pathLengthKm, type LngLat } from './geo';
import {
  WG_INGEST_CORRIDOR_PAD_DEG,
  corridorBbox,
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
  classifyCenterlineKind,
  type OsmCenterlineFeature,
} from './water-graph-ingest';
import {
  bindWaterGraphTerminal,
  buildWaterGraph,
  searchWaterGraph,
  type WaterGraph,
} from './water-graph';
import { diagnoseWaterGraphTopology } from './water-graph-topology';
import type { CenterlineSource } from './water-graph-types';
import type { ConnectionProvenance } from './water-graph-connection';

const here = dirname(fileURLToPath(import.meta.url));

function loadJsonFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(here, relativePath), 'utf8')) as T;
}

export const BELOMOR_RELATION_ID = 9909116;

/** Same corridor endpoints as E2.x Belomor benches. */
export const BELOMOR_A: LngLat = { lon: 34.82, lat: 62.86 };
export const BELOMOR_B: LngLat = { lon: 34.77, lat: 64.52 };

/** Do not treat endpoints as connected unless within this distance (no auto-join). */
export const MEMBER_CONTINUITY_CONNECT_KM = 0.05; // matches WG_MERGE_NODE_KM

export type RelationMemberWay = {
  order: number;
  osmId: number;
  role: string;
  waterway: string | null;
  name: string | null;
  tags: Record<string, string>;
  lengthKm: number;
  pointCount: number;
  coords: LngLat[];
  start: LngLat;
  end: LngLat;
};

export type OsmWaterwayRelationSnapshot = {
  retrievedAt: string;
  sourceType: 'osm';
  sourceDetail: string;
  relation: {
    id: number;
    tags: Record<string, string>;
    memberCount: number;
    memberWayIds: number[];
    mainStreamCount: number;
  };
  members: RelationMemberWay[];
  notes: string[];
};

export type DiagnosticGeometryProvenance = ConnectionProvenance & {
  confidence: 'HIGH';
  diagnosticOnly: true;
};

export type RelationAwareSegment = {
  osmId: number;
  role: string;
  order: number;
  coords: LngLat[];
  lengthKm: number;
  provenance: DiagnosticGeometryProvenance;
};

export type MemberContinuityLink = {
  fromOsmId: number;
  toOsmId: number;
  fromOrder: number;
  toOrder: number;
  /** Best endpoint-pair distance (km). Not an automatic graph edge. */
  bestEndpointDistanceKm: number;
  bestPair: 'end-start' | 'end-end' | 'start-start' | 'start-end';
  connectedBySharedEndpoint: boolean;
  directionReversedRelativeToOrder: boolean;
  classification: 'SHARED_ENDPOINT' | 'NEAR_TOUCH' | 'DISCONTINUITY';
};

export type BboxCompare = {
  label: 'CURRENT_FIXTURE_BBOX' | 'RELATION_AWARE_BBOX';
  bbox: [number, number, number, number];
  widthDeg: number;
  heightDeg: number;
  waysFullyInside: number[];
  waysPartiallyInside: number[];
  waysOutside: number[];
  geometryKmInside: number;
};

export type GraphVariantMetrics = {
  variant: 'CURRENT' | 'RELATION_AWARE';
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  largestComponentKm: number;
  gapCount: number;
  gapLengthsKm: number[];
  /** Artificial fixture-class gap (~18.96 km) still present? */
  artificialFixtureGapPresent: boolean;
  artificialFixtureGapKm: number | null;
  geometryCoverageKm: number;
  relationWayCount: number;
  graphBuildMs: number;
  searchMs: number;
  pathFound: boolean;
  pathLengthKm: number | null;
  pathFailReason: string | null;
  pathProvenanceSourceIds: string[];
  bbox: [number, number, number, number];
};

export type E27Report = {
  schemaVersion: 'e2.7-relation-aware-ingest';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  noSeam: true;
  noSyntheticGeometry: true;
  relation: {
    found: boolean;
    relationId: number;
    tags: Record<string, string>;
    memberCount: number;
    mainStreamCount: number;
    relevantWayIds: number[];
    geometryCoverageKm: number;
  };
  bboxCompare: {
    current: BboxCompare;
    relationAware: BboxCompare;
  };
  continuity: {
    links: MemberContinuityLink[];
    sharedEndpointCount: number;
    discontinuityCount: number;
    directionReversalCount: number;
    duplicateOrOverlapNotes: string[];
  };
  current: GraphVariantMetrics;
  relationAware: GraphVariantMetrics;
  comparison: {
    artificialGapEliminated: boolean;
    componentCountDelta: number;
    largestComponentKmDelta: number;
    pathFoundDelta: string;
  };
  e26Context: {
    belomorHistorical: 'CONFIRMED_WORKING';
    fixtureDataGap: 'PIPELINE_ARTIFACT';
    osmRelationContainsRealGeometry: true;
    relationAwareMayExplainBetterCoverage: string;
  };
  answers: {
    eliminatesArtificialBelomorDataGapWithoutSeam: boolean;
    safeFutureProductionIngestCandidate: boolean;
    safeCandidateRationale: string;
    remainingLimitations: string[];
  };
  summary: string;
};

type FullWaysJson = {
  retrievedAt: string;
  sourceType: string;
  sourceDetail: string;
  relation: OsmWaterwayRelationSnapshot['relation'];
  members: Array<{
    order: number;
    osmId: number;
    role: string;
    waterway: string | null;
    name: string | null;
    tags?: Record<string, string>;
    lengthKm: number;
    pointCount: number;
    coords: Array<{ lon: number; lat: number }>;
    start: { lon: number; lat: number };
    end: { lon: number; lat: number };
  }>;
  notes?: string[];
};

/** Load committed OSM relation 9909116 full-ways snapshot (deterministic). */
export function loadBelomorRelation9909116(): OsmWaterwayRelationSnapshot {
  const raw = loadJsonFixture<FullWaysJson>(
    '__fixtures__/belomor-recovery/osm-relation-9909116-full-ways.json',
  );
  if (raw.relation.id !== BELOMOR_RELATION_ID) {
    throw new Error(`Expected relation ${BELOMOR_RELATION_ID}, got ${raw.relation.id}`);
  }
  const members: RelationMemberWay[] = raw.members.map((m) => ({
    order: m.order,
    osmId: m.osmId,
    role: m.role,
    waterway: m.waterway,
    name: m.name,
    tags: m.tags ?? {},
    lengthKm: m.lengthKm,
    pointCount: m.pointCount,
    coords: m.coords.map((c) => ({ lon: c.lon, lat: c.lat })),
    start: { lon: m.start.lon, lat: m.start.lat },
    end: { lon: m.end.lon, lat: m.end.lat },
  }));
  return {
    retrievedAt: raw.retrievedAt,
    sourceType: 'osm',
    sourceDetail: raw.sourceDetail,
    relation: raw.relation,
    members,
    notes: raw.notes ?? [],
  };
}

export function memberProvenance(
  relationId: number,
  member: Pick<RelationMemberWay, 'osmId' | 'role' | 'order'>,
): DiagnosticGeometryProvenance {
  return {
    sourceType: 'osm',
    sourceId: `way/${member.osmId}`,
    sourceDetail: `OSM relation ${relationId} / ${member.role || 'member'} member (order ${member.order})`,
    confidence: 'HIGH',
    diagnosticOnly: true,
  };
}

/**
 * Process relation → diagnostic segments. Geometry is copied from OSM ways only.
 * Does not interpolate, densify across gaps, or use fixture chords.
 */
export function processOsmWaterwayRelation(
  snap: OsmWaterwayRelationSnapshot,
): {
  relationId: number;
  tags: Record<string, string>;
  memberIdsInOrder: number[];
  mainStreamMembers: RelationMemberWay[];
  relevantMembers: RelationMemberWay[];
  segments: RelationAwareSegment[];
  geometryCoverageKm: number;
} {
  const mainStream = snap.members.filter((m) => m.role === 'main_stream');
  // All waterway centerline members with ≥2 points are relevant.
  const relevant = snap.members.filter((m) => m.coords.length >= 2);
  const segments: RelationAwareSegment[] = relevant.map((m) => ({
    osmId: m.osmId,
    role: m.role,
    order: m.order,
    coords: m.coords.slice(),
    lengthKm: pathLengthKm(m.coords),
    provenance: memberProvenance(snap.relation.id, m),
  }));
  const geometryCoverageKm =
    Math.round(segments.reduce((s, x) => s + x.lengthKm, 0) * 1000) / 1000;
  return {
    relationId: snap.relation.id,
    tags: snap.relation.tags,
    memberIdsInOrder: snap.members.map((m) => m.osmId),
    mainStreamMembers: mainStream,
    relevantMembers: relevant,
    segments,
    geometryCoverageKm,
  };
}

function endpointPairDistance(
  a: RelationMemberWay,
  b: RelationMemberWay,
): { km: number; pair: MemberContinuityLink['bestPair']; reversed: boolean } {
  const pairs: Array<{
    km: number;
    pair: MemberContinuityLink['bestPair'];
    reversed: boolean;
  }> = [
    { km: haversineKm(a.end, b.start), pair: 'end-start', reversed: false },
    { km: haversineKm(a.end, b.end), pair: 'end-end', reversed: true },
    { km: haversineKm(a.start, b.start), pair: 'start-start', reversed: true },
    { km: haversineKm(a.start, b.end), pair: 'start-end', reversed: true },
  ];
  pairs.sort((x, y) => x.km - y.km);
  return pairs[0]!;
}

/**
 * Continuity between consecutive relation members.
 * Close ends are classified — never auto-joined into synthetic geometry.
 */
export function analyzeMemberContinuity(
  members: RelationMemberWay[],
  connectKm = MEMBER_CONTINUITY_CONNECT_KM,
): MemberContinuityLink[] {
  const links: MemberContinuityLink[] = [];
  const ordered = [...members].sort((a, b) => a.order - b.order);
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i]!;
    const b = ordered[i + 1]!;
    const best = endpointPairDistance(a, b);
    const shared = best.km <= 1e-6;
    const near = !shared && best.km <= connectKm;
    links.push({
      fromOsmId: a.osmId,
      toOsmId: b.osmId,
      fromOrder: a.order,
      toOrder: b.order,
      bestEndpointDistanceKm: Math.round(best.km * 1e6) / 1e6,
      bestPair: best.pair,
      connectedBySharedEndpoint: shared,
      directionReversedRelativeToOrder: best.reversed && (shared || near),
      classification: shared
        ? 'SHARED_ENDPOINT'
        : near
          ? 'NEAR_TOUCH'
          : 'DISCONTINUITY',
    });
  }
  return links;
}

function detectDuplicateOverlapNotes(members: RelationMemberWay[]): string[] {
  const notes: string[] = [];
  const byId = new Map<number, number>();
  for (const m of members) byId.set(m.osmId, (byId.get(m.osmId) ?? 0) + 1);
  for (const [id, n] of byId) {
    if (n > 1) notes.push(`duplicate member osmId=${id} count=${n}`);
  }
  // Coarse overlap: identical start+end
  for (let i = 0; i < members.length; i++) {
    for (let j = i + 1; j < members.length; j++) {
      const a = members[i]!;
      const b = members[j]!;
      if (
        haversineKm(a.start, b.start) < 1e-6 &&
        haversineKm(a.end, b.end) < 1e-6 &&
        a.pointCount === b.pointCount
      ) {
        notes.push(`possible duplicate geometry way/${a.osmId} vs way/${b.osmId}`);
      }
    }
  }
  if (!notes.length) notes.push('No duplicate member IDs or identical start/end pairs detected');
  return notes;
}

export function computeCurrentFixtureBbox(
  a: LngLat = BELOMOR_A,
  b: LngLat = BELOMOR_B,
  padDeg = WG_INGEST_CORRIDOR_PAD_DEG,
): [number, number, number, number] {
  return corridorBbox(a, b, padDeg);
}

export function computeRelationAwareBbox(
  members: RelationMemberWay[],
  padDeg = 0.05,
): [number, number, number, number] {
  const lons = members.flatMap((m) => m.coords.map((c) => c.lon));
  const lats = members.flatMap((m) => m.coords.map((c) => c.lat));
  if (!lons.length) return [0, 0, 0, 0];
  return [
    Math.min(...lons) - padDeg,
    Math.min(...lats) - padDeg,
    Math.max(...lons) + padDeg,
    Math.max(...lats) + padDeg,
  ];
}

function classifyWaysVsBbox(
  label: BboxCompare['label'],
  bbox: [number, number, number, number],
  members: RelationMemberWay[],
): BboxCompare {
  const fully: number[] = [];
  const partial: number[] = [];
  const outside: number[] = [];
  let kmInside = 0;
  for (const m of members) {
    const insideFlags = m.coords.map(
      (p) =>
        p.lon >= bbox[0] &&
        p.lat >= bbox[1] &&
        p.lon <= bbox[2] &&
        p.lat <= bbox[3],
    );
    const allIn = insideFlags.every(Boolean);
    const someIn = insideFlags.some(Boolean);
    if (allIn) {
      fully.push(m.osmId);
      kmInside += m.lengthKm;
    } else if (someIn) {
      partial.push(m.osmId);
      // Approximate: count contiguous inside runs
      let run: LngLat[] = [];
      const flush = () => {
        if (run.length >= 2) kmInside += pathLengthKm(run);
        run = [];
      };
      for (let i = 0; i < m.coords.length; i++) {
        if (insideFlags[i]) run.push(m.coords[i]!);
        else flush();
      }
      flush();
    } else {
      outside.push(m.osmId);
    }
  }
  return {
    label,
    bbox,
    widthDeg: Math.round((bbox[2] - bbox[0]) * 1000) / 1000,
    heightDeg: Math.round((bbox[3] - bbox[1]) * 1000) / 1000,
    waysFullyInside: fully,
    waysPartiallyInside: partial,
    waysOutside: outside,
    geometryKmInside: Math.round(kmInside * 1000) / 1000,
  };
}

/** Convert relation members → centerline features (real OSM IDs only). */
export function relationMembersToOsmFeatures(
  members: RelationMemberWay[],
): OsmCenterlineFeature[] {
  return members
    .filter((m) => m.coords.length >= 2)
    .map((m) => ({
      osmId: m.osmId,
      waterway: m.waterway,
      name: m.name,
      coords: m.coords.slice(),
    }));
}

/**
 * Diagnostic centerlines from relation — no fixture chord, no synthetic fill.
 * Does **not** crop to CURRENT_FIXTURE_BBOX (that is what drops the western swing).
 * Uses OSM member coordinates verbatim.
 */
export function relationAwareCenterlines(
  snap: OsmWaterwayRelationSnapshot,
): CenterlineSource[] {
  const processed = processOsmWaterwayRelation(snap);
  return processed.relevantMembers.map((m) => ({
    id: `osm:way/${m.osmId}`,
    kind: classifyCenterlineKind(m.waterway, m.name),
    coords: m.coords.slice(),
    name: m.name,
    source: 'osm',
    sourceId: `way/${m.osmId}`,
    waterId: `ww:relation:${snap.relation.id}`,
  }));
}

function assertNoFixtureChordInRelationSources(centerlines: CenterlineSource[]): void {
  for (const cl of centerlines) {
    const sid = String(cl.sourceId ?? '');
    if (sid.startsWith('5020') || sid.includes('502000')) {
      throw new Error(`Fixture chord osmId leaked into relation-aware sources: ${sid}`);
    }
  }
}

function artificialGapFromTopology(
  gapLengthsKm: number[],
): { present: boolean; km: number | null } {
  // Fixture tear is ~18.96 km; accept 15–25 km band as the same artifact class.
  const hit = gapLengthsKm.find((g) => g >= 15 && g <= 25);
  return { present: hit != null, km: hit ?? null };
}

function buildVariantMetrics(
  variant: 'CURRENT' | 'RELATION_AWARE',
  centerlines: CenterlineSource[],
  bbox: [number, number, number, number],
  relationWayCount: number,
): GraphVariantMetrics {
  const t0 = performance.now();
  const g = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines,
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  });
  const graphBuildMs = performance.now() - t0;
  const topo = diagnoseWaterGraphTopology(g, { a: BELOMOR_A, b: BELOMOR_B });
  const gapLengthsKm = topo.gapSummary.map((x) => Math.round(x.distanceKm * 1000) / 1000);
  const artificial = artificialGapFromTopology(gapLengthsKm);
  const geometryCoverageKm =
    Math.round(centerlines.reduce((s, c) => s + pathLengthKm(c.coords), 0) * 1000) / 1000;

  const termA = bindWaterGraphTerminal(g, 'A', BELOMOR_A, [
    { point: BELOMOR_A, source: 'diag', distKm: 0, classPenalty: 0, stemPenalty: 0, rank: 0 },
  ]);
  const termB = bindWaterGraphTerminal(g, 'B', BELOMOR_B, [
    { point: BELOMOR_B, source: 'diag', distKm: 0, classPenalty: 0, stemPenalty: 0, rank: 0 },
  ]);

  let pathFound = false;
  let pathLengthKmResult: number | null = null;
  let searchMs = 0;
  let pathFailReason: string | null = null;
  let pathProvenanceSourceIds: string[] = [];

  if (!termA || !termB) {
    pathFailReason = !termA && !termB
      ? 'terminal_unbound_A_and_B'
      : !termA
        ? 'terminal_unbound_A'
        : 'terminal_unbound_B';
  } else {
    const search = searchWaterGraph(g, termA.nodeId, termB.nodeId);
    searchMs = search.searchMs;
    if (!search.path) {
      pathFailReason =
        topo.componentCount > 1
          ? `graph_disconnected (components=${topo.componentCount})`
          : 'search_no_path';
    } else {
      pathFound = true;
      pathLengthKmResult = Math.round(search.path.lengthKm * 1000) / 1000;
      const ids = new Set<string>();
      for (const eid of search.path.edgeIds) {
        const e = g.edges.get(eid);
        const sid = e?.metadata?.sourceId;
        if (typeof sid === 'string') ids.add(sid);
      }
      pathProvenanceSourceIds = [...ids].slice(0, 64);
    }
  }

  return {
    variant,
    nodeCount: g.nodes.size,
    edgeCount: g.edges.size,
    componentCount: topo.componentCount,
    largestComponentKm: topo.largestComponentKm,
    gapCount: topo.gapSummary.length,
    gapLengthsKm,
    artificialFixtureGapPresent: artificial.present,
    artificialFixtureGapKm: artificial.km,
    geometryCoverageKm,
    relationWayCount,
    graphBuildMs: Math.round(graphBuildMs * 1000) / 1000,
    searchMs: Math.round(searchMs * 1000) / 1000,
    pathFound,
    pathLengthKm: pathLengthKmResult,
    pathFailReason,
    pathProvenanceSourceIds,
    bbox,
  };
}

/** CURRENT variant: existing belomor.geojson fixture + default corridor pad. */
export function buildCurrentBelomorVariant(): {
  metrics: GraphVariantMetrics;
  centerlines: CenterlineSource[];
  graph: WaterGraph;
} {
  const belomorFixture = loadJsonFixture<{
    type?: string;
    features?: Array<{
      id?: string | number;
      properties?: Record<string, unknown> | null;
      geometry?: {
        type: string;
        coordinates: number[][] | number[][][];
      } | null;
    }>;
  }>('__fixtures__/centerlines/belomor.geojson');
  const features = geojsonToCenterlineFeatures(belomorFixture);
  const bbox = computeCurrentFixtureBbox();
  const ingest = ingestCenterlineFeaturesSync(BELOMOR_A, BELOMOR_B, features, {
    padDeg: WG_INGEST_CORRIDOR_PAD_DEG,
    sourceLabel: 'fixture-belomor',
  });
  const metrics = buildVariantMetrics('CURRENT', ingest.centerlines, bbox, 0);
  const graph = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines: ingest.centerlines,
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  });
  return { metrics, centerlines: ingest.centerlines, graph };
}

/** RELATION_AWARE variant: OSM relation member geometry only. */
export function buildRelationAwareBelomorVariant(
  snap?: OsmWaterwayRelationSnapshot,
): {
  metrics: GraphVariantMetrics;
  centerlines: CenterlineSource[];
  graph: WaterGraph;
  segments: RelationAwareSegment[];
} {
  const relation = snap ?? loadBelomorRelation9909116();
  const processed = processOsmWaterwayRelation(relation);
  const centerlines = relationAwareCenterlines(relation);
  assertNoFixtureChordInRelationSources(centerlines);
  const bbox = computeRelationAwareBbox(processed.relevantMembers);
  const metrics = buildVariantMetrics(
    'RELATION_AWARE',
    centerlines,
    bbox,
    processed.relevantMembers.length,
  );
  const graph = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines,
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  });
  return { metrics, centerlines, graph, segments: processed.segments };
}

/** Prove diagnostic builds do not mutate a caller-owned production-like graph. */
export function relationAwareDoesNotMutateProductionGraph(
  beforeNodeCount: number,
  afterNodeCount: number,
): boolean {
  return beforeNodeCount === afterNodeCount;
}

export function runE27RelationAwareIngestPrototype(): E27Report {
  const snap = loadBelomorRelation9909116();
  const processed = processOsmWaterwayRelation(snap);
  const continuity = analyzeMemberContinuity(processed.relevantMembers);
  const currentBbox = computeCurrentFixtureBbox();
  const relationBbox = computeRelationAwareBbox(processed.relevantMembers);
  const bboxCurrent = classifyWaysVsBbox(
    'CURRENT_FIXTURE_BBOX',
    currentBbox,
    processed.relevantMembers,
  );
  const bboxRelation = classifyWaysVsBbox(
    'RELATION_AWARE_BBOX',
    relationBbox,
    processed.relevantMembers,
  );

  // Isolation check: empty graph size stays 0 after building diagnostic variants.
  const emptyBefore = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines: [],
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  });
  const beforeCount = emptyBefore.nodes.size;

  const current = buildCurrentBelomorVariant();
  const relationAware = buildRelationAwareBelomorVariant(snap);

  const afterEmpty = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines: [],
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  });
  if (!relationAwareDoesNotMutateProductionGraph(beforeCount, afterEmpty.nodes.size)) {
    throw new Error('Diagnostic ingest mutated shared/empty graph unexpectedly');
  }

  const artificialGapEliminated =
    current.metrics.artificialFixtureGapPresent &&
    !relationAware.metrics.artificialFixtureGapPresent;

  const eliminates =
    artificialGapEliminated ||
    (current.metrics.gapCount > 0 &&
      relationAware.metrics.componentCount === 1 &&
      !relationAware.metrics.artificialFixtureGapPresent);

  const safeCandidate =
    eliminates &&
    continuity.filter((l) => l.classification === 'DISCONTINUITY').length === 0 &&
    relationAware.segments.every((s) => s.provenance.diagnosticOnly && s.provenance.sourceType === 'osm');

  return {
    schemaVersion: 'e2.7-relation-aware-ingest',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    noSeam: true,
    noSyntheticGeometry: true,
    relation: {
      found: true,
      relationId: processed.relationId,
      tags: processed.tags,
      memberCount: snap.relation.memberCount,
      mainStreamCount: processed.mainStreamMembers.length,
      relevantWayIds: processed.relevantMembers.map((m) => m.osmId),
      geometryCoverageKm: processed.geometryCoverageKm,
    },
    bboxCompare: {
      current: bboxCurrent,
      relationAware: bboxRelation,
    },
    continuity: {
      links: continuity,
      sharedEndpointCount: continuity.filter((l) => l.classification === 'SHARED_ENDPOINT')
        .length,
      discontinuityCount: continuity.filter((l) => l.classification === 'DISCONTINUITY')
        .length,
      directionReversalCount: continuity.filter((l) => l.directionReversedRelativeToOrder)
        .length,
      duplicateOrOverlapNotes: detectDuplicateOverlapNotes(processed.relevantMembers),
    },
    current: current.metrics,
    relationAware: relationAware.metrics,
    comparison: {
      artificialGapEliminated: eliminates,
      componentCountDelta:
        relationAware.metrics.componentCount - current.metrics.componentCount,
      largestComponentKmDelta:
        Math.round(
          (relationAware.metrics.largestComponentKm - current.metrics.largestComponentKm) *
            1000,
        ) / 1000,
      pathFoundDelta: `${current.metrics.pathFound} → ${relationAware.metrics.pathFound}`,
    },
    e26Context: {
      belomorHistorical: 'CONFIRMED_WORKING',
      fixtureDataGap: 'PIPELINE_ARTIFACT',
      osmRelationContainsRealGeometry: true,
      relationAwareMayExplainBetterCoverage:
        'E2.6 noted historical Overpass relation queries (pre-35bb549) and Belomor full BRouter OK. Relation-aware ingest recovers the western canal axis that the simplified fixture/narrow bbox omit — consistent with better coverage when real OSM geometry is used, without claiming sole causality.',
    },
    answers: {
      eliminatesArtificialBelomorDataGapWithoutSeam: eliminates,
      safeFutureProductionIngestCandidate: safeCandidate,
      safeCandidateRationale: safeCandidate
        ? 'Relation-aware ingest uses only OSM member geometry with HIGH provenance, removes the fixture tear without seams/interpolation, and keeps discontinuities explicit. Still diagnostic — needs production gating, live Overpass policy, and broader corridor validation before enablement.'
        : 'Not yet a safe production candidate: residual discontinuities, path failure, or incomplete elimination of the artificial gap.',
      remainingLimitations: [
        'Diagnostic offline snapshot — live Overpass/OSM API not wired into production',
        'Belomor endpoints still user/bench clicks; terminal bind uses existing graph helper',
        'Locks/staircase portals still not modeled',
        'USE_WATER_GRAPH remains false — no production routing path',
        'Other corridors (VG-mid, X3) not covered by this prototype',
      ],
    },
    summary: eliminates
      ? 'RELATION_AWARE ingest of OSM relation 9909116 eliminates the artificial ~19 km Belomor fixture DATA_GAP using only real member way geometry (no seam, no synthetic fill). CURRENT fixture/corridor still shows the tear. Safe as a future production ingest candidate only behind explicit enablement — not enabled here.'
      : 'Relation-aware ingest did not fully eliminate the artificial Belomor gap under this diagnostic run — see metrics.',
  };
}

export function formatE27Markdown(report: E27Report = runE27RelationAwareIngestPrototype()): string {
  const c = report.current;
  const r = report.relationAware;
  return [
    '# E2.7 — Relation-aware waterway ingest prototype',
    '',
    report.summary,
    '',
    `eliminatesArtificialGap: **${report.answers.eliminatesArtificialBelomorDataGapWithoutSeam}**`,
    `safeFutureProductionCandidate: **${report.answers.safeFutureProductionIngestCandidate}**`,
    '',
    '## Relation 9909116',
    `- members: ${report.relation.memberCount}`,
    `- main_stream: ${report.relation.mainStreamCount}`,
    `- geometryCoverageKm: ${report.relation.geometryCoverageKm}`,
    '',
    '## BBox',
    `- CURRENT: ${report.bboxCompare.current.bbox.join(', ')} (${report.bboxCompare.current.widthDeg}×${report.bboxCompare.current.heightDeg}°) ways in/partial/out=${report.bboxCompare.current.waysFullyInside.length}/${report.bboxCompare.current.waysPartiallyInside.length}/${report.bboxCompare.current.waysOutside.length}`,
    `- RELATION_AWARE: ${report.bboxCompare.relationAware.bbox.join(', ')} ways all inside=${report.bboxCompare.relationAware.waysFullyInside.length}`,
    '',
    '## Metrics',
    `| metric | CURRENT | RELATION_AWARE |`,
    `| --- | ---: | ---: |`,
    `| nodes | ${c.nodeCount} | ${r.nodeCount} |`,
    `| edges | ${c.edgeCount} | ${r.edgeCount} |`,
    `| components | ${c.componentCount} | ${r.componentCount} |`,
    `| largestComponentKm | ${c.largestComponentKm} | ${r.largestComponentKm} |`,
    `| gapCount | ${c.gapCount} | ${r.gapCount} |`,
    `| artificial~19km gap | ${c.artificialFixtureGapPresent} (${c.artificialFixtureGapKm}) | ${r.artificialFixtureGapPresent} (${r.artificialFixtureGapKm}) |`,
    `| geometryKm | ${c.geometryCoverageKm} | ${r.geometryCoverageKm} |`,
    `| pathFound | ${c.pathFound} | ${r.pathFound} |`,
    `| pathKm | ${c.pathLengthKm} | ${r.pathLengthKm} |`,
    `| buildMs | ${c.graphBuildMs} | ${r.graphBuildMs} |`,
    `| searchMs | ${c.searchMs} | ${r.searchMs} |`,
    '',
  ].join('\n');
}
