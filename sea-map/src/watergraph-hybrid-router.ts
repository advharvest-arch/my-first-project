/**
 * E2.15 — Hybrid WaterGraph pilot router.
 *
 * When USE_WATER_GRAPH=true:
 *   try WaterGraph (ingest + densified lake mask + relation-aware OSM when
 *   the corridor geographically overlaps known relation geometry) →
 *   existing validateWaterRoute + hydro → if OK return WaterGraph path;
 *   else fall back to legacy Phase A/B/C (BRouter) unchanged.
 *
 * When USE_WATER_GRAPH=false: not used; measureWaterChain stays legacy-only.
 *
 * No route-name special cases (no if N08 / Belomor). No synthetic seams.
 * No snap/validator weakening. No Volga↔Akhtuba sew.
 */

import { haversineKm, type LngLat } from './geo';
import { ingestCorridorCenterlines } from './water-graph-ingest';
import {
  runWaterGraphShadow,
  type WaterGraphShadowResult,
} from './water-graph';
import type { CenterlineSource } from './water-graph-types';
import {
  findSharedOpenLake,
  cachedLakeMaskAlongPath,
  densifyOpenWaterPath,
  isLakeMaskComplete,
  routeAcrossOpenLake,
  type LakeMask,
} from './open-lake';
import {
  belomorRelationAwareCenterlinesForShadow,
  isBelomorShadowCorridor,
} from './relation-aware-shadow';
import type { WaterPath } from './waterways';
import type { WaterGraphFailureStage } from './water-graph-types';

export type HybridSelectedRouter =
  | 'watergraph'
  | 'brouter'
  | 'legacy'
  | 'none';

export type HybridWaterGraphResult =
  | 'ok'
  | 'no_path'
  | 'disconnected'
  | 'safety_reject'
  | 'terminal_unbound'
  | 'insufficient_data'
  | 'error'
  | 'skipped';

export type HybridSafetyResult = 'accepted' | 'rejected' | 'n/a';

/** RouteTrace / report block for hybrid selection. */
export type RouteTraceHybridRouter = {
  routerMode: 'legacy' | 'hybrid_pilot';
  selectedRouter: HybridSelectedRouter;
  waterGraphAttempted: boolean;
  waterGraphResult: HybridWaterGraphResult;
  waterGraphSafetyResult: HybridSafetyResult;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  pathKm: number | null;
  timing: {
    attemptMs: number;
    ingestMs: number;
    maskResolveMs: number;
    buildMs: number;
    searchMs: number;
  };
  centerlineSource: string | null;
  maskSource: string | null;
  failureStage: WaterGraphFailureStage | null;
  note: string;
};

export type HybridAttemptOk = {
  ok: true;
  path: WaterPath;
  diag: RouteTraceHybridRouter;
  shadow: WaterGraphShadowResult;
};

export type HybridAttemptFail = {
  ok: false;
  path: null;
  diag: RouteTraceHybridRouter;
  shadow: WaterGraphShadowResult | null;
};

export type HybridAttemptResult = HybridAttemptOk | HybridAttemptFail;

/** Densified shared-lake mask resolve (same idea as E2.13; no route-name gates). */
async function resolveHybridLakeMask(
  a: LngLat,
  b: LngLat,
): Promise<{
  lake: LakeMask | null;
  sharedName: string | null;
  sharedOsmId: number | null;
  complete: boolean | null;
}> {
  const shared = findSharedOpenLake([a, b]);
  if (!shared) {
    return { lake: null, sharedName: null, sharedOsmId: null, complete: null };
  }
  try {
    await routeAcrossOpenLake([a, b]);
  } catch {
    /* densify may still work */
  }
  const twoPt = cachedLakeMaskAlongPath([a, b]);
  const dens = densifyOpenWaterPath([a, b], 5);
  const densMask = cachedLakeMaskAlongPath(dens);
  const lake = densMask ?? twoPt;
  return {
    lake,
    sharedName: shared.name,
    sharedOsmId: shared.osmId,
    complete: lake ? isLakeMaskComplete(lake) : null,
  };
}

