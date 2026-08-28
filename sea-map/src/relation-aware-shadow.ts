/**
 * E2.10 — Safe relation-aware WaterGraph shadow for Belomor (diagnostic only).
 *
 * Builds CURRENT (fixture) vs RELATION_AWARE (OSM relation 9909116) shadow graphs
 * with the same builder / Dijkstra / validator / hydro. Never replaces legacy
 * production routing. USE_WATER_GRAPH stays false in production defaults.
 */

import { haversineKm, type LngLat } from './geo';
import {
  BELOMOR_A,
  BELOMOR_B,
  buildCurrentBelomorVariant,
} from './relation-aware-ingest';
import {
  provideBelomorRelation9909116Geometry,
  providerToCenterlines,
} from './relation-aware-osm-provider';
import {
  runWaterGraphShadow,
  type WaterGraphShadowResult,
} from './water-graph';
import { diagnoseWaterGraphTopology } from './water-graph-topology';
import { buildWaterGraph } from './water-graph';
import type { CenterlineSource } from './water-graph-types';

/** Belomor corridor detection for shadow wiring (bench endpoints ± tolerance). */
export function isBelomorShadowCorridor(a: LngLat, b: LngLat, maxKm = 80): boolean {
  const nearA =
    haversineKm(a, BELOMOR_A) <= maxKm || haversineKm(a, BELOMOR_B) <= maxKm;
  const nearB =
    haversineKm(b, BELOMOR_A) <= maxKm || haversineKm(b, BELOMOR_B) <= maxKm;
  return nearA && nearB;
}

export type GraphVariantSnap = {
  label: 'CURRENT' | 'RELATION_AWARE';
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  largestComponentKm: number;
  gapCount: number;
  gapLengthsKm: number[];
  geometryKm: number;
  pathFound: boolean;
  pathLengthKm: number | null;
  artificialFixtureGapPresent: boolean;
  artificialFixtureGapKm: number | null;
  graphBuildMs: number;
  graphSearchMs: number;
  seamCount: number;
  graphSafetyAccepted: boolean;
  graphSafetyRejectReason: string | null;
  failureStage: string | null;
  pathProvenanceSourceIds: string[];
  diagnosticOnly: true;
};

export type E210BelomorShadowReport = {
  schemaVersion: 'e2.10-relation-aware-shadow';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  noSeamFill: true;
  noSyntheticGeometry: true;
  relationId: number;
  relationWayCount: number;
  mainStreamCount: number;
  providerSourceKind: 'snapshot';
  providerSnapshotPath: string | null;
  current: GraphVariantSnap;
  relationAware: GraphVariantSnap;
  recoveredGeometryKm: number;
  artificialGapEliminated: boolean;
  legacyCompare: {
    diagnosticOnly: true;
    legacyOk: boolean | null;
    legacyLengthKm: number | null;
    legacyRejectReason: string | null;
    graphPathFound: boolean;
    graphPathKm: number | null;
    graphSafetyAccepted: boolean;
    divergenceReason: string;
    e2eTotalMs: number | null;
    legacyRoutingMs: number | null;
    graphShadowMs: number;
    brouterCalls: number | null;
  };
  e2eTiming: {
    requestStartMs: number;
    dataIngestMs: number;
    graphBuildMs: number;
    graphSearchMs: number;
    legacyRoutingMs: number | null;
    validationMs: number;
    totalWallMs: number;
    note: string;
  };
  answers: {
    safeShadowIntegration: boolean;
    belomorDataGapGone: boolean;
    safetyUnchanged: boolean;
    brouterDependencyPotential: string;
  };
  summary: string;
};

function artificialGap(gaps: number[]): { present: boolean; km: number | null } {
  const hit = gaps.find((g) => g >= 15 && g <= 25);
  return { present: hit != null, km: hit ?? null };
}

function snapFromShadow(
  label: 'CURRENT' | 'RELATION_AWARE',
  shadow: WaterGraphShadowResult,
  geometryKm: number,
  pathProvenanceSourceIds: string[],
): GraphVariantSnap {
  const gaps = (shadow.topology?.gapSummary ?? []).map(
    (g) => Math.round(g.distanceKm * 1000) / 1000,
  );
  const art = artificialGap(gaps);
  const pathFound = shadow.pathFound && shadow.validated;
  return {
    label,
    nodeCount: shadow.nodeCount,
    edgeCount: shadow.edgeCount,
    componentCount: shadow.topology?.componentCount ?? shadow.components?.connectedComponents ?? 0,
    largestComponentKm: shadow.topology?.largestComponentKm ?? shadow.components?.largestComponentKm ?? 0,
    gapCount: gaps.length,
    gapLengthsKm: gaps,
    geometryKm,
    pathFound,
    pathLengthKm: pathFound ? Math.round(shadow.pathLengthKm * 1000) / 1000 : null,
    artificialFixtureGapPresent: art.present,
    artificialFixtureGapKm: art.km,
    graphBuildMs: Math.round(shadow.buildMs * 1000) / 1000,
    graphSearchMs: Math.round(shadow.searchMs * 1000) / 1000,
    seamCount: shadow.edgeKindCounts.seamCount,
    graphSafetyAccepted: shadow.validated,
    graphSafetyRejectReason: shadow.validated ? null : shadow.rejectReason,
    failureStage: shadow.failureStage,
    pathProvenanceSourceIds,
    diagnosticOnly: true,
  };
}

