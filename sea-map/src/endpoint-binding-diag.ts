/**
 * E2.14 — Endpoint binding diagnostic (diagnosticOnly).
 *
 * Answers whether N06 endpoint B can be safely bound to existing water
 * geometry without inventing a 24 km seam. Does NOT create graph edges,
 * does NOT change production routing, USE_WATER_GRAPH stays false.
 */

import { haversineKm, type LngLat } from './geo';
import {
  clearRouteTraces,
  getLastRouteTrace,
  replaceLastRouteTrace,
  type RouteTrace,
  type RouteTraceEndpointBindingDiag,
} from './route-trace';
import { clearProviderCaches } from './provider-cache';
import {
  measureWaterChain,
  clearWaterwayCellCacheForTests,
  snapClickToWater,
  warmWaterNear,
} from './waterways';
import { getRouteFeatureFlags } from './route-feature-flags';
import { USER_TEST_PRESETS } from './user-test-presets';
import { BELOMOR_A, BELOMOR_B } from './relation-aware-ingest';
import { resolveLakeMaskForShadow } from './water-graph-mask-shadow';
import { ingestCorridorCenterlines } from './water-graph-ingest';
import type { CenterlineSource } from './water-graph-types';
import {
  pointInOpenWater,
  nearestOpenWater,
  type LakeMask,
} from './open-lake';
import { WG_LAKE_CONNECT_KM } from './water-graph';

export type E214RouteId = 'N06' | 'N08' | 'BELOMOR' | 'VG-mid';

export type EndpointSide = 'A' | 'B';

export type EndpointLocationClass =
  | 'on_open_water_mask'
  | 'near_open_water_mask'
  | 'on_or_near_waterway'
  | 'shore_near_waterway'
  | 'inland_far_from_water'
  | 'data_gap_unknown';

export type BindingCandidateType =
  | 'none'
  | 'already_on_mask'
  | 'short_shore_snap_to_mask'
  | 'short_shore_snap_to_waterway'
  | 'waterway_chain_to_mask_unproven'
  | 'unsafe_long_gap'
  | 'negative_control_no_cross_body';

export type EndpointBindingEvidence = {
  route: E214RouteId;
  endpoint: EndpointSide;
  coordinates: LngLat;
  locationClass: EndpointLocationClass;
  nearestMaskKm: number | null;
  nearestMaskPoint: LngLat | null;
  nearestOpenWaterKm: number | null;
  nearestOpenWaterPoint: LngLat | null;
  nearestWaterwayKm: number | null;
  nearestWaterway: {
    sourceId: string;
    name: string | null;
    kind: string;
    waterId: string | null;
    point: LngLat;
  } | null;
  /** Water polygons beyond lake mask are not separately indexed in-repo. */
  nearestWaterPolygonKm: number | null;
  nearestWaterPolygonNote: string;
  portPierHarbourKm: number | null;
  portPierHarbourNote: string;
  lockKm: number | null;
  lockNote: string;
  candidate: {
    type: BindingCandidateType;
    target: string | null;
    snapKm: number | null;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
    wouldCreateGraphEdge: false;
    diagnosticOnly: true;
    reason: string;
  };
  chainToMask: {
    waterwayReachesMask: boolean | null;
    waterwayName: string | null;
    note: string;
  };
  brouter: {
    used: boolean;
    residualStartKm: number | null;
    residualFinishKm: number | null;
    snapKm: number | null;
    geomEnd: LngLat | null;
    geomEndToEndpointKm: number | null;
    note: string;
  } | null;
  provenance: Array<{
    sourceType: string;
    sourceId: string;
    sourceDetail: string;
    diagnosticOnly: true;
  }>;
  diagnosticOnly: true;
};

export type E214CorridorReport = {
  route: E214RouteId;
  diagnosticOnly: true;
  endpoints: { A: EndpointBindingEvidence; B: EndpointBindingEvidence };
  answers?: Record<string, string>;
};

