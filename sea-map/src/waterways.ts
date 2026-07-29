import { closestOnSegment, haversineKm, type LngLat } from './geo';
import { routeWithBrouterAdaptive, routeSpanKm } from './brouter';
import waterBodies from './water-bodies.json';
import waterCore from './water-core.json';

export type ItinerarySegment = {
  name: string;
  /** Length of this named stretch along the route geometry, km. */
  km: number;
};

export type WaterPath = {
  points: LngLat[];
  lengthKm: number;
  waterName: string | null;
  method: 'waterway' | 'lake' | 'direct';
  /** Cumulative distance at each input waypoint (km), length = waypoints.length */
  waypointCumKm?: number[];
  /**
   * Itinerary measured on the full BRouter track (not the UI-thinned line).
   * Segment km sum to lengthKm.
   */
  itinerary?: ItinerarySegment[];
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
};

type GraphNode = { id: number; lon: number; lat: number };
type GraphEdge = { a: number; b: number; w: number };

const GRID = 0.0005;
const MERGE_KM = 0.18;
const SNAP_MAX_KM = 12;
const LAKE_CONNECT_KM = 0.45;
const BRIDGE_KM = 0.28;

// Mail.ru first — usually has RU data; CH often returns empty 200s (skip as primary).
const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
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
 */
async function overpassQuery(query: string): Promise<OverpassElement[]> {
  const body = `data=${encodeURIComponent(query)}`;
  return await new Promise<OverpassElement[]>((resolve, reject) => {
    let pending = OVERPASS_ENDPOINTS.length;
    let empty: OverpassElement[] | null = null;
    let done = false;
    const errors: unknown[] = [];

    for (const endpoint of OVERPASS_ENDPOINTS) {
      fetchOneOverpass(endpoint, body, 14000)
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
            else reject(errors[errors.length - 1] ?? new Error('Overpass failed'));
          }
        });
    }
  });
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
    const name = el.tags?.['name:ru'] ?? el.tags?.name ?? null;
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

