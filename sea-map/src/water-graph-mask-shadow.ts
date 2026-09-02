/**
 * E2.13 — Shadow lake-mask integration for WaterGraph (diagnostic only).
 *
 * Hypothesis: N06/N08 lose connectivity because the existing Kuibyshev
 * open-water mask is not wired into WaterGraph (2-point lookup misses it),
 * not because Dijkstra is wrong.
 *
 * Uses the existing buildWaterGraph mask mesh + waterway↔mask proximity seams.
 * Does NOT invent long-distance river↔river seams or Volga↔Akhtuba joins.
 * USE_WATER_GRAPH stays false. Production routing unchanged.
 */

import { haversineKm, type LngLat } from './geo';
import {
  clearRouteTraces,
  getLastRouteTrace,
  replaceLastRouteTrace,
  type RouteTrace,
  type RouteTraceWaterGraphMaskShadow,
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
  WG_LAKE_CONNECT_KM,
} from './water-graph';
import type { WaterGraphShadowResult } from './water-graph-types';
import {
  findSharedOpenLake,
  cachedLakeMaskAlongPath,
  densifyOpenWaterPath,
  isLakeMaskComplete,
  pointInOpenWater,
  routeAcrossOpenLake,
  type LakeMask,
} from './open-lake';
import type { CenterlineSource } from './water-graph-types';
import { diagnoseWaterGraphTopology } from './water-graph-topology';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export type E213RouteId = 'N06' | 'N08' | 'BELOMOR' | 'VG-mid';

export type E213VariantLabel = 'CURRENT' | 'MASK_SHADOW';

export type E213VariantSnap = {
  label: E213VariantLabel;
  componentCount: number;
  largestComponentKm: number;
  gapCount: number;
  nodeCount: number;
  edgeCount: number;
  maskNodeCount: number;
  maskEdgeCount: number;
  waterwayMaskConnections: number;
  pathFound: boolean;
  pathKm: number | null;
  graphSafetyAccepted: boolean;
  rejectReason: string | null;
  graphBuildMs: number;
  graphSearchMs: number;
  layers: {
    centerline: boolean;
    mask: boolean;
    fairway: boolean;
    lock: boolean;
  };
};

export type E213ResidualGap = {
  present: boolean;
  endpoint: 'A' | 'B' | 'both' | 'unknown' | null;
  nearestMaskKmA: number | null;
  nearestMaskKmB: number | null;
  endpointInOpenWaterA: boolean | null;
  endpointInOpenWaterB: boolean | null;
  terminalDistKmA: number | null;
  terminalDistKmB: number | null;
  gapSummarySample: Array<{
    distanceKm: number;
    fromLayer: string;
    toLayer: string;
    classification: string;
    note: string;
  }>;
  additionalDataNeeded: string[];
  note: string;
};

export type E213CorridorReport = {
  route: E213RouteId;
  diagnosticOnly: true;
  maskSource: string | null;
  maskVerifiedComplete: boolean | null;
  maskResolveNote: string;
  legacy: {
    accepted: boolean;
    routeKm: number | null;
    method: string;
    source: string;
    rejectReason: string | null;
  };
  current: E213VariantSnap;
  maskShadow: E213VariantSnap;
  residualGap: E213ResidualGap;
  divergenceReason: string;
  helped: boolean;
  pathWithoutBrouter: boolean;
  safetyRegression: boolean;
  summary: string;
};

export type E213SuiteReport = {
  schemaVersion: 'e2.13-watergraph-mask-shadow';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  noVolgaAkhtubaSew: true;
  generatedAt: string;
  corridors: E213CorridorReport[];
  table: Array<{
    route: E213RouteId;
    legacy: string;
    currentPath: string;
    maskPath: string;
    compsBefore: number;
    compsAfter: number;
    maskNodes: number;
    maskEdges: number;
    wwMaskLinks: number;
    helped: boolean;
    pathWithoutBrouter: boolean;
    residual: string;
  }>;
  answers: {
    A_maskHelped: string;
    B_componentPathDelta: string;
    C_n06n08WithoutBrouter: string;
    D_remainingGap: string;
    E_safetyRegression: string;
    F_nextStep: string;
  };
};

function preset(id: string): { a: LngLat; b: LngLat } {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { a: p.a, b: p.b };
}