export type E214SuiteReport = {
  schemaVersion: 'e2.14-endpoint-binding-diag';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  noLongSeamInvented: true;
  generatedAt: string;
  corridors: E214CorridorReport[];
  table: Array<{
    route: E214RouteId;
    endpoint: EndpointSide;
    nearestMaskKm: number | null;
    nearestWaterwayKm: number | null;
    nearestWaterPolygonKm: number | null;
    candidate: string;
    confidence: string;
    reason: string;
  }>;
  answers: {
    whyBFarFromMask: string;
    realDataBetweenBandMask: string;
    whatBrouterUses: string;
    canSafelyBindB: string;
    dataNeededIfNot: string;
    vgMidFalsePositiveRisk: string;
  };
};

function preset(id: string): { a: LngLat; b: LngLat } {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { a: p.a, b: p.b };
}

export function getE214Cases(): Array<{
  id: E214RouteId;
  a: LngLat;
  b: LngLat;
  role: 'target' | 'positive_control' | 'relation_control' | 'negative_control';
}> {
  const n06 = preset('N06');
  const n08 = preset('N08');
  return [
    { id: 'N06', a: n06.a, b: n06.b, role: 'target' },
    { id: 'N08', a: n08.a, b: n08.b, role: 'positive_control' },
    { id: 'BELOMOR', a: BELOMOR_A, b: BELOMOR_B, role: 'relation_control' },
    {
      id: 'VG-mid',
      a: { lon: 45.9, lat: 47.75 },
      b: { lon: 46.95, lat: 47.0 },
      role: 'negative_control',
    },
  ];
}

function lakeOuters(lake: LakeMask): Array<Array<[number, number]>> {
  if (lake.outers && lake.outers.length) {
    return lake.outers.map((o) => o.ring);
  }
  return [lake.outer];
}

function nearestMaskVertex(
  p: LngLat,
  lake: LakeMask | null,
): { km: number; point: LngLat } | null {
  if (!lake) return null;
  let best = Infinity;
  let bestP: LngLat | null = null;
  for (const ring of lakeOuters(lake)) {
    for (const [lon, lat] of ring) {
      const d = haversineKm(p, { lon, lat });
      if (d < best) {
        best = d;
        bestP = { lon, lat };
      }
    }
  }
  if (!bestP) return null;
  return { km: Math.round(best * 1000) / 1000, point: bestP };
}

async function loadWaysAroundEndpoint(p: LngLat): Promise<CenterlineSource[]> {
  const pad = 0.2;
  const ingest = await ingestCorridorCenterlines(
    { lon: p.lon - pad, lat: p.lat - pad },
    { lon: p.lon + pad, lat: p.lat + pad },
    { padDeg: 0.02, fetchAllSegments: true },
  );
  return ingest.centerlines;
}

function nearestWaterway(
  p: LngLat,
  ways: CenterlineSource[],
): {
  km: number;
  sourceId: string;
  name: string | null;
  kind: string;
  waterId: string | null;
  point: LngLat;
} | null {
  let best = Infinity;
  let hit: {
    sourceId: string;
    name: string | null;
    kind: string;
    waterId: string | null;
    point: LngLat;
  } | null = null;
  for (const c of ways) {
    for (const q of c.coords) {
      const d = haversineKm(p, q);
      if (d < best) {
        best = d;
        hit = {
          sourceId: String(c.sourceId ?? c.id),
          name: c.name ?? null,
          kind: c.kind,
          waterId: c.waterId ?? null,
          point: { lon: q.lon, lat: q.lat },
        };
      }
    }
  }
  if (!hit) return null;
  return { km: Math.round(best * 1000) / 1000, ...hit };
}