function cumKm(path: LngLat[], waypoints: LngLat[]): number[] {
  if (!path.length) return waypoints.map(() => 0);
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1]! + haversineKm(path[i - 1]!, path[i]!));
  }
  const out: number[] = [];
  let from = 0;
  for (const wp of waypoints) {
    let bestI = from;
    let bestD = Infinity;
    for (let i = from; i < path.length; i++) {
      const d = haversineKm(wp, path[i]!);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    out.push(cum[bestI] ?? 0);
    from = bestI;
  }
  return out;
}

function mapFailureToResult(
  stage: WaterGraphFailureStage | null,
  validated: boolean,
  pathFound: boolean,
): HybridWaterGraphResult {
  if (validated && pathFound) return 'ok';
  switch (stage) {
    case 'graph_disconnected':
      return 'disconnected';
    case 'search_no_path':
      return 'no_path';
    case 'validator_reject':
    case 'hydro_reject':
      return 'safety_reject';
    case 'terminal_unbound':
      return 'terminal_unbound';
    case 'centerline_missing':
    case 'centerline_empty_after_filter':
      return 'insufficient_data';
    default:
      return pathFound ? 'safety_reject' : 'no_path';
  }
}

function fallbackReasonFrom(
  result: HybridWaterGraphResult,
  rejectReason: string | null,
  stage: WaterGraphFailureStage | null,
): string {
  const base = rejectReason || stage || result;
  switch (result) {
    case 'disconnected':
      return `watergraph_disconnected:${base}`;
    case 'no_path':
      return `watergraph_no_path:${base}`;
    case 'safety_reject':
      return `watergraph_safety_reject:${base}`;
    case 'terminal_unbound':
      return `watergraph_terminal_unbound:${base}`;
    case 'insufficient_data':
      return `watergraph_insufficient_data:${base}`;
    case 'error':
      return `watergraph_error:${base}`;
    default:
      return `watergraph_fallback:${base}`;
  }
}

/**
 * Decide selection from a finished shadow result (pure; for unit tests).
 * Never invents edges — only classifies existing shadow outcome.
 */
export function decideHybridFromShadow(args: {
  shadow: Pick<
    WaterGraphShadowResult,
    'pathFound' | 'validated' | 'failureStage' | 'rejectReason' | 'pathLengthKm'
  >;
  attemptMs: number;
  ingestMs: number;
  maskResolveMs: number;
  centerlineSource: string | null;
  maskSource: string | null;
}): {
  accept: boolean;
  diag: Omit<RouteTraceHybridRouter, 'timing'> & {
    timing: RouteTraceHybridRouter['timing'];
  };
} {
  const { shadow } = args;
  const wgResult = mapFailureToResult(
    shadow.failureStage,
    shadow.validated,
    shadow.pathFound,
  );
  const safety: HybridSafetyResult = shadow.validated
    ? 'accepted'
    : shadow.failureStage === 'validator_reject' ||
        shadow.failureStage === 'hydro_reject'
      ? 'rejected'
      : 'n/a';

  if (shadow.pathFound && shadow.validated) {
    return {
      accept: true,
      diag: {
        routerMode: 'hybrid_pilot',
        selectedRouter: 'watergraph',
        waterGraphAttempted: true,
        waterGraphResult: 'ok',
        waterGraphSafetyResult: 'accepted',
        fallbackUsed: false,
        fallbackReason: null,
        pathKm: shadow.pathLengthKm,
        timing: {
          attemptMs: args.attemptMs,
          ingestMs: args.ingestMs,
          maskResolveMs: args.maskResolveMs,
          buildMs: 0,
          searchMs: 0,
        },
        centerlineSource: args.centerlineSource,
        maskSource: args.maskSource,
        failureStage: null,
        note: 'WaterGraph path accepted by existing validator+hydro',
      },
    };
  }

  return {
    accept: false,
    diag: {
      routerMode: 'hybrid_pilot',
      selectedRouter: 'brouter',
      waterGraphAttempted: true,
      waterGraphResult: wgResult,
      waterGraphSafetyResult: safety,
      fallbackUsed: true,
      fallbackReason: fallbackReasonFrom(
        wgResult,
        shadow.rejectReason,
        shadow.failureStage,
      ),
      pathKm: null,
      timing: {
        attemptMs: args.attemptMs,
        ingestMs: args.ingestMs,
        maskResolveMs: args.maskResolveMs,
        buildMs: 0,
        searchMs: 0,
      },
      centerlineSource: args.centerlineSource,
      maskSource: args.maskSource,
      failureStage: shadow.failureStage,
      note: 'WaterGraph unsafe/unavailable — legacy BRouter fallback',
    },
  };
}