export function getE213Cases(): Array<{
  id: E213RouteId;
  a: LngLat;
  b: LngLat;
  role: 'target' | 'control_positive' | 'control_negative';
}> {
  const n06 = preset('N06');
  const n08 = preset('N08');
  return [
    { id: 'N06', a: n06.a, b: n06.b, role: 'target' },
    { id: 'N08', a: n08.a, b: n08.b, role: 'target' },
    { id: 'BELOMOR', a: BELOMOR_A, b: BELOMOR_B, role: 'control_positive' },
    {
      id: 'VG-mid',
      a: { lon: 45.9, lat: 47.75 },
      b: { lon: 46.95, lat: 47.0 },
      role: 'control_negative',
    },
  ];
}

/**
 * Resolve existing production lake-mask for shadow use.
 * Why E2.11/E2.12 often saw maskAvail but maskUsed=false:
 * cachedLakeMaskAlongPath([A,B]) requires ≥3 bbox hits — two endpoints never qualify.
 * Densified A–B polyline + warmed cache (bundled Kuibyshev) resolves the same mask
 * Phase A already uses via fetchLakeMask/routeAcrossOpenLake.
 */
export async function resolveLakeMaskForShadow(
  a: LngLat,
  b: LngLat,
): Promise<{
  lake: LakeMask | null;
  sharedName: string | null;
  sharedOsmId: number | null;
  complete: boolean | null;
  source: string | null;
  note: string;
  provenance: {
    sourceType: 'lake_mask';
    sourceId: string;
    sourceDetail: string;
    diagnosticOnly: true;
  } | null;
}> {
  const shared = findSharedOpenLake([a, b]);
  if (!shared) {
    return {
      lake: null,
      sharedName: null,
      sharedOsmId: null,
      complete: null,
      source: null,
      note: 'No shared open-lake catalog match — MASK_SHADOW == CURRENT for mask layer',
      provenance: null,
    };
  }

  // Warm bundled/cached mask the same way Phase A does (no pipeline rewrite).
  try {
    await routeAcrossOpenLake([a, b]);
  } catch {
    // ignore — densify lookup may still work if cache already warm
  }

  const twoPt = cachedLakeMaskAlongPath([a, b]);
  const dens = densifyOpenWaterPath([a, b], 5);
  const densMask = cachedLakeMaskAlongPath(dens);
  const lake = densMask ?? twoPt;
  const complete = lake ? isLakeMaskComplete(lake) : null;

  if (!lake) {
    return {
      lake: null,
      sharedName: shared.name,
      sharedOsmId: shared.osmId,
      complete: null,
      source: null,
      note: `Shared lake ${shared.name} (osm ${shared.osmId}) but mask not in cache after warm`,
      provenance: null,
    };
  }

  const via = twoPt ? 'two_point_lookup' : 'densified_corridor_lookup';
  return {
    lake,
    sharedName: shared.name,
    sharedOsmId: shared.osmId,
    complete,
    source: `bundled_or_cached:${shared.name}:${via}`,
    note: twoPt
      ? 'Mask resolved via 2-point lookup'
      : 'Mask resolved via densified A–B (≥3 bbox hits). Explains E2.12 maskAvail && !maskUsed under 2-point wiring.',
    provenance: {
      sourceType: 'lake_mask',
      sourceId: `lake:${shared.osmId}`,
      sourceDetail: `${shared.name}; complete=${complete}; resolve=${via}; diagnosticOnly shadow`,
      diagnosticOnly: true,
    },
  };
}

async function loadCenterlines(
  id: E213RouteId,
  a: LngLat,
  b: LngLat,
): Promise<CenterlineSource[]> {
  if (id === 'BELOMOR') return belomorRelationAwareCenterlinesForShadow();
  if (id === 'VG-mid') {
    const fc = JSON.parse(
      readFileSync(
        join(HERE, '__fixtures__/centerlines/lower-volga-mid.geojson'),
        'utf8',
      ),
    ) as never;
    return ingestCenterlineFeaturesSync(a, b, geojsonToCenterlineFeatures(fc))
      .centerlines;
  }
  const ingest = await ingestCorridorCenterlines(a, b, {});
  return ingest.centerlines;
}