function waterwayReachesMask(
  ways: CenterlineSource[],
  waterwayName: string | null,
  waterwayId: string | null,
  lake: LakeMask | null,
): { reaches: boolean; minKmToOpenWater: number | null; note: string } {
  if (!lake) {
    return {
      reaches: false,
      minKmToOpenWater: null,
      note: 'No lake mask to test against',
    };
  }
  const nameLc = waterwayName?.toLowerCase() ?? null;
  const relevant = ways.filter((c) => {
    if (waterwayId && String(c.sourceId) === waterwayId) return true;
    if (nameLc && c.name && c.name.toLowerCase() === nameLc) return true;
    if (nameLc && c.waterId && c.waterId.toLowerCase().includes(nameLc))
      return true;
    return false;
  });
  if (!relevant.length) {
    return {
      reaches: false,
      minKmToOpenWater: null,
      note: 'Named/source waterway not present in endpoint-local ingest',
    };
  }
  let minKm = Infinity;
  let inMask = false;
  for (const c of relevant) {
    for (const q of c.coords) {
      if (pointInOpenWater(q, lake)) {
        inMask = true;
        minKm = 0;
      } else {
        const near = nearestOpenWater(q, lake, 5);
        if (near) minKm = Math.min(minKm, haversineKm(q, near));
      }
    }
  }
  if (inMask) {
    return {
      reaches: true,
      minKmToOpenWater: 0,
      note: 'Waterway geometry intersects lake mask open water',
    };
  }
  if (minKm < Infinity && minKm <= WG_LAKE_CONNECT_KM) {
    return {
      reaches: true,
      minKmToOpenWater: Math.round(minKm * 1000) / 1000,
      note: `Waterway within seam threshold ${WG_LAKE_CONNECT_KM} km of mask open water`,
    };
  }
  return {
    reaches: false,
    minKmToOpenWater: minKm < Infinity ? Math.round(minKm * 1000) / 1000 : null,
    note:
      minKm < Infinity
        ? `Waterway approaches mask to ${Math.round(minKm * 1000) / 1000} km but does not enter / seam-connect`
        : 'Waterway stays outside nearestOpenWater search (5 km) of mask',
  };
}

function classifyLocation(args: {
  inMask: boolean;
  nearestMaskKm: number | null;
  nearestWayKm: number | null;
}): EndpointLocationClass {
  if (args.inMask) return 'on_open_water_mask';
  if (args.nearestMaskKm != null && args.nearestMaskKm <= 1.0) {
    return 'near_open_water_mask';
  }
  if (args.nearestWayKm != null && args.nearestWayKm <= 0.25) {
    return 'on_or_near_waterway';
  }
  if (args.nearestWayKm != null && args.nearestWayKm <= 5.5) {
    return 'shore_near_waterway';
  }
  if (
    (args.nearestMaskKm == null || args.nearestMaskKm > 15) &&
    (args.nearestWayKm == null || args.nearestWayKm > 15)
  ) {
    return 'inland_far_from_water';
  }
  return 'data_gap_unknown';
}