/**
 * Gather centerlines for the hybrid attempt (general mechanisms only).
 * Relation-aware OSM snapshot is included when the corridor geographically
 * overlaps the Belomor waterway system — not by route name.
 */
export async function gatherHybridCenterlines(
  a: LngLat,
  b: LngLat,
): Promise<{
  centerlines: CenterlineSource[];
  ingestMs: number;
  centerlineSource: string;
  ingestFailureCode: 'none' | 'centerline_missing' | 'centerline_empty_after_filter';
  ingestStats: Awaited<ReturnType<typeof ingestCorridorCenterlines>>['stats'] | null;
}> {
  const t0 = performance.now();
  const centerlines: CenterlineSource[] = [];
  let centerlineSource = 'empty';
  let ingestFailureCode: 'none' | 'centerline_missing' | 'centerline_empty_after_filter' =
    'none';
  let ingestStats: Awaited<
    ReturnType<typeof ingestCorridorCenterlines>
  >['stats'] | null = null;

  // Geographic relation coverage (OSM relation geometry), not route-name gating.
  if (isBelomorShadowCorridor(a, b)) {
    const rel = belomorRelationAwareCenterlinesForShadow();
    centerlines.push(...rel);
    centerlineSource = 'relation_aware_osm';
  }

  const ingest = await ingestCorridorCenterlines(a, b, {});
  ingestStats = ingest.stats;
  ingestFailureCode = ingest.failureCode;
  if (ingest.centerlines.length) {
    centerlines.push(...ingest.centerlines);
    centerlineSource =
      centerlineSource === 'relation_aware_osm'
        ? 'relation_aware_osm+overpass'
        : ingest.stats.centerlineSource;
  } else if (centerlines.length === 0) {
    ingestFailureCode =
      ingest.failureCode === 'none'
        ? 'centerline_missing'
        : ingest.failureCode;
  }

  return {
    centerlines,
    ingestMs: performance.now() - t0,
    centerlineSource,
    ingestFailureCode,
    ingestStats,
  };
}

function shadowToWaterPath(
  shadow: WaterGraphShadowResult,
  a: LngLat,
  b: LngLat,
): WaterPath {
  const geom = shadow.pathGeometry!;
  const usesMask = (shadow.edgeKinds ?? []).includes('mask');
  const usesWay = (shadow.edgeKinds ?? []).some(
    (k) => k === 'waterway' || k === 'canal' || k === 'fairway',
  );
  const method: WaterPath['method'] =
    usesMask && !usesWay ? 'lake' : 'waterway';
  return {
    points: geom,
    routingGeometry: geom,
    displayGeometry: geom,
    lengthKm: shadow.pathLengthKm,
    waterName: null,
    method,
    waypointCumKm: cumKm(geom, [a, b]),
  };
}

/**
 * Attempt a WaterGraph route for A→B. Does not call BRouter.
 * Caller falls back to legacy measureWaterChain phases on failure.
 */