function snapFromShadow(
  label: E213VariantLabel,
  shadow: WaterGraphShadowResult,
): E213VariantSnap {
  const comps =
    shadow.topology?.componentCount ??
    shadow.components?.connectedComponents ??
    0;
  const gaps = shadow.topology?.gapSummary?.length ?? 0;
  return {
    label,
    componentCount: comps,
    largestComponentKm:
      Math.round(
        (shadow.topology?.largestComponentKm ??
          shadow.components?.largestComponentKm ??
          0) * 1000,
      ) / 1000,
    gapCount: gaps,
    nodeCount: shadow.nodeCount,
    edgeCount: shadow.edgeCount,
    maskNodeCount: shadow.components?.maskNodeCount ?? 0,
    maskEdgeCount: shadow.edgeKindCounts.maskEdgeCount,
    waterwayMaskConnections: shadow.edgeKindCounts.seamCount,
    pathFound: shadow.pathFound,
    pathKm: shadow.pathFound
      ? Math.round(shadow.pathLengthKm * 1000) / 1000
      : null,
    graphSafetyAccepted: shadow.validated,
    rejectReason: shadow.rejectReason,
    graphBuildMs: Math.round(shadow.buildMs * 1000) / 1000,
    graphSearchMs: Math.round(shadow.searchMs * 1000) / 1000,
    layers: { ...shadow.layers },
  };
}

function diagnoseResidualGap(
  a: LngLat,
  b: LngLat,
  centerlines: CenterlineSource[],
  lake: LakeMask | null,
  maskShadow: E213VariantSnap,
): E213ResidualGap {
  if (maskShadow.pathFound) {
    return {
      present: false,
      endpoint: null,
      nearestMaskKmA: null,
      nearestMaskKmB: null,
      endpointInOpenWaterA: null,
      endpointInOpenWaterB: null,
      terminalDistKmA: null,
      terminalDistKmB: null,
      gapSummarySample: [],
      additionalDataNeeded: [],
      note: 'MASK_SHADOW found a validated path — no residual disconnect for this A/B',
    };
  }
  if (!lake) {
    return {
      present: true,
      endpoint: 'unknown',
      nearestMaskKmA: null,
      nearestMaskKmB: null,
      endpointInOpenWaterA: null,
      endpointInOpenWaterB: null,
      terminalDistKmA: null,
      terminalDistKmB: null,
      gapSummarySample: [],
      additionalDataNeeded: ['shared_verified_lake_mask'],
      note: 'No lake mask available for this corridor',
    };
  }

  const g = buildWaterGraph({
    a,
    b,
    centerlines,
    lake,
    lakeComplete: isLakeMaskComplete(lake),
  });
  const tA = bindWaterGraphTerminal(g, 'A', a, []);
  const tB = bindWaterGraphTerminal(g, 'B', b, []);
  const masks = [...g.nodes.values()].filter((n) => n.metadata?.mask);
  const nearest = (p: LngLat): number | null => {
    if (!masks.length) return null;
    let best = Infinity;
    for (const m of masks) best = Math.min(best, haversineKm(p, m));
    return Math.round(best * 1000) / 1000;
  };
  const nearA = nearest(a);
  const nearB = nearest(b);
  const inA = pointInOpenWater(a, lake);
  const inB = pointInOpenWater(b, lake);
  const topo = diagnoseWaterGraphTopology(g, { a, b, lake });
  const sample = (topo.gapSummary ?? []).slice(0, 6).map((g) => ({
    distanceKm: Math.round(g.distanceKm * 1000) / 1000,
    fromLayer: g.fromSide.layer,
    toLayer: g.toSide.layer,
    classification: g.classification,
    note: g.note,
  }));

  const needed: string[] = [];
  let endpoint: E213ResidualGap['endpoint'] = 'unknown';
  if ((nearB ?? 99) > WG_LAKE_CONNECT_KM * 2 && (nearA ?? 99) <= WG_LAKE_CONNECT_KM) {
    endpoint = 'B';
    needed.push('endpoint_B_near_open_water_or_centerline_connected_to_mask');
  } else if ((nearA ?? 99) > WG_LAKE_CONNECT_KM * 2 && (nearB ?? 99) <= WG_LAKE_CONNECT_KM) {
    endpoint = 'A';
    needed.push('endpoint_A_near_open_water_or_centerline_connected_to_mask');
  } else if ((nearA ?? 99) > WG_LAKE_CONNECT_KM && (nearB ?? 99) > WG_LAKE_CONNECT_KM) {
    endpoint = 'both';
    needed.push('both_endpoints_far_from_mask_mesh');
  } else {
    needed.push(
      'waterway_mask_merge_for_osm_unnamed_ways_or_denser_mask_grid_or_fairway_bridge',
    );
  }
  if (!inA || !inB) {
    needed.push('shore_snap_to_open_water_before_graph_bind');
  }

  // Do NOT invent a long seam — report distance only.
  const far =
    Math.max(nearA ?? 0, nearB ?? 0) > WG_LAKE_CONNECT_KM
      ? `Nearest mask distances A=${nearA}km B=${nearB}km (seam threshold ${WG_LAKE_CONNECT_KM}km).`
      : 'Endpoints near mask but path still missing — check component merge / osm: waterId seam coverage.';

  return {
    present: true,
    endpoint,
    nearestMaskKmA: nearA,
    nearestMaskKmB: nearB,
    endpointInOpenWaterA: inA,
    endpointInOpenWaterB: inB,
    terminalDistKmA: tA ? Math.round(tA.distKm * 1000) / 1000 : null,
    terminalDistKmB: tB ? Math.round(tB.distKm * 1000) / 1000 : null,
    gapSummarySample: sample,
    additionalDataNeeded: needed,
    note: far,
  };
}

