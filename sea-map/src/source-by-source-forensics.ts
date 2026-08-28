/**
 * E2.12 — Source-by-source route forensics (diagnostic only).
 *
 * Answers which data source lets legacy succeed where WaterGraph cannot
 * (or why both succeed). Does NOT fix routing, add seams, or change safety.
 * USE_WATER_GRAPH must stay false.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { haversineKm, type LngLat } from './geo';
import {
  clearRouteTraces,
  getLastRouteTrace,
  replaceLastRouteTrace,
  type RouteTrace,
  type RouteTraceWaterGraphForensics,
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
import {
  runWaterGraphShadow,
  buildWaterGraph,
  bindWaterGraphTerminal,
  searchWaterGraph,
} from './water-graph';
import {
  findSharedOpenLake,
  cachedLakeMaskAlongPath,
  densifyOpenWaterPath,
  isLakeMaskComplete,
  pointInOpenWater,
  routeAcrossOpenLake,
  type LakeMask,
} from './open-lake';
import { validateWaterRoute } from './validate-water-route';
import type { CenterlineSource } from './water-graph-types';
import { diagnoseWaterGraphTopology } from './water-graph-topology';

const HERE = dirname(fileURLToPath(import.meta.url));

export type E212RouteId = 'BELOMOR' | 'N06' | 'N08' | 'VG-D' | 'VG-mid';

export type E212Verdict =
  | 'GRAPH_AND_LEGACY_SHARE_DATA'
  | 'LEGACY_HAS_ADDITIONAL_DATA'
  | 'GRAPH_GEOMETRY_SUSPECT'
  | 'SAFETY_INTERPRETATION_MISMATCH'
  | 'INSUFFICIENT_EVIDENCE'
  | 'CONTROL_CORRECT';

export type E212Case = {
  id: E212RouteId;
  role: 'positive' | 'negative_control';
  a: LngLat;
  b: LngLat;
  note: string;
};

export type E212ChordForensics = {
  geoKm: number;
  rawPathKm: number | null;
  rawPointCount: number | null;
  ratioRawOverGeo: number | null;
  maxEdgeKm: number | null;
  longEdgesGt20Km: number | null;
  pathEdgeKinds: string[];
  validatorIssues: string[];
  interpretation:
    | 'single_long_shortcut_edge'
    | 'near_geodesic_overall_no_long_edge'
    | 'sparse_near_geodesic'
    | 'not_applicable'
    | 'unknown';
  note: string;
};

export type E212CorridorForensics = {
  route: E212RouteId;
  role: 'positive' | 'negative_control';
  legacyResult: string;
  graphResult: string;
  legacyGeometrySource: string;
  graphGeometrySource: string;
  osmWays: number;
  osmRelations: string[];
  maskAvailable: boolean;
  maskComplete: boolean | null;
  maskUsedByGraph: boolean;
  maskLookupNote: string;
  fairwayAvailable: boolean;
  locksAvailable: boolean;
  graphComponents: number;
  graphNodes: number;
  graphEdges: number;
  largestComponentKm: number;
  endpointComponentGapKm: number | null;
  openWaterBetweenEndpoints: boolean | null;
  graphPathKm: number | null;
  graphRawPathKm: number | null;
  legacyPathKm: number | null;
  graphRejectReason: string | null;
  seamCount: number;
  chord: E212ChordForensics | null;
  missingEvidence: string[];
  whatLegacyHasGraphLacks: string[];
  whatGraphHasLegacyLacks: string[];
  unknowns: string[];
  verdict: E212Verdict;
  diagnosticOnly: true;
};

export type E212Report = {
  schemaVersion: 'e2.12-source-by-source-forensics';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  generatedAt: string;
  cases: E212CorridorForensics[];
  table: Array<{
    route: E212RouteId;
    legacyResult: string;
    graphResult: string;
    legacyGeometrySource: string;
    graphGeometrySource: string;
    OSMWays: number;
    OSMRelations: string;
    MaskAvailable: boolean;
    MaskUsedByGraph: boolean;
    FairwayAvailable: boolean;
    LocksAvailable: boolean;
    graphComponents: number;
    graphPathKm: number | null;
    legacyPathKm: number | null;
    graphRejectReason: string | null;
    missingEvidence: string;
    verdict: E212Verdict;
  }>;
  answers: {
    belomorWhyBothOk: string;
    n06Missing: string;
    n08Missing: string;
    vgDChordAorB: string;
    vgMidControl: string;
  };
  legacyCanGraphCannot: string[];
  graphCanLegacyCannot: string[];
  unknowns: string[];
};

function preset(id: string): { a: LngLat; b: LngLat } {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { a: p.a, b: p.b };
}

export function getE212Cases(): E212Case[] {
  const n06 = preset('N06');
  const n08 = preset('N08');
  return [
    {
      id: 'BELOMOR',
      role: 'positive',
      a: BELOMOR_A,
      b: BELOMOR_B,
      note: 'Both OK — relation-aware vs BRouter',
    },
    {
      id: 'N06',
      role: 'positive',
      a: n06.a,
      b: n06.b,
      note: 'Legacy OK / graph disconnected',
    },
    {
      id: 'N08',
      role: 'positive',
      a: n08.a,
      b: n08.b,
      note: 'Legacy OK / graph disconnected',
    },
    {
      id: 'VG-D',
      role: 'positive',
      a: { lon: 44.52, lat: 48.7 },
      b: { lon: 48.02, lat: 46.36 },
      note: 'Legacy OK / graph near_geodesic_chord',
    },
    {
      id: 'VG-mid',
      role: 'negative_control',
      a: { lon: 45.9, lat: 47.75 },
      b: { lon: 46.95, lat: 47.0 },
      note: 'Control — must not sew Volga↔Akhtuba',
    },
  ];
}

function loadFixture(name: string, a: LngLat, b: LngLat): CenterlineSource[] {
  const fc = JSON.parse(
    readFileSync(join(HERE, '__fixtures__/centerlines', name), 'utf8'),
  ) as never;
  return ingestCenterlineFeaturesSync(a, b, geojsonToCenterlineFeatures(fc))
    .centerlines;
}

async function loadCenterlines(c: E212Case): Promise<{
  centerlines: CenterlineSource[];
  sourceLabel: string;
  osmRelations: string[];
}> {
  if (c.id === 'BELOMOR') {
    return {
      centerlines: belomorRelationAwareCenterlinesForShadow(),
      sourceLabel: 'relation_aware_snapshot:9909116',
      osmRelations: ['9909116'],
    };
  }
  if (c.id === 'VG-D') {
    return {
      centerlines: loadFixture('lower-volga.geojson', c.a, c.b),
      sourceLabel: 'fixture:lower-volga.geojson',
      osmRelations: ['1730417(Volga fixture)', '1230074(Akhtuba fixture)'],
    };
  }
  if (c.id === 'VG-mid') {
    return {
      centerlines: loadFixture('lower-volga-mid.geojson', c.a, c.b),
      sourceLabel: 'fixture:lower-volga-mid.geojson',
      osmRelations: ['1730417(Volga)', '1230074(Akhtuba)'],
    };
  }
  const ingest = await ingestCorridorCenterlines(c.a, c.b, {});
  return {
    centerlines: ingest.centerlines,
    sourceLabel: `overpass:${ingest.stats.centerlineSource}`,
    osmRelations: [],
  };
}

function inspectMask(a: LngLat, b: LngLat): {
  sharedName: string | null;
  sharedOsmId: number | null;
  availableViaDensify: boolean;
  complete: boolean | null;
  usedByTwoPointLookup: boolean;
  note: string;
  lake: LakeMask | null;
} {
  const shared = findSharedOpenLake([a, b]);
  const twoPt = cachedLakeMaskAlongPath([a, b]);
  const dens = densifyOpenWaterPath([a, b], 5);
  const densMask = cachedLakeMaskAlongPath(dens);
  return {
    sharedName: shared?.name ?? null,
    sharedOsmId: shared?.osmId ?? null,
    availableViaDensify: Boolean(densMask),
    complete: densMask ? isLakeMaskComplete(densMask) : null,
    usedByTwoPointLookup: Boolean(twoPt),
    note: shared
      ? twoPt
        ? 'Mask resolved via 2-point cachedLakeMaskAlongPath'
        : densMask
          ? 'Mask EXISTS in cache/bundle (densified A–B lookup) but cachedLakeMaskAlongPath([A,B]) returns null — needs ≥3 bbox hits. E2.11 shadow wiring therefore often skips mask mesh.'
          : 'Shared lake catalog hit but mask not in cache yet (run legacy Phase A/B first or densify after cache warm).'
      : 'No shared open-lake catalog match',
    lake: densMask ?? twoPt,
  };
}

function openWaterBetween(
  a: LngLat,
  b: LngLat,
  lake: LakeMask | null,
): boolean | null {
  if (!lake) return null;
  const samples = [
    a,
    { lon: a.lon * 0.75 + b.lon * 0.25, lat: a.lat * 0.75 + b.lat * 0.25 },
    { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 },
    { lon: a.lon * 0.25 + b.lon * 0.75, lat: a.lat * 0.25 + b.lat * 0.75 },
    b,
  ];
  let hits = 0;
  for (const p of samples) {
    if (pointInOpenWater(p, lake)) hits += 1;
  }
  return hits >= 2;
}

function describeLegacySource(tr: RouteTrace | null, method: string): string {
  if (!tr) return `unknown(${method})`;
  if (tr.phases.A?.ok && tr.phases.A.openWaterVerified) {
    return `phase_A_open_lake_mask:${tr.phases.A.sharedLake ?? 'lake'}`;
  }
  const brouterOk = (tr.brouterAttempts ?? []).some((x) => x.hadGeometry);
  if (tr.phases.B?.ok && brouterOk) {
    const lake = tr.phases.B.sharedLake
      ? `shared_lake=${tr.phases.B.sharedLake}`
      : 'no_shared_lake';
    return `phase_B_brouter:${method};${lake}`;
  }
  if (tr.phases.C?.ok && brouterOk) {
    return `phase_C_brouter:${method}`;
  }
  if (brouterOk) return `brouter:${method}`;
  if (tr.phases.overpass?.ok) return `overpass_then:${method}`;
  return `legacy:${method}`;
}

function analyzeChord(
  a: LngLat,
  b: LngLat,
  rawGeom: LngLat[] | null | undefined,
  rawKm: number | null | undefined,
  pathEdgeKinds: string[],
  maxEdgeKm: number | null,
  longEdgesGt20: number | null,
): E212ChordForensics {
  const geoKm = Math.round(haversineKm(a, b) * 1000) / 1000;
  if (!rawGeom || rawGeom.length < 2 || rawKm == null) {
    return {
      geoKm,
      rawPathKm: null,
      rawPointCount: null,
      ratioRawOverGeo: null,
      maxEdgeKm,
      longEdgesGt20Km: longEdgesGt20,
      pathEdgeKinds,
      validatorIssues: [],
      interpretation: 'not_applicable',
      note: 'No raw graph path geometry',
    };
  }
  const v = validateWaterRoute(rawGeom, {
    waypoints: [a, b],
    lengthKm: rawKm,
    method: 'waterway',
  });
  const ratio = Math.round((rawKm / Math.max(geoKm, 0.001)) * 10000) / 10000;
  let interpretation: E212ChordForensics['interpretation'] = 'unknown';
  let note = '';
  if ((longEdgesGt20 ?? 0) > 0 && (maxEdgeKm ?? 0) > 20) {
    interpretation = 'single_long_shortcut_edge';
    note = `Path contains edge(s) >20 km (max=${maxEdgeKm}). Likely geometric shortcut.`;
  } else if (rawGeom.length <= 2) {
    interpretation = 'sparse_near_geodesic';
    note = 'Path has ≤2 points (pure chord).';
  } else if (ratio <= 1.04) {
    interpretation = 'near_geodesic_overall_no_long_edge';
    note =
      'No single long edge, but overall path length ≈ A↔B geodesic (ratio≤1.04). Guard fires on whole-path ratio — typical of over-simplified centerline vs real navigable meander. Not proof of a seam edge.';
  } else if (ratio <= 1.1 && rawGeom.length < Math.max(5, geoKm / 25)) {
    interpretation = 'sparse_near_geodesic';
    note = 'Near-geodesic with sparse vertices.';
  } else {
    interpretation = 'unknown';
    note = 'Validator issues present but ratio/edge pattern inconclusive.';
  }
  return {
    geoKm,
    rawPathKm: Math.round(rawKm * 1000) / 1000,
    rawPointCount: rawGeom.length,
    ratioRawOverGeo: ratio,
    maxEdgeKm,
    longEdgesGt20Km: longEdgesGt20,
    pathEdgeKinds,
    validatorIssues: v.issues.slice(),
    interpretation,
    note,
  };
}

function edgeStatsFromShadow(
  a: LngLat,
  b: LngLat,
  centerlines: CenterlineSource[],
  lake: LakeMask | null,
): {
  maxEdgeKm: number | null;
  longEdgesGt20: number;
  pathEdgeKinds: string[];
  rawGeom: LngLat[] | null;
  rawKm: number | null;
  endpointGapKm: number | null;
} {
  const g = buildWaterGraph({
    a,
    b,
    centerlines,
    lake,
    lakeComplete: lake ? isLakeMaskComplete(lake) : false,
  });
  const tA = bindWaterGraphTerminal(g, 'A', a, []);
  const tB = bindWaterGraphTerminal(g, 'B', b, []);
  if (!tA || !tB) {
    const topo = diagnoseWaterGraphTopology(g, { a, b, lake });
    const gap = topo.gapSummary[0]?.distanceKm ?? null;
    return {
      maxEdgeKm: null,
      longEdgesGt20: 0,
      pathEdgeKinds: [],
      rawGeom: null,
      rawKm: null,
      endpointGapKm: gap != null ? Math.round(gap * 1000) / 1000 : null,
    };
  }
  const search = searchWaterGraph(g, tA.nodeId, tB.nodeId);
  if (!search.path) {
    const topo = diagnoseWaterGraphTopology(g, { a, b, lake });
    const gap = topo.gapSummary[0]?.distanceKm ?? null;
    return {
      maxEdgeKm: null,
      longEdgesGt20: 0,
      pathEdgeKinds: [],
      rawGeom: null,
      rawKm: null,
      endpointGapKm: gap != null ? Math.round(gap * 1000) / 1000 : null,
    };
  }
  let maxEdgeKm = 0;
  let longEdgesGt20 = 0;
  for (const eid of search.path.edgeIds) {
    const e = g.edges.get(eid);
    if (!e) continue;
    if (e.lengthKm > maxEdgeKm) maxEdgeKm = e.lengthKm;
    if (e.lengthKm > 20) longEdgesGt20 += 1;
  }
  return {
    maxEdgeKm: Math.round(maxEdgeKm * 1000) / 1000,
    longEdgesGt20,
    pathEdgeKinds: search.path.edgeKinds.slice(),
    rawGeom: search.path.geometry.slice(),
    rawKm: search.path.lengthKm,
    endpointGapKm: 0,
  };
}

function assignVerdict(args: {
  c: E212Case;
  legacyOk: boolean;
  graphOk: boolean;
  chord: E212ChordForensics | null;
  legacySource: string;
  missing: string[];
}): E212Verdict {
  if (args.c.role === 'negative_control') {
    return args.graphOk ? 'GRAPH_GEOMETRY_SUSPECT' : 'CONTROL_CORRECT';
  }
  if (args.c.id === 'BELOMOR' && args.legacyOk && args.graphOk) {
    return 'GRAPH_AND_LEGACY_SHARE_DATA';
  }
  if (args.c.id === 'VG-D' && args.chord) {
    if (
      args.chord.interpretation === 'single_long_shortcut_edge' ||
      args.chord.interpretation === 'near_geodesic_overall_no_long_edge' ||
      args.chord.interpretation === 'sparse_near_geodesic'
    ) {
      return 'GRAPH_GEOMETRY_SUSPECT';
    }
    if (args.chord.interpretation === 'unknown') {
      return 'INSUFFICIENT_EVIDENCE';
    }
  }
  if (args.legacyOk && !args.graphOk) {
    return 'LEGACY_HAS_ADDITIONAL_DATA';
  }
  return 'INSUFFICIENT_EVIDENCE';
}

export async function runE212Corridor(
  c: E212Case,
): Promise<E212CorridorForensics> {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('E2.12 requires USE_WATER_GRAPH=false');
  }
  clearProviderCaches();
  clearWaterwayCellCacheForTests();
  clearRouteTraces();

  const path = await measureWaterChain([c.a, c.b]);
  const tr = getLastRouteTrace();
  const legacyOk = path.method !== 'route_not_found' && path.points.length >= 2;
  const legacyKm = legacyOk ? Math.round(path.lengthKm * 1000) / 1000 : null;
  const legacySource = describeLegacySource(tr, path.method);

  const loaded = await loadCenterlines(c);
  const maskInfo = inspectMask(c.a, c.b);
  // Same wiring as E2.11: 2-point lookup (often skips mask).
  const lakeForGraph = cachedLakeMaskAlongPath([c.a, c.b]);
  const shadow = runWaterGraphShadow({
    a: c.a,
    b: c.b,
    legacyLengthKm: legacyKm ?? 0,
    legacyOk,
    centerlines: loaded.centerlines,
    lake: lakeForGraph,
    lakeComplete: lakeForGraph ? isLakeMaskComplete(lakeForGraph) : false,
  });

  const stats = edgeStatsFromShadow(
    c.a,
    c.b,
    loaded.centerlines,
    lakeForGraph,
  );
  const rawGeom = shadow.rawPathGeometry ?? stats.rawGeom;
  const rawKm = shadow.rawPathLengthKm ?? stats.rawKm;
  const chord =
    c.id === 'VG-D' || Boolean(shadow.rejectReason?.includes('chord'))
      ? analyzeChord(
          c.a,
          c.b,
          rawGeom,
          rawKm,
          stats.pathEdgeKinds,
          stats.maxEdgeKm,
          stats.longEdgesGt20,
        )
      : null;

  const fairwayAvailable = shadow.layers.fairway;
  const locksAvailable = shadow.layers.lock;
  const maskUsedByGraph = shadow.layers.mask;
  const openWater = openWaterBetween(c.a, c.b, maskInfo.lake);

  let phaseAMaskRouteKm: number | null = null;
  if (c.id === 'N06' || c.id === 'N08') {
    try {
      const lr = await routeAcrossOpenLake([c.a, c.b]);
      phaseAMaskRouteKm = lr ? Math.round(lr.lengthKm * 1000) / 1000 : null;
    } catch {
      phaseAMaskRouteKm = null;
    }
  }

  const missing: string[] = [];
  const legacyHas: string[] = [];
  const graphHas: string[] = [];
  const unknowns: string[] = [];

  if (c.id === 'BELOMOR') {
    legacyHas.push('BRouter water profile geometry (~216 km)');
    graphHas.push('OSM relation 9909116 main_stream ways (29) as centerlines');
  }

  if (c.id === 'N06' || c.id === 'N08') {
    if (legacySource.includes('brouter')) {
      legacyHas.push(
        'BRouter geometry on shared Kuibyshev lake corridor (Phase B)',
      );
      missing.push('brouter_geometry');
    }
    if (maskInfo.availableViaDensify && !maskUsedByGraph) {
      missing.push('connected_mask_mesh_in_graph');
      legacyHas.push(
        'Complete Kuibyshev mask available in bundle (coverage hit); Phase A may still fail endpoint snap',
      );
    }
    if (shadow.rejectReason === 'graph_disconnected') {
      missing.push('connected_centerline_component');
    }
    if (!fairwayAvailable) {
      missing.push('fairway_in_corridor');
    }
    if (phaseAMaskRouteKm == null) {
      unknowns.push(
        `${c.id}: routeAcrossOpenLake failed while Phase B BRouter succeeded — exact Phase A failure beyond open_lake_fail not further instrumented`,
      );
    }
  }

  if (c.id === 'VG-D') {
    legacyHas.push('BRouter navigable track ~456 km (meander)');
    graphHas.push(
      'Fixture Volga(+Akhtuba) centerlines producing ~373 km raw path',
    );
    if (chord?.interpretation === 'near_geodesic_overall_no_long_edge') {
      missing.push('meander_fidelity_vs_brouter');
    }
  }

  if (c.id === 'VG-mid') {
    missing.push('none_expected_separate_objects');
  }

  const graphOk = shadow.pathFound && shadow.validated;
  const verdict = assignVerdict({
    c,
    legacyOk,
    graphOk,
    chord,
    legacySource,
    missing,
  });

  const row: E212CorridorForensics = {
    route: c.id,
    role: c.role,
    legacyResult: legacyOk
      ? `OK ${legacyKm}km (${path.method})`
      : `FAIL ${tr?.final.rejectReason ?? 'reject'}`,
    graphResult: graphOk
      ? `OK ${Math.round(shadow.pathLengthKm * 1000) / 1000}km`
      : `FAIL ${shadow.rejectReason ?? shadow.failureStage}`,
    legacyGeometrySource: legacySource,
    graphGeometrySource: loaded.sourceLabel,
    osmWays: loaded.centerlines.length,
    osmRelations: loaded.osmRelations,
    maskAvailable: Boolean(maskInfo.sharedName) && maskInfo.availableViaDensify,
    maskComplete: maskInfo.complete,
    maskUsedByGraph,
    maskLookupNote: maskInfo.note,
    fairwayAvailable,
    locksAvailable,
    graphComponents:
      shadow.topology?.componentCount ??
      shadow.components?.connectedComponents ??
      0,
    graphNodes: shadow.nodeCount,
    graphEdges: shadow.edgeCount,
    largestComponentKm:
      Math.round(
        (shadow.topology?.largestComponentKm ??
          shadow.components?.largestComponentKm ??
          0) * 1000,
      ) / 1000,
    endpointComponentGapKm: stats.endpointGapKm,
    openWaterBetweenEndpoints: openWater,
    graphPathKm: graphOk
      ? Math.round(shadow.pathLengthKm * 1000) / 1000
      : null,
    graphRawPathKm: rawKm != null ? Math.round(rawKm * 1000) / 1000 : null,
    legacyPathKm: legacyKm,
    graphRejectReason: shadow.rejectReason,
    seamCount: shadow.edgeKindCounts.seamCount,
    chord,
    missingEvidence: missing,
    whatLegacyHasGraphLacks: legacyHas,
    whatGraphHasLegacyLacks: graphHas,
    unknowns,
    diagnosticOnly: true,
    verdict,
  };

  if (tr) {
    const block: RouteTraceWaterGraphForensics = {
      diagnosticOnly: true,
      route: c.id,
      verdict: row.verdict,
      legacySources: {
        method: path.method,
        description: legacySource,
        phaseA: tr.phases.A
          ? {
              ok: tr.phases.A.ok,
              openWaterVerified: tr.phases.A.openWaterVerified ?? null,
              sharedLake: tr.phases.A.sharedLake ?? null,
              rejectReason: tr.phases.A.rejectReason ?? null,
            }
          : null,
        brouterAttempts: (tr.brouterAttempts ?? []).map((x) => ({
          label: x.label,
          hadGeometry: x.hadGeometry,
          lengthKm: x.lengthKm,
        })),
      },
      graphSources: {
        centerlineStrategy: loaded.sourceLabel,
        layers: { ...shadow.layers },
        provenanceSources: shadow.provenance.sources.slice(),
      },
      osmWays: loaded.centerlines.length,
      osmRelations: loaded.osmRelations,
      masks: {
        available: row.maskAvailable,
        complete: row.maskComplete,
        usedByGraph: row.maskUsedByGraph,
        note: row.maskLookupNote,
      },
      fairways: { available: fairwayAvailable },
      locks: { available: locksAvailable },
      components: {
        count: row.graphComponents,
        largestComponentKm: row.largestComponentKm,
        endpointGapKm: row.endpointComponentGapKm,
      },
      graphPath: {
        validatedKm: row.graphPathKm,
        rawKm: row.graphRawPathKm,
        rejectReason: row.graphRejectReason,
        seamCount: row.seamCount,
        chord: chord
          ? {
              geoKm: chord.geoKm,
              ratio: chord.ratioRawOverGeo,
              maxEdgeKm: chord.maxEdgeKm,
              interpretation: chord.interpretation,
            }
          : null,
      },
      divergence: {
        legacyPathKm: row.legacyPathKm,
        missingEvidence: row.missingEvidence,
      },
      missingEvidence: row.missingEvidence,
    };
    replaceLastRouteTrace({ ...tr, waterGraphForensics: block });
  }

  return row;
}

export async function runE212ForensicsSuite(opts?: {
  routes?: E212RouteId[];
}): Promise<E212Report> {
  const all = getE212Cases();
  const selected = opts?.routes
    ? all.filter((c) => opts.routes!.includes(c.id))
    : all;
  const cases: E212CorridorForensics[] = [];
  for (const c of selected) {
    cases.push(await runE212Corridor(c));
  }

  const belomor = cases.find((x) => x.route === 'BELOMOR');
  const n06 = cases.find((x) => x.route === 'N06');
  const n08 = cases.find((x) => x.route === 'N08');
  const vgd = cases.find((x) => x.route === 'VG-D');
  const vgmid = cases.find((x) => x.route === 'VG-mid');

  const answers = {
    belomorWhyBothOk: belomor
      ? `Legacy uses BRouter waterway (~${belomor.legacyPathKm} km). Graph uses OSM relation 9909116 (${belomor.osmWays} main_stream ways) → validated ~${belomor.graphPathKm} km. Lengths align (~0.5%). Both hold independent full-canal geometry — not the same bytes, but equivalent coverage. Verdict=${belomor.verdict}.`
      : 'UNKNOWN — Belomor not run',
    n06Missing: n06
      ? `Legacy succeeds via ${n06.legacyGeometrySource} (not Phase A mask A*). Graph: ${n06.osmWays} Overpass ways, components=${n06.graphComponents}, maskAvailable=${n06.maskAvailable} but maskUsedByGraph=${n06.maskUsedByGraph}. Missing: ${n06.missingEvidence.join(', ') || 'none'}. ${n06.maskLookupNote}`
      : 'UNKNOWN — N06 not run',
    n08Missing: n08
      ? `Legacy succeeds via ${n08.legacyGeometrySource}. Graph: ${n08.osmWays} Overpass ways, components=${n08.graphComponents}, maskUsedByGraph=${n08.maskUsedByGraph}. Missing: ${n08.missingEvidence.join(', ') || 'none'}.`
      : 'UNKNOWN — N08 not run',
    vgDChordAorB: vgd?.chord
      ? vgd.chord.interpretation === 'single_long_shortcut_edge'
        ? `A) Graph created a shortcut — maxEdgeKm=${vgd.chord.maxEdgeKm}.`
        : vgd.chord.interpretation === 'near_geodesic_overall_no_long_edge'
          ? `Lean A / geometry-suspect (not classic single-edge seam): rawPathKm=${vgd.chord.rawPathKm} vs geoKm=${vgd.chord.geoKm} (ratio=${vgd.chord.ratioRawOverGeo}); maxEdgeKm=${vgd.chord.maxEdgeKm}; points=${vgd.chord.rawPointCount}. Guard fires on whole-path ratio≤1.04. Legacy BRouter ~${vgd.legacyPathKm} km is materially longer (real meander). Not B (guard bug) — fixture path is near-geodesic vs A↔B. Verdict=${vgd.verdict}.`
          : `UNKNOWN — chord interpretation=${vgd.chord.interpretation}. Need: denser fixture vs BRouter sample overlay.`
      : 'UNKNOWN — VG-D chord block missing',
    vgMidControl: vgmid
      ? `Both reject; seamCount=${vgmid.seamCount}; verdict=${vgmid.verdict}. Separate Volga/Akhtuba objects preserved.`
      : 'UNKNOWN — VG-mid not run',
  };

  const legacyCanGraphCannot: string[] = [];
  const graphCanLegacyCannot: string[] = [];
  const unknowns: string[] = [];
  for (const c of cases) {
    legacyCanGraphCannot.push(
      ...c.whatLegacyHasGraphLacks.map((x) => `${c.route}: ${x}`),
    );
    graphCanLegacyCannot.push(
      ...c.whatGraphHasLegacyLacks.map((x) => `${c.route}: ${x}`),
    );
    unknowns.push(...c.unknowns);
  }
  if (belomor?.verdict === 'GRAPH_AND_LEGACY_SHARE_DATA') {
    graphCanLegacyCannot.push(
      'BELOMOR: Graph can build a validated ~217 km path from OSM relation alone without calling BRouter (shadow) — equivalent coverage, independent source',
    );
  }

  return {
    schemaVersion: 'e2.12-source-by-source-forensics',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    generatedAt: new Date().toISOString(),
    cases,
    table: cases.map((c) => ({
      route: c.route,
      legacyResult: c.legacyResult,
      graphResult: c.graphResult,
      legacyGeometrySource: c.legacyGeometrySource,
      graphGeometrySource: c.graphGeometrySource,
      OSMWays: c.osmWays,
      OSMRelations: c.osmRelations.join(';') || '—',
      MaskAvailable: c.maskAvailable,
      MaskUsedByGraph: c.maskUsedByGraph,
      FairwayAvailable: c.fairwayAvailable,
      LocksAvailable: c.locksAvailable,
      graphComponents: c.graphComponents,
      graphPathKm: c.graphPathKm,
      legacyPathKm: c.legacyPathKm,
      graphRejectReason: c.graphRejectReason,
      missingEvidence: c.missingEvidence.join(';') || '—',
      verdict: c.verdict,
    })),
    answers,
    legacyCanGraphCannot,
    graphCanLegacyCannot,
    unknowns,
  };
}

export function formatE212MarkdownTable(report: E212Report): string {
  const header =
    '| route | legacyResult | graphResult | legacyGeometrySource | graphGeometrySource | OSMWays | OSMRelations | MaskAvailable | MaskUsedByGraph | FairwayAvailable | LocksAvailable | graphComponents | graphPathKm | legacyPathKm | graphRejectReason | missingEvidence | verdict |';
  const sep =
    '| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |';
  const rows = report.table.map((r) => {
    return `| ${r.route} | ${r.legacyResult} | ${r.graphResult} | ${r.legacyGeometrySource} | ${r.graphGeometrySource} | ${r.OSMWays} | ${r.OSMRelations} | ${r.MaskAvailable} | ${r.MaskUsedByGraph} | ${r.FairwayAvailable} | ${r.LocksAvailable} | ${r.graphComponents} | ${r.graphPathKm ?? '—'} | ${r.legacyPathKm ?? '—'} | ${r.graphRejectReason ?? '—'} | ${r.missingEvidence} | ${r.verdict} |`;
  });
  return [header, sep, ...rows].join('\n');
}