export async function attemptWaterGraphRoute(
  a: LngLat,
  b: LngLat,
): Promise<HybridAttemptResult> {
  const t0 = performance.now();
  try {
    const gathered = await gatherHybridCenterlines(a, b);
    const tMask0 = performance.now();
    const maskResolved = await resolveHybridLakeMask(a, b);
    const maskResolveMs = performance.now() - tMask0;

    const shadow = runWaterGraphShadow({
      a,
      b,
      legacyLengthKm: 0,
      legacyOk: false,
      centerlines: gathered.centerlines,
      lake: maskResolved.lake,
      lakeComplete: maskResolved.complete ?? false,
      ingest: {
        failureCode: gathered.ingestFailureCode,
        stats: gathered.ingestStats
          ? {
              centerlineSource: gathered.centerlineSource,
              sourceFeatureCount: gathered.ingestStats.sourceFeatureCount,
              sourceWaterwayIds: gathered.ingestStats.sourceWaterwayIds,
              osmFeatureCount: gathered.ingestStats.osmFeatureCount,
              acceptedFeatureCount: gathered.ingestStats.acceptedFeatureCount,
              rejectedFeatureCount: gathered.ingestStats.rejectedFeatureCount,
              rejectionReasons: gathered.ingestStats.rejectionReasons,
              dataTimestampMs: gathered.ingestStats.dataTimestampMs,
              corridorBbox: gathered.ingestStats.corridorBbox,
              ingestMs: gathered.ingestMs,
            }
          : {
              centerlineSource: gathered.centerlineSource,
              sourceFeatureCount: gathered.centerlines.length,
              sourceWaterwayIds: gathered.centerlines
                .map((c) => c.sourceId)
                .filter((x): x is string => !!x)
                .slice(0, 64),
              osmFeatureCount: gathered.centerlines.length,
              acceptedFeatureCount: gathered.centerlines.length,
              rejectedFeatureCount: 0,
              rejectionReasons: {},
              dataTimestampMs: Date.now(),
              corridorBbox: [
                Math.min(a.lon, b.lon),
                Math.min(a.lat, b.lat),
                Math.max(a.lon, b.lon),
                Math.max(a.lat, b.lat),
              ],
              ingestMs: gathered.ingestMs,
            },
      },
    });

    const attemptMs = performance.now() - t0;
    const decision = decideHybridFromShadow({
      shadow,
      attemptMs,
      ingestMs: gathered.ingestMs,
      maskResolveMs,
      centerlineSource: gathered.centerlineSource,
      maskSource: maskResolved.sharedName
        ? `lake:${maskResolved.sharedOsmId ?? '?'}:${maskResolved.sharedName}`
        : null,
    });
    decision.diag.timing.buildMs = shadow.buildMs;
    decision.diag.timing.searchMs = shadow.searchMs;
    decision.diag.timing.attemptMs = attemptMs;

    if (decision.accept && shadow.pathGeometry && shadow.pathGeometry.length >= 2) {
      return {
        ok: true,
        path: shadowToWaterPath(shadow, a, b),
        diag: decision.diag,
        shadow,
      };
    }

    return {
      ok: false,
      path: null,
      diag: decision.diag,
      shadow,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      path: null,
      diag: {
        routerMode: 'hybrid_pilot',
        selectedRouter: 'brouter',
        waterGraphAttempted: true,
        waterGraphResult: 'error',
        waterGraphSafetyResult: 'n/a',
        fallbackUsed: true,
        fallbackReason: `watergraph_error:${msg}`,
        pathKm: null,
        timing: {
          attemptMs: performance.now() - t0,
          ingestMs: 0,
          maskResolveMs: 0,
          buildMs: 0,
          searchMs: 0,
        },
        centerlineSource: null,
        maskSource: null,
        failureStage: null,
        note: `WaterGraph attempt threw — legacy fallback (${msg})`,
      },
      shadow: null,
    };
  }
}