function describeLegacySource(tr: RouteTrace | null, method: string): string {
  if (!tr) return method;
  if (tr.phases.A?.ok && tr.phases.A.openWaterVerified) {
    return `phase_A_mask:${tr.phases.A.sharedLake ?? 'lake'}`;
  }
  const brouter = (tr.brouterAttempts ?? []).some((x) => x.hadGeometry);
  if (tr.phases.B?.ok && brouter) {
    return `phase_B_brouter:${method}${tr.phases.B.sharedLake ? `;lake=${tr.phases.B.sharedLake}` : ''}`;
  }
  if (brouter) return `brouter:${method}`;
  return `legacy:${method}`;
}

export async function runE213Corridor(
  id: E213RouteId,
): Promise<E213CorridorReport> {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('E2.13 requires USE_WATER_GRAPH=false');
  }
  const c = getE213Cases().find((x) => x.id === id);
  if (!c) throw new Error(`unknown corridor ${id}`);

  clearProviderCaches();
  clearWaterwayCellCacheForTests();
  clearRouteTraces();

  const path = await measureWaterChain([c.a, c.b]);
  const tr = getLastRouteTrace();
  const legacyOk = path.method !== 'route_not_found' && path.points.length >= 2;
  const legacyKm = legacyOk ? Math.round(path.lengthKm * 1000) / 1000 : null;
  const legacySource = describeLegacySource(tr, path.method);

  const centerlines = await loadCenterlines(id, c.a, c.b);
  const resolved = await resolveLakeMaskForShadow(c.a, c.b);

  const currentShadow = runWaterGraphShadow({
    a: c.a,
    b: c.b,
    legacyLengthKm: legacyKm ?? 0,
    legacyOk,
    centerlines,
    lake: null,
    lakeComplete: false,
  });

  const maskShadowRun = runWaterGraphShadow({
    a: c.a,
    b: c.b,
    legacyLengthKm: legacyKm ?? 0,
    legacyOk,
    centerlines,
    lake: resolved.lake,
    lakeComplete: resolved.complete === true,
  });

  const current = snapFromShadow('CURRENT', currentShadow);
  const maskShadow = snapFromShadow('MASK_SHADOW', maskShadowRun);
  const residualGap = diagnoseResidualGap(
    c.a,
    c.b,
    centerlines,
    resolved.lake,
    maskShadow,
  );

  const helped =
    (!current.pathFound && maskShadow.pathFound) ||
    maskShadow.componentCount < current.componentCount ||
    maskShadow.largestComponentKm > current.largestComponentKm + 5;

  const pathWithoutBrouter = maskShadow.pathFound && maskShadow.graphSafetyAccepted;

  // Safety regression: control negative must not gain an accepted path that sews bodies.
  let safetyRegression = false;
  if (id === 'VG-mid' && maskShadow.pathFound) {
    safetyRegression = true;
  }
  if (maskShadow.waterwayMaskConnections < 0) safetyRegression = true;

  let divergenceReason = 'none';
  if (legacyOk && pathWithoutBrouter) {
    divergenceReason = 'both_ok_mask_shadow_replaces_brouter_dependency_diagnostically';
  } else if (legacyOk && !current.pathFound && !maskShadow.pathFound) {
    divergenceReason = `legacy_ok_graph_still_fail:${maskShadow.rejectReason ?? 'unknown'}; residual=${residualGap.note}`;
  } else if (legacyOk && !current.pathFound && maskShadow.pathFound) {
    divergenceReason = 'mask_shadow_recovers_path_legacy_had_via_brouter';
  } else if (!legacyOk && !maskShadow.pathFound) {
    divergenceReason = 'both_reject_control_or_fail';
  }

  const summary = pathWithoutBrouter
    ? `MASK_SHADOW pathFound km=${maskShadow.pathKm} (CURRENT pathFound=${current.pathFound}). comps ${current.componentCount}→${maskShadow.componentCount}.`
    : `MASK_SHADOW still no path (${maskShadow.rejectReason}). comps ${current.componentCount}→${maskShadow.componentCount}. ${residualGap.note}`;

  const report: E213CorridorReport = {
    route: id,
    diagnosticOnly: true,
    maskSource: resolved.source,
    maskVerifiedComplete: resolved.complete,
    maskResolveNote: resolved.note,
    legacy: {
      accepted: legacyOk,
      routeKm: legacyKm,
      method: path.method,
      source: legacySource,
      rejectReason: tr?.final.rejectReason ?? null,
    },
    current,
    maskShadow,
    residualGap,
    divergenceReason,
    helped,
    pathWithoutBrouter,
    safetyRegression,
    summary,
  };

  if (tr) {
    const block: RouteTraceWaterGraphMaskShadow = {
      diagnosticOnly: true,
      corridor: id,
      maskSource: resolved.source,
      maskVerifiedComplete: resolved.complete,
      maskResolveNote: resolved.note,
      maskNodeCount: maskShadow.maskNodeCount,
      maskEdgeCount: maskShadow.maskEdgeCount,
      waterwayMaskConnections: maskShadow.waterwayMaskConnections,
      componentCountBefore: current.componentCount,
      componentCountAfter: maskShadow.componentCount,
      pathBefore: current.pathFound,
      pathAfter: maskShadow.pathFound,
      pathKmBefore: current.pathKm,
      pathKmAfter: maskShadow.pathKm,
      safetyBefore: current.graphSafetyAccepted,
      safetyAfter: maskShadow.graphSafetyAccepted,
      legacyCompare: {
        legacyAccepted: legacyOk,
        legacyKm,
        legacySource,
        divergenceReason,
      },
      timing: {
        currentBuildMs: current.graphBuildMs,
        currentSearchMs: current.graphSearchMs,
        maskBuildMs: maskShadow.graphBuildMs,
        maskSearchMs: maskShadow.graphSearchMs,
      },
      residualGap: residualGap.present
        ? {
            endpoint: residualGap.endpoint,
            nearestMaskKmA: residualGap.nearestMaskKmA,
            nearestMaskKmB: residualGap.nearestMaskKmB,
            note: residualGap.note,
            additionalDataNeeded: residualGap.additionalDataNeeded,
          }
        : null,
    };
    replaceLastRouteTrace({ ...tr, waterGraphMaskShadow: block });
  }

  return report;
}

