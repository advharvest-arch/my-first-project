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

type GraphNode = {
  id: number;
  lon: number;
  lat: number;
};

type GraphEdge = {
  a: number;
  b: number;
  w: number;
};

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function keyOf(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

async function overpassQuery(query: string): Promise<OverpassElement[]> {
  let lastError: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const data = (await res.json()) as { elements?: OverpassElement[] };
      return data.elements ?? [];
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Overpass failed');
}

function linesFromElements(elements: OverpassElement[]): Array<{
  name: string | null;
  coords: LngLat[];
  kind: 'waterway' | 'lake';
}> {
  const lines: Array<{ name: string | null; coords: LngLat[]; kind: 'waterway' | 'lake' }> = [];

  for (const el of elements) {
    const name = el.tags?.name ?? el.tags?.['name:ru'] ?? null;
    const isLake =
      el.tags?.natural === 'water' ||
      el.tags?.water === 'lake' ||
      el.tags?.water === 'reservoir' ||
      el.tags?.landuse === 'reservoir';

    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      lines.push({
        name,
        kind: isLake ? 'lake' : 'waterway',
        coords: el.geometry.map((g) => ({ lon: g.lon, lat: g.lat })),
      });
    }

    if (el.type === 'relation' && el.members) {
      for (const m of el.members) {
        if (m.geometry && m.geometry.length >= 2) {
          lines.push({
            name,
            kind: 'lake',
            coords: m.geometry.map((g) => ({ lon: g.lon, lat: g.lat })),
          });
        }
      }
    }
  }

  return lines;
}

function buildGraph(lines: Array<{ coords: LngLat[] }>): {
  nodes: GraphNode[];
  edges: GraphEdge[];
  index: Map<string, number>;
} {
  const index = new Map<string, number>();
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const ensure = (p: LngLat): number => {
    const k = keyOf(p.lon, p.lat);
    const existing = index.get(k);
    if (existing != null) return existing;
    const id = nodes.length;
    nodes.push({ id, lon: p.lon, lat: p.lat });
    index.set(k, id);
    return id;
  };

  for (const line of lines) {
    for (let i = 1; i < line.coords.length; i++) {
      const a = line.coords[i - 1]!;
      const b = line.coords[i]!;
      const ia = ensure(a);
      const ib = ensure(b);
      const w = haversineKm(a, b);
      if (w <= 0) continue;
      edges.push({ a: ia, b: ib, w });
      edges.push({ a: ib, b: ia, w });
    }
  }

  return { nodes, edges, index };
}

function snapToGraph(
  p: LngLat,
  lines: Array<{ coords: LngLat[] }>,
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodeId: number; point: LngLat; distKm: number } | null {
  let best: {
    point: LngLat;
    distKm: number;
    a: LngLat;
    b: LngLat;
  } | null = null;

  for (const line of lines) {
    for (let i = 1; i < line.coords.length; i++) {
      const a = line.coords[i - 1]!;
      const b = line.coords[i]!;
      const c = closestOnSegment(p, a, b);
      if (!best || c.distKm < best.distKm) {
        best = { point: c.point, distKm: c.distKm, a, b };
      }
    }
  }

  if (!best || best.distKm > 25) return null;

  // Add temporary snap node connected to segment endpoints
  const nodeId = nodes.length;
  nodes.push({ id: nodeId, lon: best.point.lon, lat: best.point.lat });

  const findOrApprox = (q: LngLat): number => {
    let id = -1;
    let d = Infinity;
    for (const n of nodes) {
      const dd = haversineKm(q, n);
      if (dd < d) {
        d = dd;
        id = n.id;
      }
    }
    return id;
  };

  const ia = findOrApprox(best.a);
  const ib = findOrApprox(best.b);
  edges.push({ a: nodeId, b: ia, w: haversineKm(best.point, nodes[ia]!) });
  edges.push({ a: ia, b: nodeId, w: haversineKm(best.point, nodes[ia]!) });
  edges.push({ a: nodeId, b: ib, w: haversineKm(best.point, nodes[ib]!) });
  edges.push({ a: ib, b: nodeId, w: haversineKm(best.point, nodes[ib]!) });

  return { nodeId, point: best.point, distKm: best.distKm };
}

