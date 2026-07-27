import { closestOnSegment, haversineKm, type LngLat } from './geo';

export type WaterPath = {
  points: LngLat[];
  lengthKm: number;
  waterName: string | null;
  method: 'waterway' | 'lake' | 'direct';
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
const MERGE_KM = 0.06;
const SNAP_MAX_KM = 10;
const LAKE_CONNECT_KM = 0.2;

const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function keyCell(lon: number, lat: number): string {
  return `${Math.round(lon / GRID)},${Math.round(lat / GRID)}`;
}

async function overpassQuery(query: string): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': 'AquaRoute/1.2 (inland waterways; https://advharvest-arch.github.io)',
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error(`Overpass ${res.status} @ ${endpoint}`);
      const data = JSON.parse(text) as { elements?: OverpassElement[] };
      return data.elements ?? [];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass failed');
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

function buildGraph(lines: WaterLine[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
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
      line.kind === 'lake' && line.coords.length > 100
        ? Math.ceil(line.coords.length / 100)
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

  return { nodes, edges };
}

function snapToNetwork(
  p: LngLat,
  lines: WaterLine[],
  nodes: GraphNode[],
  edges: GraphEdge[],
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
  if (bestWay && bestWay.distKm <= maxKm && bestWay.distKm <= 2) best = bestWay;
  else if (bestLake && bestLake.distKm <= maxKm) best = bestLake;
  else if (bestWay && bestWay.distKm <= maxKm) best = bestWay;
  if (!best) return null;

  const nodeId = nodes.length;
  nodes.push({ id: nodeId, lon: best.point.lon, lat: best.point.lat });

  const attachNearest = (q: LngLat, limitKm: number) => {
    let id = -1;
    let d = limitKm;
    for (const n of nodes) {
      if (n.id === nodeId) continue;
      const dd = haversineKm(q, n);
      if (dd < d) {
        d = dd;
        id = n.id;
      }
    }
    if (id >= 0) {
      const w = haversineKm(nodes[nodeId]!, nodes[id]!);
      edges.push({ a: nodeId, b: id, w });
      edges.push({ a: id, b: nodeId, w });
    }
  };

  attachNearest(best.a, 0.25);
  attachNearest(best.b, 0.25);
  attachNearest(best.point, best.line.kind === 'lake' ? 3 : 0.3);

  return { nodeId, point: best.point, distKm: best.distKm, line: best.line };
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

function bboxOf(points: LngLat[], padDeg: number): [number, number, number, number] {
  let s = Infinity;
  let n = -Infinity;
  let w = Infinity;
  let e = -Infinity;
  for (const p of points) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
  }
  return [s - padDeg, w - padDeg, n + padDeg, e + padDeg];
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

function escapeOverpass(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** Fast local lookup around a click */
function aroundQuery(p: LngLat, radiusM: number): string {
  return `
[out:json][timeout:25];
(
  way(around:${radiusM},${p.lat},${p.lon})["waterway"~"^(river|canal|fairway|ship_canal|link|stream)$"];
  way(around:${radiusM},${p.lat},${p.lon})["landuse"="reservoir"];
  way(around:${radiusM},${p.lat},${p.lon})["natural"="water"]["water"~"^(lake|reservoir|basin)$"];
  way(around:${radiusM},${p.lat},${p.lon})["natural"="water"]["name"];
  relation(around:${radiusM},${p.lat},${p.lon})["landuse"="reservoir"];
  relation(around:${radiusM},${p.lat},${p.lon})["natural"="water"]["name"];
  relation(around:${radiusM},${p.lat},${p.lon})["waterway"~"^(river|canal)$"];
  relation(around:${radiusM},${p.lat},${p.lon})["type"="waterway"];
);
out geom;
`;
}

function namedWaterwayQuery(
  names: string[],
  s: number,
  w: number,
  n: number,
  e: number,
): string {
  const nameFilters = names
    .slice(0, 6)
    .map((name) => {
      const q = escapeOverpass(name);
      return `
  way["waterway"~"^(river|canal)$"]["name"="${q}"](${s},${w},${n},${e});
  way["waterway"~"^(river|canal)$"]["name:ru"="${q}"](${s},${w},${n},${e});
  relation["waterway"~"^(river|canal)$"]["name"="${q}"](${s},${w},${n},${e});
  relation["waterway"~"^(river|canal)$"]["name:ru"="${q}"](${s},${w},${n},${e});
  relation["type"="waterway"]["name"="${q}"](${s},${w},${n},${e});
  way["landuse"="reservoir"]["name"="${q}"](${s},${w},${n},${e});
  relation["landuse"="reservoir"]["name"="${q}"](${s},${w},${n},${e});
  way["natural"="water"]["name"="${q}"](${s},${w},${n},${e});
  relation["natural"="water"]["name"="${q}"](${s},${w},${n},${e});`;
    })
    .join('\n');

  return `
[out:json][timeout:35];
(
${nameFilters}
);
out geom;
`;
}

function corridorQuery(s: number, w: number, n: number, e: number): string {
  return `
[out:json][timeout:30];
(
  way["waterway"="river"](${s},${w},${n},${e});
  way["waterway"="canal"](${s},${w},${n},${e});
  way["waterway"="fairway"](${s},${w},${n},${e});
  way["waterway"="ship_canal"](${s},${w},${n},${e});
);
out geom;
`;
}

async function fetchWaterNetwork(points: LngLat[]): Promise<WaterLine[]> {
  const byId = new Map<string, WaterLine>();
  const add = (lines: WaterLine[]) => {
    for (const line of lines) {
      if (!byId.has(line.id)) byId.set(line.id, line);
    }
  };

  const names = new Set<string>();

  // One fast parallel around-pass (2 km)
  {
    const batches = await Promise.all(
      points.map(async (p) => {
        try {
          return linesFromElements(await overpassQuery(aroundQuery(p, 2000)));
        } catch {
          return [] as WaterLine[];
        }
      }),
    );
    for (const lines of batches) {
      add(lines);
      for (const line of lines) if (line.name) names.add(line.name);
    }
  }

  // Retry farther only if nothing found
  if (byId.size === 0) {
    const batches = await Promise.all(
      points.map(async (p) => {
        try {
          return linesFromElements(await overpassQuery(aroundQuery(p, 5000)));
        } catch {
          return [] as WaterLine[];
        }
      }),
    );
    for (const lines of batches) {
      add(lines);
      for (const line of lines) if (line.name) names.add(line.name);
    }
  }

  const span = pathLength(points);
  const pad = Math.min(1.2, Math.max(0.06, span / 180 + 0.06));
  const [s, w, n, e] = bboxOf(points, pad);

  // Pull full named rivers/reservoirs across the short corridor
  if (names.size > 0) {
    try {
      add(
        linesFromElements(
          await overpassQuery(namedWaterwayQuery([...names].slice(0, 4), s, w, n, e)),
        ),
      );
    } catch {
      // ignore
    }
  }

  // Early exit if already routable between endpoints
  if (points.length >= 2) {
    const probe = routeOnLines(points[0]!, points[points.length - 1]!, [...byId.values()]);
    if (probe.method !== 'direct') return [...byId.values()];
  }

  // Lightweight corridor fill for missing links
  try {
    add(linesFromElements(await overpassQuery(corridorQuery(s, w, n, e))));
  } catch {
    // ignore
  }

  return [...byId.values()];
}

function routeOnLines(origin: LngLat, destination: LngLat, lines: WaterLine[]): WaterPath {
  const distDirect = haversineKm(origin, destination);
  if (lines.length === 0) {
    return { points: [origin, destination], lengthKm: distDirect, waterName: null, method: 'direct' };
  }

  const { nodes, edges } = buildGraph(lines);
  const snapMax = Math.min(SNAP_MAX_KM, Math.max(2, distDirect * 0.3 + 1));
  const snapA = snapToNetwork(origin, lines, nodes, edges, snapMax);
  const snapB = snapToNetwork(destination, lines, nodes, edges, snapMax);

  if (!snapA || !snapB) {
    return { points: [origin, destination], lengthKm: distDirect, waterName: null, method: 'direct' };
  }

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
      waterName: snapA.line.name ?? 'водоём',
      method: 'lake',
    };
  }

  const nodePath = dijkstra(snapA.nodeId, snapB.nodeId, nodes.length, edges);
  if (!nodePath || nodePath.length < 2) {
    const points = simplifyPath([origin, snapA.point, snapB.point, destination]);
    const lakeish = snapA.line.kind === 'lake' || snapB.line.kind === 'lake';
    return {
      points,
      lengthKm: pathLength(points),
      waterName: snapA.line.name ?? snapB.line.name,
      method: lakeish ? 'lake' : 'direct',
    };
  }

  const points: LngLat[] = [origin];
  for (const id of nodePath) {
    const n = nodes[id]!;
    points.push({ lon: n.lon, lat: n.lat });
  }
  points.push(destination);

  const named =
    [snapA.line.name, snapB.line.name]
      .filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(', ') || null;

  return {
    points: simplifyPath(points),
    lengthKm: pathLength(points),
    waterName: named,
    method: 'waterway',
  };
}

export async function routeAlongWater(origin: LngLat, destination: LngLat): Promise<WaterPath> {
  const lines = await fetchWaterNetwork([origin, destination]);
  return routeOnLines(origin, destination, lines);
}

export async function measureWaterChain(waypoints: LngLat[]): Promise<WaterPath> {
  if (waypoints.length < 2) {
    return { points: waypoints.slice(), lengthKm: 0, waterName: null, method: 'direct' };
  }

  const lines = await fetchWaterNetwork(waypoints);
  if (lines.length === 0) {
    return {
      points: waypoints.slice(),
      lengthKm: pathLength(waypoints),
      waterName: null,
      method: 'direct',
    };
  }

  const allPoints: LngLat[] = [];
  let lengthKm = 0;
  const names = new Set<string>();
  let method: WaterPath['method'] = 'waterway';
  let anyRouted = false;

  for (let i = 1; i < waypoints.length; i++) {
    const leg = routeOnLines(waypoints[i - 1]!, waypoints[i]!, lines);
    if (leg.method !== 'direct') anyRouted = true;
    if (leg.method === 'lake' && method === 'waterway') method = 'lake';
    if (leg.waterName) names.add(leg.waterName);
    const chunk = i === 1 ? leg.points : leg.points.slice(1);
    allPoints.push(...chunk);
    lengthKm += leg.lengthKm;
  }

  if (!anyRouted) method = 'direct';

  return {
    points: simplifyPath(allPoints),
    lengthKm,
    waterName: names.size ? [...names].slice(0, 4).join(', ') : null,
    method,
  };
}