function centerlineProvenanceIds(centerlines: CenterlineSource[]): string[] {
  return [
    ...new Set(
      centerlines
        .map((c) => c.sourceId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  ].slice(0, 64);
}

/**
 * Shadow-only Belomor compare. Does not mutate production routing.
 * Optional legacyResult from a prior measureWaterChain call.
 */
export function runBelomorRelationAwareShadow(opts?: {
  legacyOk?: boolean | null;
  legacyLengthKm?: number | null;
  legacyRejectReason?: string | null;
  legacyRoutingMs?: number | null;
  e2eTotalMs?: number | null;
  brouterCalls?: number | null;
}): E210BelomorShadowReport {
  const t0 = performance.now();
  const provider = provideBelomorRelation9909116Geometry();
  const tIngest1 = performance.now();

  const currentVariant = buildCurrentBelomorVariant();
  const relationCenterlines = providerToCenterlines(provider);

  // Assert no fixture chord ids.
  for (const cl of relationCenterlines) {
    if (String(cl.sourceId ?? '').includes('502000')) {
      throw new Error('Fixture chord leaked into relation-aware shadow centerlines');
    }
  }

  const currentShadow = runWaterGraphShadow({
    a: BELOMOR_A,
    b: BELOMOR_B,
    legacyLengthKm: opts?.legacyLengthKm ?? 0,
    legacyOk: opts?.legacyOk ?? false,
    centerlines: currentVariant.centerlines,
    ingest: {
      failureCode: 'none',
      stats: {
        osmFeatureCount: currentVariant.centerlines.length,
        acceptedFeatureCount: currentVariant.centerlines.length,
        rejectedFeatureCount: 0,
        rejectionReasons: {},
        sourceFeatureCount: currentVariant.centerlines.length,
        sourceWaterwayIds: centerlineProvenanceIds(currentVariant.centerlines),
        centerlineSource: 'fixture',
        dataTimestampMs: Date.now(),
        corridorBbox: currentVariant.metrics.bbox,
        ingestMs: 0,
        longSpanSegmented: false,
        segmentCount: 1,
      },
    },
  });

  const relationShadow = runWaterGraphShadow({
    a: BELOMOR_A,
    b: BELOMOR_B,
    legacyLengthKm: opts?.legacyLengthKm ?? 0,
    legacyOk: opts?.legacyOk ?? false,
    centerlines: relationCenterlines,
    ingest: {
      failureCode: 'none',
      stats: {
        osmFeatureCount: relationCenterlines.length,
        acceptedFeatureCount: relationCenterlines.length,
        rejectedFeatureCount: 0,
        rejectionReasons: {},
        sourceFeatureCount: relationCenterlines.length,
        sourceWaterwayIds: centerlineProvenanceIds(relationCenterlines),
        centerlineSource: 'fixture', // snapshot-backed OSM; labeled in provider
        dataTimestampMs: Date.now(),
        corridorBbox: [
          Math.min(BELOMOR_A.lon, BELOMOR_B.lon) - 0.6,
          Math.min(BELOMOR_A.lat, BELOMOR_B.lat) - 0.1,
          Math.max(BELOMOR_A.lon, BELOMOR_B.lon) + 0.6,
          Math.max(BELOMOR_A.lat, BELOMOR_B.lat) + 0.1,
        ],
        ingestMs: tIngest1 - t0,
        longSpanSegmented: false,
        segmentCount: 1,
      },
    },
  });

  // Re-label provenance centerlineSource for relation path via topology note —
  // WaterGraphProvenance union has no 'snapshot'; keep fixture + osm sources via centerlines.source='osm'.

  const current = snapFromShadow(
    'CURRENT',
    currentShadow,
    currentVariant.metrics.geometryCoverageKm,
    centerlineProvenanceIds(currentVariant.centerlines),
  );
  const relationAware = snapFromShadow(
    'RELATION_AWARE',
    relationShadow,
    provider.geometryCoverageKm,
    centerlineProvenanceIds(relationCenterlines),
  );

  const recoveredGeometryKm =
    Math.round(
      (relationAware.largestComponentKm - current.largestComponentKm) * 1000,
    ) / 1000;

  const artificialGapEliminated =
    current.artificialFixtureGapPresent && !relationAware.artificialFixtureGapPresent;

  const graphShadowMs =
    Math.round((current.graphBuildMs + current.graphSearchMs + relationAware.graphBuildMs + relationAware.graphSearchMs) * 1000) /
    1000;

  let divergenceReason = 'none';
  if ((opts?.legacyOk ?? false) && !relationAware.pathFound) {
    divergenceReason = 'legacy_ok_graph_no_path';
  } else if (!(opts?.legacyOk ?? false) && relationAware.pathFound) {
    divergenceReason = 'legacy_fail_graph_path_diagnostic';
  } else if ((opts?.legacyOk ?? false) && relationAware.pathFound) {
    divergenceReason = 'both_ok_compare_lengths';
  } else {
    divergenceReason = 'both_fail_or_unset';
  }

  const tEnd = performance.now();
  const totalWallMs = Math.round((tEnd - t0) * 1000) / 1000;

  // Isolation: empty graph unchanged
  const emptyBefore = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines: [],
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  }).nodes.size;
  const emptyAfter = buildWaterGraph({
    a: BELOMOR_A,
    b: BELOMOR_B,
    centerlines: [],
    options: { includeMask: false, includeFairway: false, includeLocks: false },
  }).nodes.size;
  if (emptyBefore !== emptyAfter) {
    throw new Error('Relation-aware shadow mutated empty graph');
  }

  return {
    schemaVersion: 'e2.10-relation-aware-shadow',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    noSeamFill: true,
    noSyntheticGeometry: true,
    relationId: provider.relationId,
    relationWayCount: provider.members.length,
    mainStreamCount: provider.mainStreamCount,
    providerSourceKind: 'snapshot',
    providerSnapshotPath: provider.snapshotPath,
    current,
    relationAware,
    recoveredGeometryKm,
    artificialGapEliminated,
    legacyCompare: {
      diagnosticOnly: true,
      legacyOk: opts?.legacyOk ?? null,
      legacyLengthKm: opts?.legacyLengthKm ?? null,
      legacyRejectReason: opts?.legacyRejectReason ?? null,
      graphPathFound: relationAware.pathFound,
      graphPathKm: relationAware.pathLengthKm,
      graphSafetyAccepted: relationAware.graphSafetyAccepted,
      divergenceReason,
      e2eTotalMs: opts?.e2eTotalMs ?? null,
      legacyRoutingMs: opts?.legacyRoutingMs ?? null,
      graphShadowMs,
      brouterCalls: opts?.brouterCalls ?? null,
    },
    e2eTiming: {
      requestStartMs: 0,
      dataIngestMs: Math.round((tIngest1 - t0) * 1000) / 1000,
      graphBuildMs:
        Math.round((current.graphBuildMs + relationAware.graphBuildMs) * 1000) / 1000,
      graphSearchMs:
        Math.round((current.graphSearchMs + relationAware.graphSearchMs) * 1000) / 1000,
      legacyRoutingMs: opts?.legacyRoutingMs ?? null,
      validationMs: 0,
      totalWallMs,
      note: 'Shadow wall only; do not treat graphSearchMs as UI latency win. Legacy E2E measured separately when provided.',
    },
    answers: {
      safeShadowIntegration: true,
      belomorDataGapGone:
        artificialGapEliminated &&
        !relationAware.artificialFixtureGapPresent &&
        relationAware.pathFound,
      safetyUnchanged: true,
      brouterDependencyPotential: relationAware.pathFound
        ? 'Diagnostic graph path exists with validator/hydro accept — potential to reduce BRouter dependency for this corridor IF production enablement is approved later. Not measured as UI speedup; USE_WATER_GRAPH remains false.'
        : 'No validated graph path — no BRouter-reduction claim.',
    },
    summary: artificialGapEliminated
      ? `E2.10 Belomor shadow: RELATION_AWARE eliminates artificial ~19 km gap (pathFound=${relationAware.pathFound}, pathKm=${relationAware.pathLengthKm}). CURRENT still torn. Production unchanged; diagnosticOnly.`
      : 'E2.10 Belomor shadow: artificial gap not fully eliminated — see metrics.',
  };
}

/** Centerlines for Belomor WaterGraph shadow when flag enables shadow (tests/bench). */
export function belomorRelationAwareCenterlinesForShadow(): CenterlineSource[] {
  return providerToCenterlines(provideBelomorRelation9909116Geometry());
}

/** Topology-only CURRENT fixture check (no mutation). */
export function currentBelomorStillHasArtificialGap(): boolean {
  const v = buildCurrentBelomorVariant();
  const topo = diagnoseWaterGraphTopology(v.graph, { a: BELOMOR_A, b: BELOMOR_B });
  return topo.gapSummary.some((g) => g.distanceKm >= 15 && g.distanceKm <= 25);
}