function dijkstra(
  start: number,
  goal: number,
  nodes: GraphNode[],
  edges: GraphEdge[],
): number[] | null {
  const adj = new Map<number, Array<{ to: number; w: number }>>();
  for (const e of edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    adj.get(e.a)!.push({ to: e.b, w: e.w });
  }

  const dist = new Float64Array(nodes.length).fill(Infinity);
  const prev = new Int32Array(nodes.length).fill(-1);
  dist[start] = 0;

  // binary-heap-less: for local graphs this is fine
  const used = new Uint8Array(nodes.length);
  for (let iter = 0; iter < nodes.length; iter++) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < nodes.length; i++) {
      if (!used[i] && dist[i]! < best) {
        best = dist[i]!;
        u = i;
      }
    }
    if (u < 0 || best === Infinity) break;
    if (u === goal) break;
    used[u] = 1;
    for (const { to, w } of adj.get(u) ?? []) {
      const nd = dist[u]! + w;
      if (nd < dist[to]!) {
        dist[to] = nd;
        prev[to] = u;
      }
    }
  }

  if (!Number.isFinite(dist[goal]!)) return null;
  const path: number[] = [];
  for (let cur = goal; cur !== -1; cur = prev[cur]!) path.push(cur);
  path.reverse();
  return path;
}

function bboxOf(a: LngLat, b: LngLat, padDeg: number): [number, number, number, number] {
  const south = Math.min(a.lat, b.lat) - padDeg;
  const north = Math.max(a.lat, b.lat) + padDeg;
  const west = Math.min(a.lon, b.lon) - padDeg;
  const east = Math.max(a.lon, b.lon) + padDeg;
  return [south, west, north, east];
}

export async function routeAlongWater(origin: LngLat, destination: LngLat): Promise<WaterPath> {
  const distDirect = haversineKm(origin, destination);
  const pad = Math.min(2.5, Math.max(0.15, distDirect / 111 / 2 + 0.2));
  const [s, w, n, e] = bboxOf(origin, destination, pad);

  const query = `
[out:json][timeout:40];
(
  way["waterway"~"^(river|canal|fairway|tidal_channel|ship_canal)$"](${s},${w},${n},${e});
  way["natural"="water"](${s},${w},${n},${e});
  way["water"~"^(lake|reservoir|river|canal)$"](${s},${w},${n},${e});
  relation["natural"="water"](${s},${w},${n},${e});
  relation["water"~"^(lake|reservoir)$"](${s},${w},${n},${e});
);
out body geom;
`;

  const elements = await overpassQuery(query);
  const lines = linesFromElements(elements);

  if (lines.length === 0) {
    return {
      points: [origin, destination],
      lengthKm: distDirect,
      waterName: null,
      method: 'direct',
    };
  }

  const { nodes, edges } = buildGraph(lines);
  const snapA = snapToGraph(origin, lines, nodes, edges);
  const snapB = snapToGraph(destination, lines, nodes, edges);

  if (!snapA || !snapB) {
    return {
      points: [origin, destination],
      lengthKm: distDirect,
      waterName: null,
      method: 'direct',
    };
  }

  const nodePath = dijkstra(snapA.nodeId, snapB.nodeId, nodes, edges);
  if (!nodePath || nodePath.length < 2) {
    // Same lake polygon: allow straight water crossing if both snaps are close to lake lines
    const lakeHit = lines.some((l) => l.kind === 'lake');
    if (lakeHit) {
      const points = [origin, snapA.point, snapB.point, destination];
      let lengthKm = 0;
      for (let i = 1; i < points.length; i++) lengthKm += haversineKm(points[i - 1]!, points[i]!);
      return {
        points,
        lengthKm,
        waterName: lines.find((l) => l.kind === 'lake' && l.name)?.name ?? 'озеро',
        method: 'lake',
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

  let lengthKm = 0;
  for (let i = 1; i < points.length; i++) lengthKm += haversineKm(points[i - 1]!, points[i]!);

  const named = lines.find((l) => l.name)?.name ?? null;

  return {
    points,
    lengthKm,
    waterName: named,
    method: 'waterway',
  };
}

export async function measureWaterChain(waypoints: LngLat[]): Promise<WaterPath> {
  if (waypoints.length < 2) {
    return { points: waypoints.slice(), lengthKm: 0, waterName: null, method: 'direct' };
  }

  const allPoints: LngLat[] = [];
  let lengthKm = 0;
  const names = new Set<string>();
  let method: WaterPath['method'] = 'waterway';

  for (let i = 1; i < waypoints.length; i++) {
    const leg = await routeAlongWater(waypoints[i - 1]!, waypoints[i]!);
    if (leg.method === 'direct') method = method === 'waterway' ? 'direct' : method;
    if (leg.method === 'lake' && method === 'waterway') method = 'lake';
    if (leg.waterName) names.add(leg.waterName);
    const chunk = i === 1 ? leg.points : leg.points.slice(1);
    allPoints.push(...chunk);
    lengthKm += leg.lengthKm;
  }

  return {
    points: allPoints,
    lengthKm,
    waterName: names.size ? [...names].slice(0, 3).join(', ') : null,
    method,
  };
}
