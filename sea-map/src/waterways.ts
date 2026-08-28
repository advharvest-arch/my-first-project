import { closestOnSegment, haversineKm, type LngLat } from './geo';
import { routeWithBrouterAdaptive, routeSpanKm } from './brouter';
import { findSharedOpenLake, routeAcrossOpenLake, straightenOpenWaterSpans, chooseSafeDisplayGeometry, cachedLakeMaskAlongPath, densifyOpenWaterPath, openLakePinsToward, isLakeMaskComplete } from './open-lake';
import { dualGeometry } from './route-geometry';
import { validateWaterRoute } from './validate-water-route';
import { evaluateHydroAcceptGate } from './hydro-gate';
import {
  endpointReachToOriginals,
  maxSnapKmForMethod,
  maxWaterSnapKm,
  maxOpenWaterSnapKm,
  chooseBrouterWaterMethod,
  endpointSnapKmForAccept,
  MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM,
  MAX_SHARED_LAKE_BROUTER_KM,
} from './water-snap';
import {
  PHASE_C_K,
  PHASE_C_MAX_PAIRS,
  PHASE_C_FAIRWAY_SEARCH_KM,
  type WaterCandidate,
  candidateRank,
  diversifyCandidates,
  fairwayPinsNear,
  mergeCandidatePools,
  notePhaseCBrouterTrial,
  offFairwayStemPenalty,
  pairClassPenalty,
  resetPhaseCBrouterTrials,
  getPhaseCBrouterTrials,
  selectPhaseCPairs,
  scoreAcceptedPhaseCRoute,
  sourceClassPenalty,
} from './water-candidates';
import {
  beginRouteTrace,
  candidateToTrace,
  hydroToTrace,
  type RouteTraceBuilder,
} from './route-trace';
import {
  getWaterKnowledgeForRoute,
  toRouteTraceKnowledge,
} from './water-knowledge';
import { getRouteFeatureFlags } from './route-feature-flags';
import { shouldEarlyStopPhaseC } from './phase-c-early-stop';
import {
  beginProviderRequestScope,
  endProviderRequestScope,
} from './provider-cache';
import {
  addPerfMs,
  createRoutePerfCounters,
  getRoutePerf,
  nowPerfMs,
  setRoutePerf,
  timeSync,
} from './route-perf-context';
import {
  LONG_SPAN_TRIGGER_KM,
  runLongSpanSegmentedRoute,
} from './long-span-segment';
import {
  beginFallbackEvent,
  beginFallbackTimeline,
  endFallbackEvent,
  endFallbackTimeline,
  markFallbackEvent,
  nextFallbackParallelGroup,
} from './route-fallback-timeline';
import { runWaterGraphShadow, type CenterlineSource } from './water-graph';
import { ingestCorridorCenterlines } from './water-graph-ingest';
import { mapPool } from './parallel-candidates';

import {
  ensureGvrIndex,
  officialGvrName,
  rememberGvrPair,
  resolveWaterName,
} from './gvr';
import { endpointsStraddleRybinskBarrier } from './routing-rules';
import waterBodies from './water-bodies.json';

export {
  getPhaseCBrouterTrials,
  resetPhaseCBrouterTrials,
  type WaterCandidate,
} from './water-candidates';

export {
  ROUTE_TRACE_SCHEMA_VERSION,
  clearRouteTraces,
  getLastRouteTrace,
  getRouteTraceBuffer,
  setRouteTraceSink,
  type RouteTrace,
} from './route-trace';

export type ItinerarySegment = {
  name: string;
  /** Length of this named stretch along the route geometry, km. */
  km: number;
  /** Код водного объекта в Государственном водном реестре. */
  gvrCode?: string;
  /** true = имя из ГВР (по коду / реестру). */
  fromGvr?: boolean;
};

export type WaterPath = {
  /** Display geometry for the map (may match routingGeometry). */
  points: LngLat[];
  lengthKm: number;
  waterName: string | null;
  method: 'waterway' | 'lake' | 'direct' | 'route_not_found';
  /** Cumulative distance at each input waypoint (km), length = waypoints.length */
  waypointCumKm?: number[];
  /**
   * Itinerary measured on the full BRouter track (not the UI-thinned line).
   * Segment km sum to lengthKm.
   */
  itinerary?: ItinerarySegment[];
  /** Navigable track — GPX and length source when present. */
  routingGeometry?: LngLat[];
  /** Visual line for the map (defaults to points). */
  displayGeometry?: LngLat[];
};

type OverpassElement = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{
    type: string;
    role: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
};

type WaterLine = {
  id: string;
  name: string | null;
  kind: 'waterway' | 'lake';
  coords: LngLat[];
  closed: boolean;
  /** Код ГВР с объекта OSM (`gvr:code`). */
  gvrCode?: string | null;
};

type GraphNode = { id: number; lon: number; lat: number };
type GraphEdge = { a: number; b: number; w: number };

const GRID = 0.0005;
const MERGE_KM = 0.18;
const SNAP_MAX_KM = 12;
const LAKE_CONNECT_KM = 0.45;
const BRIDGE_KM = 0.28;

// Prefer mirrors that reliably return RU waterway geometry (lz4/de).
// Mail.ru / CH often time out or answer empty 200s.
const OVERPASS_ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function keyCell(lon: number, lat: number): string {
  return `${Math.round(lon / GRID)},${Math.round(lat / GRID)}`;
}

