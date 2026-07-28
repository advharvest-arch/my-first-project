import { closestOnSegment, haversineKm, type LngLat } from './geo';
import { routeWithBrouterAdaptive, routeSpanKm } from './brouter';
import waterBodies from './water-bodies.json';
import waterCore from './water-core.json';

export type WaterPath = {
  points: LngLat[];
  lengthKm: number;
  waterName: string | null;
  method: 'waterway' | 'lake' | 'direct';
  /** Cumulative distance at each input waypoint (km), length = waypoints.length */
  waypointCumKm?: number[];
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

/** Keep Leaflet / parallel / arrows responsive on 2000+ km tracks. */
function downsamplePath(points: LngLat[], maxPoints: number): LngLat[] {
  if (points.length <= maxPoints) return points;
  const out: LngLat[] = [points[0]!];
  const step = (points.length - 1) / (maxPoints - 1);
  for (let i = 1; i < maxPoints - 1; i++) {
    out.push(points[Math.round(i * step)]!);
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

function douglasPeucker(points: LngLat[], epsilonKm: number): LngLat[] {
  if (points.length <= 2) return points.slice();
  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDistKm(points[i]!, first, last);
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }
  if (maxDist <= epsilonKm) return [first, last];
  const left = douglasPeucker(points.slice(0, maxIdx + 1), epsilonKm);
  const right = douglasPeucker(points.slice(maxIdx), epsilonKm);
  return [...left.slice(0, -1), ...right];
}

/** Min distance from point to a polyline, km. */
function distToPolylineKm(p: LngLat, line: LngLat[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    best = Math.min(best, perpDistKm(p, line[i - 1]!, line[i]!));
  }
  return best;
}

/**
 * Chord/segment is safe only if it stays near the original BRouter track
 * (on water). Bbox midpoints are NOT enough — Цимлянское chords cut land
 * inside the rectangle.
 */
function segmentFollowsWater(
  a: LngLat,
  b: LngLat,
  waterPath: LngLat[],
  maxDevKm: number,
): boolean {
  const geo = haversineKm(a, b);
  if (geo < 0.3) return true;
  const samples = Math.max(3, Math.ceil(geo / 3));
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

/** Keep DP vertices whose consecutive chords still hug the water track. */
function douglasPeuckerOnWater(
  points: LngLat[],
  epsilonKm: number,
  maxDevKm: number,
): LngLat[] {
  if (points.length <= 2) return points.slice();
  if (epsilonKm < 0.5) return points.slice();

  const rough = douglasPeucker(points, epsilonKm);
  if (rough.length <= 2) {
    return segmentFollowsWater(points[0]!, points[points.length - 1]!, points, maxDevKm)
      ? rough
      : points.slice();
  }

  const nearestIdx = (p: LngLat): number => {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = haversineKm(p, points[i]!);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const out: LngLat[] = [rough[0]!];
  for (let i = 1; i < rough.length; i++) {
    const a = out[out.length - 1]!;
    const b = rough[i]!;
    if (segmentFollowsWater(a, b, points, maxDevKm)) {
      out.push(b);
      continue;
    }
    const ia = nearestIdx(a);
    const ib = nearestIdx(b);
    if (ib > ia + 1) {
      const mid = douglasPeuckerOnWater(
        points.slice(ia, ib + 1),
        Math.max(0.55, epsilonKm * 0.5),
        maxDevKm,
      );
      out.push(...mid.slice(1));
    } else {
      out.push(b);
    }
  }
  return out;
}

function openWaterBodies(): CatalogBody[] {
  return CATALOG.filter((b) => {
    if (b.k !== 'l') return false;
    const [w, s, e, n] = b.b;
    const diagKm = Math.hypot((e - w) * 75, (n - s) * 111);
    return diagKm >= 28;
  }).sort((a, b) => catalogArea(b) - catalogArea(a));
}

/**
 * Straighten meandering BRouter tracks across reservoirs / large lakes.
 * Only cut wiggles that stay within a few km of the original water track —
 * never trust catalog bbox alone (Цимлянское etc.).
 */
function straightenAcrossReservoirs(points: LngLat[]): LngLat[] {
  if (points.length < 4) return points;
  let current = points;
  for (const body of openWaterBodies()) {
    const next: LngLat[] = [];
    let i = 0;
    while (i < current.length) {
      if (!pointInCatalog(current[i]!, body)) {
        next.push(current[i]!);
        i += 1;
        continue;
      }
      let j = i;
      while (j + 1 < current.length && pointInCatalog(current[j + 1]!, body)) j += 1;
      const run = current.slice(i, j + 1);
      const runKm = pathLength(run);
      if (run.length >= 4 && runKm >= 12) {
        const a = run[0]!;
        const b = run[run.length - 1]!;
        const geo = Math.max(0.001, haversineKm(a, b));
        const ratio = runKm / geo;
        // Sparse near-chord runs are often already land cuts — leave them alone.
        if (run.length < 10 && ratio < 1.15) {
          if (next.length) next.push(...run.slice(1));
          else next.push(...run);
          i = j + 1;
          continue;
        }
        // Stay close to the navigable track (bbox is not the shoreline).
        const maxDev = Math.min(1.35, Math.max(0.9, geo * 0.03));
        let straight: LngLat[];
        if (
          geo <= 35 &&
          ratio > 1.25 &&
          run.length >= 12 &&
          segmentFollowsWater(a, b, run, maxDev)
        ) {
          const step = Math.min(6, Math.max(3, geo / 5));
          straight = densifyPoints([a, b], step);
        } else {
          const eps = Math.min(2.4, Math.max(1.0, Math.min(runKm * 0.015, geo * 0.06)));
          straight = douglasPeuckerOnWater(run, eps, maxDev);
          if (straight.length < 2) straight = run.slice();
          if (pathLength(straight) > 40 && straight.length >= 3) {
            straight = densifyPoints(straight, 10);
          }
        }
        // Safety: if any straightened segment left the water track, keep original.
        let safe = straight.length >= 2;
        for (let s = 1; safe && s < straight.length; s++) {
          if (!segmentFollowsWater(straight[s - 1]!, straight[s]!, run, maxDev + 0.15)) {
            safe = false;
          }
        }
        if (!safe || pathLength(straight) < geo * 0.9) straight = run;
        if (next.length) {
          next.push(...straight.slice(1));
        } else {
          next.push(...straight);
        }
      } else if (next.length) {
        next.push(...run.slice(1));
      } else {
        next.push(...run);
      }
      i = j + 1;
    }
    current = next.length >= 2 ? next : current;
  }
  return current;
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

const CATALOG = waterBodies as CatalogBody[];

function catalogArea(body: CatalogBody): number {
  const [w, s, e, n] = body.b;
  return Math.max(1e-9, (e - w) * (n - s));
}

function pointInCatalog(p: LngLat, body: CatalogBody): boolean {
  const [w, s, e, n] = body.b;
  return p.lon >= w && p.lon <= e && p.lat >= s && p.lat <= n;
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
  return { name: best.n, kind: best.k === 'l' ? 'lake' : 'river' };
}

function catalogBodyByName(name: string): CatalogBody | undefined {
  const key = name.toLocaleLowerCase('ru');
  return CATALOG.find((b) => b.n.toLocaleLowerCase('ru') === key);
}

const TRUNK_RIVERS = new Set(
  ['волга', 'москва', 'нева', 'кама', 'дон', 'ока'].map((s) => s.toLocaleLowerCase('ru')),
);

function isTrunkRiver(name: string): boolean {
  return TRUNK_RIVERS.has(name.toLocaleLowerCase('ru'));
}

function nameAtSample(
  p: LngLat,
  stickyLake: string | null,
  stickyOutsideKm: number,
  usedNames: Set<string>,
  stepKm: number,
): { name: string | null; stickyLake: string | null; stickyOutsideKm: number } {
  if (stickyLake) {
    const body = catalogBodyByName(stickyLake);
    if (body && pointInCatalog(p, body)) {
      return { name: stickyLake, stickyLake, stickyOutsideKm: 0 };
    }

    // Leaving a lake into a named tributary / outflow (Селижаровка, Нева…):
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
        return { name: catalogNow.name, stickyLake: null, stickyOutsideKm: 0 };
      }
    }

    // Hysteresis for brief gaps inside the same reservoir corridor.
    const outside = stickyOutsideKm + stepKm;
    if (outside < 8) {
      return { name: stickyLake, stickyLake, stickyOutsideKm: outside };
    }
    usedNames.add(stickyLake.toLocaleLowerCase('ru'));
    stickyLake = null;
    stickyOutsideKm = 0;
  }

  // Catalog only — never pull random OSM tributaries (e.g. «Ить»).
  const catalog = pickCatalogName(p, usedNames);
  if (catalog?.kind === 'lake') {
    return { name: catalog.name, stickyLake: catalog.name, stickyOutsideKm: 0 };
  }
  if (catalog?.kind === 'river') {
    return { name: catalog.name, stickyLake: null, stickyOutsideKm: 0 };
  }
  return { name: null, stickyLake: null, stickyOutsideKm: 0 };
}

export type ItinerarySegment = {
  name: string;
  /** Length of this named stretch along the route geometry, km. */
  km: number;
};

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
  const collapsed: ItinerarySegment[] = [];
  for (const s of out) {
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
  const k = totalKm / sum;
  return segments.map((s) => ({ name: s.name, km: s.km * k }));
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
  const usedNames = new Set<string>();
  const segments: ItinerarySegment[] = [];
  // Suppress «Канал имени Москвы» until after Иваньковское when the route
  // already visited mid-Volga reservoirs (avoids false canal labels on bad geometry).
  let seenEasternCascade = false;
  let seenIvankovo = false;

  const labelAt = (p: LngLat, stepKm: number): string | null => {
    const hit = nameAtSample(p, stickyLake, stickyOutsideKm, usedNames, stepKm);
    stickyLake = hit.stickyLake;
    stickyOutsideKm = hit.stickyOutsideKm;
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

  const flush = () => {
    if (!currentName || currentKm < 0.5) {
      currentKm = 0;
      return;
    }
    const prev = segments[segments.length - 1];
    if (prev && prev.name.toLocaleLowerCase('ru') === currentName.toLocaleLowerCase('ru')) {
      prev.km += currentKm;
    } else {
      segments.push({ name: currentName, km: currentKm });
    }
    currentKm = 0;
  };

  for (let i = 1; i < path.length; i++) {
    const d = haversineKm(path[i - 1]!, path[i]!);
    const name = labelAt(path[i]!, d);

    if (!name) {
      currentKm += d;
      continue;
    }

    if (currentName && name.toLocaleLowerCase('ru') === currentName.toLocaleLowerCase('ru')) {
      currentKm += d;
      continue;
    }

    const half = d / 2;
    currentKm += half;
    flush();
    // Lock out finished stretches: lakes always; secondary rivers after entering a lake.
    if (currentName && name !== currentName) {
      if (isLakeCatalogName(currentName)) {
        usedNames.add(currentName.toLocaleLowerCase('ru'));
      } else if (
        !isTrunkRiver(currentName) &&
        (isLakeCatalogName(name) || isTrunkRiver(name))
      ) {
        usedNames.add(currentName.toLocaleLowerCase('ru'));
      }
    }
    currentName = name;
    currentKm = half;
  }

  flush();
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

  // «Москва» on a cascade itinerary = wrong geometry (unless endpoint is Moscow).
  if (hasMoskva && hasCascade && !nearMos && !nearMosB) {
    return [];
  }

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
      const km = Math.max(1, Math.round(s.km));
      return `${s.name} (${km} км)`;
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

  const routeOnCachedLines = (lines: WaterLine[]): WaterPath | null => {
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
    const path = straightenAcrossReservoirs(simplifyPath(allPoints));
    return {
      points: path,
      lengthKm: pathLength(path),
      waterName: uniqueWaterName(...nameBits) ?? namesNearEndpoints(path),
      method,
      waypointCumKm: cumKmAlongPath(path, waypoints),
    };
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
    const minSimplifyKm =
      brouted.lengthKm > 800
        ? 0.55
        : brouted.lengthKm > 250
          ? 0.2
          : brouted.lengthKm > 80
            ? 0.08
            : 0.03;
    const simplified = downsamplePath(simplifyPath(brouted.points, minSimplifyKm), 2200);
    const straightened = straightenAcrossReservoirs(simplified);
    const lengthKm = pathLength(straightened);
    const named =
      waterNameFromTags(brouted.wayTags) ?? namesNearEndpoints(straightened);
    return {
      points: straightened,
      lengthKm,
      waterName: named,
      method: 'waterway',
      waypointCumKm: cumKmAlongPath(straightened, waypoints),
    };
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
  const fromCache = routeOnCachedLines(cachedLines);
  if (fromCache) return fromCache;

  // 3) Fetch more OSM geometry, then route (may be slower).
  const run = async (forceRefresh: boolean): Promise<WaterPath> => {
    const lines = await fetchWaterNetwork(waypoints, { forceRefresh });
    return routeOnCachedLines(lines) ?? directFallback();
  };

  let path = await run(false);
  if (path.method === 'direct') path = await run(true);
  return path;
}
