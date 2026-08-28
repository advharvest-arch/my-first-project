/**
 * E2.11 — Shadow WaterGraph vs legacy real-corridor benchmark (diagnostic only).
 *
 * USE_WATER_GRAPH stays false. Production routing unchanged.
 * No seams, no synthetic geometry, no Volga↔Akhtuba sewing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { haversineKm, pathLengthKm, type LngLat } from './geo';
import {
  clearRouteTraces,
  getLastRouteTrace,
  replaceLastRouteTrace,
  type RouteTrace,
  type RouteTraceWaterGraphBenchmark,
} from './route-trace';
import { clearProviderCaches } from './provider-cache';
import {
  measureWaterChain,
  clearWaterwayCellCacheForTests,
} from './waterways';
import { getRouteFeatureFlags } from './route-feature-flags';
import { USER_TEST_PRESETS } from './user-test-presets';
import { BELOMOR_A, BELOMOR_B } from './relation-aware-ingest';
import { belomorRelationAwareCenterlinesForShadow } from './relation-aware-shadow';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
  ingestCorridorCenterlines,
} from './water-graph-ingest';
import { runWaterGraphShadow } from './water-graph';
import {
  findSharedOpenLake,
  cachedLakeMaskAlongPath,
  isLakeMaskComplete,
} from './open-lake';
import type { CenterlineSource } from './water-graph-types';
import { hasIllegalBarrierCrossing } from './routing-rules';

const HERE = dirname(fileURLToPath(import.meta.url));

export type E211CorridorId =
  | 'BELOMOR'
  | 'N06'
  | 'N08'
  | 'L2'
  | 'VG-D'
  | 'VG-mid';

export type E211Role = 'positive' | 'negative_control';

export type E211Verdict =
  | 'GRAPH_PROMISING'
  | 'GRAPH_NEEDS_DATA'
  | 'GRAPH_TOPOLOGY_RISK'
  | 'GRAPH_REJECTS_SAFE_ROUTE'
  | 'CONTROL_CORRECTLY_REJECTED';

export type E211CacheMode = 'cold' | 'warm' | 'cold_cleared';

export type E211CorridorCase = {
  id: E211CorridorId;
  role: E211Role;
  a: LngLat;
  b: LngLat;
  note: string;
  centerlineStrategy:
    | 'relation_aware_belomor_snapshot'
    | 'fixture_lower_volga'
    | 'fixture_lower_volga_mid'
    | 'overpass_corridor';
};

export type E211LegacySnap = {
  found: boolean;
  accepted: boolean;
  rejectReason: string | null;
  routeKm: number;
  method: string;
  brouterCalls: number;
  brouterCacheHits: number;
  brouterCacheMisses: number;
  e2eMs: number;
  phaseAMs: number;
  phaseBMs: number;
  phaseCMs: number;
  overpassMs: number;
  validationMs: number;
  hydroMs: number;
  geometry: LngLat[];
};

export type E211GraphSnap = {
  graphBuilt: boolean;
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  largestComponentKm: number;
  pathFound: boolean;
  pathKm: number | null;
  graphBuildMs: number;
  graphSearchMs: number;
  graphIngestMs: number;
  graphShadowWallMs: number;
  safetyAccepted: boolean;
  rejectReason: string | null;
  failureStage: string | null;
  layers: {
    centerline: boolean;
    mask: boolean;
    fairway: boolean;
    lock: boolean;
  };
  edgeKinds: {
    centerlineEdges: number;
    maskEdges: number;
    fairwayEdges: number;
    seamEdges: number;
    lockEdges: number;
  };
  centerlineCount: number;
  centerlineStrategy: string;
  dataGap: boolean;
  dataGapNote: string | null;
  geometry: LngLat[] | null;
};

export type E211GeometryDiag = {
  startEndDistKm: number;
  legacyKm: number | null;
  graphKm: number | null;
  ratioGraphOverLegacy: number | null;
  sampledMeanAbsKm: number | null;
  sampledMaxAbsKm: number | null;
  chordOrShoreSuspect: boolean;
  knownBarrierHit: boolean;
  note: string;
};

export type E211Comparison = {
  both_ok: boolean;
  both_reject: boolean;
  legacy_only: boolean;
  graph_only: boolean;
  both_ok_length_delta_km: number | null;
  both_ok_length_delta_percent: number | null;
  graph_vs_legacy_method: string;
  topology_divergence_reason: string;
};

export type E211RunRow = {
  corridor: E211CorridorId;
  role: E211Role;
  cacheMode: E211CacheMode;
  legacy: E211LegacySnap;
  graph: E211GraphSnap;
  comparison: E211Comparison;
  geometry: E211GeometryDiag;
  verdict: E211Verdict;
  useWaterGraphFlag: boolean;
  diagnosticOnly: true;
};

export type E211SuiteReport = {
  schemaVersion: 'e2.11-watergraph-vs-legacy-benchmark';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  noSeamFill: true;
  noSyntheticGeometry: true;
  noVolgaAkhtubaSew: true;
  generatedAt: string;
  corridors: E211CorridorCase[];
  runs: E211RunRow[];
  summaryTable: Array<{
    route: E211CorridorId;
    legacy: string;
    graph: string;
    both_ok: boolean;
    graphKm: number | null;
    legacyKm: number | null;
    deltaPct: number | null;
    graphSafety: string;
    components: number;
    graphBuildMs: number;
    graphSearchMs: number;
    verdict: E211Verdict;
  }>;
  divergenceCases: string[];
  safetyFailures: string[];
  dataGaps: string[];
  latencyNotes: string[];
  answers: {
    promisingCorridors: E211CorridorId[];
    needsData: E211CorridorId[];
    topologyRisks: E211CorridorId[];
    rejectsSafe: E211CorridorId[];
    controlsOk: E211CorridorId[];
    potentialLatencyGainNote: string;
  };
};

function preset(id: string): { a: LngLat; b: LngLat } {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { a: p.a, b: p.b };
}

export function getE211Corridors(): E211CorridorCase[] {
  const n06 = preset('N06');
  const n08 = preset('N08');
  const l2 = preset('L2');
  return [
    {
      id: 'BELOMOR',
      role: 'positive',
      a: BELOMOR_A,
      b: BELOMOR_B,
      note: 'Relation-aware OSM snapshot (E2.10)',
      centerlineStrategy: 'relation_aware_belomor_snapshot',
    },
    {
      id: 'N06',
      role: 'positive',
      a: n06.a,
      b: n06.b,
      note: 'Kuibyshev S mid — Overpass centerlines + lake/fairway layers',
      centerlineStrategy: 'overpass_corridor',
    },
    {
      id: 'N08',
      role: 'positive',
      a: n08.a,
      b: n08.b,
      note: 'Kuibyshev north — Overpass centerlines + lake/fairway layers',
      centerlineStrategy: 'overpass_corridor',
    },
    {
      id: 'L2',
      role: 'positive',
      a: l2.a,
      b: l2.b,
      note: 'Kuibyshev mid-pool — Overpass centerlines + lake/fairway layers',
      centerlineStrategy: 'overpass_corridor',
    },
    {
      id: 'VG-D',
      role: 'positive',
      a: { lon: 44.52, lat: 48.7 },
      b: { lon: 48.02, lat: 46.36 },
      note: 'Lower Volga fixture (Volga+Akhtuba features kept separate)',
      centerlineStrategy: 'fixture_lower_volga',
    },
    {
      id: 'VG-mid',
      role: 'negative_control',
      a: { lon: 45.9, lat: 47.75 },
      b: { lon: 46.95, lat: 47.0 },
      note: 'Volga↔Akhtuba negative control — must NOT sew',
      centerlineStrategy: 'fixture_lower_volga_mid',
    },
  ];
}

function loadFixtureCenterlines(
  fixtureName: string,
  a: LngLat,
  b: LngLat,
): CenterlineSource[] {
  const path = join(HERE, '__fixtures__/centerlines', fixtureName);
  const fc = JSON.parse(readFileSync(path, 'utf8')) as never;
  return ingestCenterlineFeaturesSync(a, b, geojsonToCenterlineFeatures(fc))
    .centerlines;
}

async function loadCenterlinesForCorridor(c: E211CorridorCase): Promise<{
  centerlines: CenterlineSource[];
  ingestMs: number;
  dataGap: boolean;
  dataGapNote: string | null;
  strategy: string;
}> {
  const t0 = performance.now();
  if (c.centerlineStrategy === 'relation_aware_belomor_snapshot') {
    const centerlines = belomorRelationAwareCenterlinesForShadow();
    return {
      centerlines,
      ingestMs: performance.now() - t0,
      dataGap: centerlines.length === 0,
      dataGapNote: centerlines.length === 0 ? 'relation snapshot empty' : null,
      strategy: c.centerlineStrategy,
    };
  }
  if (c.centerlineStrategy === 'fixture_lower_volga') {
    const centerlines = loadFixtureCenterlines('lower-volga.geojson', c.a, c.b);
    return {
      centerlines,
      ingestMs: performance.now() - t0,
      dataGap: centerlines.length === 0,
      dataGapNote:
        centerlines.length === 0 ? 'lower-volga fixture empty after crop' : null,
      strategy: c.centerlineStrategy,
    };
  }
  if (c.centerlineStrategy === 'fixture_lower_volga_mid') {
    const centerlines = loadFixtureCenterlines(
      'lower-volga-mid.geojson',
      c.a,
      c.b,
    );
    return {
      centerlines,
      ingestMs: performance.now() - t0,
      dataGap: false,
      dataGapNote: null,
      strategy: c.centerlineStrategy,
    };
  }
  const ingest = await ingestCorridorCenterlines(c.a, c.b, {});
  const dataGap =
    ingest.failureCode !== 'none' || ingest.centerlines.length === 0;
  return {
    centerlines: ingest.centerlines,
    ingestMs: ingest.stats.ingestMs,
    dataGap,
    dataGapNote: dataGap
      ? `overpass ingest failureCode=${ingest.failureCode} features=${ingest.centerlines.length}`
      : null,
    strategy: `${c.centerlineStrategy}:${ingest.stats.centerlineSource}`,
  };
}

function sampleAlong(path: LngLat[], n = 24): LngLat[] {
  if (path.length < 2) return path.slice();
  const total = pathLengthKm(path);
  if (total <= 0) return [path[0]!, path[path.length - 1]!];
  const out: LngLat[] = [];
  for (let i = 0; i < n; i++) {
    const target = (total * i) / (n - 1);
    let acc = 0;
    for (let j = 1; j < path.length; j++) {
      const seg = haversineKm(path[j - 1]!, path[j]!);
      if (acc + seg >= target || j === path.length - 1) {
        const t = seg > 0 ? Math.min(1, (target - acc) / seg) : 0;
        const a = path[j - 1]!;
        const b = path[j]!;
        out.push({
          lon: a.lon + (b.lon - a.lon) * t,
          lat: a.lat + (b.lat - a.lat) * t,
        });
        break;
      }
      acc += seg;
    }
  }
  return out;
}

function minDistToPath(p: LngLat, path: LngLat[]): number {
  let best = Infinity;
  for (const q of path) {
    best = Math.min(best, haversineKm(p, q));
  }
  return best;
}

function geometryDiag(
  a: LngLat,
  b: LngLat,
  legacyGeom: LngLat[],
  graphGeom: LngLat[] | null,
  legacyKm: number | null,
  graphKm: number | null,
  graphReject: string | null,
): E211GeometryDiag {
  const startEndDistKm = Math.round(haversineKm(a, b) * 1000) / 1000;
  let ratio: number | null = null;
  if (legacyKm != null && legacyKm > 0.1 && graphKm != null) {
    ratio = Math.round((graphKm / legacyKm) * 1000) / 1000;
  }
  let sampledMean: number | null = null;
  let sampledMax: number | null = null;
  if (legacyGeom.length >= 2 && graphGeom && graphGeom.length >= 2) {
    const lg = sampleAlong(legacyGeom, 20);
    const gg = sampleAlong(graphGeom, 20);
    const dists = lg.map((p) => minDistToPath(p, gg));
    const dists2 = gg.map((p) => minDistToPath(p, lg));
    const all = [...dists, ...dists2];
    sampledMean =
      Math.round((all.reduce((s, x) => s + x, 0) / all.length) * 1000) / 1000;
    sampledMax = Math.round(Math.max(...all) * 1000) / 1000;
  }
  const chordOrShoreSuspect =
    Boolean(graphReject?.includes('near_geodesic_chord')) ||
    Boolean(graphReject?.includes('river_chord')) ||
    Boolean(graphReject?.includes('endpoints_far')) ||
    (ratio != null && (ratio < 0.7 || ratio > 1.4));
  let knownBarrierHit = false;
  if (graphGeom && graphGeom.length >= 2) {
    knownBarrierHit = hasIllegalBarrierCrossing(graphGeom);
  }
  return {
    startEndDistKm,
    legacyKm,
    graphKm,
    ratioGraphOverLegacy: ratio,
    sampledMeanAbsKm: sampledMean,
    sampledMaxAbsKm: sampledMax,
    chordOrShoreSuspect,
    knownBarrierHit,
    note:
      graphGeom && legacyGeom.length >= 2
        ? 'Sampled bidirectional nearest-point distances (diagnostic, not full Hausdorff).'
        : 'Geometry compare limited — missing path geometry on one side.',
  };
}

function classifyComparison(
  legacyOk: boolean,
  graphOk: boolean,
  legacyKm: number,
  graphKm: number | null,
  legacyMethod: string,
  graphReject: string | null,
  componentCount: number,
): E211Comparison {
  const both_ok = legacyOk && graphOk;
  const both_reject = !legacyOk && !graphOk;
  const legacy_only = legacyOk && !graphOk;
  const graph_only = !legacyOk && graphOk;
  let deltaKm: number | null = null;
  let deltaPct: number | null = null;
  if (both_ok && graphKm != null) {
    deltaKm = Math.round((graphKm - legacyKm) * 1000) / 1000;
    deltaPct =
      legacyKm > 0.1
        ? Math.round(((graphKm - legacyKm) / legacyKm) * 10000) / 100
        : null;
  }
  let topology = 'none';
  if (both_ok) topology = 'both_ok';
  else if (legacy_only && graphReject === 'graph_disconnected')
    topology = 'graph_disconnected_vs_legacy_ok';
  else if (legacy_only && graphReject?.includes('chord'))
    topology = 'graph_chord_reject_vs_legacy_ok';
  else if (
    legacy_only &&
    (graphReject === 'centerline_missing' || componentCount === 0)
  )
    topology = 'graph_data_gap_vs_legacy_ok';
  else if (legacy_only) topology = `legacy_only:${graphReject ?? 'unknown'}`;
  else if (graph_only) topology = 'graph_only_diagnostic';
  else if (both_reject) topology = `both_reject:${graphReject ?? 'unknown'}`;

  return {
    both_ok,
    both_reject,
    legacy_only,
    graph_only,
    both_ok_length_delta_km: deltaKm,
    both_ok_length_delta_percent: deltaPct,
    graph_vs_legacy_method: `legacy=${legacyMethod}; graph=${graphOk ? 'watergraph_validated' : graphReject ?? 'no_path'}`,
    topology_divergence_reason: topology,
  };
}

function assignVerdict(
  c: E211CorridorCase,
  legacyOk: boolean,
  graphOk: boolean,
  graph: E211GraphSnap,
  geometry: E211GeometryDiag,
  comparison: E211Comparison,
): E211Verdict {
  if (c.role === 'negative_control') {
    if (graphOk) return 'GRAPH_TOPOLOGY_RISK';
    return 'CONTROL_CORRECTLY_REJECTED';
  }

  if (graphOk && geometry.knownBarrierHit) return 'GRAPH_TOPOLOGY_RISK';
  if (
    graphOk &&
    geometry.chordOrShoreSuspect &&
    (geometry.sampledMaxAbsKm ?? 0) > 15
  ) {
    return 'GRAPH_TOPOLOGY_RISK';
  }

  if (comparison.both_ok) {
    const pct = Math.abs(comparison.both_ok_length_delta_percent ?? 0);
    if (pct > 35 || (geometry.sampledMaxAbsKm ?? 0) > 25) {
      return 'GRAPH_TOPOLOGY_RISK';
    }
    return 'GRAPH_PROMISING';
  }

  if (legacyOk && !graphOk) {
    if (
      graph.dataGap ||
      graph.rejectReason === 'centerline_missing' ||
      graph.rejectReason === 'centerline_empty_after_filter' ||
      (graph.rejectReason === 'graph_disconnected' && graph.componentCount > 5)
    ) {
      return 'GRAPH_NEEDS_DATA';
    }
    return 'GRAPH_REJECTS_SAFE_ROUTE';
  }

  if (!legacyOk && graphOk) return 'GRAPH_PROMISING';
  if (graph.dataGap) return 'GRAPH_NEEDS_DATA';
  return 'GRAPH_REJECTS_SAFE_ROUTE';
}

function clearCachesForCold(): void {
  clearProviderCaches();
  clearWaterwayCellCacheForTests();
  clearRouteTraces();
}

async function runLegacy(a: LngLat, b: LngLat): Promise<E211LegacySnap> {
  const t0 = performance.now();
  const path = await measureWaterChain([a, b]);
  const e2eMs = performance.now() - t0;
  const tr = getLastRouteTrace();
  const geom =
    path.routingGeometry && path.routingGeometry.length >= 2
      ? path.routingGeometry
      : path.points;
  const found = path.method !== 'route_not_found' && path.points.length >= 2;
  return {
    found,
    accepted: found,
    rejectReason: tr?.final.rejectReason ?? null,
    routeKm: found ? Math.round(path.lengthKm * 1000) / 1000 : 0,
    method: path.method,
    brouterCalls: tr?.performance?.brouterCalls ?? 0,
    brouterCacheHits: tr?.performance?.brouterCacheHits ?? 0,
    brouterCacheMisses: tr?.performance?.brouterCacheMisses ?? 0,
    e2eMs: Math.round(e2eMs * 1000) / 1000,
    phaseAMs: Math.round((tr?.timing?.phaseAMs ?? 0) * 1000) / 1000,
    phaseBMs: Math.round((tr?.timing?.phaseBMs ?? 0) * 1000) / 1000,
    phaseCMs: Math.round((tr?.timing?.phaseCMs ?? 0) * 1000) / 1000,
    overpassMs: Math.round((tr?.timing?.overpassMs ?? 0) * 1000) / 1000,
    validationMs: Math.round((tr?.timing?.validationMs ?? 0) * 1000) / 1000,
    hydroMs: Math.round((tr?.timing?.hydroMs ?? 0) * 1000) / 1000,
    geometry: geom.slice(),
  };
}

async function runGraphShadow(
  c: E211CorridorCase,
  legacy: E211LegacySnap,
): Promise<E211GraphSnap> {
  const loaded = await loadCenterlinesForCorridor(c);
  const shared = findSharedOpenLake([c.a, c.b]);
  const lake = shared ? cachedLakeMaskAlongPath([c.a, c.b]) : null;
  const t0 = performance.now();
  const shadow = runWaterGraphShadow({
    a: c.a,
    b: c.b,
    legacyLengthKm: legacy.routeKm,
    legacyOk: legacy.accepted,
    centerlines: loaded.centerlines,
    lake,
    lakeComplete: lake ? isLakeMaskComplete(lake) : false,
    ingest: {
      failureCode: loaded.dataGap ? 'centerline_missing' : 'none',
      stats: {
        centerlineSource:
          c.centerlineStrategy === 'overpass_corridor' ? 'overpass' : 'fixture',
        sourceFeatureCount: loaded.centerlines.length,
        sourceWaterwayIds: loaded.centerlines
          .map((x) => x.sourceId)
          .filter((x): x is string => !!x)
          .slice(0, 64),
        osmFeatureCount: loaded.centerlines.length,
        acceptedFeatureCount: loaded.centerlines.length,
        rejectedFeatureCount: 0,
        rejectionReasons: {},
        dataTimestampMs: Date.now(),
        corridorBbox: [
          Math.min(c.a.lon, c.b.lon) - 0.5,
          Math.min(c.a.lat, c.b.lat) - 0.5,
          Math.max(c.a.lon, c.b.lon) + 0.5,
          Math.max(c.a.lat, c.b.lat) + 0.5,
        ],
        ingestMs: loaded.ingestMs,
      },
    },
  });
  const wall = performance.now() - t0;
  const ek = shadow.edgeKindCounts;
  return {
    graphBuilt: shadow.built,
    nodeCount: shadow.nodeCount,
    edgeCount: shadow.edgeCount,
    componentCount:
      shadow.topology?.componentCount ??
      shadow.components?.connectedComponents ??
      0,
    largestComponentKm:
      Math.round(
        (shadow.topology?.largestComponentKm ??
          shadow.components?.largestComponentKm ??
          0) * 1000,
      ) / 1000,
    pathFound: shadow.pathFound,
    pathKm: shadow.pathFound
      ? Math.round(shadow.pathLengthKm * 1000) / 1000
      : null,
    graphBuildMs: Math.round(shadow.buildMs * 1000) / 1000,
    graphSearchMs: Math.round(shadow.searchMs * 1000) / 1000,
    graphIngestMs: Math.round(loaded.ingestMs * 1000) / 1000,
    graphShadowWallMs: Math.round(wall * 1000) / 1000,
    safetyAccepted: shadow.validated,
    rejectReason: shadow.rejectReason,
    failureStage: shadow.failureStage,
    layers: { ...shadow.layers },
    edgeKinds: {
      centerlineEdges: ek.waterwayEdgeCount + ek.canalEdgeCount,
      maskEdges: ek.maskEdgeCount,
      fairwayEdges: ek.fairwayEdgeCount,
      seamEdges: ek.seamCount,
      lockEdges: ek.lockEdgeCount,
    },
    centerlineCount: loaded.centerlines.length,
    centerlineStrategy: loaded.strategy,
    dataGap: loaded.dataGap,
    dataGapNote: loaded.dataGapNote,
    geometry: shadow.pathGeometry?.slice() ?? null,
  };
}

export function toRouteTraceBenchmark(
  row: E211RunRow,
): RouteTraceWaterGraphBenchmark {
  return {
    corridor: row.corridor,
    role: row.role,
    cacheMode: row.cacheMode,
    verdict: row.verdict,
    diagnosticOnly: true,
    legacy: {
      found: row.legacy.found,
      accepted: row.legacy.accepted,
      rejectReason: row.legacy.rejectReason,
      routeKm: row.legacy.routeKm,
      method: row.legacy.method,
      brouterCalls: row.legacy.brouterCalls,
      e2eMs: row.legacy.e2eMs,
      phaseAMs: row.legacy.phaseAMs,
      phaseBMs: row.legacy.phaseBMs,
      phaseCMs: row.legacy.phaseCMs,
    },
    graph: {
      graphBuilt: row.graph.graphBuilt,
      nodeCount: row.graph.nodeCount,
      edgeCount: row.graph.edgeCount,
      componentCount: row.graph.componentCount,
      largestComponentKm: row.graph.largestComponentKm,
      pathFound: row.graph.pathFound,
      pathKm: row.graph.pathKm,
      graphBuildMs: row.graph.graphBuildMs,
      graphSearchMs: row.graph.graphSearchMs,
      safetyAccepted: row.graph.safetyAccepted,
      rejectReason: row.graph.rejectReason,
      layers: row.graph.layers,
      edgeKinds: row.graph.edgeKinds,
      dataGap: row.graph.dataGap,
    },
    comparison: row.comparison,
    topology: {
      componentCount: row.graph.componentCount,
      divergenceReason: row.comparison.topology_divergence_reason,
      seamEdges: row.graph.edgeKinds.seamEdges,
    },
    safety: {
      graphSafetyAccepted: row.graph.safetyAccepted,
      graphRejectReason: row.graph.rejectReason,
      chordOrShoreSuspect: row.geometry.chordOrShoreSuspect,
      knownBarrierHit: row.geometry.knownBarrierHit,
    },
    timing: {
      legacyE2eMs: row.legacy.e2eMs,
      graphBuildMs: row.graph.graphBuildMs,
      graphSearchMs: row.graph.graphSearchMs,
      graphIngestMs: row.graph.graphIngestMs,
      graphShadowWallMs: row.graph.graphShadowWallMs,
      note: 'graph* timings are shadow-only; not application speedup while USE_WATER_GRAPH=false',
    },
  };
}

export function attachBenchmarkToLastTrace(row: E211RunRow): RouteTrace | null {
  const tr = getLastRouteTrace();
  if (!tr) return null;
  const next: RouteTrace = {
    ...tr,
    waterGraphBenchmark: toRouteTraceBenchmark(row),
  };
  replaceLastRouteTrace(next);
  return next;
}

export async function runE211CorridorOnce(
  c: E211CorridorCase,
  cacheMode: E211CacheMode,
): Promise<E211RunRow> {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error(
      'E2.11 requires USE_WATER_GRAPH=false (production unchanged)',
    );
  }
  if (cacheMode === 'cold' || cacheMode === 'cold_cleared') {
    clearCachesForCold();
  }

  const legacy = await runLegacy(c.a, c.b);
  const graph = await runGraphShadow(c, legacy);
  const geometry = geometryDiag(
    c.a,
    c.b,
    legacy.geometry,
    graph.geometry,
    legacy.accepted ? legacy.routeKm : null,
    graph.pathKm,
    graph.rejectReason,
  );
  const comparison = classifyComparison(
    legacy.accepted,
    graph.pathFound && graph.safetyAccepted,
    legacy.routeKm,
    graph.pathKm,
    legacy.method,
    graph.rejectReason,
    graph.componentCount,
  );
  const verdict = assignVerdict(
    c,
    legacy.accepted,
    graph.pathFound && graph.safetyAccepted,
    graph,
    geometry,
    comparison,
  );

  const row: E211RunRow = {
    corridor: c.id,
    role: c.role,
    cacheMode,
    legacy: { ...legacy, geometry: [] },
    graph: { ...graph, geometry: null },
    comparison,
    geometry,
    verdict,
    useWaterGraphFlag: getRouteFeatureFlags().USE_WATER_GRAPH,
    diagnosticOnly: true,
  };

  attachBenchmarkToLastTrace(row);
  return row;
}

export async function runE211BenchmarkSuite(opts?: {
  corridors?: E211CorridorId[];
  modes?: E211CacheMode[];
}): Promise<E211SuiteReport> {
  const all = getE211Corridors();
  const selected = opts?.corridors
    ? all.filter((c) => opts.corridors!.includes(c.id))
    : all;
  const modes: E211CacheMode[] = opts?.modes ?? [
    'cold',
    'warm',
    'cold_cleared',
  ];
  const runs: E211RunRow[] = [];

  for (const c of selected) {
    for (const mode of modes) {
      runs.push(await runE211CorridorOnce(c, mode));
    }
  }

  const pickSummary = (id: E211CorridorId): E211RunRow => {
    const rows = runs.filter((r) => r.corridor === id);
    return (
      rows.find((r) => r.cacheMode === 'cold_cleared') ??
      rows.find((r) => r.cacheMode === 'cold') ??
      rows[0]!
    );
  };

  const summaryTable = selected.map((c) => {
    const r = pickSummary(c.id);
    return {
      route: c.id,
      legacy: r.legacy.accepted
        ? `OK ${r.legacy.routeKm}`
        : `FAIL ${r.legacy.rejectReason ?? ''}`,
      graph: r.graph.pathFound
        ? `OK ${r.graph.pathKm}`
        : `FAIL ${r.graph.rejectReason ?? ''}`,
      both_ok: r.comparison.both_ok,
      graphKm: r.graph.pathKm,
      legacyKm: r.legacy.accepted ? r.legacy.routeKm : null,
      deltaPct: r.comparison.both_ok_length_delta_percent,
      graphSafety: r.graph.safetyAccepted
        ? 'accepted'
        : (r.graph.rejectReason ?? 'rejected'),
      components: r.graph.componentCount,
      graphBuildMs: r.graph.graphBuildMs,
      graphSearchMs: r.graph.graphSearchMs,
      verdict: r.verdict,
    };
  });

  const byId = (id: E211CorridorId) => pickSummary(id);
  const divergenceCases = selected
    .map((c) => byId(c.id))
    .filter((r) => !r.comparison.both_ok)
    .map(
      (r) =>
        `${r.corridor}: ${r.comparison.topology_divergence_reason} → ${r.verdict}`,
    );
  const safetyFailures = selected
    .map((c) => byId(c.id))
    .filter(
      (r) =>
        r.geometry.knownBarrierHit ||
        (r.role === 'negative_control' && r.graph.pathFound),
    )
    .map(
      (r) =>
        `${r.corridor}: barrier=${r.geometry.knownBarrierHit} pathFound=${r.graph.pathFound} verdict=${r.verdict}`,
    );
  const dataGaps = selected
    .map((c) => byId(c.id))
    .filter((r) => r.graph.dataGap || r.verdict === 'GRAPH_NEEDS_DATA')
    .map(
      (r) =>
        `${r.corridor}: ${r.graph.dataGapNote ?? r.graph.rejectReason ?? 'needs_data'}`,
    );

  return {
    schemaVersion: 'e2.11-watergraph-vs-legacy-benchmark',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    noSeamFill: true,
    noSyntheticGeometry: true,
    noVolgaAkhtubaSew: true,
    generatedAt: new Date().toISOString(),
    corridors: selected,
    runs,
    summaryTable,
    divergenceCases,
    safetyFailures,
    dataGaps,
    latencyNotes: selected.map((c) => {
      const r = byId(c.id);
      return `${c.id}: legacyE2e=${r.legacy.e2eMs}ms graphBuild=${r.graph.graphBuildMs}ms graphSearch=${r.graph.graphSearchMs}ms shadowWall=${r.graph.graphShadowWallMs}ms (not app speedup)`;
    }),
    answers: {
      promisingCorridors: summaryTable
        .filter((s) => s.verdict === 'GRAPH_PROMISING')
        .map((s) => s.route),
      needsData: summaryTable
        .filter((s) => s.verdict === 'GRAPH_NEEDS_DATA')
        .map((s) => s.route),
      topologyRisks: summaryTable
        .filter((s) => s.verdict === 'GRAPH_TOPOLOGY_RISK')
        .map((s) => s.route),
      rejectsSafe: summaryTable
        .filter((s) => s.verdict === 'GRAPH_REJECTS_SAFE_ROUTE')
        .map((s) => s.route),
      controlsOk: summaryTable
        .filter((s) => s.verdict === 'CONTROL_CORRECTLY_REJECTED')
        .map((s) => s.route),
      potentialLatencyGainNote:
        'Where GRAPH_PROMISING, graph build+search is often << legacy E2E — but this is only potential savings if a future graph-first path is enabled. USE_WATER_GRAPH remains false; do not claim UI speedup from these numbers alone.',
    },
  };
}

export function formatE211MarkdownTable(report: E211SuiteReport): string {
  const header =
    '| route | legacy | graph | both_ok | graphKm | legacyKm | delta% | graphSafety | components | graphBuildMs | graphSearchMs | verdict |';
  const sep =
    '| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |';
  const rows = report.summaryTable.map((r) => {
    return `| ${r.route} | ${r.legacy} | ${r.graph} | ${r.both_ok} | ${r.graphKm ?? '—'} | ${r.legacyKm ?? '—'} | ${r.deltaPct ?? '—'} | ${r.graphSafety} | ${r.components} | ${r.graphBuildMs} | ${r.graphSearchMs} | ${r.verdict} |`;
  });
  return [header, sep, ...rows].join('\n');
}