async function fetchOneOverpass(endpoint: string, body: string, ms: number): Promise<OverpassElement[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'AquaRoute/1.4 (inland waterways; https://advharvest-arch.github.io)',
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Overpass ${res.status} @ ${endpoint}`);
    const data = JSON.parse(text) as { elements?: OverpassElement[] };
    return data.elements ?? [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Race mirrors; ignore empty 200s (some mirrors answer fast with zero elements).
 * First non-empty wins. If all empty/fail, return [] or throw.
 * Losing mirrors are NOT aborted (existing behaviour) — diag notes that.
 */
async function overpassQuery(
  query: string,
  diag?: {
    queryType: string;
    cell?: string;
    parallelGroup?: string | null;
    parent?: string | null;
  },
): Promise<OverpassElement[]> {
  const body = `data=${encodeURIComponent(query)}`;
  const t0 = nowPerfMs();
  const perf = getRoutePerf();
  if (perf) perf.overpassCalls += 1;
  const evId = beginFallbackEvent('overpass', diag?.queryType ?? 'overpass', {
    parent: diag?.parent ?? null,
    parallelGroup: diag?.parallelGroup ?? null,
    meta: {
      queryType: diag?.queryType ?? 'unknown',
      cell: diag?.cell ?? null,
      mirrorRace: true,
      mirrorCount: OVERPASS_ENDPOINTS.length,
      note: 'losing mirrors not aborted (existing behaviour)',
    },
  });
  try {
    const els = await new Promise<OverpassElement[]>((resolve) => {
      let pending = OVERPASS_ENDPOINTS.length;
      let empty: OverpassElement[] | null = null;
      let done = false;
      const errors: unknown[] = [];

      for (const endpoint of OVERPASS_ENDPOINTS) {
        fetchOneOverpass(endpoint, body, 16000)
          .then((els) => {
            if (done) return;
            if (els.length > 0) {
              done = true;
              resolve(els);
              return;
            }
            empty = els;
            pending -= 1;
            if (pending === 0) resolve(empty ?? []);
          })
          .catch((err) => {
            if (done) return;
            errors.push(err);
            pending -= 1;
            if (pending === 0) {
              if (empty) resolve(empty);
              else resolve([]);
            }
          });
      }
    });
    endFallbackEvent(evId, els.length > 0 ? 'ok_elements' : 'empty', {
      elementCount: els.length,
      cache: 'miss',
    });
    return els;
  } catch (err) {
    endFallbackEvent(evId, 'error', {
      error: err instanceof Error ? err.message : 'error',
      cache: 'miss',
    });
    throw err;
  } finally {
    addPerfMs('overpassMs', nowPerfMs() - t0);
  }
}

function isWaterArea(tags: Record<string, string> | undefined): boolean {
  if (!tags) return false;
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return true;
  if (tags.natural === 'water') return true;
  if (tags.water === 'lake' || tags.water === 'reservoir' || tags.water === 'basin') return true;
  return false;
}

function isNavigableWaterway(tags: Record<string, string> | undefined): boolean {
  if (!tags?.waterway) return false;
  const w = tags.waterway;
  if (w === 'riverbank' || w === 'weir' || w === 'dam' || w === 'waterfall') return false;
  return (
    w === 'river' ||
    w === 'canal' ||
    w === 'fairway' ||
    w === 'ship_canal' ||
    w === 'tidal_channel' ||
    w === 'link' ||
    w === 'stream' ||
    tags.boat === 'yes' ||
    tags.motorboat === 'yes' ||
    Boolean(tags.CEMT)
  );
}

function linesFromElements(elements: OverpassElement[]): WaterLine[] {
  const lines: WaterLine[] = [];
  for (const el of elements) {
    const rawName = el.tags?.['name:ru'] ?? el.tags?.name ?? null;
    const gvrCode = el.tags?.['gvr:code']?.trim() || null;
    if (gvrCode && rawName) rememberGvrPair(gvrCode, rawName);
    const gvr = officialGvrName(rawName, gvrCode);
    const name = gvr?.name ?? rawName;
    const area = isWaterArea(el.tags);
    const waterway = isNavigableWaterway(el.tags) || el.tags?.type === 'waterway';

    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      if (!area && !waterway) continue;
      const coords = el.geometry.map((g) => ({ lon: g.lon, lat: g.lat }));
      const closed =
        area ||
        (coords.length > 3 &&
          Math.abs(coords[0]!.lon - coords[coords.length - 1]!.lon) < 1e-7 &&
          Math.abs(coords[0]!.lat - coords[coords.length - 1]!.lat) < 1e-7);
      lines.push({
        id: `w${el.id}`,
        name,
        kind: area || closed ? 'lake' : 'waterway',
        coords,
        closed,
        gvrCode: gvr?.gvrCode ?? gvrCode,
      });
    }

    if (el.type === 'relation' && el.members && (area || waterway)) {
      for (const [mi, m] of el.members.entries()) {
        if (!m.geometry || m.geometry.length < 2) continue;
        if (area && m.role && m.role !== 'outer' && m.role !== '') continue;
        const coords = m.geometry.map((g) => ({ lon: g.lon, lat: g.lat }));
        lines.push({
          id: `r${el.id}-${mi}`,
          name,
          kind: area ? 'lake' : 'waterway',
          coords,
          closed: Boolean(area),
          gvrCode: gvr?.gvrCode ?? gvrCode,
        });
      }
    }
  }
  return lines;
}

function buildGraph(lines: WaterLine[]): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  lineNodeIds: Map<string, number[]>;
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const cellIndex = new Map<string, number[]>();
  const lineNodeIds = new Map<string, number[]>();

  const findNearby = (p: LngLat): number | null => {
    const cx = Math.round(p.lon / GRID);
    const cy = Math.round(p.lat / GRID);
    let bestId: number | null = null;
    let bestD = MERGE_KM;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const ids = cellIndex.get(`${cx + dx},${cy + dy}`);
        if (!ids) continue;
        for (const id of ids) {
          const d = haversineKm(p, nodes[id]!);
          if (d < bestD) {
            bestD = d;
            bestId = id;
          }
        }
      }
    }
    return bestId;
  };

  const ensure = (p: LngLat): number => {
    const existing = findNearby(p);
    if (existing != null) return existing;
    const id = nodes.length;
    nodes.push({ id, lon: p.lon, lat: p.lat });
    const k = keyCell(p.lon, p.lat);
    const bucket = cellIndex.get(k);
    if (bucket) bucket.push(id);
    else cellIndex.set(k, [id]);
    return id;
  };

  const link = (a: number, b: number) => {
    if (a === b) return;
    const w = haversineKm(nodes[a]!, nodes[b]!);
    if (w <= 0 || w > 80) return;
    edges.push({ a, b, w });
    edges.push({ a: b, b: a, w });
  };

  for (const line of lines) {
    const ids: number[] = [];
    const step =
      line.kind === 'lake' && line.coords.length > 120
        ? Math.ceil(line.coords.length / 120)
        : 1;
    for (let i = 0; i < line.coords.length; i += step) ids.push(ensure(line.coords[i]!));
    const last = ensure(line.coords[line.coords.length - 1]!);
    if (ids[ids.length - 1] !== last) ids.push(last);

    for (let i = 1; i < ids.length; i++) link(ids[i - 1]!, ids[i]!);
    if (line.closed && ids.length > 2) link(ids[ids.length - 1]!, ids[0]!);

    if (line.kind === 'lake' && ids.length >= 3) {
      let sx = 0;
      let sy = 0;
      for (const id of ids) {
        sx += nodes[id]!.lon;
        sy += nodes[id]!.lat;
      }
      const cid = ensure({ lon: sx / ids.length, lat: sy / ids.length });
      for (const id of ids) link(cid, id);
    }

    lineNodeIds.set(line.id, ids);
  }

  // Connect river ends to nearby lakes
  for (const line of lines) {
    if (line.kind !== 'waterway') continue;
    const ids = lineNodeIds.get(line.id);
    if (!ids?.length) continue;
    for (const eid of [ids[0]!, ids[ids.length - 1]!]) {
      const p = nodes[eid]!;
      for (const lake of lines) {
        if (lake.kind !== 'lake') continue;
        const lids = lineNodeIds.get(lake.id);
        if (!lids) continue;
        let best: number | null = null;
        let bestD = LAKE_CONNECT_KM;
        for (const id of lids) {
          const d = haversineKm(p, nodes[id]!);
          if (d < bestD) {
            bestD = d;
            best = id;
          }
        }
        if (best != null) link(eid, best);
      }
    }
  }

  // Bridge tiny gaps between any nearby nodes (broken OSM way joins).
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]!;
    const cx = Math.round(a.lon / GRID);
    const cy = Math.round(a.lat / GRID);
    for (let dx = -2; dx <= 2; dx++) {
      for (let dy = -2; dy <= 2; dy++) {
        const ids = cellIndex.get(`${cx + dx},${cy + dy}`);
        if (!ids) continue;
        for (const j of ids) {
          if (j <= i) continue;
          const d = haversineKm(a, nodes[j]!);
          if (d > 0 && d <= BRIDGE_KM) link(i, j);
        }
      }
    }
  }

  // Join same-named waterways at closest approach (up to 1.2 km).
  const byName = new Map<string, WaterLine[]>();
  for (const line of lines) {
    if (!line.name || line.kind !== 'waterway') continue;
    const key = line.name.toLocaleLowerCase('ru');
    const arr = byName.get(key) ?? [];
    arr.push(line);
    byName.set(key, arr);
  }
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const ia = lineNodeIds.get(group[i]!.id);
        const ib = lineNodeIds.get(group[j]!.id);
        if (!ia?.length || !ib?.length) continue;
        let bestA = ia[0]!;
        let bestB = ib[0]!;
        let bestD = 1.2;
        for (const a of ia) {
          for (const b of ib) {
            const d = haversineKm(nodes[a]!, nodes[b]!);
            if (d < bestD) {
              bestD = d;
              bestA = a;
              bestB = b;
            }
          }
        }
        if (bestD < 1.2) link(bestA, bestB);
      }
    }
  }

  return { nodes, edges, lineNodeIds };
}

function snapToNetwork(
  p: LngLat,
  lines: WaterLine[],
  nodes: GraphNode[],
  edges: GraphEdge[],
  lineNodeIds: Map<string, number[]>,
  maxKm: number,
): { nodeId: number; point: LngLat; distKm: number; line: WaterLine } | null {
  let bestWay: {
    point: LngLat;
    distKm: number;
    a: LngLat;
    b: LngLat;
    line: WaterLine;
  } | null = null;
  let bestLake: {
    point: LngLat;
    distKm: number;
    a: LngLat;
    b: LngLat;
    line: WaterLine;
  } | null = null;

  for (const line of lines) {
    for (let i = 1; i < line.coords.length; i++) {
      const a = line.coords[i - 1]!;
      const b = line.coords[i]!;
      const c = closestOnSegment(p, a, b);
      if (line.kind === 'lake') {
        if (!bestLake || c.distKm < bestLake.distKm) {
          bestLake = { point: c.point, distKm: c.distKm, a, b, line };
        }
      } else if (!bestWay || c.distKm < bestWay.distKm) {
        bestWay = { point: c.point, distKm: c.distKm, a, b, line };
      }
    }
  }

  let best: typeof bestWay = null;
  // Prefer a nearby river/canal; lakes only if clearly closer or no river nearby.
  if (bestWay && bestWay.distKm <= Math.min(maxKm, 3)) best = bestWay;
  else if (bestLake && bestLake.distKm <= maxKm) best = bestLake;
  else if (bestWay && bestWay.distKm <= maxKm) best = bestWay;
  if (!best) return null;

  const nodeId = nodes.length;
  nodes.push({ id: nodeId, lon: best.point.lon, lat: best.point.lat });

  const attachTo = (candidateIds: number[] | undefined, limitKm: number) => {
    if (!candidateIds?.length) return false;
    let id = -1;
    let d = limitKm;
    for (const nid of candidateIds) {
      const dd = haversineKm(best.point, nodes[nid]!);
      if (dd < d) {
        d = dd;
        id = nid;
      }
    }
    if (id < 0) return false;
    const w = Math.max(haversineKm(nodes[nodeId]!, nodes[id]!), 0.001);
    edges.push({ a: nodeId, b: id, w });
    edges.push({ a: id, b: nodeId, w });
    return true;
  };

  const lineIds = lineNodeIds.get(best.line.id);
  const attached =
    attachTo(lineIds, best.line.kind === 'lake' ? 4 : 1.5) ||
    attachTo(
      nodes.map((n) => n.id).filter((id) => id !== nodeId),
      best.line.kind === 'lake' ? 4 : 0.8,
    );

  if (!attached) {
    // Still keep the node; dijkstra may fail but along-line fallback can use geometry.
  }

  return { nodeId, point: best.point, distKm: best.distKm, line: best.line };
}

function pathAlongLine(line: WaterLine, from: LngLat, to: LngLat, minKm = 0.02): LngLat[] {
  const coords = line.coords;
  if (coords.length < 2) return [from, to];
  let i0 = 0;
  let i1 = 0;
  let d0 = Infinity;
  let d1 = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const da = haversineKm(from, coords[i]!);
    const db = haversineKm(to, coords[i]!);
    if (da < d0) {
      d0 = da;
      i0 = i;
    }
    if (db < d1) {
      d1 = db;
      i1 = i;
    }
  }
  const slice =
    i0 <= i1 ? coords.slice(i0, i1 + 1) : coords.slice(i1, i0 + 1).reverse();
  return simplifyPath([from, ...slice, to], minKm);
}

/**
 * Closest waterway centerline hit (rivers/canals only — lakes stay open-water routed).
 * Also returns the vertex index on the line for ordered meander inserts.
 */
function nearestWaterwayHit(
  p: LngLat,
  lines: WaterLine[],
  maxKm: number,
): { line: WaterLine; point: LngLat; distKm: number; idx: number } | null {
  let best: { line: WaterLine; point: LngLat; distKm: number; idx: number } | null = null;
  for (const line of lines) {
    if (line.kind !== 'waterway' || line.coords.length < 2) continue;
    const stride = Math.max(1, Math.floor(line.coords.length / 120));
    for (let j = stride; j < line.coords.length; j += stride) {
      const c = closestOnSegment(p, line.coords[j - stride]!, line.coords[j]!);
      if (c.distKm > maxKm) continue;
      if (!best || c.distKm < best.distKm) {
        const idx = c.t < 0.5 ? j - stride : j;
        best = { line, point: c.point, distKm: c.distKm, idx };
      }
    }
  }
  return best;
}

function linesNearPath(points: LngLat[], padDeg = 0.03): WaterLine[] {
  const cells = new Set<string>();
  for (const p of densifyPoints(points, 4)) {
    const { cx, cy } = pointCell(p);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        cells.add(cellKey(cx + dx, cy + dy));
      }
    }
  }
  if (padDeg > CELL_DEG) {
    let w = 180,
      s = 90,
      e = -180,
      n = -90;
    for (const p of points) {
      w = Math.min(w, p.lon);
      s = Math.min(s, p.lat);
      e = Math.max(e, p.lon);
      n = Math.max(n, p.lat);
    }
    const cx0 = Math.floor((w - padDeg) / CELL_DEG);
    const cx1 = Math.floor((e + padDeg) / CELL_DEG);
    const cy0 = Math.floor((s - padDeg) / CELL_DEG);
    const cy1 = Math.floor((n + padDeg) / CELL_DEG);
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cy = cy0; cy <= cy1; cy++) cells.add(cellKey(cx, cy));
    }
  }
  return mergeLines([...cells].map((id) => cellCache.get(id) ?? []).filter((g) => g.length > 0));
}

function isOpenWaterCatalogPoint(p: LngLat): boolean {
  return CATALOG.some((b) => b.k === 'l' && pointInCatalog(p, b));
}

/**
 * Keep every BRouter vertex (already on water) and insert extra OSM centerline
 * vertices wherever the track skips river bends between two samples.
 */
function refineTrackToRiverCenterlines(points: LngLat[]): LngLat[] {
  if (points.length < 3) return points;
  const allLines = linesNearPath(points, 0.04).filter((l) => l.kind === 'waterway');
  if (allLines.length < 1) return points;

  const out: LngLat[] = [{ ...points[0]! }];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const cur = points[i]!;

    if (!isOpenWaterCatalogPoint(prev) && !isOpenWaterCatalogPoint(cur)) {
      const a = nearestWaterwayHit(prev, allLines, 0.55);
      const b = nearestWaterwayHit(cur, allLines, 0.55);
      if (a && b && a.distKm <= 0.4 && b.distKm <= 0.4) {
        if (a.line.id === b.line.id && a.idx !== b.idx) {
          const coords = a.line.coords;
          const lo = Math.min(a.idx, b.idx);
          const hi = Math.max(a.idx, b.idx);
          if (hi - lo >= 2) {
            let alongKm = 0;
            for (let k = lo + 1; k <= hi; k++) {
              alongKm += haversineKm(coords[k - 1]!, coords[k]!);
            }
            const chord = haversineKm(prev, cur);
            // Reject wrong-direction wraps on a long OSM way.
            if (alongKm <= Math.max(chord * 2.2, chord + 1.2) && alongKm >= chord * 0.9) {
              const forward = a.idx <= b.idx;
              if (forward) {
                for (let k = lo + 1; k < hi; k++) {
                  const p = coords[k]!;
                  const last = out[out.length - 1]!;
                  if (haversineKm(last, p) > 0.006 && haversineKm(p, cur) > 0.006) {
                    out.push({ ...p });
                  }
                }
              } else {
                for (let k = hi - 1; k > lo; k--) {
                  const p = coords[k]!;
                  const last = out[out.length - 1]!;
                  if (haversineKm(last, p) > 0.006 && haversineKm(p, cur) > 0.006) {
                    out.push({ ...p });
                  }
                }
              }
            }
          }
        } else if (
          haversineKm(prev, cur) >= 0.15 &&
          a.line.name &&
          b.line.name &&
          a.line.name.toLocaleLowerCase('ru') === b.line.name.toLocaleLowerCase('ru')
        ) {
          const corridor = linesNearPath([prev, cur], 0.03).filter((l) => l.kind === 'waterway');
          const nameKey = a.line.name.toLocaleLowerCase('ru');
          const named = corridor.filter(
            (l) =>
              l.id === a.line.id ||
              l.id === b.line.id ||
              (l.name != null && l.name.toLocaleLowerCase('ru') === nameKey),
          );
          const pool = (named.length ? named : corridor).slice(0, 60);
          if (pool.length) {
            const leg = routeOnLines(a.point, b.point, pool);
            const chord = haversineKm(prev, cur);
            if (
              leg.method === 'waterway' &&
              leg.points.length >= 4 &&
              leg.lengthKm >= chord * 1.05 &&
              leg.lengthKm <= Math.min(chord * 1.85, chord + 1.8)
            ) {
              for (let k = 1; k < leg.points.length - 1; k++) {
                const p = leg.points[k]!;
                const last = out[out.length - 1]!;
                if (haversineKm(last, p) > 0.006 && haversineKm(p, cur) > 0.006) {
                  out.push({ ...p });
                }
              }
            }
          }
        }
      }
    }

    // Always keep the original track vertex.
    const last = out[out.length - 1]!;
    if (haversineKm(last, cur) > 0.003) out.push({ ...cur });
  }

  return out.length >= 2 ? out : points;
}

/** Meander polish from whatever is already in cell cache (no Overpass wait). */
function refineRouteGeometryFast(points: LngLat[]): LngLat[] {
  if (points.length < 3) return points;
  return refineTrackToRiverCenterlines(points);
}

/**
 * Background polish: fetch OSM around the track, then re-apply centerline bends.
 * Used after the BRouter path is already on screen.
 */
async function refineRouteGeometryDeep(points: LngLat[]): Promise<LngLat[]> {
  if (points.length < 3) return points;
  try {
    await fetchWaterNetwork(
      sampleAlongPath(points, Math.min(16, Math.max(4, Math.ceil(pathLength(points) / 10)))),
      { forceRefresh: false },
    );
    await enrichNamedWaterwaysForItinerary(points);
  } catch {
    // Keep cache-only refine.
  }
  return refineTrackToRiverCenterlines(points);
}

function dijkstra(start: number, goal: number, nodeCount: number, edges: GraphEdge[]): number[] | null {
  const adj: Array<Array<{ to: number; w: number }>> = Array.from({ length: nodeCount }, () => []);
  for (const e of edges) adj[e.a]!.push({ to: e.b, w: e.w });

  const dist = new Float64Array(nodeCount).fill(Infinity);
  const prev = new Int32Array(nodeCount).fill(-1);
  const used = new Uint8Array(nodeCount);
  dist[start] = 0;

  const heap: number[] = [];
  const less = (i: number, j: number) => dist[heap[i]!]! < dist[heap[j]!]!;
  const swap = (i: number, j: number) => {
    const t = heap[i]!;
    heap[i] = heap[j]!;
    heap[j] = t;
  };
  const push = (x: number) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(i, p)) break;
      swap(i, p);
      i = p;
    }
  };
  const pop = (): number | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        let sm = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < heap.length && less(l, sm)) sm = l;
        if (r < heap.length && less(r, sm)) sm = r;
        if (sm === i) break;
        swap(i, sm);
        i = sm;
      }
    }
    return top;
  };

  push(start);
  while (heap.length) {
    const u = pop()!;
    if (used[u]) continue;
    used[u] = 1;
    if (u === goal) break;
    for (const { to, w } of adj[u]!) {
      const nd = dist[u]! + w;
      if (nd < dist[to]!) {
        dist[to] = nd;
        prev[to] = u;
        push(to);
      }
    }
  }

  if (!Number.isFinite(dist[goal]!)) return null;
  const path: number[] = [];
  for (let cur = goal; cur !== -1; cur = prev[cur]!) path.push(cur);
  path.reverse();
  return path;
}

function pathLength(points: LngLat[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1]!, points[i]!);
  return sum;
}

function simplifyPath(points: LngLat[], minKm = 0.04): LngLat[] {
  if (points.length <= 2) return points;
  const out: LngLat[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    if (haversineKm(out[out.length - 1]!, points[i]!) >= minKm) out.push(points[i]!);
  }
  out.push(points[points.length - 1]!);
  return out;
}

/** Perpendicular distance from P to segment AB, km (equirectangular local). */
function perpDistKm(p: LngLat, a: LngLat, b: LngLat): number {
  const cosLat = Math.max(0.2, Math.cos(((a.lat + b.lat) / 2) * (Math.PI / 180)));
  const bx = (b.lon - a.lon) * 111.32 * cosLat;
  const by = (b.lat - a.lat) * 110.54;
  const px = (p.lon - a.lon) * 111.32 * cosLat;
  const py = (p.lat - a.lat) * 110.54;
  const denom = bx * bx + by * by;
  if (denom < 1e-8) return Math.hypot(px, py);
  let t = (px * bx + py * by) / denom;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - t * bx, py - t * by);
}

/** Min distance from point to a polyline, km. */
function distToPolylineKm(p: LngLat, line: LngLat[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, perpDistKm(p, line[i - 1]!, line[i]!));
  }
  return best;
}

/** Index of nearest vertex on a polyline. */
function nearestVertexIdx(p: LngLat, line: LngLat[]): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = haversineKm(p, line[i]!);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Chord is on water only if:
 * 1) every sample stays within maxDevKm of the navigable track, AND
 * 2) along-track length is not much longer than the chord (no peninsula cut).
 * Dist-to-polyline alone is NOT enough — a chord across Цимлянское land
 * can still sit "near" the shoreline bend.
 */
function segmentFollowsWater(
  a: LngLat,
  b: LngLat,
  waterPath: LngLat[],
  maxDevKm: number,
): boolean {
  const geo = haversineKm(a, b);
  if (geo < 0.25) return true;
  if (waterPath.length < 2) return false;

  const ia = nearestVertexIdx(a, waterPath);
  const ib = nearestVertexIdx(b, waterPath);
  if (ia !== ib) {
    const lo = Math.min(ia, ib);
    const hi = Math.max(ia, ib);
    const along = pathLength(waterPath.slice(lo, hi + 1));
    // Hard land ban: cutting a bend / peninsula.
    if (along > geo * 1.08 + 0.35) return false;
  }

  const samples = Math.max(4, Math.ceil(geo / 1.5));
  for (let k = 1; k < samples; k++) {
    const t = k / samples;
    const p = {
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    };
    if (distToPolylineKm(p, waterPath) > maxDevKm) return false;
  }
  return true;
}

/**
 * Hard ban on land: any candidate edge that leaves the water track is replaced
 * by the original navigable vertices between its ends.
 */
function forbidLandCuts(candidate: LngLat[], waterRef: LngLat[], maxDevKm = 0.35): LngLat[] {
  if (candidate.length < 2 || waterRef.length < 2) return candidate;
  const out: LngLat[] = [candidate[0]!];
  for (let i = 1; i < candidate.length; i++) {
    const a = out[out.length - 1]!;
    const b = candidate[i]!;
    if (segmentFollowsWater(a, b, waterRef, maxDevKm)) {
      out.push(b);
      continue;
    }
    const ia = nearestVertexIdx(a, waterRef);
    const ib = nearestVertexIdx(b, waterRef);
    if (ia === ib) {
      out.push(b);
      continue;
    }
    const slice =
      ia < ib ? waterRef.slice(ia, ib + 1) : waterRef.slice(ib, ia + 1).reverse();
    // Skip first (≈ a); keep water vertices; ensure b is last.
    for (let k = 1; k < slice.length; k++) {
      const p = slice[k]!;
      if (haversineKm(out[out.length - 1]!, p) < 0.02) continue;
      out.push(p);
    }
    if (haversineKm(out[out.length - 1]!, b) > 0.05) out.push(b);
  }
  return out;
}

/** Keep Leaflet / parallel / arrows responsive without inventing land chords. */
function downsampleOnWater(points: LngLat[], maxPoints: number, maxDevKm = 0.35): LngLat[] {
  if (points.length <= maxPoints) return points;
  // Target spacing from length, then refuse any land-cutting skip.
  const total = pathLength(points);
  const targetKm = Math.max(0.12, total / (maxPoints - 1));
  const out: LngLat[] = [points[0]!];
  let anchor = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const last = out[out.length - 1]!;
    if (haversineKm(last, points[i]!) < targetKm) continue;
    const slice = points.slice(anchor, i + 1);
    if (segmentFollowsWater(last, points[i]!, slice, maxDevKm)) {
      out.push(points[i]!);
      anchor = i;
    } else {
      // Must keep the previous vertex so the edge stays on water.
      const keep = Math.max(anchor + 1, i - 1);
      if (keep > anchor) {
        out.push(points[keep]!);
        anchor = keep;
      }
      if (i > anchor && haversineKm(out[out.length - 1]!, points[i]!) >= targetKm * 0.5) {
        out.push(points[i]!);
        anchor = i;
      }
    }
  }
  out.push(points[points.length - 1]!);
  if (out.length <= maxPoints) return out;
  // Still too dense: raise spacing once more under the same land ban.
  return forbidLandCuts(
    (() => {
      const step = Math.ceil(out.length / maxPoints);
      const thin: LngLat[] = [out[0]!];
      for (let i = step; i < out.length - 1; i += step) thin.push(out[i]!);
      thin.push(out[out.length - 1]!);
      return thin;
    })(),
    points,
    maxDevKm,
  );
}

/** Intermediate points along a path */
function densifyPoints(points: LngLat[], stepKm: number): LngLat[] {
  if (points.length < 2) return points;
  const out: LngLat[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = haversineKm(a, b);
    const n = Math.max(1, Math.ceil(d / stepKm));
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
      });
    }
  }
  return out;
}

/** ~22 km cells — reuse between nearby routes */
const CELL_DEG = 0.2;
const cellCache = new Map<string, WaterLine[]>();
const EMPTY_CELL_TTL_MS = 45_000;
const emptyCellUntil = new Map<string, number>();
const cellInflight = new Map<string, Promise<WaterLine[]>>();

type CoreLine = { id: string; n: string | null; k: 'w' | 'l'; c: Array<[number, number]> };

let coreSeedPromise: Promise<void> | null = null;

/** Load water-core as a separate asset so the map boot chunk stays small. */
export function ensureCoreWaterways(): Promise<void> {
  if (coreSeedPromise) return coreSeedPromise;
  coreSeedPromise = (async () => {
    await ensureGvrIndex();
    const res = await fetch(new URL('./water-core.json', import.meta.url));
    if (!res.ok) return;
    const raw = (await res.json()) as CoreLine[];
    const lines: WaterLine[] = raw.map((row) => {
      const gvr = officialGvrName(row.n);
      return {
        id: row.id,
        name: gvr?.name ?? row.n,
        kind: row.k === 'l' ? 'lake' : 'waterway',
        coords: row.c.map(([lon, lat]) => ({ lon, lat })),
        closed: row.k === 'l' && row.c.length > 3,
        gvrCode: gvr?.gvrCode ?? null,
      };
    });
    rememberLinesInCells(lines);
  })().catch(() => {
    /* Overpass/BRouter still work without the seed. */
  });
  return coreSeedPromise;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function pointCell(p: LngLat): { cx: number; cy: number } {
  return { cx: Math.floor(p.lon / CELL_DEG), cy: Math.floor(p.lat / CELL_DEG) };
}

function cellsAlong(points: LngLat[]): Array<{ cx: number; cy: number }> {
  const seen = new Set<string>();
  const out: Array<{ cx: number; cy: number }> = [];
  for (const p of densifyPoints(points, 10)) {
    const { cx, cy } = pointCell(p);
    const k = cellKey(cx, cy);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ cx, cy });
  }
  return out;
}

function sampleAlongPath(points: LngLat[], count: number): LngLat[] {
  if (points.length === 0) return [];
  if (count <= 1 || points.length === 1) return [points[0]!];
  const densified = densifyPoints(points, 0.5);
  if (densified.length <= count) return densified;
  const out: LngLat[] = [];
  const step = (densified.length - 1) / (count - 1);
  for (let i = 0; i < count; i++) out.push(densified[Math.round(i * step)]!);
  return out;
}

/** Compact around-query for a route corridor (one request). */
function aroundWaterQuery(points: LngLat[]): string {
  const span = pathLength(points);
  const sampleCount = Math.min(10, Math.max(2, Math.ceil(span / 5) + 1));
  const gapKm = span / Math.max(1, sampleCount - 1);
  const radius = Math.min(4500, Math.max(1500, Math.ceil(gapKm * 1000 * 0.7)));
  const blocks = sampleAlongPath(points, sampleCount)
    .map((p) => {
      const { lat, lon } = p;
      return `
  way(around:${radius},${lat},${lon})["waterway"~"^(river|canal|fairway|ship_canal|link)$"];
  way(around:${radius},${lat},${lon})["waterway"="stream"]["name"];
  way(around:${radius},${lat},${lon})["landuse"="reservoir"];
  way(around:${radius},${lat},${lon})["natural"="water"]["water"~"^(lake|reservoir|basin)$"];
  way(around:${radius},${lat},${lon})["natural"="water"]["name"];`;
    })
    .join('\n');

  return `
[out:json][timeout:12];
(
${blocks}
);
out geom;
`;
}

function cellBboxQuery(cx: number, cy: number): string {
  const pad = 0.015;
  const w = cx * CELL_DEG - pad;
  const s = cy * CELL_DEG - pad;
  const e = (cx + 1) * CELL_DEG + pad;
  const n = (cy + 1) * CELL_DEG + pad;
  return `
[out:json][timeout:10];
(
  way["waterway"~"^(river|canal|fairway|ship_canal|link)$"](${s},${w},${n},${e});
  way["waterway"="stream"]["name"](${s},${w},${n},${e});
  way["landuse"="reservoir"](${s},${w},${n},${e});
  way["natural"="water"]["water"~"^(lake|reservoir|basin)$"](${s},${w},${n},${e});
  way["natural"="water"]["name"](${s},${w},${n},${e});
);
out geom;
`;
}

function rememberLinesInCells(lines: WaterLine[]): void {
  if (!lines.length) return;
  const byCell = new Map<string, WaterLine[]>();
  for (const line of lines) {
    const cells = new Set<string>();
    for (const p of line.coords) {
      const { cx, cy } = pointCell(p);
      cells.add(cellKey(cx, cy));
    }
    for (const id of cells) {
      const arr = byCell.get(id) ?? [];
      arr.push(line);
      byCell.set(id, arr);
    }
  }
  for (const [id, group] of byCell) {
    const prev = cellCache.get(id) ?? [];
    const seen = new Set(prev.map((l) => l.id));
    const merged = prev.slice();
    for (const l of group) {
      if (seen.has(l.id)) continue;
      seen.add(l.id);
      merged.push(l);
    }
    cellCache.set(id, merged);
  }
  while (cellCache.size > 700) {
    const first = cellCache.keys().next().value;
    if (!first) break;
    cellCache.delete(first);
  }
}

void ensureCoreWaterways();

function mergeLines(groups: WaterLine[][]): WaterLine[] {
  const seen = new Set<string>();
  const out: WaterLine[] = [];
  for (const g of groups) {
    for (const line of g) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
      out.push(line);
    }
  }
  return out;
}

async function loadCell(
  cx: number,
  cy: number,
  diag?: { parallelGroup?: string | null; parent?: string | null },
): Promise<WaterLine[]> {
  const id = cellKey(cx, cy);
  const hit = cellCache.get(id);
  if (hit?.length) {
    const perf = getRoutePerf();
    if (perf) perf.overpassCacheHits += 1;
    markFallbackEvent('overpass', `cell-cache:${id}`, 'cache_hit', {
      parent: diag?.parent ?? null,
      parallelGroup: diag?.parallelGroup ?? null,
      meta: { queryType: 'cell_bbox', cell: id, cache: 'hit' },
    });
    return hit;
  }

  const emptyUntil = emptyCellUntil.get(id) ?? 0;
  if (emptyUntil > Date.now()) {
    const perf = getRoutePerf();
    if (perf) perf.overpassCacheHits += 1;
    markFallbackEvent('overpass', `cell-empty-ttl:${id}`, 'empty_ttl_hit', {
      parent: diag?.parent ?? null,
      parallelGroup: diag?.parallelGroup ?? null,
      meta: { queryType: 'cell_bbox', cell: id, cache: 'empty_ttl' },
    });
    return [];
  }

  const inflight = cellInflight.get(id);
  if (inflight) {
    markFallbackEvent('overpass', `cell-inflight:${id}`, 'inflight_share', {
      parent: diag?.parent ?? null,
      parallelGroup: diag?.parallelGroup ?? null,
      meta: { queryType: 'cell_bbox', cell: id, cache: 'inflight' },
    });
    return inflight;
  }

  const task = (async () => {
    try {
      const lines = linesFromElements(
        await overpassQuery(cellBboxQuery(cx, cy), {
          queryType: 'cell_bbox',
          cell: id,
          parallelGroup: diag?.parallelGroup ?? null,
          parent: diag?.parent ?? null,
        }),
      );
      if (lines.length) rememberLinesInCells(lines);
      else emptyCellUntil.set(id, Date.now() + EMPTY_CELL_TTL_MS);
      return cellCache.get(id) ?? lines;
    } finally {
      cellInflight.delete(id);
    }
  })();

  cellInflight.set(id, task);
  return task;
}

/** Diagnostic/test only: clear Overpass cell memory (does not change fetch behaviour). */
export function clearWaterwayCellCacheForTests(): void {
  cellCache.clear();
  emptyCellUntil.clear();
  cellInflight.clear();
}

async function fetchWaterNetwork(
  points: LngLat[],
  opts: { forceRefresh?: boolean } = {},
): Promise<WaterLine[]> {
  const fetchId = beginFallbackEvent('overpass_fetch_network', 'fetchWaterNetwork', {
    meta: { forceRefresh: Boolean(opts.forceRefresh) },
  });
  try {
    const cells = cellsAlong(points);
    const fromCache = mergeLines(
      cells.map((c) => cellCache.get(cellKey(c.cx, c.cy)) ?? []).filter((g) => g.length > 0),
    );
    const missing = cells.filter((c) => {
      const id = cellKey(c.cx, c.cy);
      if (cellCache.get(id)?.length) return false;
      const emptyUntil = emptyCellUntil.get(id) ?? 0;
      return emptyUntil <= Date.now();
    });

    // Full cache hit — skip Overpass unless forced (failed route retry).
    if (!opts.forceRefresh && missing.length === 0 && fromCache.length > 0) {
      endFallbackEvent(fetchId, 'full_cache_hit', {
        cellCount: cells.length,
        lineCount: fromCache.length,
      });
      return fromCache;
    }

    const span = pathLength(points);

    // Short corridor: one compact around-query (fast).
    if (span <= 100) {
      try {
        const lines = linesFromElements(
          await overpassQuery(aroundWaterQuery(points), {
            queryType: 'around_corridor',
            parent: fetchId,
          }),
        );
        if (lines.length) {
          rememberLinesInCells(lines);
          endFallbackEvent(fetchId, 'around_ok', { spanKm: span, lineCount: lines.length });
          return mergeLines([fromCache, lines]);
        }
      } catch {
        // fall through to cell loads
      }
    }

    // Long corridor (or short query failed): load cells along the path in batches.
    // Cap so we don't fire hundreds of Overpass calls at once.
    // Cap Overpass fan-out — BRouter is primary; this is only a backup.
    const toLoad = (opts.forceRefresh ? cells : missing).slice(0, 24);
    for (let i = 0; i < toLoad.length; i += 8) {
      const batch = toLoad.slice(i, i + 8);
      const group = nextFallbackParallelGroup(`overpass_batch_${i / 8}`);
      const batchId = beginFallbackEvent('overpass_batch', `batch-${i / 8}`, {
        parent: fetchId,
        parallelGroup: group,
        meta: { batchIndex: i / 8, cellCount: batch.length },
      });
      await Promise.all(
        batch.map((c) =>
          loadCell(c.cx, c.cy, { parallelGroup: group, parent: batchId }),
        ),
      );
      endFallbackEvent(batchId, 'batch_done', { cells: batch.map((c) => cellKey(c.cx, c.cy)) });
    }

    const loaded = mergeLines(
      cells.map((c) => cellCache.get(cellKey(c.cx, c.cy)) ?? []).filter((g) => g.length > 0),
    );
    if (loaded.length) {
      endFallbackEvent(fetchId, 'cells_ok', {
        spanKm: span,
        toLoad: toLoad.length,
        lineCount: loaded.length,
      });
      return loaded;
    }

    if (fromCache.length) {
      endFallbackEvent(fetchId, 'fallback_from_cache', { lineCount: fromCache.length });
      return fromCache;
    }

    const ends = [points[0]!, points[points.length - 1]!].map(pointCell);
    const unique = new Map(ends.map((c) => [cellKey(c.cx, c.cy), c]));
    const endGroup = nextFallbackParallelGroup('overpass_ends');
    const endLines = await Promise.all(
      [...unique.values()].map((c) =>
        loadCell(c.cx, c.cy, { parallelGroup: endGroup, parent: fetchId }),
      ),
    );
    const merged = mergeLines(endLines);
    endFallbackEvent(fetchId, 'ends_only', { lineCount: merged.length });
    return merged;
  } catch (err) {
    endFallbackEvent(fetchId, 'error', {
      error: err instanceof Error ? err.message : 'error',
    });
    throw err;
  }
}

/** Warm waterway cache around a point (call after inland click / demo). */
export function prefetchWaterNear(point: LngLat): void {
  void ensureCoreWaterways();
  const { cx, cy } = pointCell(point);
  void loadCell(cx, cy).catch(() => {});
}

/** Awaited warm for long-span joint snaps (E1.7). */
export async function warmWaterNear(point: LngLat): Promise<void> {
  await ensureCoreWaterways();
  const { cx, cy } = pointCell(point);
  await Promise.all(
    [-1, 0, 1].flatMap((dx) =>
      [-1, 0, 1].map((dy) => loadCell(cx + dx, cy + dy).catch(() => [] as WaterLine[])),
    ),
  );
}

/** Warm cache for the visible map (call on inland moveend). */
export function prefetchWaterBbox(south: number, west: number, north: number, east: number): void {
  void ensureCoreWaterways();
  const cx0 = Math.floor(west / CELL_DEG);
  const cx1 = Math.floor(east / CELL_DEG);
  const cy0 = Math.floor(south / CELL_DEG);
  const cy1 = Math.floor(north / CELL_DEG);
  const midX = Math.round((cx0 + cx1) / 2);
  const midY = Math.round((cy0 + cy1) / 2);
  void loadCell(midX, midY).catch(() => {});
}

export type WaterSnap = {
  point: LngLat;
  distKm: number;
  name: string | null;
  kind: 'waterway' | 'lake';
};

/**
 * Pull a map click onto the nearest river/canal/lake centerline.
 * Cache-only (instant): never awaits Overpass. Background prefetch warms cells.
 * Default radius follows MAX_WATER_SNAP_DISTANCE_METERS.
 */
export function snapClickToWater(
  click: LngLat,
  maxKm: number = maxWaterSnapKm(),
): WaterSnap | null {
  const { cx, cy } = pointCell(click);
  // Warm neighbours in the background — do not block the click / route.
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      void loadCell(cx + dx, cy + dy).catch(() => {});
    }
  }

  let bestWay: WaterSnap | null = null;
  let bestLake: WaterSnap | null = null;
  const seen = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const line of cellCache.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (seen.has(line.id) || line.coords.length < 2) continue;
        seen.add(line.id);
        const stride = Math.max(1, Math.floor(line.coords.length / 80));
        for (let j = stride; j < line.coords.length; j += stride) {
          const c = closestOnSegment(click, line.coords[j - stride]!, line.coords[j]!);
          if (c.distKm > maxKm) continue;
          const name = line.name ? canonicalWaterwayName(line.name) : null;
          const hit: WaterSnap = {
            point: c.point,
            distKm: c.distKm,
            name: name && !isGenericWaterwayName(name) ? name : null,
            kind: line.kind,
          };
          if (line.kind === 'lake') {
            if (!bestLake || hit.distKm < bestLake.distKm) bestLake = hit;
          } else if (!bestWay || hit.distKm < bestWay.distKm) {
            bestWay = hit;
          }
        }
      }
    }
  }

  // Prefer a nearby river/canal; lakes only when clearly closer or no river.
  if (bestWay && bestWay.distKm <= Math.min(maxKm, 0.9)) return bestWay;
  if (bestLake && (!bestWay || bestLake.distKm + 0.12 < bestWay.distKm)) return bestLake;
  return bestWay ?? bestLake;
}

/**
 * Phase C: collect up to `k` endpoint candidates (waterway / lake / fairway),
 * ranked with optional destination bias. Not nearest-only.
 *
 * `maxKm` is the candidate *search* radius (typically open-water 10 km for
 * Phase C). Acceptance ceilings remain endpointSnapKmForAccept (3 / 5.5 / 10).
 */
export function snapWaterCandidates(
  click: LngLat,
  maxKm: number,
  k: number = PHASE_C_K,
  toward?: LngLat | null,
): WaterCandidate[] {
  const { cx, cy } = pointCell(click);
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      void loadCell(cx + dx, cy + dy).catch(() => {});
    }
  }

  const wayHits: WaterCandidate[] = [];
  const lakeHits: WaterCandidate[] = [];
  const seen = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const line of cellCache.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (seen.has(line.id) || line.coords.length < 2) continue;
        seen.add(line.id);
        const stride = Math.max(1, Math.floor(line.coords.length / 80));
        let bestOnLine: WaterCandidate | null = null;
        for (let j = stride; j < line.coords.length; j += stride) {
          const c = closestOnSegment(click, line.coords[j - stride]!, line.coords[j]!);
          if (c.distKm > maxKm) continue;
          const source = line.kind === 'lake' ? ('lake' as const) : ('waterway' as const);
          const cand: WaterCandidate = {
            point: c.point,
            distKm: c.distKm,
            source,
            rank: candidateRank(c.distKm, click, c.point, toward, source),
          };
          if (!bestOnLine || cand.rank < bestOnLine.rank) bestOnLine = cand;
        }
        if (!bestOnLine) continue;
        if (bestOnLine.source === 'lake') lakeHits.push(bestOnLine);
        else wayHits.push(bestOnLine);
      }
    }
  }

  wayHits.sort((a, b) => a.rank - b.rank || a.distKm - b.distKm);
  lakeHits.sort((a, b) => a.rank - b.rank || a.distKm - b.distKm);

  const fairway = fairwayPinsNear(click, maxKm, toward, k);
  const merged = mergeCandidatePools(
    [diversifyCandidates(wayHits, k, 0.85), diversifyCandidates(lakeHits, k, 0.85), fairway],
    Math.max(k, PHASE_C_K),
  );
  return merged.slice(0, Math.max(1, Math.min(5, k)));
}

function uniqueWaterName(...parts: Array<string | null | undefined>): string | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    if (!raw) continue;
    for (const piece of raw.split(',')) {
      const name = piece.trim();
      if (!name) continue;
      const key = name.toLocaleLowerCase('ru');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out.length ? out.join(', ') : null;
}

function routeOnLines(origin: LngLat, destination: LngLat, lines: WaterLine[]): WaterPath {
  const distDirect = haversineKm(origin, destination);
  if (lines.length === 0) {
    return { points: [origin, destination], lengthKm: distDirect, waterName: null, method: 'direct' };
  }

  const { nodes, edges, lineNodeIds } = buildGraph(lines);
  const snapMax = Math.min(SNAP_MAX_KM, Math.max(3, distDirect * 0.35 + 1.5));
  const snapA = snapToNetwork(origin, lines, nodes, edges, lineNodeIds, snapMax);
  const snapB = snapToNetwork(destination, lines, nodes, edges, lineNodeIds, snapMax);

  if (!snapA || !snapB) {
    return { points: [origin, destination], lengthKm: distDirect, waterName: null, method: 'direct' };
  }

  const waterName = uniqueWaterName(snapA.line.name, snapB.line.name);

  if (
    snapA.line.kind === 'lake' &&
    snapB.line.kind === 'lake' &&
    (snapA.line.id === snapB.line.id ||
      (snapA.line.name && snapA.line.name === snapB.line.name))
  ) {
    const points = simplifyPath([origin, snapA.point, snapB.point, destination]);
    return {
      points,
      lengthKm: pathLength(points),
      waterName: waterName ?? 'водоём',
      method: 'lake',
    };
  }

  // Same OSM way — follow its geometry even if graph attach failed.
  if (snapA.line.id === snapB.line.id && snapA.line.kind === 'waterway') {
    const points = pathAlongLine(snapA.line, origin, destination);
    return {
      points,
      lengthKm: pathLength(points),
      waterName: waterName ?? snapA.line.name,
      method: 'waterway',
    };
  }

  let nodePath = dijkstra(snapA.nodeId, snapB.nodeId, nodes.length, edges);

  // Retry on subset of same-named rivers / the two snapped lines.
  if (!nodePath || nodePath.length < 2) {
    const nameKeys = new Set<string>();
    for (const n of [snapA.line.name, snapB.line.name]) {
      if (n) nameKeys.add(n.toLocaleLowerCase('ru'));
    }
    const subset = lines.filter(
      (l) =>
        l.id === snapA.line.id ||
        l.id === snapB.line.id ||
        (l.name != null && nameKeys.has(l.name.toLocaleLowerCase('ru'))),
    );
    if (subset.length >= 1 && subset.length < lines.length) {
      const g2 = buildGraph(subset);
      const s2a = snapToNetwork(origin, subset, g2.nodes, g2.edges, g2.lineNodeIds, snapMax);
      const s2b = snapToNetwork(destination, subset, g2.nodes, g2.edges, g2.lineNodeIds, snapMax);
      if (s2a && s2b) {
        nodePath = dijkstra(s2a.nodeId, s2b.nodeId, g2.nodes.length, g2.edges);
        if (nodePath && nodePath.length >= 2) {
          const points: LngLat[] = [origin];
          for (const id of nodePath) {
            const n = g2.nodes[id]!;
            points.push({ lon: n.lon, lat: n.lat });
          }
          points.push(destination);
          return {
            points: simplifyPath(points, 0.02),
            lengthKm: pathLength(points),
            waterName,
            method: 'waterway',
          };
        }
      }
    }
  }

  if (!nodePath || nodePath.length < 2) {
    // Same water body only — never invent a land chord between distant rivers/lakes
    // (that looked like a "straight line not on water" for Seliger→Vokhma).
    if (
      distDirect <= 40 &&
      snapA.distKm <= 2.5 &&
      snapB.distKm <= 2.5 &&
      snapA.line.id === snapB.line.id
    ) {
      const points = pathAlongLine(snapA.line, origin, destination);
      return {
        points,
        lengthKm: pathLength(points),
        waterName: waterName ?? snapA.line.name,
        method: snapA.line.kind === 'lake' ? 'lake' : 'waterway',
      };
    }
    return {
      points: [origin, destination],
      lengthKm: distDirect,
      waterName: null,
      method: 'direct',
    };
  }

  const points: LngLat[] = [origin];
  for (const id of nodePath) {
    const n = nodes[id]!;
    points.push({ lon: n.lon, lat: n.lat });
  }
  points.push(destination);

  return {
    points: simplifyPath(points, 0.02),
    lengthKm: pathLength(points),
    waterName,
    method: 'waterway',
  };
}

/**
 * Cheap label from nearby named waterways (endpoint snaps only).
 * Avoid full path×line scans — water-core near Moscow has 300+ named rivers and freezes the UI.
 */
function namesNearEndpoints(path: LngLat[]): string | null {
  if (path.length < 2) return null;
  const ends = [path[0]!, path[path.length - 1]!];
  const scored = new Map<string, number>();
  for (const p of ends) {
    const { cx, cy } = pointCell(p);
    const seen = new Set<string>();
    const nearby: WaterLine[] = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const line of cellCache.get(cellKey(cx + dx, cy + dy)) ?? []) {
          if (!line.name || line.kind !== 'waterway' || seen.has(line.id)) continue;
          seen.add(line.id);
          nearby.push(line);
        }
      }
    }
    // Cap — dense cities have hundreds of named canals/streams in cache.
    const limited = nearby.length > 80 ? nearby.slice(0, 80) : nearby;
    let bestName: string | null = null;
    let bestD = 0.35;
    for (const line of limited) {
      const stride = Math.max(1, Math.floor(line.coords.length / 24));
      for (let j = stride; j < line.coords.length; j += stride) {
        const c = closestOnSegment(p, line.coords[j - stride]!, line.coords[j]!);
        if (c.distKm < bestD) {
          bestD = c.distKm;
          bestName = line.name;
        }
      }
    }
    if (bestName) scored.set(bestName, (scored.get(bestName) ?? 0) + 1);
  }
  const names = [...scored.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  return names.length ? uniqueWaterName(...names) : null;
}

function cumKmAlongPath(path: LngLat[], waypoints: LngLat[]): number[] {
  if (!path.length) return waypoints.map(() => 0);
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + haversineKm(path[i - 1]!, path[i]!));

  // Forward-only nearest vertex — O(path) total, stable for long one-way rivers.
  const out: number[] = [];
  let from = 0;
  for (let w = 0; w < waypoints.length; w++) {
    const wp = waypoints[w]!;
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

function waterNameFromTags(tags: string[]): string | null {
  const names: string[] = [];
  const kinds = new Set<string>();
  for (const t of tags) {
    if (t.startsWith('name=') || t.startsWith('name:ru=')) {
      const n = t.slice(t.indexOf('=') + 1).trim();
      if (n && !isGenericWaterwayName(n)) names.push(n);
      continue;
    }
    if (t === 'waterway=river') kinds.add('река');
    else if (t === 'waterway=canal') kinds.add('канал');
    else if (t === 'waterway=stream') kinds.add('ручей');
    else if (t === 'waterway=fairway') kinds.add('фарватер');
    else if (t.startsWith('waterway=')) kinds.add(t.slice('waterway='.length));
  }
  if (names.length) {
    const uniq = uniqueWaterName(...names);
    return resolveWaterName(uniq) ?? uniq;
  }
  return kinds.size ? [...kinds].join(', ') : null;
}

/** Skip anonymous ditches / lock labels when naming itinerary stretches. */
function isGenericWaterwayName(name: string): boolean {
  const k = name.trim().toLocaleLowerCase('ru');
  if (k.length < 2) return true;
  if (/^шлюз\b/.test(k)) return true;
  if (/^(канал|протока|рукав|водоток|ручей|река)\s*\d*$/i.test(k)) return true;
  if (/водоотвод/i.test(k)) return true;
  if (/^без названия/i.test(k)) return true;
  return false;
}

/** Moscow Canal and its OSM name variants (must not be labeled from a giant bbox). */
function isMoscowCanalName(name: string): boolean {
  const k = name.trim().toLocaleLowerCase('ru');
  if (!(k.includes('канал') && k.includes('москв'))) return false;
  // Keep unrelated city canals out of this bucket.
  if (k.includes('водоотвод') || k.includes('головин') || k.includes('гребн')) return false;
  return /имени\s+москвы|им\.?\s*москвы|канал\s+им/.test(k) || k === 'канал имени москвы';
}

/** Stable display name for itinerary (merge OSM aliases; prefer GVR spelling). */
function canonicalWaterwayName(name: string): string {
  const raw = name.trim();
  if (isMoscowCanalName(raw)) return 'Канал имени Москвы';
  const k = raw.toLocaleLowerCase('ru');
  if (k.includes('сходненск') && k.includes('деривац')) return 'Сходня';
  const gvr = officialGvrName(raw);
  if (gvr) return gvr.name;
  return raw;
}

function namedSegment(name: string, km: number): ItinerarySegment {
  const canon = canonicalWaterwayName(name);
  const gvr = officialGvrName(canon);
  if (gvr) {
    return { name: gvr.name, km, gvrCode: gvr.gvrCode, fromGvr: true };
  }
  return { name: canon, km };
}

/**
 * Closest named waterway centerline from water-core / Overpass cache.
 * Includes trunk rivers — geometry distance beats giant catalog bboxes.
 * When a trunk and a tributary are both nearby, prefer the closer one; on a
 * near-tie, prefer the non-trunk (Сходня over Волга at a confluence).
 *
 * Optional trackBearing penalizes rivers that only cross the track
 * (passing tributaries) and boosts ones aligned with the route.
 */
function nearestLocalWaterwayName(
  p: LngLat,
  maxKm = 0.55,
  opts: {
    preferName?: string | null;
    excludeTrunk?: boolean;
    /** Track heading in degrees (0–360); used to ignore crossing tributaries. */
    trackBearing?: number | null;
  } = {},
): { name: string; distKm: number } | null {
  const { cx, cy } = pointCell(p);
  const preferKey = opts.preferName
    ? canonicalWaterwayName(opts.preferName).toLocaleLowerCase('ru')
    : null;
  let bestName: string | null = null;
  let bestD = maxKm;
  let bestScore = maxKm;
  let bestIsTrunk = false;
  let bestIsCanal = false;
  const seen = new Set<string>();
  let checked = 0;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const lines = cellCache.get(cellKey(cx + dx, cy + dy)) ?? [];
      for (const line of lines) {
        if (!line.name || line.kind !== 'waterway') continue;
        if (seen.has(line.id)) continue;
        seen.add(line.id);
        if (isGenericWaterwayName(line.name)) continue;
        const canon = canonicalWaterwayName(line.name);
        const trunk = isTrunkRiver(canon);
        const canal = isMoscowCanalName(canon);
        if (opts.excludeTrunk && trunk) continue;
        if (++checked > 160) break;
        const stride = Math.max(1, Math.floor(line.coords.length / 32));
        for (let j = stride; j < line.coords.length; j += stride) {
          const a = line.coords[j - stride]!;
          const b = line.coords[j]!;
          const c = closestOnSegment(p, a, b);
          if (c.distKm > bestD + 0.12) continue;
          const nameKey = canon.toLocaleLowerCase('ru');
          const preferBoost = preferKey && nameKey === preferKey ? 0.14 : 0;
          // Official GVR-linked geometries beat anonymous OSM names.
          const gvrBoost = line.gvrCode ? 0.08 : 0;
          let alignPenalty = 0;
          if (opts.trackBearing != null && Number.isFinite(opts.trackBearing)) {
            const segBear = bearingDeg(a, b);
            const diff = bearingDiffDeg(opts.trackBearing, segBear);
            // Crossing (~90°) tributaries: strong penalty so they don't steal the label.
            if (diff >= 55) alignPenalty = 0.22;
            else if (diff >= 40) alignPenalty = 0.1;
            else if (diff <= 25) alignPenalty = -0.04; // aligned with track
          }
          const score = c.distKm - preferBoost - gvrBoost + alignPenalty;
          // Near-tie: keep river over trunk/canal so Горетовка/Сходня win beside КиМ.
          const tiePenalty =
            ((trunk || canal) && bestName && !bestIsTrunk && !bestIsCanal && Math.abs(score - bestScore) < 0.14
              ? 0.06
              : 0) +
            (canal && bestName && !bestIsCanal && Math.abs(score - bestScore) < 0.22 ? 0.05 : 0);
          if (score + tiePenalty < bestScore) {
            bestScore = score;
            bestD = c.distKm;
            bestName = canon;
            bestIsTrunk = trunk;
            bestIsCanal = canal;
          }
        }
      }
    }
  }
  return bestName ? { name: bestName, distKm: bestD } : null;
}

/** Distance from a point to a specific named waterway centerline in the cell cache. */
function distToNamedWaterway(
  p: LngLat,
  name: string,
  maxKm = 0.9,
): number | null {
  const want = canonicalWaterwayName(name).toLocaleLowerCase('ru');
  const { cx, cy } = pointCell(p);
  let best = maxKm;
  let found = false;
  const seen = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const line of cellCache.get(cellKey(cx + dx, cy + dy)) ?? []) {
        if (!line.name || line.kind !== 'waterway' || line.coords.length < 2) continue;
        if (seen.has(line.id)) continue;
        seen.add(line.id);
        if (canonicalWaterwayName(line.name).toLocaleLowerCase('ru') !== want) continue;
        const stride = Math.max(1, Math.floor(line.coords.length / 40));
        for (let j = stride; j < line.coords.length; j += stride) {
          const c = closestOnSegment(p, line.coords[j - stride]!, line.coords[j]!);
          if (c.distKm < best) {
            best = c.distKm;
            found = true;
          }
        }
      }
    }
  }
  return found ? best : null;
}

function bearingDeg(a: LngLat, b: LngLat): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLon = toR(b.lon - a.lon);
  const lat1 = toR(a.lat);
  const lat2 = toR(b.lat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest angle between two bearings, 0..90 (direction-insensitive). */
function bearingDiffDeg(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  if (d > 90) d = 180 - d;
  return d;
}

/** Use OSM/water-core geometry for river labels whenever it is close enough. */
function shouldPreferLocalWaterway(
  catalog: { name: string; kind: 'river' | 'lake' } | null,
  local: { name: string; distKm: number } | null,
): boolean {
  if (!local) return false;
  const localKey = local.name.toLocaleLowerCase('ru');
  if (!catalog) return local.distKm <= 0.4;
  if (catalog.name.toLocaleLowerCase('ru') === localKey) return local.distKm <= 0.7;
  // Reservoir bbox can cover a tributary mouth (Сходня vs Химкинское) — river centerline wins.
  if (catalog.kind === 'lake') {
    if (isMoscowCanalName(local.name)) return local.distKm <= 0.18;
    return local.distKm <= 0.28;
  }
  // Catalog already names a river: only override with a different local when
  // it is tightly under the track (otherwise nearby tributaries steal the label).
  if (catalog.kind === 'river') {
    if (isTrunkRiver(catalog.name) && !isTrunkRiver(local.name)) {
      return local.distKm <= 0.22;
    }
    return local.distKm <= 0.2;
  }
  if (local.distKm <= 0.3 && !isCorridorTributary(catalog.name)) return true;
  return false;
}

function stickyNameForRiver(name: string): string | null {
  if (isMoscowCanalName(name) || isTrunkRiver(name)) return null;
  return name;
}

/** Volga-cascade reservoirs are retired after leaving; small lakes (Химкинское) may re-enter. */
function shouldRetireLakeName(name: string): boolean {
  const k = name.toLocaleLowerCase('ru');
  return /иваньков|углич|рыбин|горьков|чебоксар|куйбышев|саратов|волгоград|камск|воткин|нижнекам|цимлян|юмагузин/.test(
    k,
  );
}

function retireLakeName(usedNames: Set<string>, name: string): void {
  if (shouldRetireLakeName(name)) usedNames.add(name.toLocaleLowerCase('ru'));
}

/**
 * Pull named river/stream/canal geometry along a route so itinerary labeling
 * is not limited to the sparse water-core seed (or giant catalog bboxes).
 */
async function enrichNamedWaterwaysForItinerary(path: LngLat[]): Promise<void> {
  if (path.length < 2) return;
  const span = pathLength(path);
  // Keep samples modest — this runs in background polish, not on the critical path.
  const sampleCount = Math.min(24, Math.max(4, Math.ceil(span / 14) + 1));
  const samples = sampleAlongPath(path, sampleCount);
  const chunkSize = 12;
    const jobs: Promise<void>[] = [];
  for (let i = 0; i < samples.length; i += chunkSize) {
    const chunk = samples.slice(i, i + chunkSize);
    const blocks = chunk
      .map((p) => {
        const r = span > 250 ? 1600 : 2000;
        // Prefer geometries that carry an official GVR code.
        return `
  way(around:${r},${p.lat},${p.lon})["waterway"~"^(river|stream|canal|fairway|ship_canal|link)$"]["name"]["gvr:code"];
  way(around:${r},${p.lat},${p.lon})["waterway"~"^(river|stream|canal|fairway|ship_canal|link)$"]["name"];
  relation(around:${r},${p.lat},${p.lon})["waterway"~"^(river|stream|canal)$"]["name"]["gvr:code"];
  way(around:${r},${p.lat},${p.lon})["natural"="water"]["name"]["gvr:code"];`;
      })
      .join('\n');
    const query = `
[out:json][timeout:10];
(
${blocks}
);
out geom;
`;
    jobs.push(
      (async () => {
        try {
          const lines = linesFromElements(
            await overpassQuery(query, { queryType: 'name_lookup' }),
          );
          if (lines.length) rememberLinesInCells(lines);
        } catch {
          // Naming still falls back to water-core + catalog.
        }
      })(),
    );
  }
  // Cap concurrency: two Overpass batches at a time.
  for (let i = 0; i < jobs.length; i += 2) {
    await Promise.all(jobs.slice(i, i + 2));
  }
}

type CatalogBody = {
  n: string;
  k: 'r' | 'l';
  b: [number, number, number, number]; // west, south, east, north
};

/**
 * Navigational reservoir extents (ship fairway):
 * - End = dam + lock: below the lock the stretch is river, not the reservoir.
 * - Start = channel widening into the backwater.
 *
 * Cascade notes (official backwater / rules of use):
 * - Угличское: подпор до Иваньковского гидроузла → starts just below Dubna lock.
 * - Рыбинское: подпор по Волге до Угличского гидроузла → starts just below Uglich lock;
 *   ends at the Rybinsk lock.
 *
 * `below` is the cardinal side of the lower pool relative to the dam point.
 */
type ReservoirLock = {
  lon: number;
  lat: number;
  /**
   * Cardinal / diagonal side of the lower pool relative to the dam/lock.
   * SE = south of lock AND not far west (avoids cutting the Volga arm of a reservoir).
   */
  below: 'N' | 'S' | 'E' | 'W' | 'SE';
};

const RESERVOIR_LOCKS: Record<string, ReservoirLock> = {
  // Шлюз №1 КиМ / Иваньковский гидроузел (Дубна) — верхняя голова камеры
  'иваньковское водохранилище': { lon: 37.1374, lat: 56.7343, below: 'E' },
  'угличское водохранилище': { lon: 38.314, lat: 57.526, below: 'N' }, // Углич
  // Шлюзы №11–12 Переборы (не водосброс восточнее ~38.83)
  'рыбинское водохранилище': { lon: 38.7086, lat: 58.0999, below: 'SE' },
  'горьковское водохранилище': { lon: 43.47, lat: 56.65, below: 'E' }, // Городец
  'чебоксарское водохранилище': { lon: 47.37, lat: 56.14, below: 'E' }, // Новочебоксарск
  'куйбышевское водохранилище': { lon: 49.48, lat: 53.42, below: 'S' }, // Жигули / Тольятти
  'саратовское водохранилище': { lon: 47.83, lat: 52.024, below: 'S' }, // Балаково
  'волгоградское водохранилище': { lon: 44.677, lat: 48.825, below: 'S' }, // Волжский
  'цимлянское водохранилище': { lon: 42.125, lat: 47.628, below: 'W' }, // Цимлянск (Дон)
  'камское водохранилище': { lon: 56.33, lat: 58.007, below: 'W' }, // Пермь
  'воткинское водохранилище': { lon: 54.135, lat: 56.85, below: 'W' }, // Чайковский
  'нижнекамское водохранилище': { lon: 52.39, lat: 55.7, below: 'W' }, // Наб. Челны
  'юмагузинское водохранилище': { lon: 57.05, lat: 52.96, below: 'N' }, // Белая
};

function pastReservoirLock(p: LngLat, lock: ReservoirLock): boolean {
  switch (lock.below) {
    case 'N':
      return p.lat > lock.lat;
    case 'S':
      return p.lat < lock.lat;
    case 'E':
      return p.lon > lock.lon;
    case 'W':
      return p.lon < lock.lon;
    case 'SE':
      // Lower pool south of the lock; keep the reservoir's southern Volga arm (west of lock).
      return p.lat < lock.lat && p.lon > lock.lon - 0.04;
  }
}

const CATALOG = waterBodies as CatalogBody[];

/** Навигационное начало Ветлуги: рукав выше открытого плёса у Юрина (не wiki-устье в чаше вдхр.). */
const VETLUGA_MOUTH: LngLat = { lon: 46.20, lat: 56.50 };
/** д. Малое Раменье on Vetluga (below the Vohma turn). */
const MALOE_RAMENYE: LngLat = { lon: 46.5598, lat: 58.7603 };
/**
 * Устье Вохмы: ~4 km upstream of Малое Раменье along Vetluga
 * (= OSM confluence of Вохма, way 142440981 → Ветлуга).
 */
const VOHMA_MOUTH: LngLat = { lon: 46.6064, lat: 58.7543 };

/** Lower Vetluga channel above the open Cheboksary pool (not the Yurino bay). */
function onVetlugaAboveMouth(p: LngLat): boolean {
  if (p.lat < VETLUGA_MOUTH.lat - 0.01) return false;
  // Near the mouth stay over the Vetluga valley, not east along the Volga pool.
  if (p.lat < 56.7) return p.lon >= 45.7 && p.lon <= 46.75;
  return p.lon >= 45.5 && p.lon <= 47.7;
}

/**
 * Vohma from its confluence (~4 km above Малое Раменье) east/NE up the tributary.
 * The Vetluga stem by the village stays Ветлуга.
 */
function onVohmaAboveMouth(p: LngLat): boolean {
  const dMouth = haversineKm(p, VOHMA_MOUTH);
  const dMaloe = haversineKm(p, MALOE_RAMENYE);
  // Closer to the village than to the confluence → still on Vetluga below the mouth.
  if (dMaloe + 0.3 < dMouth) return false;
  if (dMouth <= 0.5) return true;
  // Upstream along Vohma (E/NE of the confluence), not back down Vetluga.
  if (p.lon < VOHMA_MOUTH.lon - 0.003) return false;
  if (p.lat < VOHMA_MOUTH.lat - 0.003) return false;
  return p.lon <= 47.1 && p.lat <= 59.55;
}

function catalogArea(body: CatalogBody): number {
  const [w, s, e, n] = body.b;
  return Math.max(1e-9, (e - w) * (n - s));
}

function pointInCatalog(p: LngLat, body: CatalogBody): boolean {
  const [w, s, e, n] = body.b;
  if (!(p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n)) return false;
  // Dam/lock is the navigational end of a reservoir — do not label the lower pool.
  const lock = RESERVOIR_LOCKS[body.n.toLocaleLowerCase('ru')];
  if (lock && pastReservoirLock(p, lock)) return false;
  return true;
}

const LAKE_NAME_RE = /(водохранилищ|озеро|оз\.)/i;

function isLakeCatalogName(name: string): boolean {
  const key = name.toLocaleLowerCase('ru');
  return CATALOG.some((b) => b.k === 'l' && b.n.toLocaleLowerCase('ru') === key) || LAKE_NAME_RE.test(name);
}

/** Prefer reservoirs, then smaller river corridors over the broad Volga box. */
function pickCatalogName(
  sample: LngLat,
  skipNames: Set<string> = new Set(),
): { name: string; kind: 'river' | 'lake' } | null {
  const hits = CATALOG.filter((b) => {
    if (!pointInCatalog(sample, b)) return false;
    if (skipNames.has(b.n.toLocaleLowerCase('ru'))) return false;
    return true;
  });
  if (!hits.length) return null;
  // On the Vetluga climb above the mouth, Чебоксарское must not re-enter the label set —
  // lake↔river flicker there produced several hash marks at the same mouth.
  const filtered = onVetlugaAboveMouth(sample)
    ? hits.filter((h) => !h.n.toLocaleLowerCase('ru').includes('чебоксар'))
    : hits;
  const pool = filtered.length ? filtered : hits;
  pool.sort((a, b) => {
    const lakeA = a.k === 'l' ? 0 : 1;
    const lakeB = b.k === 'l' ? 0 : 1;
    if (lakeA !== lakeB) return lakeA - lakeB;
    return catalogArea(a) - catalogArea(b);
  });

  const best = pool[0]!;
  const bestKey = best.n.toLocaleLowerCase('ru');

  // Чебоксарское backwater covers lower Ветлуга — still name the climb Ветлуга
  // from the real mouth near Юрино, not from the north edge of the reservoir box.
  if (best.k === 'l' && bestKey.includes('чебоксар')) {
    const vetluga = hits.find((h) => h.n.toLocaleLowerCase('ru') === 'ветлуга');
    if (vetluga && onVetlugaAboveMouth(sample)) {
      return { name: 'Ветлуга', kind: 'river' };
    }
  }

  // Ветлуга box overlaps the Volga / Cheboksary band — don't label the stem as Ветлуга.
  if (bestKey === 'ветлуга') {
    const volga = pool.find((h) => h.n.toLocaleLowerCase('ru') === 'волга');
    const lake = pool.find((h) => h.k === 'l');
    if (lake) {
      const lakeKey = lake.n.toLocaleLowerCase('ru');
      if (lakeKey.includes('чебоксар') && onVetlugaAboveMouth(sample)) {
        return { name: 'Ветлуга', kind: 'river' };
      }
      return { name: lake.n, kind: 'lake' };
    }
    if (volga && sample.lat < VETLUGA_MOUTH.lat) {
      return { name: 'Волга', kind: 'river' };
    }
  }

  // Вохма must not start south of its mouth on the Vetluga stem.
  if (bestKey === 'вохма' && !onVohmaAboveMouth(sample)) {
    const vetluga = pool.find((h) => h.n.toLocaleLowerCase('ru') === 'ветлуга');
    if (vetluga) return { name: 'Ветлуга', kind: 'river' };
    const next = pool.find((h) => h.n.toLocaleLowerCase('ru') !== 'вохма');
    if (next) {
      return { name: next.n, kind: next.k === 'l' ? 'lake' : 'river' };
    }
  }

  // While climbing a corridor, never let the giant Волга box win over Ветлуга/Вохма.
  if (bestKey === 'волга') {
    const trib = pool.find((h) => {
      const k = h.n.toLocaleLowerCase('ru');
      return k === 'ветлуга' || k === 'вохма' || k === 'селижаровка' || k === 'белая';
    });
    if (trib) {
      const k = trib.n.toLocaleLowerCase('ru');
      if (k === 'ветлуга' && sample.lat < VETLUGA_MOUTH.lat) {
        return { name: 'Волга', kind: 'river' };
      }
      if (k === 'вохма' && !onVohmaAboveMouth(sample)) {
        const vetluga = pool.find((h) => h.n.toLocaleLowerCase('ru') === 'ветлуга');
        if (vetluga) return { name: 'Ветлуга', kind: 'river' };
        return { name: 'Волга', kind: 'river' };
      }
      return { name: trib.n, kind: 'river' };
    }
    // At the Vetluga mouth band, skip a bare «Волга» flicker (it doubled the tick).
    if (onVetlugaAboveMouth(sample)) {
      const vetluga = hits.find((h) => h.n.toLocaleLowerCase('ru') === 'ветлуга');
      if (vetluga) return { name: 'Ветлуга', kind: 'river' };
    }
  }

  return { name: resolveWaterName(best.n) ?? best.n, kind: best.k === 'l' ? 'lake' : 'river' };
}

function catalogBodyByName(name: string): CatalogBody | undefined {
  const key = name.toLocaleLowerCase('ru');
  return CATALOG.find((b) => b.n.toLocaleLowerCase('ru') === key);
}

const TRUNK_RIVERS = new Set(
  [
    'волга',
    'москва',
    'нева',
    'кама',
    'дон',
    'ока',
    'белая',
    'обь',
    'иртыш',
    'енисей',
    'лена',
    'амур',
    'печора',
    'северная двина',
  ].map((s) => s.toLocaleLowerCase('ru')),
);

/** Named corridors that must not be permanently locked on a Volga confluence flicker. */
const CORRIDOR_TRIBUTARIES = new Set(
  [
    'ветлуга',
    'вохма',
    'селижаровка',
    'белая',
    'шексна',
    'свирь',
    'нева',
    'ковжа',
    'вытегра',
    'волхов',
  ].map((s) => s.toLocaleLowerCase('ru')),
);

function isTrunkRiver(name: string): boolean {
  return TRUNK_RIVERS.has(name.toLocaleLowerCase('ru'));
}

function isCorridorTributary(name: string): boolean {
  return CORRIDOR_TRIBUTARIES.has(name.toLocaleLowerCase('ru'));
}

/** Long climbs (Ветлуга→Вохма, Белая) — keep label even outside a tight bbox. */
function isStrongCorridorSticky(name: string): boolean {
  const k = name.toLocaleLowerCase('ru');
  return k === 'ветлуга' || k === 'вохма' || k === 'белая';
}

function nameAtSample(
  p: LngLat,
  stickyLake: string | null,
  stickyOutsideKm: number,
  usedNames: Set<string>,
  stepKm: number,
  stickyRiver: string | null,
  stickyRiverOutsideKm: number,
  trackBearing: number | null = null,
): {
  name: string | null;
  stickyLake: string | null;
  stickyOutsideKm: number;
  stickyRiver: string | null;
  stickyRiverOutsideKm: number;
} {
  // Sticky river: keep a named stretch along meanders; switch when another
  // named centerline is clearly under the track — not merely a nearby tributary.
  if (stickyRiver) {
    const key = stickyRiver.toLocaleLowerCase('ru');
    const body = catalogBodyByName(stickyRiver);
    const inBody = !!(body && pointInCatalog(p, body));
    const stickyDist = distToNamedWaterway(p, stickyRiver, 0.95);
    const localNear = nearestLocalWaterwayName(p, 0.65, {
      preferName: stickyRiver,
      trackBearing,
    });
    const localKey = localNear?.name.toLocaleLowerCase('ru') ?? null;

    // Snap to Вохма at the confluence (~4 km above Малое Раменье).
    const peek = pickCatalogName(p, usedNames);
    if (key === 'ветлуга' && onVohmaAboveMouth(p) && haversineKm(p, VOHMA_MOUTH) <= 0.6) {
      return {
        name: 'Вохма',
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver: 'Вохма',
        stickyRiverOutsideKm: 0,
      };
    }
    if (
      peek?.kind === 'river' &&
      isCorridorTributary(peek.name) &&
      peek.name.toLocaleLowerCase('ru') !== key &&
      catalogBodyByName(peek.name) &&
      catalogArea(catalogBodyByName(peek.name)!) <=
        (body ? catalogArea(body) : Infinity) &&
      !(peek.name.toLocaleLowerCase('ru') === 'вохма' && !onVohmaAboveMouth(p))
    ) {
      // Catalog bbox alone is not enough — require the track to sit on that
      // tributary centerline (otherwise a wide bbox steals the sticky label).
      const peekDist = distToNamedWaterway(p, peek.name, 0.7);
      const stillOnSticky = stickyDist != null && stickyDist <= 0.35;
      if (peekDist != null && peekDist <= 0.28 && (!stillOnSticky || peekDist + 0.12 < stickyDist!)) {
        return {
          name: peek.name,
          stickyLake: null,
          stickyOutsideKm: 0,
          stickyRiver: peek.name,
          stickyRiverOutsideKm: 0,
        };
      }
    }

    // Reservoir / lake always wins over a sticky river — except Чебоксарское
    // reclaiming the Vetluga climb (that flickered several ticks at the mouth).
    if (peek?.kind === 'lake') {
      const lakeKey = peek.name.toLocaleLowerCase('ru');
      if (
        lakeKey.includes('чебоксар') &&
        (key === 'ветлуга' || key === 'вохма' || onVetlugaAboveMouth(p))
      ) {
        usedNames.add(lakeKey);
        // keep sticky river
      } else if (
        localNear &&
        localNear.distKm <= 0.28 &&
        localKey === key &&
        !isMoscowCanalName(localNear.name)
      ) {
        // Still on the sticky river centerline inside a reservoir bbox (Сходня / Химкинское).
        return {
          name: stickyRiver,
          stickyLake: null,
          stickyOutsideKm: 0,
          stickyRiver,
          stickyRiverOutsideKm: 0,
        };
      } else {
        return {
          name: peek.name,
          stickyLake: peek.name,
          stickyOutsideKm: 0,
          stickyRiver: null,
          stickyRiverOutsideKm: 0,
        };
      }
    }

    // Another named waterway is clearly under the track → switch label.
    // Require leaving the sticky centerline OR a large distance gap — otherwise
    // a tributary that only passes nearby steals the label for a few hundred m.
    if (localNear && localKey && localKey !== key) {
      const onSticky =
        stickyDist != null && stickyDist <= 0.38
          ? stickyDist
          : stickyDist == null && localKey !== key
            ? 0.5
            : stickyDist ?? 0.5;
      const other = localNear.distKm;
      const clearlyOffSticky = onSticky > 0.42;
      const clearlyCloser = other + 0.2 < onSticky;
      const tightOnOther = other <= 0.14 && onSticky > 0.3;
      const allowTrunkSteal =
        isTrunkRiver(localNear.name) && !isTrunkRiver(stickyRiver)
          ? other <= 0.18 && onSticky > 0.32
          : true;
      const allowCanalSteal =
        isMoscowCanalName(localNear.name) && !isMoscowCanalName(stickyRiver)
          ? other <= 0.16 && onSticky > 0.28
          : true;
      if (
        ((clearlyOffSticky && other <= 0.28) || clearlyCloser || tightOnOther) &&
        allowTrunkSteal &&
        allowCanalSteal
      ) {
        return {
          name: localNear.name,
          stickyLake: null,
          stickyOutsideKm: 0,
          stickyRiver: stickyNameForRiver(localNear.name),
          stickyRiverOutsideKm: 0,
        };
      }
    }

    // Still on the sticky river centerline.
    if (
      (localNear && localKey === key && localNear.distKm <= 0.65) ||
      (stickyDist != null && stickyDist <= 0.45)
    ) {
      return {
        name: stickyRiver,
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver,
        stickyRiverOutsideKm: 0,
      };
    }

    // Terminal / mouth: release back to the trunk / parent river.
    // Do not release Вохма→Ветлуга on upstream meanders north of the confluence.
    const atVetlugaMouth =
      key === 'ветлуга' &&
      p.lat < VETLUGA_MOUTH.lat - 0.02 &&
      !onVetlugaAboveMouth(p);
    const atVohmaMouth =
      key === 'вохма' &&
      p.lat < VOHMA_MOUTH.lat - 0.02 &&
      haversineKm(p, MALOE_RAMENYE) + 0.5 < haversineKm(p, VOHMA_MOUTH);
    // Селижаровка mouth in Селижарово (~33.455E, 56.854N) — do not keep sticky into the Volga.
    const pastSelizharovka =
      key === 'селижаровка' &&
      (p.lon > 33.46 ||
        p.lat < 56.85 ||
        (peek?.kind === 'river' && peek.name.toLocaleLowerCase('ru') === 'волга'));
    if (atVetlugaMouth || atVohmaMouth || pastSelizharovka) {
      stickyRiver = null;
      stickyRiverOutsideKm = 0;
    } else if (key === 'вохма' && peek?.kind === 'river' && peek.name.toLocaleLowerCase('ru') === 'ветлуга') {
      // Once on the Vohma climb, never fall back to Vetluga labeling.
      return {
        name: stickyRiver,
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver,
        stickyRiverOutsideKm: 0,
      };
    } else if (key === 'ветлуга' && peek?.kind === 'river' && peek.name.toLocaleLowerCase('ru') === 'волга') {
      // Keep Vetluga through short Volga catalog hits on the climb.
      return {
        name: stickyRiver,
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver,
        stickyRiverOutsideKm: 0,
      };
    } else if (inBody) {
      return {
        name: stickyRiver,
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver,
        stickyRiverOutsideKm: 0,
      };
    } else if (isStrongCorridorSticky(stickyRiver)) {
      // Never flip a long climb (Ветлуга→Вохма) to Волга just because the
      // track left a rectangular catalog box — real river meanders widely.
      return {
        name: stickyRiver,
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver,
        stickyRiverOutsideKm: 0,
      };
    } else {
      const outside = stickyRiverOutsideKm + stepKm;
      const holdKm = isTrunkRiver(stickyRiver) ? 1.5 : 4;
      if (outside < holdKm) {
        return {
          name: stickyRiver,
          stickyLake: null,
          stickyOutsideKm: 0,
          stickyRiver,
          stickyRiverOutsideKm: outside,
        };
      }
      stickyRiver = null;
      stickyRiverOutsideKm = 0;
    }
  }

  if (stickyLake) {
    const body = catalogBodyByName(stickyLake);
    const lock = RESERVOIR_LOCKS[stickyLake.toLocaleLowerCase('ru')];
    const lakeKey = stickyLake.toLocaleLowerCase('ru');
    // Past the dam/lock → river, not the reservoir (no hysteresis across the gate).
    if (lock && pastReservoirLock(p, lock)) {
      retireLakeName(usedNames, stickyLake);
      stickyLake = null;
      stickyOutsideKm = 0;
    } else if (lakeKey.includes('чебоксар') && onVetlugaAboveMouth(p)) {
      // Reservoir box covers lower Ветлуга; leave Чебоксарское at the real mouth.
      retireLakeName(usedNames, stickyLake);
      return {
        name: 'Ветлуга',
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver: 'Ветлуга',
        stickyRiverOutsideKm: 0,
      };
    } else if (body && pointInCatalog(p, body)) {
      return {
        name: stickyLake,
        stickyLake,
        stickyOutsideKm: 0,
        stickyRiver,
        stickyRiverOutsideKm,
      };
    } else {
      // Leaving a lake into a named tributary / outflow (Селижаровка, Нева, Белая…):
      // switch immediately — do not let lake hysteresis swallow the river.
      const catalogNow = pickCatalogName(p, usedNames);
      if (catalogNow?.kind === 'river') {
        const riverBody = catalogBodyByName(catalogNow.name);
        const volga = catalogBodyByName('Волга');
        if (
          riverBody &&
          volga &&
          catalogArea(riverBody) < catalogArea(volga) * 0.45
        ) {
          retireLakeName(usedNames, stickyLake);
          const riverSticky = isCorridorTributary(catalogNow.name)
            ? catalogNow.name
            : null;
          return {
            name: catalogNow.name,
            stickyLake: null,
            stickyOutsideKm: 0,
            stickyRiver: riverSticky,
            stickyRiverOutsideKm: 0,
          };
        }
      }

      // Short hysteresis — long hold made Селигер/Селижаровка split unstable.
      const outside = stickyOutsideKm + stepKm;
      const hystKm = stickyLake.toLocaleLowerCase('ru').includes('селигер') ? 1.5 : 4;
      if (outside < hystKm) {
        return {
          name: stickyLake,
          stickyLake,
          stickyOutsideKm: outside,
          stickyRiver,
          stickyRiverOutsideKm,
        };
      }
      retireLakeName(usedNames, stickyLake);
      stickyLake = null;
      stickyOutsideKm = 0;
    }
  }

  // Catalog lakes first, but a river under the track (Сходня у Химкинского) wins.
  const catalog = pickCatalogName(p, usedNames);
  const local = nearestLocalWaterwayName(p, 0.55, { trackBearing });
  if (shouldPreferLocalWaterway(catalog, local) && local) {
    const stick = stickyNameForRiver(local.name);
    return {
      name: local.name,
      stickyLake: null,
      stickyOutsideKm: 0,
      stickyRiver: stick ?? stickyRiver,
      stickyRiverOutsideKm: stick ? 0 : stickyRiverOutsideKm,
    };
  }
  if (catalog?.kind === 'lake') {
    return {
      name: catalog.name,
      stickyLake: catalog.name,
      stickyOutsideKm: 0,
      stickyRiver: null,
      stickyRiverOutsideKm: 0,
    };
  }

  if (catalog?.kind === 'river') {
    const riverSticky =
      isCorridorTributary(catalog.name) || !isTrunkRiver(catalog.name)
        ? catalog.name
        : null;
    return {
      name: catalog.name,
      stickyLake: null,
      stickyOutsideKm: 0,
      stickyRiver: riverSticky ?? stickyRiver,
      stickyRiverOutsideKm: riverSticky ? 0 : stickyRiverOutsideKm,
    };
  }
  // Last resort: any nearby named waterway even without catalog coverage.
  // Tighter radius — avoid grabbing a tributary that only passes near the track.
  if (local && local.distKm <= 0.35) {
    const stick = stickyNameForRiver(local.name);
    return {
      name: local.name,
      stickyLake: null,
      stickyOutsideKm: 0,
      stickyRiver: stick ?? stickyRiver,
      stickyRiverOutsideKm: stick ? 0 : stickyRiverOutsideKm,
    };
  }
  return {
    name: null,
    stickyLake: null,
    stickyOutsideKm: 0,
    stickyRiver,
    stickyRiverOutsideKm,
  };
}

/** Merge Чебоксарское↔Ветлуга↔Волга / Вохма flickers into a clean cascade climb. */
function collapseVetlugaMouthFlicker(segments: ItinerarySegment[]): ItinerarySegment[] {
  if (segments.length < 2) return segments;
  const out = segments.map((s) => ({ ...s }));
  const keyOf = (s: ItinerarySegment) => s.name.toLocaleLowerCase('ru');
  const isCheb = (s: ItinerarySegment) => keyOf(s).includes('чебоксар');
  const isKuib = (s: ItinerarySegment) => keyOf(s).includes('куйбышев');
  const isCascadeLake = (s: ItinerarySegment) =>
    isCheb(s) ||
    isKuib(s) ||
    keyOf(s).includes('горьков') ||
    keyOf(s).includes('рыбин') ||
    keyOf(s).includes('углич') ||
    keyOf(s).includes('иваньков');
  const isVetluga = (s: ItinerarySegment) => keyOf(s) === 'ветлуга';
  const isVohma = (s: ItinerarySegment) => keyOf(s) === 'вохма';
  const isVolga = (s: ItinerarySegment) => keyOf(s) === 'волга';

  let guard = 0;
  while (guard++ < 60) {
    let changed = false;
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i]!;
      const b = out[i + 1]!;
      const c = out[i + 2];

      // Cascade lake — short Волга — cascade lake → absorb Волга into the previous lake.
      if (isCascadeLake(a) && isVolga(b) && b.km < 20 && c && isCascadeLake(c)) {
        a.km += b.km;
        out.splice(i + 1, 1);
        changed = true;
        break;
      }
      // Ветлуга — Чебоксарское → keep Ветлуга (climb already started).
      if (isVetluga(a) && isCheb(b)) {
        a.km += b.km;
        out.splice(i + 1, 1);
        changed = true;
        break;
      }
      // Чебоксарское — Волга — Ветлуга → absorb Волга into Чебоксарское.
      if (isCheb(a) && isVolga(b) && c && isVetluga(c)) {
        a.km += b.km;
        out.splice(i + 1, 1);
        changed = true;
        break;
      }
      // Чебоксарское — Ветлуга — Волга — Ветлуга (mouth flicker) → one Ветлуга climb.
      if (isCheb(a) && isVetluga(b) && c && isVolga(c) && out[i + 3] && isVetluga(out[i + 3]!)) {
        const longVetluga = out[i + 3]!;
        longVetluga.km += b.km + c.km;
        out.splice(i + 1, 2);
        changed = true;
        break;
      }
      // Ветлуга — Волга — Ветлуга → one Ветлуга.
      if (isVetluga(a) && isVolga(b) && c && isVetluga(c)) {
        a.km += b.km + c.km;
        out.splice(i + 1, 2);
        changed = true;
        break;
      }
      // Short Ветлуга — Волга — Ветлуга after a lake.
      if (isVetluga(a) && isVolga(b) && a.km < 20 && b.km < 20) {
        const prev = i > 0 ? out[i - 1] : null;
        if (prev && isCheb(prev) && c && isVetluga(c)) {
          prev.km += a.km + b.km;
          out.splice(i, 2);
          changed = true;
          break;
        }
      }
      // Чебоксарское — Ветлуга — Чебоксарское → absorb trailing reservoir into Ветлуга.
      if (isCheb(a) && isVetluga(b) && c && isCheb(c)) {
        b.km += c.km;
        out.splice(i + 2, 1);
        changed = true;
        break;
      }
      // Волга — Ветлуга right after Чебоксарское: absorb short Волга.
      if (isVolga(a) && isVetluga(b) && a.km < 20) {
        const prev = i > 0 ? out[i - 1] : null;
        if (prev && isCheb(prev)) {
          prev.km += a.km;
          out.splice(i, 1);
          changed = true;
          break;
        }
      }
      // … — Вохма — Ветлуга (trailing): stay on Вохма once the climb entered it.
      if (isVohma(a) && isVetluga(b) && !c) {
        a.km += b.km;
        out.splice(i + 1, 1);
        changed = true;
        break;
      }
      // Ветлуга — Вохма — Ветлуга
      if (isVetluga(a) && isVohma(b) && c && isVetluga(c)) {
        if (b.km >= 20) {
          // Real Вохма climb with a false trailing Ветлуга label → keep Вохма.
          b.km += c.km;
          out.splice(i + 2, 1);
        } else {
          // Tiny Вохма blip on the Vetluga stem.
          a.km += b.km + c.km;
          out.splice(i + 1, 2);
        }
        changed = true;
        break;
      }
      // Short Волга anywhere between corridor/cascade names.
      if (isVolga(b) && b.km < 12) {
        const prev = a;
        const next = c;
        if (
          next &&
          (isCascadeLake(prev) || isVetluga(prev) || isVohma(prev)) &&
          (isCascadeLake(next) || isVetluga(next) || isVohma(next))
        ) {
          prev.km += b.km;
          out.splice(i + 1, 1);
          changed = true;
          break;
        }
      }
    }
    if (!changed) break;
  }
  return collapseAdjacentSegments(out);
}
function mergeShortSegments(segments: ItinerarySegment[], minKm = 1.2): ItinerarySegment[] {
  if (segments.length <= 1) return segments;
  const out: ItinerarySegment[] = segments.map((s) => ({ ...s }));
  let i = 0;
  while (i < out.length) {
    const s = out[i]!;
    if (s.km >= minKm || out.length === 1) {
      i += 1;
      continue;
    }
    const prev = i > 0 ? out[i - 1] : null;
    const next = i + 1 < out.length ? out[i + 1] : null;
    // Keep distinct non-trunk rivers (Сходня, Истра…) even when short —
    // do not fold them into Волга / Москва.
    const protectNamed =
      s.km >= 0.55 &&
      !isTrunkRiver(s.name) &&
      !isLakeCatalogName(s.name) &&
      ((prev && isTrunkRiver(prev.name)) || (next && isTrunkRiver(next.name)));
    if (protectNamed) {
      i += 1;
      continue;
    }
    if (prev && next && prev.name.toLocaleLowerCase('ru') === next.name.toLocaleLowerCase('ru')) {
      prev.km += s.km + next.km;
      out.splice(i, 2);
      continue;
    }
    if (prev && (!next || prev.km >= (next?.km ?? 0))) {
      prev.km += s.km;
      out.splice(i, 1);
      continue;
    }
    if (next) {
      next.km += s.km;
      out.splice(i, 1);
      continue;
    }
    i += 1;
  }
  return collapseAdjacentSegments(out);
}

/** Fold short Moscow-Canal blips that flicker between real rivers / Khimki. */
function collapseMoscowCanalFlicker(segments: ItinerarySegment[]): ItinerarySegment[] {
  if (segments.length < 2) return segments;
  const out = segments.map((s) => ({
    ...s,
    name: canonicalWaterwayName(s.name),
  }));
  const isCanal = (s: ItinerarySegment) => isMoscowCanalName(s.name);
  const isKhimki = (s: ItinerarySegment) =>
    s.name.toLocaleLowerCase('ru').includes('химкинск');
  let guard = 0;
  while (guard++ < 40) {
    let changed = false;
    for (let i = 0; i < out.length; i++) {
      const s = out[i]!;
      const prev = i > 0 ? out[i - 1] : null;
      const next = i + 1 < out.length ? out[i + 1] : null;

      // Short Химкинское between rivers (Сходня mouth bbox) then real Moskva→Khimki:
      // Химкинское — Москва — Химкинское → drop the first blip into Москва.
      if (
        isKhimki(s) &&
        s.km < 5 &&
        next &&
        next.name.toLocaleLowerCase('ru') === 'москва' &&
        out[i + 2] &&
        isKhimki(out[i + 2]!)
      ) {
        next.km += s.km;
        out.splice(i, 1);
        changed = true;
        break;
      }

      if (!isCanal(s)) continue;
      // Short canal between two non-canal stretches → absorb into the longer neighbor.
      if (s.km >= 8) continue;
      if (prev && next && !isCanal(prev) && !isCanal(next)) {
        if (prev.name.toLocaleLowerCase('ru') === next.name.toLocaleLowerCase('ru')) {
          prev.km += s.km + next.km;
          out.splice(i, 2);
        } else if (prev.km >= next.km) {
          prev.km += s.km;
          out.splice(i, 1);
        } else {
          next.km += s.km;
          out.splice(i, 1);
        }
        changed = true;
        break;
      }
      // Leading short canal before a river (Горетовка/Сходня) — drop into the river.
      if (!prev && next && !isCanal(next) && s.km < 12) {
        next.km += s.km;
        out.splice(i, 1);
        changed = true;
        break;
      }
      // Trailing short canal after a lake/river when destination is Khimki pool:
      // keep canal only if longer than 6 km (real КиМ fairway).
      if (prev && !next && !isCanal(prev) && s.km < 6) {
        prev.km += s.km;
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  return collapseAdjacentSegments(out);
}

/** Merge consecutive stretches that share the same name. */
function collapseAdjacentSegments(segments: ItinerarySegment[]): ItinerarySegment[] {
  const collapsed: ItinerarySegment[] = [];
  for (const s of segments) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.name.toLocaleLowerCase('ru') === s.name.toLocaleLowerCase('ru')) {
      prev.km += s.km;
      if (!prev.gvrCode && s.gvrCode) {
        prev.gvrCode = s.gvrCode;
        prev.fromGvr = s.fromGvr;
      }
    } else {
      collapsed.push({ ...s });
    }
  }
  return collapsed;
}

/**
 * Fold A → short secondary B → A into a single A.
 *
 * Absorbs B only when it is a short non-trunk, non-lake, non-corridor blip
 * between identical neighbours. Does not apply a global “drop all short”
 * rule and does not touch A → B → C (different outer names).
 *
 * `shortMaxKm` defaults to the same 1.2 km used by mergeShortSegments.
 */
export function foldSandwichedShortSegments(
  segments: ItinerarySegment[],
  shortMaxKm = 1.2,
): ItinerarySegment[] {
  if (segments.length < 3) {
    return segments.map((s) => ({ ...s }));
  }
  const out = segments.map((s) => ({ ...s }));
  let i = 0;
  while (i + 2 < out.length) {
    const left = out[i]!;
    const mid = out[i + 1]!;
    const right = out[i + 2]!;
    const sameOuter =
      left.name.toLocaleLowerCase('ru') === right.name.toLocaleLowerCase('ru');
    const absorbMid =
      sameOuter &&
      mid.km <= shortMaxKm &&
      !isTrunkRiver(mid.name) &&
      !isLakeCatalogName(mid.name) &&
      !isCorridorTributary(mid.name);
    if (!absorbMid) {
      i += 1;
      continue;
    }
    left.km += mid.km + right.km;
    if (!left.gvrCode && right.gvrCode) {
      left.gvrCode = right.gvrCode;
      left.fromGvr = right.fromGvr;
    }
    out.splice(i + 1, 2);
  }
  return collapseAdjacentSegments(out);
}

/** Scale stretch lengths so they sum to the reported route distance. */
function scaleSegmentsToTotal(segments: ItinerarySegment[], totalKm: number): ItinerarySegment[] {
  if (!(totalKm > 0) || segments.length === 0) return segments;
  const sum = segments.reduce((a, s) => a + s.km, 0);
  if (!(sum > 0)) return segments;
  const drift = Math.abs(sum - totalKm) / totalKm;
  // Same geometry → tiny drift only. Large drift means a bug — do not distort.
  if (drift > 0.04) return segments;
  const k = totalKm / sum;
  return segments.map((s) => ({ ...s, km: s.km * k }));
}

/**
 * Length + itinerary from the full navigable track; optional thinner line for the map.
 * Guarantees itinerary km are taken from the same geometry as lengthKm.
 */
async function finalizeMeasuredRoute(
  waterRef: LngLat[],
  trackLengthKm: number,
  waypoints: LngLat[],
  extras: {
    waterName: string | null;
    method: WaterPath['method'];
    /** When true, Overpass-enrich names (slow). Default: cache/catalog only. */
    enrich?: boolean;
    /** Authoritative navigable track when display geometry was polished. */
    routingGeometry?: LngLat[];
  },
): Promise<WaterPath> {
  // Keep meanders: only drop sub-12 m duplicates.
  const measurePath = simplifyPath(waterRef, 0.012);
  const routingSrc = extras.routingGeometry?.length
    ? simplifyPath(extras.routingGeometry, 0.012)
    : measurePath;
  const geomKm = pathLength(routingSrc);
  const measureKm = pathLength(measurePath);
  // Prefer BRouter track length when it matches the polyline (graph length).
  let lengthKm = geomKm;
  if (
    trackLengthKm > 0 &&
    Math.abs(trackLengthKm - geomKm) / Math.max(geomKm, 0.001) <= 0.06
  ) {
    lengthKm = trackLengthKm;
  } else if (Math.abs(measureKm - geomKm) / Math.max(geomKm, 0.001) <= 0.02) {
    lengthKm = measureKm;
  }

  const itinerary = await describeWaterItinerary(routingSrc, {
    totalKm: lengthKm,
    origin: waypoints[0],
    destination: waypoints[waypoints.length - 1],
    enrich: extras.enrich === true,
  });

  const displayPoints =
    measurePath.length > 10000
      ? downsampleOnWater(measurePath, 10000, 0.1)
      : measurePath;

  const dual = dualGeometry(routingSrc, displayPoints);

  return {
    points: dual.displayGeometry,
    lengthKm: dual.lengthKm || lengthKm,
    waterName: extras.waterName,
    method: extras.method,
    waypointCumKm: cumKmAlongPath(routingSrc, waypoints),
    itinerary: itinerary.length ? itinerary : undefined,
    routingGeometry: dual.routingGeometry,
    displayGeometry: dual.displayGeometry,
  };
}

/** Densify a sparse path so river/reservoir labels are not skipped while naming. */
function densifyPathForItinerary(path: LngLat[], stepKm = 1.2): LngLat[] {
  if (path.length < 2) return path;
  const out: LngLat[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const d = haversineKm(a, b);
    if (d > stepKm * 1.5) {
      const n = Math.min(80, Math.ceil(d / stepKm));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
      }
    }
    out.push(b);
  }
  return out;
}

/**
 * Build ordered waterway/reservoir chain with per-stretch distances.
 * Prefer nearby named OSM/water-core centerlines along the track so every
 * river on the path appears; catalog lakes/reservoirs still win on open water.
 * Crossing / nearby tributaries must persist ~0.7 km before stealing the label.
 */
function itineraryFromPath(path: LngLat[]): ItinerarySegment[] {
  if (path.length < 2) return [];
  path = densifyPathForItinerary(path);

  let stickyLake: string | null = null;
  let stickyOutsideKm = 0;
  let stickyRiver: string | null = null;
  let stickyRiverOutsideKm = 0;
  const usedNames = new Set<string>();
  const segments: ItinerarySegment[] = [];
  // Suppress «Канал имени Москвы» until after Иваньковское when the route
  // already visited mid-Volga reservoirs (avoids false canal labels on bad geometry).
  let seenEasternCascade = false;
  let seenIvankovo = false;

  const labelAt = (p: LngLat, stepKm: number, trackBearing: number | null): string | null => {
    const hit = nameAtSample(
      p,
      stickyLake,
      stickyOutsideKm,
      usedNames,
      stepKm,
      stickyRiver,
      stickyRiverOutsideKm,
      trackBearing,
    );
    stickyLake = hit.stickyLake;
    stickyOutsideKm = hit.stickyOutsideKm;
    stickyRiver = hit.stickyRiver;
    stickyRiverOutsideKm = hit.stickyRiverOutsideKm;
    if (!hit.name) return null;
    const name = canonicalWaterwayName(hit.name);
    const key = name.toLocaleLowerCase('ru');
    if (usedNames.has(key)) return null;

    if (key.includes('куйбышев') || key.includes('чебоксар') || key.includes('горьков')) {
      seenEasternCascade = true;
    }
    if (key.includes('иваньков')) {
      seenIvankovo = true;
    }
    if (
      key.includes('канал имени москвы') &&
      seenEasternCascade &&
      !seenIvankovo
    ) {
      // Still on the Volga cascade — do not label a canal detour here.
      return 'Волга';
    }
    return name;
  };

  const trackBearingAt = (i: number): number | null => {
    if (i > 0) return bearingDeg(path[i - 1]!, path[i]!);
    if (path.length > 1) return bearingDeg(path[0]!, path[1]!);
    return null;
  };

  let currentName = labelAt(path[0]!, 0, trackBearingAt(0));
  let currentKm = 0;
  /** Unlabeled stretch — attach to the next named segment (never drop / rescale-inflate). */
  let pendingKm = 0;
  /** Candidate name waiting for sustained confirmation (filters passing tributaries). */
  let pendingSwitchName: string | null = null;
  let pendingSwitchKm = 0;

  const flushNamed = () => {
    if (!currentName) {
      pendingKm += currentKm;
      currentKm = 0;
      return;
    }
    const add = currentKm;
    currentKm = 0;
    if (add < 0.05) return;
    const prev = segments[segments.length - 1];
    if (prev && prev.name.toLocaleLowerCase('ru') === currentName.toLocaleLowerCase('ru')) {
      prev.km += add;
    } else {
      segments.push(namedSegment(currentName, add));
    }
  };

  const confirmKmFor = (from: string | null, to: string): number => {
    if (!from) return 0;
    if (isLakeCatalogName(from) || isLakeCatalogName(to)) return 0.35;
    // Real river changes need a short sustained stretch; flickers are shorter.
    return 0.7;
  };

  for (let i = 1; i < path.length; i++) {
    const d = haversineKm(path[i - 1]!, path[i]!);
    let name = labelAt(path[i]!, d, trackBearingAt(i));

    // Require sustained agreement before switching river labels — a tributary
    // that only crosses or runs beside the track for <~700 m must not appear.
    if (
      name &&
      currentName &&
      name.toLocaleLowerCase('ru') !== currentName.toLocaleLowerCase('ru')
    ) {
      if (
        pendingSwitchName &&
        pendingSwitchName.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru')
      ) {
        pendingSwitchKm += d;
      } else {
        pendingSwitchName = name;
        pendingSwitchKm = d;
      }
      if (pendingSwitchKm < confirmKmFor(currentName, name)) {
        name = currentName;
      } else {
        pendingSwitchName = null;
        pendingSwitchKm = 0;
      }
    } else {
      pendingSwitchName = null;
      pendingSwitchKm = 0;
    }

    if (!name) {
      // Keep counting under the current label when possible; otherwise hold as pending.
      if (currentName) currentKm += d;
      else pendingKm += d;
      continue;
    }

    if (currentName && name.toLocaleLowerCase('ru') === currentName.toLocaleLowerCase('ru')) {
      currentKm += d + pendingKm;
      pendingKm = 0;
      continue;
    }

    // Switch label: close previous, give unlabeled gap to the new stretch.
    if (currentName) {
      currentKm += d / 2;
      flushNamed();
      if (currentName && name !== currentName) {
        if (isLakeCatalogName(currentName)) {
          retireLakeName(usedNames, currentName);
        } else if (
          // Never lock Ветлуга/Селижаровка/… on a Volga confluence flicker —
          // that turned the whole Vetluga climb into «Волга (500 км)».
          !isTrunkRiver(currentName) &&
          !isCorridorTributary(currentName) &&
          isLakeCatalogName(name)
        ) {
          // Non-cascade river entering a lake — do not permanently ban the river name.
        }
      }
      currentName = name;
      currentKm = d / 2 + pendingKm;
      pendingKm = 0;
    } else {
      currentName = name;
      currentKm = d + pendingKm;
      pendingKm = 0;
    }
  }

  flushNamed();
  if (pendingKm >= 0.5) {
    if (segments.length) {
      segments[segments.length - 1]!.km += pendingKm;
    } else if (currentName) {
      segments.push(namedSegment(currentName, pendingKm));
    }
  }
  return foldSandwichedShortSegments(
    mergeShortSegments(
      collapseMoscowCanalFlicker(collapseVetlugaMouthFlicker(segments)),
      1.2,
    ),
  );
}

export type ItineraryOptions = {
  /**
   * Reported route length (e.g. BRouter). Segment km are scaled to this total
   * so the description matches the distance shown in stats.
   */
  totalKm?: number;
  /** Route endpoints — used to reject impossible cascade/Москва mixes. */
  origin?: LngLat;
  destination?: LngLat;
  /**
   * Fetch named OSM waterways along the path before labeling.
   * Default false for instant routes; enable in background polish.
   */
  enrich?: boolean;
};

/**
 * Ordered chain of named waterways / reservoirs along a route geometry,
 * e.g. «Волга (215 км) — Иваньковское водохранилище (120 км) — …».
 */
export async function describeWaterItinerary(
  path: LngLat[],
  opts: ItineraryOptions = {},
): Promise<ItinerarySegment[]> {
  if (path.length < 2) return [];
  await ensureGvrIndex();
  await ensureCoreWaterways();
  if (opts.enrich) {
    try {
      await enrichNamedWaterwaysForItinerary(path);
    } catch {
      // Continue with catalog + whatever is already cached.
    }
  }
  let chain = itineraryFromPath(path);

  const hasMoskva = chain.some((s) => {
    const k = s.name.toLocaleLowerCase('ru');
    return k === 'москва' || k.includes('канал имени москвы');
  });
  const hasCascade = chain.some((s) => {
    const k = s.name.toLocaleLowerCase('ru');
    return (
      k.includes('куйбышев') ||
      k.includes('чебоксар') ||
      k.includes('горьков') ||
      k.includes('рыбин') ||
      k.includes('углич') ||
      k.includes('иваньков')
    );
  });

  const origin = opts.origin ?? path[0]!;
  const destination = opts.destination ?? path[path.length - 1]!;
  const nearMos =
    origin.lat >= 55.4 &&
    origin.lat <= 56.35 &&
    origin.lon >= 36.9 &&
    origin.lon <= 38.1;
  const nearMosB =
    destination.lat >= 55.4 &&
    destination.lat <= 56.35 &&
    destination.lon >= 36.9 &&
    destination.lon <= 38.1;

  // «Москва» / канал on a cascade itinerary = wrong branch (unless endpoint is Moscow).
  // Drop only those false stretches — never strip Иваньковское (it sits next to the canal junction).
  if (hasMoskva && hasCascade && !nearMos && !nearMosB) {
    chain = chain.filter((s) => {
      const k = s.name.toLocaleLowerCase('ru');
      return k !== 'москва' && !k.includes('канал имени москвы');
    });
    if (!chain.length) return [];
  }

  // Collapse neighbours left adjacent after filters (e.g. Волга — [removed] — Волга).
  chain = collapseAdjacentSegments(chain);
  chain = collapseVetlugaMouthFlicker(chain);
  chain = collapseMoscowCanalFlicker(chain);
  chain = foldSandwichedShortSegments(chain);

  const geo = haversineKm(origin, destination);
  if (opts.totalKm && geo > 40 && opts.totalKm > geo * 3.5) {
    return [];
  }

  if (opts.totalKm && opts.totalKm > 0) {
    chain = scaleSegmentsToTotal(chain, opts.totalKm);
  }
  return chain;
}

/** Format itinerary for UI / clipboard — только имя и длина участка. */
export function formatItinerary(segments: ItinerarySegment[]): string {
  return segments
    .filter((s) => s.name)
    .map((s) => {
      const km = Math.max(0.1, Math.round(s.km * 10) / 10);
      const kmText = km.toLocaleString('ru-RU', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 1,
      });
      return `${s.name} (${kmText} км)`;
    })
    .join(' — ');
}

export async function routeAlongWater(origin: LngLat, destination: LngLat): Promise<WaterPath> {
  return measureWaterChain([origin, destination]);
}

export async function measureWaterChain(waypoints: LngLat[]): Promise<WaterPath> {
  const perf = createRoutePerfCounters();
  setRoutePerf(perf);
  beginProviderRequestScope();
  beginFallbackTimeline();
  try {
    return await measureWaterChainInner(waypoints, perf);
  } finally {
    endProviderRequestScope();
    setRoutePerf(null);
    endFallbackTimeline();
  }
}

async function measureWaterChainInner(
  waypoints: LngLat[],
  perf: ReturnType<typeof createRoutePerfCounters>,
): Promise<WaterPath> {
  if (waypoints.length < 2) {
    const trace = beginRouteTrace(waypoints, 0);
    trace.perf = perf;
    const empty: WaterPath = {
      points: waypoints.slice(),
      lengthKm: 0,
      waterName: null,
      method: 'route_not_found',
      waypointCumKm: waypoints.map(() => 0),
      routingGeometry: [],
      displayGeometry: [],
    };
    trace.lastRejectReason = 'too_few_waypoints';
    trace.finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'too_few_waypoints',
      waterName: null,
    });
    return empty;
  }

  resetPhaseCBrouterTrials();
  await ensureCoreWaterways();

  /** Original user coordinates — endpoint reach is always measured against these. */
  const originalWaypoints = waypoints.map((w) => ({ lon: w.lon, lat: w.lat }));
  const geoSpanKm0 =
    originalWaypoints.length === 2
      ? haversineKm(originalWaypoints[0]!, originalWaypoints[1]!)
      : routeSpanKm(originalWaypoints);
  const trace: RouteTraceBuilder = beginRouteTrace(originalWaypoints, geoSpanKm0);
  trace.perf = perf;

  /** Water mode must never present a geodesic START→FINISH chord as success. */
  const routeNotFound = (): WaterPath => ({
    points: [],
    lengthKm: 0,
    waterName: null,
    method: 'route_not_found',
    waypointCumKm: originalWaypoints.map(() => 0),
    routingGeometry: [],
    displayGeometry: [],
  });

  const attachKnowledge = (path: WaterPath): void => {
    // E2 advisory only — never changes accept/reject / ranking / thresholds.
    const t0 = nowPerfMs();
    try {
      const routePts =
        path.routingGeometry && path.routingGeometry.length >= 2
          ? path.routingGeometry
          : path.points.length >= 2
            ? path.points
            : originalWaypoints;
      const wk = getWaterKnowledgeForRoute({
        a: originalWaypoints[0]!,
        b: originalWaypoints[originalWaypoints.length - 1]!,
        route: routePts,
        riverHints: path.waterName ? [path.waterName] : null,
      });
      if (wk.factsMatched > 0) trace.knowledge = toRouteTraceKnowledge(wk);
    } catch {
      // Knowledge failures must never affect routing.
    } finally {
      addPerfMs('knowledgeMs', nowPerfMs() - t0);
    }
  };

  const emitDone = async (path: WaterPath, rejectReason?: string | null): Promise<WaterPath> => {
    attachKnowledge(path);
    // E2.0/E2.1 — WaterGraph shadow (diagnostic only; never changes returned path).
    // Shadow wall is timed separately and excluded from legacyRoutingMs in e2e.
    if (getRouteFeatureFlags().USE_WATER_GRAPH) {
      const tShadow0 = nowPerfMs();
      try {
        const aPt = originalWaypoints[0]!;
        const bPt = originalWaypoints[originalWaypoints.length - 1]!;
        const centerlines: CenterlineSource[] = [];

        // E2.1 — ingest real OSM/Overpass (or empty if offline) before legacy fallback.
        const ingest = await ingestCorridorCenterlines(aPt, bPt, {
          // Prefer live Overpass; fixtures are for unit tests only.
        });
        centerlines.push(...ingest.centerlines);

        const geom =
          path.routingGeometry && path.routingGeometry.length >= 2
            ? path.routingGeometry
            : path.points;
        // BRouter/legacy geometry is fallback provider only — not source of truth.
        if (
          centerlines.length === 0 &&
          geom.length >= 2 &&
          path.method !== 'route_not_found'
        ) {
          centerlines.push({
            id: 'legacy-route',
            kind: 'brouter',
            coords: geom,
            waterId: 'cl:legacy',
            source: 'legacy-measureWaterChain',
            sourceId: path.method,
          });
        }
        const shared = findSharedOpenLake(originalWaypoints);
        const lake = shared ? cachedLakeMaskAlongPath(originalWaypoints) : null;
        const shadow = runWaterGraphShadow({
          a: aPt,
          b: bPt,
          legacyLengthKm: path.lengthKm,
          legacyOk: path.method !== 'route_not_found' && path.points.length >= 2,
          candidates: trace.candidates.map((c) => ({
            endpoint: c.endpoint,
            point: { lon: c.point.lon, lat: c.point.lat },
            source: c.source,
            distKm: c.distKm,
            classPenalty: c.classPenalty,
            stemPenalty: c.stemPenalty,
            rank: c.rank,
          })),
          centerlines,
          lake,
          lakeComplete: lake ? isLakeMaskComplete(lake) : false,
          ingest: {
            failureCode: ingest.failureCode,
            stats: ingest.stats,
          },
        });
        const comps = shadow.components;
        const timing = shadow.timing;
        const ek = shadow.edgeKindCounts;
        trace.graph = {
          ...trace.graph,
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
          centerlineIngestMs: timing?.centerlineIngestMs ?? ingest.stats.ingestMs,
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
          centerlineSource: shadow.provenance.centerlineSource,
          sourceFeatureCount: shadow.provenance.sourceFeatureCount,
          sourceWaterwayIds: shadow.provenance.sourceWaterwayIds,
          osmFeatureCount: shadow.provenance.osmFeatureCount,
          acceptedFeatureCount: shadow.provenance.acceptedFeatureCount,
          rejectedFeatureCount: shadow.provenance.rejectedFeatureCount,
          rejectionReasons: shadow.provenance.rejectionReasons,
          dataTimestampMs: shadow.provenance.dataTimestampMs,
          corridorBbox: shadow.provenance.corridorBbox,
          provenanceSources: shadow.provenance.sources,
          note: 'E2.1 WaterGraph shadow + OSM centerline ingest — production result remains legacy',
        };
      } catch {
        // Shadow failures must never affect routing.
      } finally {
        trace.graphShadowRan = true;
        trace.graphShadowMs = nowPerfMs() - tShadow0;
      }
    }
    // Tiny finalization bucket so optional stage is present without changing behavior.
    addPerfMs('finalAssemblyMs', 0.001);
    if (path.method === 'route_not_found' || path.points.length < 2) {
      markFallbackEvent('final_reject', 'final', rejectReason ?? trace.lastRejectReason ?? 'route_not_found');
      trace.finish({
        ok: false,
        method: 'route_not_found',
        lengthKm: 0,
        rejectReason: rejectReason ?? trace.lastRejectReason ?? 'route_not_found',
        waterName: null,
      });
    } else {
      markFallbackEvent('final_ok', 'final', path.method);
      trace.finish({
        ok: true,
        method: path.method,
        lengthKm: path.lengthKm,
        rejectReason: null,
        waterName: path.waterName,
      });
    }
    return path;
  };

  const acceptPath = async (
    routing: LngLat[],
    display: LngLat[],
    trackLengthKm: number,
    extras: {
      waterName: string | null;
      method: 'waterway' | 'lake';
      enrich?: boolean;
      /** Phase A: mask-verified open-water track — skip dry-land chord heuristics. */
      openWaterVerified?: boolean;
      /** Optional residual override (Phase C long shared-lake only). */
      endpointSnapKm?: number;
    },
  ): Promise<WaterPath | null> => {
    // Phase A verified open-lake → full 10 km reach.
    // Phase B shared-bbox BRouter → 5.5 km stem-miss ceiling (not full open snap).
    const snapKm =
      extras.endpointSnapKm ??
      endpointSnapKmForAccept(extras.method, Boolean(extras.openWaterVerified));
    // Hard gate: routing ends must reach the *original* START/FINISH.
    const reach = endpointReachToOriginals(routing, originalWaypoints, snapKm);
    if (!reach.ok) {
      // Trace only — identical reject.
      trace.validator = { ok: false, issues: ['endpoints_far'] };
      trace.lastRejectReason = `endpoints_far ${reach.startKm.toFixed(2)}/${reach.finishKm.toFixed(2)}>${snapKm}`;
      if (routing.length >= 2) {
        try {
          trace.hydro = hydroToTrace(evaluateHydroAcceptGate(routing));
        } catch {
          /* ignore */
        }
      }
      return null;
    }

    const validation = timeSync('validationMs', () =>
      validateWaterRoute(routing, {
        waypoints: originalWaypoints,
        lengthKm: trackLengthKm > 0 ? trackLengthKm : pathLength(routing),
        method: extras.method,
        endpointSnapKm: snapKm,
        openWaterVerified: extras.openWaterVerified,
      }),
    );
    // Trace copy of validator / hydro — does not alter accept.
    trace.validator = { ok: validation.ok, issues: validation.issues.slice() };
    if (routing.length >= 2) {
      const tH = nowPerfMs();
      try {
        trace.hydro = hydroToTrace(evaluateHydroAcceptGate(routing));
      } catch {
        /* ignore */
      } finally {
        addPerfMs('hydroMs', nowPerfMs() - tH);
      }
    }
    if (!validation.ok) {
      trace.lastRejectReason = validation.issues.join(',') || 'validator_reject';
      return null;
    }
    return finalizeMeasuredRoute(display, trackLengthKm, originalWaypoints, {
      waterName: extras.waterName,
      method: extras.method,
      enrich: extras.enrich,
      routingGeometry: routing,
    });
  };

  /** Snap each original waypoint onto nearby water (within MAX snap) for a retry. */
  const snapWaypointsForRetry = (): LngLat[] | null => {
    const maxKm = maxWaterSnapKm();
    const snapped: LngLat[] = [];
    let changed = false;
    for (const wp of originalWaypoints) {
      const hit = snapClickToWater(wp, maxKm);
      if (!hit || hit.distKm > maxKm) return null;
      if (hit.distKm >= 0.02) changed = true;
      snapped.push(hit.point);
    }
    return changed ? snapped : null;
  };

  const tryBrouterChain = async (
    routeWaypoints: LngLat[],
    method: 'waterway' | 'lake' = 'waterway',
    endpointSnapKm?: number,
    traceLabel: 'original' | 'snapped' | 'phase_c' = 'original',
  ): Promise<{ path: WaterPath | null; hadGeometry: boolean }> => {
    const brouted = await routeWithBrouterAdaptive(routeWaypoints);
    if (!brouted || brouted.points.length < 2 || brouted.lengthKm <= 0) {
      trace.brouterAttempts.push({
        label: traceLabel,
        hadGeometry: false,
      });
      return { path: null, hadGeometry: false };
    }
    if (routeWaypoints.length === 2) {
      const geo = haversineKm(routeWaypoints[0]!, routeWaypoints[1]!);
      if (geo > 40 && brouted.lengthKm > geo * 3.5) {
        trace.brouterAttempts.push({
          label: traceLabel,
          hadGeometry: true,
          lengthKm: brouted.lengthKm,
          validatorIssues: ['excessive_detour'],
        });
        trace.lastRejectReason = 'brouter_detour_cut';
        return { path: null, hadGeometry: true };
      }
    }
    const routing = brouted.points;
    const snapKm =
      endpointSnapKm ?? endpointSnapKmForAccept(method, false);
    const reach = endpointReachToOriginals(routing, originalWaypoints, snapKm);
    const straightened = await straightenOpenWaterSpans(routing, { cachedOnly: true });
    const safeDisplay = chooseSafeDisplayGeometry(
      routing,
      straightened,
      cachedLakeMaskAlongPath(routing),
    );
    const display = refineRouteGeometryFast(safeDisplay);
    const named = waterNameFromTags(brouted.wayTags) ?? namesNearEndpoints(routing);
    const path = await acceptPath(routing, display, brouted.lengthKm, {
      waterName: named,
      method,
      enrich: false,
      endpointSnapKm,
    });
    trace.brouterAttempts.push({
      label: traceLabel,
      hadGeometry: true,
      lengthKm: brouted.lengthKm,
      residual: {
        startKm: reach.startKm,
        finishKm: reach.finishKm,
        snapKm,
        ok: reach.ok,
      },
      validatorIssues: trace.validator?.issues.slice(),
    });
    return { path, hadGeometry: true };
  };

  /**
   * Phase C: destination-biased multi-candidate A×B trials (budget ≤ 3×3).
   * Acceptance ceilings unchanged for Phase A/B paths.
   * Long shared-lake hops (geo > Phase B 150 km cap, e.g. L07) may use a
   * Phase-C-only residual up to fairway search radius so inland shore clicks
   * can bind to fairway pins — Vetluga-class short stems keep 5.5 km.
   */
  const tryPhaseCMultiCandidate = async (
    method: 'waterway' | 'lake',
    allowOpenLake: boolean,
  ): Promise<WaterPath | null> => {
    const phaseCId = beginFallbackEvent('phase_c', 'phaseC', {
      meta: { method, allowOpenLake },
    });
    const finishPhaseC = (result: string, path: WaterPath | null): WaterPath | null => {
      endFallbackEvent(phaseCId, result);
      return path;
    };
    if (originalWaypoints.length !== 2) return finishPhaseC('too_few_waypoints', null);
    const a = originalWaypoints[0]!;
    const b = originalWaypoints[1]!;
    // Do not invent open-lake chords across the Rybinsk dam (DAM regression).
    if (endpointsStraddleRybinskBarrier(a, b)) {
      trace.phases.C = {
        attempted: true,
        ok: false,
        phase: 'C',
        rejectReason: 'dam_straddle',
      };
      trace.lastRejectReason = 'dam_straddle';
      return finishPhaseC('dam_straddle', null);
    }

    const searchKm = maxOpenWaterSnapKm();
    const k = PHASE_C_K;
    const geo = haversineKm(a, b);
    const phaseCMethod: 'waterway' | 'lake' = allowOpenLake ? 'lake' : method;
    const longSharedLake = allowOpenLake && geo > MAX_SHARED_LAKE_BROUTER_KM;
    const phaseCSnapKm = longSharedLake
      ? Math.min(PHASE_C_FAIRWAY_SEARCH_KM, 12)
      : endpointSnapKmForAccept(phaseCMethod, false);

    const tCand = nowPerfMs();
    let candsA = snapWaterCandidates(a, searchKm, k, b);
    let candsB = snapWaterCandidates(b, searchKm, k, a);

    if (allowOpenLake) {
      const tPins = nowPerfMs();
      const [pinsA, pinsB] = await Promise.all([
        openLakePinsToward(a, b, searchKm, k),
        openLakePinsToward(b, a, searchKm, k),
      ]);
      addPerfMs('openLakeMs', nowPerfMs() - tPins);
      const perfPins = getRoutePerf();
      if (perfPins) perfPins.openLakeOps += 2;
      const maskA: WaterCandidate[] = pinsA.map((pt) => ({
        point: pt,
        distKm: haversineKm(a, pt),
        source: 'mask' as const,
        rank: candidateRank(haversineKm(a, pt), a, pt, b, 'mask'),
      }));
      const maskB: WaterCandidate[] = pinsB.map((pt) => ({
        point: pt,
        distKm: haversineKm(b, pt),
        source: 'mask' as const,
        rank: candidateRank(haversineKm(b, pt), b, pt, a, 'mask'),
      }));
      candsA = mergeCandidatePools([candsA, maskA], k);
      candsB = mergeCandidatePools([candsB, maskB], k);
    }
    addPerfMs('candidatesMs', nowPerfMs() - tCand);
    addPerfMs('bindMs', nowPerfMs() - tCand);
    {
      const perfC = getRoutePerf();
      if (perfC) perfC.candidateCount += candsA.length + candsB.length;
    }

    // E0: record candidate pool (side-effect only).
    trace.candidates = [
      ...candsA.map((c) =>
        candidateToTrace(
          'A',
          c,
          sourceClassPenalty(c.source),
          offFairwayStemPenalty(c.point, c.source),
        ),
      ),
      ...candsB.map((c) =>
        candidateToTrace(
          'B',
          c,
          sourceClassPenalty(c.source),
          offFairwayStemPenalty(c.point, c.source),
        ),
      ),
    ];

    if (!candsA.length || !candsB.length) {
      trace.phases.C = {
        attempted: true,
        ok: false,
        phase: 'C',
        method: phaseCMethod,
        rejectReason: 'snap_empty',
      };
      trace.lastRejectReason = 'snap_empty';
      markFallbackEvent('snap_empty', 'phaseC-snap', 'snap_empty', {
        meta: {
          candsA: candsA.length,
          candsB: candsB.length,
          allowOpenLake,
          searchKm,
        },
      });
      return finishPhaseC('snap_empty', null);
    }

    const maxPairs =
      getRouteFeatureFlags().PHASE_C_MAX_PAIRS_OVERRIDE ?? PHASE_C_MAX_PAIRS;
    const pairs = selectPhaseCPairs(candsA, candsB, a, b, maxPairs);
    if (!pairs.length) {
      trace.phases.C = {
        attempted: true,
        ok: false,
        phase: 'C',
        method: phaseCMethod,
        rejectReason: 'no_pairs',
      };
      return finishPhaseC('no_pairs', null);
    }
    {
      const perfP = getRoutePerf();
      if (perfP) perfP.pairCount += pairs.length;
    }

    let best: {
      path: WaterPath;
      score: number;
      ca: WaterCandidate;
      cb: WaterCandidate;
      via: 'brouter' | 'open_lake';
    } | null = null;
    let brouterLeft = maxPairs;
    let pairsTried = 0;
    const flagsC = getRouteFeatureFlags();
    const earlyStopEnabled = flagsC.USE_ROUTE_EARLY_STOP;

    const considerBrouterTrial = (
      ca: WaterCandidate,
      cb: WaterCandidate,
      trial: { path: WaterPath | null; hadGeometry: boolean },
    ): boolean => {
      // returns true if early-stop triggered
      if (!trial.path) return false;
      const geom = trial.path.routingGeometry ?? trial.path.points;
      const reach = endpointReachToOriginals(geom, originalWaypoints, 99);
      const classPen = pairClassPenalty(ca, cb);
      const score = scoreAcceptedPhaseCRoute(
        reach.startKm,
        reach.finishKm,
        trial.path.lengthKm,
        geo,
        { classPenalty: classPen, hydroReject: false },
      );
      if (!best || score < best.score) {
        best = { path: trial.path, score, ca, cb, via: 'brouter' };
      }
      if (
        shouldEarlyStopPhaseC({
          enabled: earlyStopEnabled,
          score,
          startResidualKm: reach.startKm,
          finishResidualKm: reach.finishKm,
          lengthKm: trial.path.lengthKm,
          geoKm: geo,
          classPenalty: classPen,
          hydroReject: false,
        })
      ) {
        const perfE = getRoutePerf();
        if (perfE) perfE.earlyStopTriggered = true;
        return true;
      }
      return false;
    };

    // E1.7 experimental: capped parallel BRouter trials (default off).
    if (flagsC.USE_PARALLEL_CANDIDATES) {
      const concurrency = flagsC.PARALLEL_CANDIDATE_CONCURRENCY;
      const slice = pairs.slice(0, brouterLeft);
      pairsTried = slice.length;
      const results = await mapPool(slice, concurrency, async ([ca, cb]) => {
        notePhaseCBrouterTrial();
        const perfT = getRoutePerf();
        if (perfT) perfT.trialCount += 1;
        const trial = await tryBrouterChain(
          [ca.point, cb.point],
          phaseCMethod,
          phaseCSnapKm,
          'phase_c',
        );
        return { ca, cb, trial };
      });
      brouterLeft = 0;
      for (const r of results) {
        if (considerBrouterTrial(r.ca, r.cb, r.trial) && earlyStopEnabled) break;
      }
      // Open-lake still sequential (lighter + mask-bound).
      if (allowOpenLake && !longSharedLake && !getRoutePerf()?.earlyStopTriggered) {
        for (const [ca, cb] of pairs) {
          const tLake = nowPerfMs();
          const open = await routeAcrossOpenLake([ca.point, cb.point]);
          addPerfMs('openLakeMs', nowPerfMs() - tLake);
          const perfLake = getRoutePerf();
          if (perfLake) perfLake.openLakeOps += 1;
          if (open && open.points.length >= 2 && open.lengthKm > 0) {
            const densified = densifyOpenWaterPath(open.points, 1.5);
            const accepted = await acceptPath(densified, densified, open.lengthKm, {
              waterName: open.waterName,
              method: 'lake',
              openWaterVerified: true,
              endpointSnapKm: MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM,
            });
            if (accepted) {
              const geom = accepted.routingGeometry ?? accepted.points;
              const reach = endpointReachToOriginals(geom, originalWaypoints, 99);
              const classPen = pairClassPenalty(ca, cb);
              const score = scoreAcceptedPhaseCRoute(
                reach.startKm,
                reach.finishKm,
                accepted.lengthKm,
                geo,
                { classPenalty: classPen, hydroReject: false },
              );
              if (!best || score < best.score) {
                best = { path: accepted, score, ca, cb, via: 'open_lake' };
              }
            }
          }
        }
      }
    } else {
    for (const [ca, cb] of pairs) {
      pairsTried += 1;
      if (brouterLeft > 0) {
        notePhaseCBrouterTrial();
        brouterLeft -= 1;
        {
          const perfT = getRoutePerf();
          if (perfT) perfT.trialCount += 1;
        }
        const trialId = beginFallbackEvent('phase_c_trial', `trial-${pairsTried}`, {
          parent: phaseCId,
          meta: {
            trial: pairsTried,
            aSource: ca.source,
            bSource: cb.source,
            aDistKm: ca.distKm,
            bDistKm: cb.distKm,
          },
        });
        const trial = await tryBrouterChain(
          [ca.point, cb.point],
          phaseCMethod,
          phaseCSnapKm,
          'phase_c',
        );
        endFallbackEvent(
          trialId,
          trial.path ? 'accepted_candidate' : trial.hadGeometry ? 'reject_geometry' : 'no_geometry',
          { hadGeometry: trial.hadGeometry },
        );
        if (considerBrouterTrial(ca, cb, trial)) break;
      }

      if (allowOpenLake && !longSharedLake) {
        const tLake = nowPerfMs();
        const open = await routeAcrossOpenLake([ca.point, cb.point]);
        addPerfMs('openLakeMs', nowPerfMs() - tLake);
        const perfLake = getRoutePerf();
        if (perfLake) perfLake.openLakeOps += 1;
        if (open && open.points.length >= 2 && open.lengthKm > 0) {
          const densified = densifyOpenWaterPath(open.points, 1.5);
          const accepted = await acceptPath(densified, densified, open.lengthKm, {
            waterName: open.waterName,
            method: 'lake',
            openWaterVerified: true,
            endpointSnapKm: MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM,
          });
          if (accepted) {
            const geom = accepted.routingGeometry ?? accepted.points;
            const reach = endpointReachToOriginals(geom, originalWaypoints, 99);
            const classPen = pairClassPenalty(ca, cb);
            const score = scoreAcceptedPhaseCRoute(
              reach.startKm,
              reach.finishKm,
              accepted.lengthKm,
              geo,
              { classPenalty: classPen, hydroReject: false },
            );
            if (!best || score < best.score) {
              best = { path: accepted, score, ca, cb, via: 'open_lake' };
            }
            if (
              shouldEarlyStopPhaseC({
                enabled: earlyStopEnabled,
                score,
                startResidualKm: reach.startKm,
                finishResidualKm: reach.finishKm,
                lengthKm: accepted.lengthKm,
                geoKm: geo,
                classPenalty: classPen,
                hydroReject: false,
              })
            ) {
              const perfE = getRoutePerf();
              if (perfE) perfE.earlyStopTriggered = true;
              break;
            }
          }
        }
      }
    }
    } // end sequential vs parallel

    if (best) {
      trace.chosenCandidate = {
        a: candidateToTrace(
          'A',
          best.ca,
          sourceClassPenalty(best.ca.source),
          offFairwayStemPenalty(best.ca.point, best.ca.source),
        ),
        b: candidateToTrace(
          'B',
          best.cb,
          sourceClassPenalty(best.cb.source),
          offFairwayStemPenalty(best.cb.point, best.cb.source),
        ),
        pairClassPenalty: pairClassPenalty(best.ca, best.cb),
        score: best.score,
        via: best.via,
      };
      trace.phases.C = {
        attempted: true,
        ok: true,
        phase: 'C',
        lengthKm: best.path.lengthKm,
        method: phaseCMethod,
        pairsTried,
        trials: getPhaseCBrouterTrials(),
      };
      return finishPhaseC('ok', best.path);
    }

    trace.phases.C = {
      attempted: true,
      ok: false,
      phase: 'C',
      method: phaseCMethod,
      pairsTried,
      trials: getPhaseCBrouterTrials(),
      rejectReason: trace.lastRejectReason ?? 'phase_c_all_fail',
    };
    return finishPhaseC('phase_c_all_fail', null);
  };

  const routeOnCachedLines = async (lines: WaterLine[]): Promise<WaterPath | null> => {
    if (!lines.length) return null;
    const allPoints: LngLat[] = [];
    let lengthKm = 0;
    let method: 'waterway' | 'lake' = 'waterway';
    let anyRouted = false;
    const nameBits: Array<string | null> = [];

    for (let i = 1; i < originalWaypoints.length; i++) {
      const leg = routeOnLines(originalWaypoints[i - 1]!, originalWaypoints[i]!, lines);
      if (leg.method === 'direct') continue;
      anyRouted = true;
      if (leg.method === 'lake') method = 'lake';
      if (leg.waterName) nameBits.push(leg.waterName);
      const chunk = allPoints.length === 0 ? leg.points : leg.points.slice(1);
      allPoints.push(...chunk);
      lengthKm += leg.lengthKm;
    }
    if (!anyRouted || allPoints.length < 2) return null;
    return acceptPath(allPoints, allPoints, pathLength(allPoints), {
      waterName: uniqueWaterName(...nameBits) ?? namesNearEndpoints(allPoints),
      method,
    });
  };

  // 1) Pure open-water legs (lake or reservoir): straight chords that only
  // bend around islands / peninsulas. BRouter river fairways hug the shore
  // and must not win here — but if the lake mask is unavailable, shared-lake
  // BRouter hops may still use Phase B lake accept (≤150 km geo, 5.5 km
  // residual ceiling — not full 10 km open snap), so stem-miss inside a giant
  // reservoir catalog bbox (Volga→Vetluga) still fails.
  const sharedLake = findSharedOpenLake(originalWaypoints);
  {
    const tA = nowPerfMs();
    const phaseAId = beginFallbackEvent('phase_a', 'phaseA');
    if (sharedLake) {
      const tLake = nowPerfMs();
      const open = await routeAcrossOpenLake(originalWaypoints);
      addPerfMs('openLakeMs', nowPerfMs() - tLake);
      const perfLake = getRoutePerf();
      if (perfLake) perfLake.openLakeOps += 1;
      if (open && open.points.length >= 2 && open.lengthKm > 0) {
        // Phase A: densify clear chords so gap heuristics (and UI) see continuous water,
        // and mark the track as mask-verified so dry-land geodesic rejects do not apply.
        // Hydro-gate / KNOWN_BARRIERS still run inside validateWaterRoute.
        const densified = densifyOpenWaterPath(open.points, 1.5);
        const accepted = await acceptPath(densified, densified, open.lengthKm, {
          waterName: open.waterName,
          method: 'lake',
          openWaterVerified: true,
        });
        if (accepted) {
          trace.phases.A = {
            attempted: true,
            ok: true,
            phase: 'A',
            lengthKm: accepted.lengthKm,
            method: 'lake',
            openWaterVerified: true,
            sharedLake: sharedLake.name,
          };
          addPerfMs('phaseAMs', nowPerfMs() - tA);
          endFallbackEvent(phaseAId, 'ok', { sharedLake: sharedLake.name });
          return await emitDone(accepted);
        }
        trace.phases.A = {
          attempted: true,
          ok: false,
          phase: 'A',
          method: 'lake',
          openWaterVerified: true,
          sharedLake: sharedLake.name,
          rejectReason: trace.lastRejectReason ?? 'phase_a_reject',
        };
        endFallbackEvent(phaseAId, trace.lastRejectReason ?? 'phase_a_reject', {
          sharedLake: sharedLake.name,
        });
      } else {
        trace.phases.A = {
          attempted: true,
          ok: false,
          phase: 'A',
          sharedLake: sharedLake.name,
          rejectReason: 'open_lake_fail',
        };
        if (!trace.lastRejectReason) trace.lastRejectReason = 'open_lake_fail';
        endFallbackEvent(phaseAId, 'open_lake_fail', { sharedLake: sharedLake.name });
      }
    } else {
      trace.phases.A = {
        attempted: false,
        ok: false,
        phase: 'A',
        sharedLake: null,
        rejectReason: 'no_shared_lake',
      };
      endFallbackEvent(phaseAId, 'no_shared_lake');
    }
    addPerfMs('phaseAMs', nowPerfMs() - tA);
  }

  const geoSpanKm =
    originalWaypoints.length === 2
      ? haversineKm(originalWaypoints[0]!, originalWaypoints[1]!)
      : routeSpanKm(originalWaypoints);

  // E1.7 — experimental long-span segmentation (default OFF).
  // When enabled and span > 120 km: try water-aware segments before monolithic BRouter.
  // On failure, fall through to Phase B so flag-on does not regress successful monoliths.
  {
    const flags = getRouteFeatureFlags();
    if (
      flags.USE_LONG_SPAN_SEGMENTATION &&
      originalWaypoints.length === 2 &&
      geoSpanKm > LONG_SPAN_TRIGGER_KM
    ) {
      const tSeg = nowPerfMs();
      const seg = await runLongSpanSegmentedRoute(
        originalWaypoints[0]!,
        originalWaypoints[originalWaypoints.length - 1]!,
        snapClickToWater,
        (lon, lat) => warmWaterNear({ lon, lat }),
      );
      addPerfMs('phaseBMs', nowPerfMs() - tSeg);
      trace.longSpan = {
        enabled: true,
        segmented: true,
        segmentCount: seg.segments.length,
        failedSegment: seg.failedSegment,
        seamFailures: seg.seamFailures,
        rejectReason: seg.rejectReason,
      };
      trace.segments = seg.segments.map((s) => ({
        index: s.index,
        a: s.a,
        b: s.b,
        lengthKm: s.lengthKm,
        method: s.method,
        brouterAttempts: s.brouterAttempts,
        ok: s.ok,
        rejectReason: s.rejectReason,
      }));
      if (seg.ok && seg.points.length >= 2) {
        const accepted = await acceptPath(seg.points, seg.points, seg.lengthKm, {
          waterName: seg.waterName,
          method: 'waterway',
        });
        if (accepted) {
          trace.phases.B = {
            attempted: true,
            ok: true,
            phase: 'B',
            lengthKm: accepted.lengthKm,
            method: 'waterway',
            rejectReason: null,
          };
          return await emitDone(accepted);
        }
        if (!trace.longSpan.rejectReason) {
          trace.longSpan.rejectReason = trace.lastRejectReason ?? 'segment_chain_accept_fail';
        }
      }
      // Fall through to monolithic Phase B/C.
    } else {
      trace.longSpan = {
        enabled: flags.USE_LONG_SPAN_SEGMENTATION,
        segmented: false,
        segmentCount: 0,
        failedSegment: null,
        seamFailures: 0,
        rejectReason: null,
      };
    }
  }

  const brouterMethod = chooseBrouterWaterMethod(
    Boolean(sharedLake),
    geoSpanKm,
    originalWaypoints.length,
  );

  // 2) BRouter on original clicks, then retry with water snaps if ends miss FINISH/START.
  {
    const tB = nowPerfMs();
    const phaseBId = beginFallbackEvent('phase_b', 'phaseB', {
      meta: { method: brouterMethod },
    });
    const first = await tryBrouterChain(originalWaypoints, brouterMethod, undefined, 'original');
    if (first.path) {
      trace.phases.B = {
        attempted: true,
        ok: true,
        phase: 'B',
        lengthKm: first.path.lengthKm,
        method: brouterMethod,
        sharedLake: sharedLake?.name ?? null,
        brouterHadGeometry: true,
      };
      addPerfMs('phaseBMs', nowPerfMs() - tB);
      endFallbackEvent(phaseBId, 'ok');
      return await emitDone(first.path);
    }

    const snapped = snapWaypointsForRetry();
    if (snapped) {
      const second = await tryBrouterChain(snapped, brouterMethod, undefined, 'snapped');
      if (second.path) {
        trace.phases.B = {
          attempted: true,
          ok: true,
          phase: 'B',
          lengthKm: second.path.lengthKm,
          method: brouterMethod,
          sharedLake: sharedLake?.name ?? null,
          brouterHadGeometry: true,
          rejectReason: null,
        };
        addPerfMs('phaseBMs', nowPerfMs() - tB);
        endFallbackEvent(phaseBId, 'ok_snapped');
        return await emitDone(second.path);
      }
    }

    trace.phases.B = {
      attempted: true,
      ok: false,
      phase: 'B',
      method: brouterMethod,
      sharedLake: sharedLake?.name ?? null,
      brouterHadGeometry: first.hadGeometry,
      rejectReason: trace.lastRejectReason ?? 'phase_b_fail',
    };
    addPerfMs('phaseBMs', nowPerfMs() - tB);
    endFallbackEvent(phaseBId, trace.lastRejectReason ?? 'phase_b_fail', {
      hadGeometry: first.hadGeometry,
    });

    // 2b) Phase C — multi-candidate endpoint binding (max 3×3 BRouter trials).
    // Runs before the stem-miss early exit so L07-class wrong stems can recover,
    // and before Overpass so L02 mid-pool can try fairway/mask pins.
    if (originalWaypoints.length === 2) {
      const tC = nowPerfMs();
      const phaseC = await tryPhaseCMultiCandidate(brouterMethod, Boolean(sharedLake));
      addPerfMs('phaseCMs', nowPerfMs() - tC);
      if (phaseC) return await emitDone(phaseC);
    }

    // BRouter produced a water track that does not reach the original START/FINISH
    // (e.g. stem instead of tributary). Do not burn minutes on Overpass for that miss.
    if (first.hadGeometry && routeSpanKm(originalWaypoints) > 40) {
      return await emitDone(routeNotFound(), trace.lastRejectReason ?? 'stem_miss_early');
    }
  }

  // Long inland trips only work via BRouter. Overpass cell crawl cannot connect
  // Seliger→Vokhma and only hangs the UI for minutes before returning empty.
  if (routeSpanKm(originalWaypoints) > 120) {
    // Observability only — records why Overpass fallback was skipped (no threshold change).
    trace.request.longSpanOverpassSkip = true;
    trace.phases.overpass = {
      attempted: false,
      ok: false,
      phase: 'overpass_fetch',
      rejectReason: 'span_gt_120',
    };
    trace.lastRejectReason = 'span_gt_120';
    return await emitDone(routeNotFound(), 'span_gt_120');
  }

  // 3) Instant local fallback from water-core already in memory (no network).
  const cachedLines = mergeLines(
    cellsAlong(originalWaypoints)
      .map((c) => cellCache.get(cellKey(c.cx, c.cy)) ?? [])
      .filter((g) => g.length > 0),
  );
  const fromCache = await routeOnCachedLines(cachedLines);
  if (fromCache) {
    trace.graph = {
      hybridAvailable: false,
      legacyOverpassUsed: true,
      legacySource: 'cache',
      note: 'E0: legacy Overpass cell cache fallback',
    };
    trace.phases.overpass = {
      attempted: true,
      ok: true,
      phase: 'overpass_cache',
      lengthKm: fromCache.lengthKm,
      method: fromCache.method === 'lake' ? 'lake' : 'waterway',
    };
    return await emitDone(fromCache);
  }

  // 4) Fetch more OSM geometry, then route (may be slower).
  const run = async (forceRefresh: boolean): Promise<WaterPath | null> => {
    const lines = await fetchWaterNetwork(originalWaypoints, { forceRefresh });
    return routeOnCachedLines(lines);
  };

  const path = (await run(false)) ?? (await run(true));
  if (path) {
    trace.graph = {
      hybridAvailable: false,
      legacyOverpassUsed: true,
      legacySource: 'fetch',
      note: 'E0: legacy Overpass network fetch fallback',
    };
    trace.phases.overpass = {
      attempted: true,
      ok: true,
      phase: 'overpass_fetch',
      lengthKm: path.lengthKm,
      method: path.method === 'lake' ? 'lake' : 'waterway',
    };
    return await emitDone(path);
  }

  trace.phases.overpass = {
    attempted: true,
    ok: false,
    phase: 'overpass_fetch',
    rejectReason: 'overpass_fail',
  };
  return await emitDone(routeNotFound(), trace.lastRejectReason ?? 'route_not_found');
}

/**
 * Background polish after the fast BRouter path is on screen:
 * lake straighten (Nominatim), meander refine (Overpass), richer itinerary names.
 * Returns null if nothing meaningful changed.
 */
export async function polishWaterPath(
  path: WaterPath,
  waypoints: LngLat[],
): Promise<WaterPath | null> {
  if (
    path.method === 'direct' ||
    path.method === 'route_not_found' ||
    path.points.length < 3
  ) {
    return null;
  }
  try {
    const routing = path.routingGeometry?.length ? path.routingGeometry : path.points;
    const straightened = await straightenOpenWaterSpans(routing, { cachedOnly: false });
    const lake = cachedLakeMaskAlongPath(routing);
    const safeStraight = chooseSafeDisplayGeometry(routing, straightened, lake);
    const refined = await refineRouteGeometryDeep(safeStraight);
    const safeDisplay = chooseSafeDisplayGeometry(routing, refined, lake);
    const polished = await finalizeMeasuredRoute(safeDisplay, pathLength(routing), waypoints, {
      waterName: path.waterName,
      method: path.method === 'lake' ? 'lake' : 'waterway',
      enrich: true,
      routingGeometry: routing,
    });
    const validation = validateWaterRoute(polished.routingGeometry ?? polished.points, {
      waypoints,
      lengthKm: polished.lengthKm,
      method: polished.method,
      endpointSnapKm: maxSnapKmForMethod(polished.method),
    });
    if (!validation.ok) return null;
    const geomChanged =
      polished.points.length !== path.points.length ||
      (polished.points.length > 0 &&
        (Math.abs(polished.points[0]!.lat - path.points[0]!.lat) > 1e-6 ||
          Math.abs(
            polished.points[Math.floor(polished.points.length / 2)]!.lon -
              path.points[Math.floor(path.points.length / 2)]!.lon,
          ) > 1e-5));
    const itinChanged =
      formatItinerary(polished.itinerary ?? []) !== formatItinerary(path.itinerary ?? []);
    const lenChanged = Math.abs(polished.lengthKm - path.lengthKm) > 0.15;
    if (!geomChanged && !itinChanged && !lenChanged) return null;
    return polished;
  } catch {
    return null;
  }
}