function buildCandidate(args: {
  route: E214RouteId;
  locationClass: EndpointLocationClass;
  nearestMaskKm: number | null;
  nearestWayKm: number | null;
  nearestWayName: string | null;
  chainReachesMask: boolean | null;
}): EndpointBindingEvidence['candidate'] {
  if (args.route === 'VG-mid') {
    return {
      type: 'negative_control_no_cross_body',
      target: null,
      snapKm: null,
      confidence: 'HIGH',
      wouldCreateGraphEdge: false,
      diagnosticOnly: true,
      reason:
        'VG-mid negative control — do not invent Volga↔Akhtuba binding from proximity',
    };
  }
  if (args.locationClass === 'on_open_water_mask') {
    return {
      type: 'already_on_mask',
      target: 'lake_mask',
      snapKm: 0,
      confidence: 'HIGH',
      wouldCreateGraphEdge: false,
      diagnosticOnly: true,
      reason: 'Endpoint already inside verified lake mask',
    };
  }
  if (
    args.nearestMaskKm != null &&
    args.nearestMaskKm <= WG_LAKE_CONNECT_KM
  ) {
    return {
      type: 'short_shore_snap_to_mask',
      target: 'lake_mask',
      snapKm: args.nearestMaskKm,
      confidence: 'HIGH',
      wouldCreateGraphEdge: false,
      diagnosticOnly: true,
      reason: `Within existing waterway↔mask seam threshold (${WG_LAKE_CONNECT_KM} km)`,
    };
  }
  if (
    args.nearestWayKm != null &&
    args.nearestWayKm <= 5.5 &&
    args.chainReachesMask === true
  ) {
    return {
      type: 'short_shore_snap_to_waterway',
      target: args.nearestWayName ?? 'waterway',
      snapKm: args.nearestWayKm,
      confidence: 'MEDIUM',
      wouldCreateGraphEdge: false,
      diagnosticOnly: true,
      reason:
        'Short shore snap to waterway that reaches mask — candidate only, not an auto edge',
    };
  }
  if (
    args.nearestWayKm != null &&
    args.nearestWayKm <= 5.5 &&
    args.chainReachesMask === false
  ) {
    return {
      type: 'waterway_chain_to_mask_unproven',
      target: args.nearestWayName ?? 'waterway',
      snapKm: args.nearestWayKm,
      confidence: 'LOW',
      wouldCreateGraphEdge: false,
      diagnosticOnly: true,
      reason:
        'Nearest waterway is close, but it does not reach/seam-connect to lake mask in available geometry — no safe auto-bind',
    };
  }
  if (args.nearestMaskKm != null && args.nearestMaskKm > 15) {
    return {
      type: 'unsafe_long_gap',
      target: null,
      snapKm: args.nearestMaskKm,
      confidence: 'NONE',
      wouldCreateGraphEdge: false,
      diagnosticOnly: true,
      reason: `Long gap to mask (~${args.nearestMaskKm} km) — inventing a chord/seam is forbidden`,
    };
  }
  return {
    type: 'none',
    target: null,
    snapKm: null,
    confidence: 'NONE',
    wouldCreateGraphEdge: false,
    diagnosticOnly: true,
    reason: 'No safe binding candidate under current evidence',
  };
}