export async function runE213MaskShadowSuite(opts?: {
  routes?: E213RouteId[];
}): Promise<E213SuiteReport> {
  const all = getE213Cases();
  const selected = opts?.routes
    ? all.filter((c) => opts.routes!.includes(c.id))
    : all;
  const corridors: E213CorridorReport[] = [];
  for (const c of selected) {
    corridors.push(await runE213Corridor(c.id));
  }

  const n06 = corridors.find((c) => c.route === 'N06');
  const n08 = corridors.find((c) => c.route === 'N08');
  const bel = corridors.find((c) => c.route === 'BELOMOR');
  const vg = corridors.find((c) => c.route === 'VG-mid');

  const helpedRoutes = corridors.filter((c) => c.helped).map((c) => c.route);
  const withoutBrouter = corridors
    .filter((c) => c.pathWithoutBrouter)
    .map((c) => c.route);

  return {
    schemaVersion: 'e2.13-watergraph-mask-shadow',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    noVolgaAkhtubaSew: true,
    generatedAt: new Date().toISOString(),
    corridors,
    table: corridors.map((c) => ({
      route: c.route,
      legacy: c.legacy.accepted
        ? `OK ${c.legacy.routeKm}`
        : `FAIL ${c.legacy.rejectReason ?? ''}`,
      currentPath: c.current.pathFound
        ? `OK ${c.current.pathKm}`
        : `FAIL ${c.current.rejectReason ?? ''}`,
      maskPath: c.maskShadow.pathFound
        ? `OK ${c.maskShadow.pathKm}`
        : `FAIL ${c.maskShadow.rejectReason ?? ''}`,
      compsBefore: c.current.componentCount,
      compsAfter: c.maskShadow.componentCount,
      maskNodes: c.maskShadow.maskNodeCount,
      maskEdges: c.maskShadow.maskEdgeCount,
      wwMaskLinks: c.maskShadow.waterwayMaskConnections,
      helped: c.helped,
      pathWithoutBrouter: c.pathWithoutBrouter,
      residual: c.residualGap.present
        ? `${c.residualGap.endpoint}: A=${c.residualGap.nearestMaskKmA} B=${c.residualGap.nearestMaskKmB}`
        : 'none',
    })),
    answers: {
      A_maskHelped:
        helpedRoutes.length > 0
          ? `Yes for ${helpedRoutes.join(', ')}. Mask mesh + existing waterway↔mask seams (${WG_LAKE_CONNECT_KM} km) improve connectivity when the shared lake mask is correctly resolved.`
          : 'No corridor showed clear mask help in this run.',
      B_componentPathDelta: [
        n06 &&
          `N06: comps ${n06.current.componentCount}→${n06.maskShadow.componentCount}, largestKm ${n06.current.largestComponentKm}→${n06.maskShadow.largestComponentKm}, path ${n06.current.pathFound}→${n06.maskShadow.pathFound}`,
        n08 &&
          `N08: comps ${n08.current.componentCount}→${n08.maskShadow.componentCount}, largestKm ${n08.current.largestComponentKm}→${n08.maskShadow.largestComponentKm}, path ${n08.current.pathFound}→${n08.maskShadow.pathFound}`,
        bel &&
          `BELOMOR: comps ${bel.current.componentCount}→${bel.maskShadow.componentCount} (no shared lake mask)`,
        vg &&
          `VG-mid: path ${vg.current.pathFound}→${vg.maskShadow.pathFound} (must stay rejected)`,
      ]
        .filter(Boolean)
        .join(' | '),
      C_n06n08WithoutBrouter: `N06 pathWithoutBrouter=${n06?.pathWithoutBrouter ?? 'n/a'}; N08 pathWithoutBrouter=${n08?.pathWithoutBrouter ?? 'n/a'}. Routes with graph path under MASK_SHADOW: ${withoutBrouter.join(', ') || 'none'}.`,
      D_remainingGap: n06?.residualGap.present
        ? `N06 residual: endpoint=${n06.residualGap.endpoint}; nearestMask A=${n06.residualGap.nearestMaskKmA}km B=${n06.residualGap.nearestMaskKmB}km; inWater A=${n06.residualGap.endpointInOpenWaterA} B=${n06.residualGap.endpointInOpenWaterB}. Need: ${n06.residualGap.additionalDataNeeded.join(', ')}. ${n06.residualGap.note}`
        : n06
          ? 'N06 has no residual gap (path found).'
          : 'N06 not run.',
      E_safetyRegression: corridors.some((c) => c.safetyRegression)
        ? 'YES — unexpected accepted path on negative control'
        : 'NO — VG-mid stays rejected; no Volga↔Akhtuba sew; no safety threshold changes.',
      F_nextStep: withoutBrouter.includes('N08') && !withoutBrouter.includes('N06')
        ? 'Wire densified/shared-lake mask resolve into WaterGraph shadow for Kuibyshev corridors; for N06 investigate shore snap / endpoint-B distance to mask before any production graph-first. Still do not enable USE_WATER_GRAPH.'
        : withoutBrouter.includes('N06') && withoutBrouter.includes('N08')
          ? 'Mask shadow recovers both N06/N08 diagnostically — next: E2E latency compare + production enablement review (still gated).'
          : 'Mask alone insufficient — quantify remaining endpoint/mask gaps before architecture changes; do not add long-distance seams.',
    },
  };
}

export function formatE213MarkdownTable(report: E213SuiteReport): string {
  const header =
    '| route | legacy | CURRENT | MASK_SHADOW | comps before→after | maskNodes | maskEdges | ww↔mask | helped | noBrouter | residual |';
  const sep =
    '| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |';
  const rows = report.table.map((r) => {
    return `| ${r.route} | ${r.legacy} | ${r.currentPath} | ${r.maskPath} | ${r.compsBefore}→${r.compsAfter} | ${r.maskNodes} | ${r.maskEdges} | ${r.wwMaskLinks} | ${r.helped} | ${r.pathWithoutBrouter} | ${r.residual} |`;
  });
  return [header, sep, ...rows].join('\n');
}

/** Test helper: ensure VG-mid never accepts via mask shadow. */
export async function assertVgMidNotSewedByMaskShadow(): Promise<boolean> {
  const row = await runE213Corridor('VG-mid');
  return !row.maskShadow.pathFound && !row.safetyRegression;
}