function pathAlongLine(line: WaterLine, from: LngLat, to: LngLat): LngLat[] {
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
  return simplifyPath([from, ...slice, to]);
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

function seedCoreWaterways(): void {
  const raw = waterCore as CoreLine[];
  const lines: WaterLine[] = raw.map((row) => ({
    id: row.id,
    name: row.n,
    kind: row.k === 'l' ? 'lake' : 'waterway',
    coords: row.c.map(([lon, lat]) => ({ lon, lat })),
    closed: row.k === 'l' && row.c.length > 3,
  }));
  rememberLinesInCells(lines);
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
  while (cellCache.size > 400) {
    const first = cellCache.keys().next().value;
    if (!first) break;
    cellCache.delete(first);
  }
}

seedCoreWaterways();

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

async function loadCell(cx: number, cy: number): Promise<WaterLine[]> {
  const id = cellKey(cx, cy);
  const hit = cellCache.get(id);
  if (hit?.length) return hit;

  const emptyUntil = emptyCellUntil.get(id) ?? 0;
  if (emptyUntil > Date.now()) return [];

  const inflight = cellInflight.get(id);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const lines = linesFromElements(await overpassQuery(cellBboxQuery(cx, cy)));
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

async function fetchWaterNetwork(
  points: LngLat[],
  opts: { forceRefresh?: boolean } = {},
): Promise<WaterLine[]> {
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
  if (!opts.forceRefresh && missing.length === 0 && fromCache.length > 0) return fromCache;

  const span = pathLength(points);

  // Short corridor: one compact around-query (fast).
  if (span <= 100) {
    try {
      const lines = linesFromElements(await overpassQuery(aroundWaterQuery(points)));
      if (lines.length) {
        rememberLinesInCells(lines);
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
    await Promise.all(batch.map((c) => loadCell(c.cx, c.cy)));
  }

  const loaded = mergeLines(
    cells.map((c) => cellCache.get(cellKey(c.cx, c.cy)) ?? []).filter((g) => g.length > 0),
  );
  if (loaded.length) return loaded;

  if (fromCache.length) return fromCache;

  const ends = [points[0]!, points[points.length - 1]!].map(pointCell);
  const unique = new Map(ends.map((c) => [cellKey(c.cx, c.cy), c]));
  const endLines = await Promise.all([...unique.values()].map((c) => loadCell(c.cx, c.cy)));
  return mergeLines(endLines);
}

/** Warm waterway cache around a point (call after inland click / demo). */
export function prefetchWaterNear(point: LngLat): void {
  const { cx, cy } = pointCell(point);
  void loadCell(cx, cy);
}

/** Warm cache for the visible map (call on inland moveend). */
export function prefetchWaterBbox(south: number, west: number, north: number, east: number): void {
  const cx0 = Math.floor(west / CELL_DEG);
  const cx1 = Math.floor(east / CELL_DEG);
  const cy0 = Math.floor(south / CELL_DEG);
  const cy1 = Math.floor(north / CELL_DEG);
  const midX = Math.round((cx0 + cx1) / 2);
  const midY = Math.round((cy0 + cy1) / 2);
  void loadCell(midX, midY);
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
            points: simplifyPath(points),
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
    points: simplifyPath(points),
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
  const kinds = new Set<string>();
  for (const t of tags) {
    if (t === 'waterway=river') kinds.add('река');
    else if (t === 'waterway=canal') kinds.add('канал');
    else if (t === 'waterway=fairway') kinds.add('фарватер');
    else if (t.startsWith('waterway=')) kinds.add(t.slice('waterway='.length));
  }
  return kinds.size ? [...kinds].join(', ') : null;
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
/** Устье Вохмы → Ветлуга (OSM); восточнее створа, до впадения Сырденки (~46.597E, 58.759N). */
const VOHMA_MOUTH: LngLat = { lon: 46.6064, lat: 58.7543 };

/** Lower Vetluga channel above the open Cheboksary pool (not the Yurino bay). */
function onVetlugaAboveMouth(p: LngLat): boolean {
  if (p.lat < VETLUGA_MOUTH.lat - 0.01) return false;
  // Near the mouth stay over the Vetluga valley, not east along the Volga pool.
  if (p.lat < 56.7) return p.lon >= 45.7 && p.lon <= 46.75;
  return p.lon >= 45.5 && p.lon <= 47.7;
}

/**
 * Vohma channel upstream of its confluence with Vetluga.
 * Do not claim the Vetluga stem near Сырденка (slightly west/north of the mouth).
 */
function onVohmaAboveMouth(p: LngLat): boolean {
  if (p.lat < VOHMA_MOUTH.lat - 0.008) return false;
  // Vohma leaves to the E/NE; Сырденка joins Vetluga just west of this lon.
  if (p.lon < VOHMA_MOUTH.lon - 0.004) return false;
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
  hits.sort((a, b) => {
    const lakeA = a.k === 'l' ? 0 : 1;
    const lakeB = b.k === 'l' ? 0 : 1;
    if (lakeA !== lakeB) return lakeA - lakeB;
    return catalogArea(a) - catalogArea(b);
  });

  const best = hits[0]!;
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
    const volga = hits.find((h) => h.n.toLocaleLowerCase('ru') === 'волга');
    const lake = hits.find((h) => h.k === 'l');
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
    const vetluga = hits.find((h) => h.n.toLocaleLowerCase('ru') === 'ветлуга');
    if (vetluga) return { name: 'Ветлуга', kind: 'river' };
    const next = hits.find((h) => h.n.toLocaleLowerCase('ru') !== 'вохма');
    if (next) {
      return { name: next.n, kind: next.k === 'l' ? 'lake' : 'river' };
    }
  }

  // While climbing a corridor, never let the giant Волга box win over Ветлуга/Вохма.
  if (bestKey === 'волга') {
    const trib = hits.find((h) => {
      const k = h.n.toLocaleLowerCase('ru');
      return k === 'ветлуга' || k === 'вохма' || k === 'селижаровка' || k === 'белая';
    });
    if (trib) {
      const k = trib.n.toLocaleLowerCase('ru');
      if (k === 'ветлуга' && sample.lat < VETLUGA_MOUTH.lat) {
        return { name: 'Волга', kind: 'river' };
      }
      if (k === 'вохма' && !onVohmaAboveMouth(sample)) {
        const vetluga = hits.find((h) => h.n.toLocaleLowerCase('ru') === 'ветлуга');
        if (vetluga) return { name: 'Ветлуга', kind: 'river' };
        return { name: 'Волга', kind: 'river' };
      }
      return { name: trib.n, kind: 'river' };
    }
  }

  return { name: best.n, kind: best.k === 'l' ? 'lake' : 'river' };
}

function catalogBodyByName(name: string): CatalogBody | undefined {
  const key = name.toLocaleLowerCase('ru');
  return CATALOG.find((b) => b.n.toLocaleLowerCase('ru') === key);
}

const TRUNK_RIVERS = new Set(
  ['волга', 'москва', 'нева', 'кама', 'дон', 'ока', 'белая'].map((s) =>
    s.toLocaleLowerCase('ru'),
  ),
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
): {
  name: string | null;
  stickyLake: string | null;
  stickyOutsideKm: number;
  stickyRiver: string | null;
  stickyRiverOutsideKm: number;
} {
  // Sticky tributary: must not flip to Волга every time the track leaves a narrow bbox.
  if (stickyRiver) {
    const key = stickyRiver.toLocaleLowerCase('ru');
    const body = catalogBodyByName(stickyRiver);
    const inBody = !!(body && pointInCatalog(p, body));

    // Prefer a more specific corridor ahead (Ветлуга → Вохма) only above the mouth.
    const peek = pickCatalogName(p, usedNames);
    if (
      peek?.kind === 'river' &&
      isCorridorTributary(peek.name) &&
      peek.name.toLocaleLowerCase('ru') !== key &&
      catalogBodyByName(peek.name) &&
      catalogArea(catalogBodyByName(peek.name)!) <=
        (body ? catalogArea(body) : Infinity) &&
      !(peek.name.toLocaleLowerCase('ru') === 'вохма' && !onVohmaAboveMouth(p))
    ) {
      return {
        name: peek.name,
        stickyLake: null,
        stickyOutsideKm: 0,
        stickyRiver: peek.name,
        stickyRiverOutsideKm: 0,
      };
    }

    // Reservoir / lake always wins over a sticky river.
    if (peek?.kind === 'lake') {
      return {
        name: peek.name,
        stickyLake: peek.name,
        stickyOutsideKm: 0,
        stickyRiver: null,
        stickyRiverOutsideKm: 0,
      };
    }

    // Terminal / mouth: release back to the trunk / parent river.
    const atVetlugaMouth = key === 'ветлуга' && p.lat < VETLUGA_MOUTH.lat;
    const atVohmaMouth = key === 'вохма' && !onVohmaAboveMouth(p);
    // Селижаровка mouth in Селижарово (~33.455E, 56.854N) — do not keep sticky into the Volga.
    const pastSelizharovka =
      key === 'селижаровка' &&
      (p.lon > 33.46 ||
        p.lat < 56.85 ||
        (peek?.kind === 'river' && peek.name.toLocaleLowerCase('ru') === 'волга'));
    if (atVetlugaMouth || atVohmaMouth || pastSelizharovka) {
      stickyRiver = null;
      stickyRiverOutsideKm = 0;
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
      const holdKm = 3;
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
      usedNames.add(lakeKey);
      stickyLake = null;
      stickyOutsideKm = 0;
    } else if (lakeKey.includes('чебоксар') && onVetlugaAboveMouth(p)) {
      // Reservoir box covers lower Ветлуга; leave Чебоксарское at the real mouth.
      usedNames.add(lakeKey);
      stickyLake = null;
      stickyOutsideKm = 0;
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
          usedNames.add(stickyLake.toLocaleLowerCase('ru'));
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
      usedNames.add(stickyLake.toLocaleLowerCase('ru'));
      stickyLake = null;
      stickyOutsideKm = 0;
    }
  }

  // Catalog only — never pull random OSM tributaries (e.g. «Ить»).
  const catalog = pickCatalogName(p, usedNames);
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
    const riverSticky = isCorridorTributary(catalog.name) ? catalog.name : null;
    return {
      name: catalog.name,
      stickyLake: null,
      stickyOutsideKm: 0,
      stickyRiver: riverSticky ?? stickyRiver,
      stickyRiverOutsideKm: riverSticky ? 0 : stickyRiverOutsideKm,
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

/** Fold tiny noise stretches into neighbours (keeps cascade readable). */
function mergeShortSegments(segments: ItinerarySegment[], minKm = 3): ItinerarySegment[] {
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

/** Merge consecutive stretches that share the same name. */
function collapseAdjacentSegments(segments: ItinerarySegment[]): ItinerarySegment[] {
  const collapsed: ItinerarySegment[] = [];
  for (const s of segments) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.name.toLocaleLowerCase('ru') === s.name.toLocaleLowerCase('ru')) {
      prev.km += s.km;
    } else {
      collapsed.push({ ...s });
    }
  }
  return collapsed;
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
  return segments.map((s) => ({ name: s.name, km: s.km * k }));
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
  },
): Promise<WaterPath> {
  // Light simplify only — same fidelity for short and long routes.
  const measurePath = simplifyPath(waterRef, 0.08);
  const geomKm = pathLength(waterRef);
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

  const itinerary = await describeWaterItinerary(measurePath, {
    totalKm: lengthKm,
    origin: waypoints[0],
    destination: waypoints[waypoints.length - 1],
  });

  const points =
    measurePath.length > 3600
      ? downsampleOnWater(measurePath, 3600, 0.3)
      : measurePath;

  return {
    points,
    lengthKm,
    waterName: extras.waterName,
    method: extras.method,
    waypointCumKm: cumKmAlongPath(measurePath, waypoints),
    itinerary: itinerary.length ? itinerary : undefined,
  };
}

/** Densify a sparse path so reservoir bboxes are not skipped while naming. */
function densifyPathForItinerary(path: LngLat[], stepKm = 2.5): LngLat[] {
  if (path.length < 2) return path;
  const out: LngLat[] = [path[0]!];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const d = haversineKm(a, b);
    if (d > stepKm * 1.5) {
      const n = Math.min(40, Math.ceil(d / stepKm));
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
 * Naming uses the curated catalog only (no OSM tributary noise).
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

  const labelAt = (p: LngLat, stepKm: number): string | null => {
    const hit = nameAtSample(
      p,
      stickyLake,
      stickyOutsideKm,
      usedNames,
      stepKm,
      stickyRiver,
      stickyRiverOutsideKm,
    );
    stickyLake = hit.stickyLake;
    stickyOutsideKm = hit.stickyOutsideKm;
    stickyRiver = hit.stickyRiver;
    stickyRiverOutsideKm = hit.stickyRiverOutsideKm;
    if (!hit.name) return null;
    const key = hit.name.toLocaleLowerCase('ru');
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
    return hit.name;
  };

  let currentName = labelAt(path[0]!, 0);
  let currentKm = 0;
  /** Unlabeled stretch — attach to the next named segment (never drop / rescale-inflate). */
  let pendingKm = 0;

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
      segments.push({ name: currentName, km: add });
    }
  };

  for (let i = 1; i < path.length; i++) {
    const d = haversineKm(path[i - 1]!, path[i]!);
    const name = labelAt(path[i]!, d);

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
          usedNames.add(currentName.toLocaleLowerCase('ru'));
        } else if (
          // Never lock Ветлуга/Селижаровка/… on a Volga confluence flicker —
          // that turned the whole Vetluga climb into «Волга (500 км)».
          !isTrunkRiver(currentName) &&
          !isCorridorTributary(currentName) &&
          isLakeCatalogName(name)
        ) {
          usedNames.add(currentName.toLocaleLowerCase('ru'));
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
      segments.push({ name: currentName, km: pendingKm });
    }
  }
  return mergeShortSegments(segments, 3);
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

  const geo = haversineKm(origin, destination);
  if (opts.totalKm && geo > 40 && opts.totalKm > geo * 3.5) {
    return [];
  }

  if (opts.totalKm && opts.totalKm > 0) {
    chain = scaleSegmentsToTotal(chain, opts.totalKm);
  }
  return chain;
}

/** Format itinerary for UI / clipboard. */
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
  if (waypoints.length < 2) {
    return {
      points: waypoints.slice(),
      lengthKm: 0,
      waterName: null,
      method: 'direct',
      waypointCumKm: waypoints.map(() => 0),
    };
  }

  const directFallback = (): WaterPath => {
    const cum = [0];
    let sum = 0;
    for (let i = 1; i < waypoints.length; i++) {
      sum += haversineKm(waypoints[i - 1]!, waypoints[i]!);
      cum.push(sum);
    }
    return {
      points: waypoints.slice(),
      lengthKm: sum,
      waterName: null,
      method: 'direct',
      waypointCumKm: cum,
    };
  };

  const routeOnCachedLines = async (lines: WaterLine[]): Promise<WaterPath | null> => {
    if (!lines.length) return null;
    const allPoints: LngLat[] = [];
    let lengthKm = 0;
    const waypointCumKm = [0];
    let method: WaterPath['method'] = 'waterway';
    let anyRouted = false;
    const nameBits: Array<string | null> = [];

    for (let i = 1; i < waypoints.length; i++) {
      const leg = routeOnLines(waypoints[i - 1]!, waypoints[i]!, lines);
      if (leg.method !== 'direct') anyRouted = true;
      if (leg.method === 'lake' && method === 'waterway') method = 'lake';
      if (leg.waterName) nameBits.push(leg.waterName);
      const chunk = i === 1 ? leg.points : leg.points.slice(1);
      allPoints.push(...chunk);
      lengthKm += leg.lengthKm;
      waypointCumKm.push(lengthKm);
    }
    if (!anyRouted) return null;
    const raw = allPoints;
    return finalizeMeasuredRoute(raw, pathLength(raw), waypoints, {
      waterName: uniqueWaterName(...nameBits) ?? namesNearEndpoints(raw),
      method,
    });
  };

  // 1) BRouter — short legs OK as-is; long corridors are split before the request.
  const brouted = await routeWithBrouterAdaptive(waypoints);

  if (brouted && brouted.points.length >= 2 && brouted.lengthKm > 0) {
    // Guard: only drop obvious basin-hopping loops (align with brouter soft cap).
    if (waypoints.length === 2) {
      const geo = haversineKm(waypoints[0]!, waypoints[1]!);
      if (geo > 40 && brouted.lengthKm > geo * 3.5) {
        return directFallback();
      }
    }
    const waterRef = brouted.points;
    const named = waterNameFromTags(brouted.wayTags) ?? namesNearEndpoints(waterRef);
    return finalizeMeasuredRoute(waterRef, brouted.lengthKm, waypoints, {
      waterName: named,
      method: 'waterway',
    });
  }

  // Long inland trips only work via BRouter. Overpass cell crawl cannot connect
  // Seliger→Vokhma and only hangs the UI for minutes before returning "direct".
  if (routeSpanKm(waypoints) > 120) {
    return directFallback();
  }

  // 2) Instant local fallback from water-core already in memory (no network).
  const cachedLines = mergeLines(
    cellsAlong(waypoints)
      .map((c) => cellCache.get(cellKey(c.cx, c.cy)) ?? [])
      .filter((g) => g.length > 0),
  );
  const fromCache = await routeOnCachedLines(cachedLines);
  if (fromCache) return fromCache;

  // 3) Fetch more OSM geometry, then route (may be slower).
  const run = async (forceRefresh: boolean): Promise<WaterPath> => {
    const lines = await fetchWaterNetwork(waypoints, { forceRefresh });
    return (await routeOnCachedLines(lines)) ?? directFallback();
  };

  let path = await run(false);
  if (path.method === 'direct') path = await run(true);
  return path;
}