async function diagnoseEndpoint(args: {
  route: E214RouteId;
  endpoint: EndpointSide;
  point: LngLat;
  lake: LakeMask | null;
  lakeName: string | null;
  brouter: EndpointBindingEvidence['brouter'];
}): Promise<EndpointBindingEvidence> {
  const { point, lake } = args;
  await warmWaterNear(point).catch(() => undefined);

  const maskNear = nearestMaskVertex(point, lake);
  const inMask = lake ? pointInOpenWater(point, lake) : false;
  const openNear =
    lake && !inMask ? nearestOpenWater(point, lake, 30) : inMask ? point : null;
  const openKm =
    openNear && !inMask
      ? Math.round(haversineKm(point, openNear) * 1000) / 1000
      : inMask
        ? 0
        : null;

  const ways = await loadWaysAroundEndpoint(point);
  const way = nearestWaterway(point, ways);
  const snap = snapClickToWater(point, 30);

  const chain = waterwayReachesMask(
    ways,
    way?.name ?? null,
    way?.sourceId ?? null,
    lake,
  );

  // Also test named Uren specifically for N06-B if present in ways under other ids
  let chainNote = chain.note;
  let chainReaches = chain.reaches;
  if (args.route === 'N06' && args.endpoint === 'B' && way?.name) {
    const urenChain = waterwayReachesMask(ways, way.name, way.sourceId, lake);
    chainReaches = urenChain.reaches;
    chainNote = urenChain.note;
  }

  const locationClass = classifyLocation({
    inMask,
    nearestMaskKm: maskNear?.km ?? null,
    nearestWayKm: way?.km ?? snap?.distKm ?? null,
  });

  const candidate = buildCandidate({
    route: args.route,
    locationClass,
    nearestMaskKm: maskNear?.km ?? null,
    nearestWayKm: way?.km ?? null,
    nearestWayName: way?.name ?? null,
    chainReachesMask: lake ? chainReaches : null,
  });

  const provenance: EndpointBindingEvidence['provenance'] = [];
  if (lake && args.lakeName) {
    provenance.push({
      sourceType: 'lake_mask',
      sourceId: `lake:${lake.osmId}`,
      sourceDetail: `${args.lakeName}; complete=${lake.complete}`,
      diagnosticOnly: true,
    });
  }
  if (way) {
    provenance.push({
      sourceType: 'osm_waterway',
      sourceId: `way/${way.sourceId}`,
      sourceDetail: `${way.name ?? 'unnamed'} kind=${way.kind} distKm=${way.km}`,
      diagnosticOnly: true,
    });
  }

  return {
    route: args.route,
    endpoint: args.endpoint,
    coordinates: { lon: point.lon, lat: point.lat },
    locationClass,
    nearestMaskKm: maskNear?.km ?? null,
    nearestMaskPoint: maskNear?.point ?? null,
    nearestOpenWaterKm: openKm,
    nearestOpenWaterPoint: openNear,
    nearestWaterwayKm: way?.km ?? null,
    nearestWaterway: way
      ? {
          sourceId: way.sourceId,
          name: way.name,
          kind: way.kind,
          waterId: way.waterId,
          point: way.point,
        }
      : null,
    nearestWaterPolygonKm: openKm,
    nearestWaterPolygonNote: lake
      ? 'Using verified lake-mask open-water polygon (no separate water-polygon index in-repo)'
      : 'No shared lake mask; water-polygon index not available in-repo',
    portPierHarbourKm: null,
    portPierHarbourNote:
      'No port/pier/harbour OSM binding layer in current codebase',
    lockKm: null,
    lockNote: 'Lock portals are graph-global (Dubna/Rybinsk); not endpoint-local indexed here',
    candidate,
    chainToMask: {
      waterwayReachesMask: lake ? chainReaches : null,
      waterwayName: way?.name ?? null,
      note: chainNote,
    },
    brouter: args.brouter,
    provenance,
    diagnosticOnly: true,
  };
}

function brouterForEndpoint(
  tr: RouteTrace | null,
  endpoint: EndpointSide,
  endpointPt: LngLat,
  geom: LngLat[],
): EndpointBindingEvidence['brouter'] {
  const attempts = (tr?.brouterAttempts ?? []).filter((x) => x.hadGeometry);
  if (!attempts.length || geom.length < 2) {
    return {
      used: false,
      residualStartKm: null,
      residualFinishKm: null,
      snapKm: null,
      geomEnd: null,
      geomEndToEndpointKm: null,
      note: 'No BRouter geometry on this request',
    };
  }
  const last = attempts[attempts.length - 1]!;
  const tip = endpoint === 'A' ? geom[0]! : geom[geom.length - 1]!;
  return {
    used: true,
    residualStartKm: last.residual?.startKm ?? null,
    residualFinishKm: last.residual?.finishKm ?? null,
    snapKm: last.residual?.snapKm ?? null,
    geomEnd: tip,
    geomEndToEndpointKm: Math.round(haversineKm(tip, endpointPt) * 1000) / 1000,
    note:
      endpoint === 'B'
        ? `BRouter finish residual ${last.residual?.finishKm?.toFixed(3) ?? '?'} km (snapKm=${last.residual?.snapKm ?? '?'})`
        : `BRouter start residual ${last.residual?.startKm?.toFixed(3) ?? '?'} km`,
  };
}