/** Legacy-mode diag when flag is off. */
export function legacyHybridDiag(): RouteTraceHybridRouter {
  return {
    routerMode: 'legacy',
    selectedRouter: 'legacy',
    waterGraphAttempted: false,
    waterGraphResult: 'skipped',
    waterGraphSafetyResult: 'n/a',
    fallbackUsed: false,
    fallbackReason: null,
    pathKm: null,
    timing: {
      attemptMs: 0,
      ingestMs: 0,
      maskResolveMs: 0,
      buildMs: 0,
      searchMs: 0,
    },
    centerlineSource: null,
    maskSource: null,
    failureStage: null,
    note: 'USE_WATER_GRAPH=false — legacy Phase A/B/C only',
  };
}

/** Apply shadow metrics onto RouteTrace.graph (shared with emitDone). */
export function applyShadowToGraphInfo(
  shadow: WaterGraphShadowResult,
  extras?: { centerlineSource?: string; note?: string },
): Record<string, unknown> {
  const comps = shadow.components;
  const timing = shadow.timing;
  const ek = shadow.edgeKindCounts;
  return {
    hybridAvailable: true,
    built: shadow.built,
    nodeCount: shadow.nodeCount,
    edgeCount: shadow.edgeCount,
    layers: shadow.layers,
    componentCount: comps?.connectedComponents,
    largestComponentKm: comps?.largestComponentKm,
    isolatedNodes: comps?.isolatedNodes,
    deadEnds: comps?.deadEnds,
    portalCount: comps?.portalCount,
    lockCount: comps?.lockCount,
    maskNodeCount: comps?.maskNodeCount,
    waterwayNodeCount: comps?.waterwayNodeCount,
    waterwayEdgeCount: ek.waterwayEdgeCount,
    canalEdgeCount: ek.canalEdgeCount,
    maskEdgeCount: ek.maskEdgeCount,
    fairwayEdgeCount: ek.fairwayEdgeCount,
    lockEdgeCount: ek.lockEdgeCount,
    seamCount: ek.seamCount,
    graphBuildMs: shadow.buildMs,
    centerlineMs: timing?.centerlineMs,
    centerlineIngestMs: timing?.centerlineIngestMs,
    maskMs: timing?.maskMs,
    seamMs: timing?.seamMs,
    fairwayMs: timing?.fairwayMs,
    searchMs: shadow.searchMs,
    buildMs: shadow.buildMs,
    totalGraphMs: timing?.totalGraphMs ?? shadow.buildMs + shadow.searchMs,
    pathFound: shadow.pathFound,
    pathLengthKm: shadow.pathLengthKm,
    pathCost: shadow.pathCost,
    edgeKinds: shadow.edgeKinds,
    rejectReason: shadow.rejectReason,
    failureStage: shadow.failureStage,
    terminalA: shadow.terminalA
      ? {
          source: shadow.terminalA.source,
          distKm: shadow.terminalA.distKm,
          nodeId: shadow.terminalA.nodeId,
        }
      : null,
    terminalB: shadow.terminalB
      ? {
          source: shadow.terminalB.source,
          distKm: shadow.terminalB.distKm,
          nodeId: shadow.terminalB.nodeId,
        }
      : null,
    expandedNodes: shadow.expandedNodes,
    legacyCompare: shadow.legacyCompare,
    centerlineSource:
      extras?.centerlineSource ?? shadow.provenance.centerlineSource,
    sourceFeatureCount: shadow.provenance.sourceFeatureCount,
    sourceWaterwayIds: shadow.provenance.sourceWaterwayIds,
    osmFeatureCount: shadow.provenance.osmFeatureCount,
    acceptedFeatureCount: shadow.provenance.acceptedFeatureCount,
    rejectedFeatureCount: shadow.provenance.rejectedFeatureCount,
    rejectionReasons: shadow.provenance.rejectionReasons,
    dataTimestampMs: shadow.provenance.dataTimestampMs,
    corridorBbox: shadow.provenance.corridorBbox,
    provenanceSources: shadow.provenance.sources,
    note:
      extras?.note ??
      'E2.15 Hybrid WaterGraph pilot — selected when validated; else BRouter fallback',
  };
}