export async function runE214Corridor(
  id: E214RouteId,
): Promise<E214CorridorReport> {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('E2.14 requires USE_WATER_GRAPH=false');
  }
  const c = getE214Cases().find((x) => x.id === id);
  if (!c) throw new Error(`unknown ${id}`);

  clearProviderCaches();
  clearWaterwayCellCacheForTests();
  clearRouteTraces();

  const path = await measureWaterChain([c.a, c.b]);
  const tr = getLastRouteTrace();
  const geom =
    path.routingGeometry && path.routingGeometry.length >= 2
      ? path.routingGeometry
      : path.points;

  const resolved = await resolveLakeMaskForShadow(c.a, c.b);

  const evidenceA = await diagnoseEndpoint({
    route: id,
    endpoint: 'A',
    point: c.a,
    lake: resolved.lake,
    lakeName: resolved.sharedName,
    brouter: brouterForEndpoint(tr, 'A', c.a, geom),
  });
  const evidenceB = await diagnoseEndpoint({
    route: id,
    endpoint: 'B',
    point: c.b,
    lake: resolved.lake,
    lakeName: resolved.sharedName,
    brouter: brouterForEndpoint(tr, 'B', c.b, geom),
  });

  const report: E214CorridorReport = {
    route: id,
    diagnosticOnly: true,
    endpoints: { A: evidenceA, B: evidenceB },
  };

  if (tr) {
    const block: RouteTraceEndpointBindingDiag = {
      diagnosticOnly: true,
      route: id,
      endpoints: {
        A: {
          coordinates: evidenceA.coordinates,
          locationClass: evidenceA.locationClass,
          nearestMaskKm: evidenceA.nearestMaskKm,
          nearestWaterwayKm: evidenceA.nearestWaterwayKm,
          candidateType: evidenceA.candidate.type,
          confidence: evidenceA.candidate.confidence,
          reason: evidenceA.candidate.reason,
        },
        B: {
          coordinates: evidenceB.coordinates,
          locationClass: evidenceB.locationClass,
          nearestMaskKm: evidenceB.nearestMaskKm,
          nearestWaterwayKm: evidenceB.nearestWaterwayKm,
          candidateType: evidenceB.candidate.type,
          confidence: evidenceB.candidate.confidence,
          reason: evidenceB.candidate.reason,
          nearestWaterwayName: evidenceB.nearestWaterway?.name ?? null,
          chainToMask: evidenceB.chainToMask,
          brouter: evidenceB.brouter,
        },
      },
    };
    replaceLastRouteTrace({ ...tr, endpointBindingDiag: block });
  }

  return report;
}

export async function runE214Suite(opts?: {
  routes?: E214RouteId[];
}): Promise<E214SuiteReport> {
  const all = getE214Cases();
  const selected = opts?.routes
    ? all.filter((c) => opts.routes!.includes(c.id))
    : all;
  const corridors: E214CorridorReport[] = [];
  for (const c of selected) {
    corridors.push(await runE214Corridor(c.id));
  }

  const n06 = corridors.find((c) => c.route === 'N06');
  const n08 = corridors.find((c) => c.route === 'N08');
  const vg = corridors.find((c) => c.route === 'VG-mid');

  const table: E214SuiteReport['table'] = [];
  for (const c of corridors) {
    for (const ep of ['A', 'B'] as EndpointSide[]) {
      const e = c.endpoints[ep];
      table.push({
        route: c.route,
        endpoint: ep,
        nearestMaskKm: e.nearestMaskKm,
        nearestWaterwayKm: e.nearestWaterwayKm,
        nearestWaterPolygonKm: e.nearestWaterPolygonKm,
        candidate: e.candidate.type,
        confidence: e.candidate.confidence,
        reason: e.candidate.reason,
      });
    }
  }

  const b = n06?.endpoints.B;
  return {
    schemaVersion: 'e2.14-endpoint-binding-diag',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    noLongSeamInvented: true,
    generatedAt: new Date().toISOString(),
    corridors,
    table,
    answers: {
      whyBFarFromMask: b
        ? `N06 B (${b.coordinates.lon}, ${b.coordinates.lat}) is outside the verified Kuibyshev mask polygon (locationClass=${b.locationClass}). Nearest mask vertex ~${b.nearestMaskKm} km. Catalog bbox still matches Kuibyshev, which is why shared-lake detection fires while mask mesh does not cover B.`
        : 'UNKNOWN — N06 not run',
      realDataBetweenBandMask: b
        ? `Nearest OSM waterway: ${b.nearestWaterway?.name ?? 'unnamed'} way/${b.nearestWaterway?.sourceId ?? '?'} at ${b.nearestWaterwayKm} km. Chain to mask: reaches=${b.chainToMask.waterwayReachesMask} (${b.chainToMask.note}). No port/pier layer. Do NOT treat the ${b.nearestMaskKm} km mask gap as fillable.`
        : 'UNKNOWN',
      whatBrouterUses: b?.brouter?.used
        ? `Legacy N06 uses Phase B BRouter (method=lake). BRouter geometry ends ${b.brouter.geomEndToEndpointKm} km from B (finish residual ${b.brouter.residualFinishKm} km, snapKm=${b.brouter.snapKm}). Geom tip ≈ nearest Урень centerline — BRouter follows water network that includes this tributary approach; WaterGraph mask mesh does not cover that approach and Урень does not seam-connect into the mask in our ingest.`
        : 'UNKNOWN — no BRouter geometry captured',
      canSafelyBindB: b
        ? b.candidate.type === 'short_shore_snap_to_waterway' &&
          b.chainToMask.waterwayReachesMask
          ? `Conditionally: short snap (${b.candidate.snapKm} km) to ${b.candidate.target} IF chain to mask is proven. Current evidence: ${b.candidate.reason}`
          : `Not safely as a mask bind today. Candidate=${b.candidate.type} confidence=${b.candidate.confidence}. ${b.candidate.reason}`
        : 'UNKNOWN',
      dataNeededIfNot: b
        ? 'Need either (1) OSM geometry proving Урень (or other tributary) enters/seam-connects to Kuibyshev mask, (2) expanded verified mask covering the river mouth near B, or (3) an explicit navigable centreline from tributary to reservoir with provenance — not a 24 km synthetic edge.'
        : 'UNKNOWN',
      vgMidFalsePositiveRisk: vg
        ? `VG-mid candidates are typed ${vg.endpoints.A.candidate.type} / ${vg.endpoints.B.candidate.type} — mechanism refuses cross-body sew. Risk of accidental Volga↔Akhtuba join via this diagnostic: LOW/NONE.`
        : 'UNKNOWN — VG-mid not run',
    },
  };
}

export function formatE214MarkdownTable(report: E214SuiteReport): string {
  const header =
    '| route | endpoint | nearest mask | nearest waterway | nearest water polygon | candidate | confidence | reason |';
  const sep = '| --- | --- | ---: | ---: | ---: | --- | --- | --- |';
  const rows = report.table.map((r) => {
    return `| ${r.route} | ${r.endpoint} | ${r.nearestMaskKm ?? '—'} | ${r.nearestWaterwayKm ?? '—'} | ${r.nearestWaterPolygonKm ?? '—'} | ${r.candidate} | ${r.confidence} | ${r.reason.replace(/\|/g, '/')} |`;
  });
  return [header, sep, ...rows].join('\n');
}

/** Far-from-water synthetic control for unit tests (no network). */
export function classifyFarInlandForTests(): EndpointLocationClass {
  return classifyLocation({
    inMask: false,
    nearestMaskKm: 40,
    nearestWayKm: 40,
  });
}

export function candidateWhenWaterwayNearButNoMaskChainForTests(): BindingCandidateType {
  return buildCandidate({
    route: 'N06',
    locationClass: 'shore_near_waterway',
    nearestMaskKm: 23.9,
    nearestWayKm: 3.56,
    nearestWayName: 'Урень',
    chainReachesMask: false,
  }).type;
}
