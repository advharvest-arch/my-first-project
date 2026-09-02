/**
 * Area-Bridge overlay for WaterGraph routing.
 *
 * E1 centerlines stay the primary graph. Lake / reservoir / river_area polygons
 * may bridge two E1 fragments only when an E1 edge geometrically intersects
 * (or has a vertex in/on) the same water area.
 *
 * Forbidden: proximity snap, distance-based seams, permanent wg_edges, land gaps.
 */

import { haversineKm, pathLengthKm, type LngLat } from './geo';

export const AREA_BRIDGE_PROVIDER = 'area_bridge' as const;

/** Water-area classes eligible for bridging. */
export const AREA_BRIDGE_WATER_TYPES = new Set([
  'lake',
  'reservoir',
  'river_area',
]);

export type AreaBridgeNode = {
  node_id: number;
  lon: number;
  lat: number;
};

export type AreaBridgeEdge = {
  edge_id: number;
  osm_id?: number;
  name?: string | null;
  waterway?: string | null;
  from_node_id: number;
  to_node_id: number;
  length_m: number;
  nav_status: string;
  geom?: { type: string; coordinates: number[][] } | null;
};

export type AreaBridgeArea = {
  osm_id: number;
  name?: string | null;
  water_type: string;
  geometry: {
    type: string;
    coordinates: unknown;
  };
};

export type AreaBridgeSnapshot = {
  schemaVersion?: string;
  title?: string;
  areas: AreaBridgeArea[];
  nodes: AreaBridgeNode[];
  edges: AreaBridgeEdge[];
};

export type AreaBridgeRouteOk = {
  ok: true;
  provider: typeof AREA_BRIDGE_PROVIDER;
  points: LngLat[];
  lengthKm: number;
  edgeIds: number[];
  areaOsmIds: number[];
  usedAreaBridge: boolean;
  startNodeId: number;
  endNodeId: number;
  note: string;
};

export type AreaBridgeRouteFail = {
  ok: false;
  provider: typeof AREA_BRIDGE_PROVIDER;
  reason: 'no_path' | 'terminal_unbound' | 'no_navigable_edges' | 'geometry_missing';
  note: string;
};

export type AreaBridgeRouteResult = AreaBridgeRouteOk | AreaBridgeRouteFail;

type Ring = Array<[number, number]>;

type ParsedArea = {
  osm_id: number;
  name: string | null;
  water_type: string;
  outers: Ring[];
  holes: Ring[];
  bbox: [number, number, number, number];
  hub: LngLat | null;
};

type Adj = { to: number; weight: number; edgeId: number; kind: 'e1' | 'area' };

type Portal = {
  id: number;
  areaOsmId: number;
  edgeId: number;
  point: LngLat;
  fromNodeId: number;
  toNodeId: number;
  distFromM: number;
  distToM: number;
};

const PORTAL_ID_BASE = 1_000_000_000;
const HUB_ID_BASE = 1_100_000_000;

function isNavigable(status: string): boolean {
  return status === 'NAVIGABLE';
}

function ringBBox(ring: Ring): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function inBBox(
  p: LngLat,
  b: [number, number, number, number],
  pad = 0,
): boolean {
  return (
    p.lon >= b[0] - pad &&
    p.lat >= b[1] - pad &&
    p.lon <= b[2] + pad &&
    p.lat <= b[3] + pad
  );
}

function pointInRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const inter =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

function onSeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  return (
    Math.min(ax, bx) - 1e-12 <= cx &&
    cx <= Math.max(ax, bx) + 1e-12 &&
    Math.min(ay, by) - 1e-12 <= cy &&
    cy <= Math.max(ay, by) + 1e-12 &&
    Math.abs((by - ay) * (cx - ax) - (bx - ax) * (cy - ay)) < 1e-10
  );
}

/** Boundary-inclusive membership (geometric incidence, not proximity). */
function pointInOrOnArea(p: LngLat, area: ParsedArea): boolean {
  if (!inBBox(p, area.bbox, 1e-4)) return false;
  let inOuter = false;
  for (const outer of area.outers) {
    if (pointInRing(p.lon, p.lat, outer)) {
      inOuter = true;
      break;
    }
    for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
      if (onSeg(outer[j]![0], outer[j]![1], outer[i]![0], outer[i]![1], p.lon, p.lat)) {
        inOuter = true;
        break;
      }
    }
    if (inOuter) break;
  }
  if (!inOuter) return false;
  for (const hole of area.holes) {
    if (pointInRing(p.lon, p.lat, hole)) return false;
  }
  return true;
}

function parseRing(raw: unknown): Ring | null {
  if (!Array.isArray(raw) || raw.length < 4) return null;
  const out: Ring = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 2) return null;
    out.push([Number(c[0]), Number(c[1])]);
  }
  return out;
}

function parseArea(area: AreaBridgeArea): ParsedArea | null {
  if (!AREA_BRIDGE_WATER_TYPES.has(area.water_type)) return null;
  const g = area.geometry;
  const outers: Ring[] = [];
  const holes: Ring[] = [];
  const pushPoly = (coords: unknown) => {
    if (!Array.isArray(coords) || !coords.length) return;
    const outer = parseRing(coords[0]);
    if (outer) outers.push(outer);
    for (let i = 1; i < coords.length; i++) {
      const hole = parseRing(coords[i]);
      if (hole) holes.push(hole);
    }
  };
  if (g.type === 'Polygon') pushPoly(g.coordinates);
  else if (g.type === 'MultiPolygon' && Array.isArray(g.coordinates)) {
    for (const poly of g.coordinates) pushPoly(poly);
  } else return null;
  if (!outers.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of outers) {
    const b = ringBBox(r);
    minX = Math.min(minX, b[0]);
    minY = Math.min(minY, b[1]);
    maxX = Math.max(maxX, b[2]);
    maxY = Math.max(maxY, b[3]);
  }
  const bbox: [number, number, number, number] = [minX, minY, maxX, maxY];
  // Hub: average of outer vertices that lie in water (fallback: bbox center if in water).
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const r of outers) {
    for (const [x, y] of r) {
      sx += x;
      sy += y;
      n += 1;
    }
  }
  const cand: LngLat = { lon: sx / Math.max(n, 1), lat: sy / Math.max(n, 1) };
  const parsed: ParsedArea = {
    osm_id: area.osm_id,
    name: area.name ?? null,
    water_type: area.water_type,
    outers,
    holes,
    bbox,
    hub: null,
  };
  if (pointInOrOnArea(cand, parsed)) parsed.hub = cand;
  else {
    // Probe a few interior offsets from centroid.
    for (const [dx, dy] of [
      [0, 0],
      [0.05, 0],
      [-0.05, 0],
      [0, 0.03],
      [0, -0.03],
      [0.1, 0.05],
      [-0.1, -0.05],
    ] as const) {
      const p = { lon: cand.lon + dx, lat: cand.lat + dy };
      if (pointInOrOnArea(p, parsed)) {
        parsed.hub = p;
        break;
      }
    }
  }
  return parsed;
}

function edgeCoords(edge: AreaBridgeEdge, nodes: Map<number, AreaBridgeNode>): LngLat[] {
  const coords = edge.geom?.coordinates;
  if (coords && coords.length >= 2) {
    return coords.map((c) => ({ lon: c[0]!, lat: c[1]! }));
  }
  const a = nodes.get(edge.from_node_id);
  const b = nodes.get(edge.to_node_id);
  if (a && b) return [{ lon: a.lon, lat: a.lat }, { lon: b.lon, lat: b.lat }];
  return [];
}

function densify(coords: LngLat[], stepKm = 0.08): LngLat[] {
  if (coords.length < 2) return coords;
  const out: LngLat[] = [{ ...coords[0]! }];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
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

function cumulativeKm(coords: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) {
    cum.push(cum[i - 1]! + haversineKm(coords[i - 1]!, coords[i]!));
  }
  return cum;
}

/**
 * Geometric incidence portals: samples of edge geometry that lie in/on area.
 * No proximity between disconnected objects.
 */
function portalsForEdge(
  edge: AreaBridgeEdge,
  area: ParsedArea,
  nodes: Map<number, AreaBridgeNode>,
  portalSeq: { n: number },
): Portal[] {
  const raw = edgeCoords(edge, nodes);
  if (raw.length < 2) return [];
  const dens = densify(raw, 0.08);
  const cum = cumulativeKm(dens);
  const totalKm = cum[cum.length - 1] || 1e-9;
  const insideFlags = dens.map((p) => pointInOrOnArea(p, area));
  if (!insideFlags.some(Boolean)) return [];

  const runs: Array<{ lo: number; hi: number }> = [];
  let start = -1;
  for (let i = 0; i < insideFlags.length; i++) {
    if (insideFlags[i] && start < 0) start = i;
    if ((!insideFlags[i] || i === insideFlags.length - 1) && start >= 0) {
      const hi = insideFlags[i] && i === insideFlags.length - 1 ? i : i - 1;
      if (hi >= start) runs.push({ lo: start, hi });
      start = -1;
    }
  }

  const portals: Portal[] = [];
  for (const run of runs) {
    const pts =
      run.lo === run.hi
        ? [dens[run.lo]!]
        : [dens[run.lo]!, dens[run.hi]!];
    for (const p of pts) {
      const idx = dens.findIndex(
        (q) => Math.abs(q.lon - p.lon) < 1e-12 && Math.abs(q.lat - p.lat) < 1e-12,
      );
      const alongKm = cum[Math.max(0, idx)] ?? 0;
      const distFromM = (alongKm / totalKm) * edge.length_m;
      const distToM = Math.max(0, edge.length_m - distFromM);
      portalSeq.n += 1;
      portals.push({
        id: PORTAL_ID_BASE + portalSeq.n,
        areaOsmId: area.osm_id,
        edgeId: edge.edge_id,
        point: p,
        fromNodeId: edge.from_node_id,
        toNodeId: edge.to_node_id,
        distFromM,
        distToM,
      });
    }
  }
  return portals;
}

function waterChordOk(a: LngLat, b: LngLat, area: ParsedArea, samples = 16): boolean {
  let inside = 0;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = {
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    };
    if (pointInOrOnArea(p, area)) inside += 1;
  }
  return inside / (samples + 1) >= 0.8;
}

function buildAdjacency(
  edges: AreaBridgeEdge[],
  portals: Portal[],
  areas: ParsedArea[],
): Map<number, Adj[]> {
  const adj = new Map<number, Adj[]>();
  const add = (u: number, v: number, weight: number, edgeId: number, kind: 'e1' | 'area') => {
    if (u === v || weight < 0) return;
    const list = adj.get(u) ?? [];
    list.push({ to: v, weight, edgeId, kind });
    adj.set(u, list);
  };

  for (const e of edges) {
    if (!isNavigable(e.nav_status)) continue;
    add(e.from_node_id, e.to_node_id, e.length_m, e.edge_id, 'e1');
    add(e.to_node_id, e.from_node_id, e.length_m, e.edge_id, 'e1');
  }

  // Portal ↔ E1 endpoints along the incident edge.
  for (const p of portals) {
    add(p.fromNodeId, p.id, p.distFromM, p.edgeId, 'e1');
    add(p.id, p.fromNodeId, p.distFromM, p.edgeId, 'e1');
    add(p.toNodeId, p.id, p.distToM, p.edgeId, 'e1');
    add(p.id, p.toNodeId, p.distToM, p.edgeId, 'e1');
  }

  // Same-area portal mesh: direct water chord or via hub (still inside one area).
  const byArea = new Map<number, Portal[]>();
  for (const p of portals) {
    const list = byArea.get(p.areaOsmId) ?? [];
    list.push(p);
    byArea.set(p.areaOsmId, list);
  }
  const areaById = new Map(areas.map((a) => [a.osm_id, a]));

  for (const [areaId, list] of byArea) {
    const area = areaById.get(areaId);
    if (!area) continue;
    // Dedup portals that coincide.
    const uniq: Portal[] = [];
    for (const p of list) {
      if (
        uniq.some(
          (q) =>
            haversineKm(p.point, q.point) < 0.02 && p.edgeId === q.edgeId,
        )
      ) {
        continue;
      }
      uniq.push(p);
    }

    let hubId: number | null = null;
    if (area.hub) {
      hubId = HUB_ID_BASE + areaId;
      for (const p of uniq) {
        if (!waterChordOk(p.point, area.hub, area)) continue;
        const w = haversineKm(p.point, area.hub) * 1000;
        add(p.id, hubId, w, -areaId, 'area');
        add(hubId, p.id, w, -areaId, 'area');
      }
    }

    for (let i = 0; i < uniq.length; i++) {
      for (let j = i + 1; j < uniq.length; j++) {
        const a = uniq[i]!;
        const b = uniq[j]!;
        if (!waterChordOk(a.point, b.point, area)) continue;
        const w = haversineKm(a.point, b.point) * 1000;
        add(a.id, b.id, w, -areaId, 'area');
        add(b.id, a.id, w, -areaId, 'area');
      }
    }
    void hubId;
  }

  return adj;
}

function dijkstra(
  adj: Map<number, Adj[]>,
  start: number,
  goal: number,
): { nodes: number[]; usedArea: boolean; edgeIds: number[]; areaOsmIds: number[] } | null {
  if (!adj.has(start) || !adj.has(goal)) return null;
  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, { via: number; link: Adj }>();
  const heap: Array<{ d: number; u: number }> = [{ d: 0, u: start }];
  while (heap.length) {
    heap.sort((a, b) => a.d - b.d);
    const cur = heap.shift()!;
    if (cur.d !== dist.get(cur.u)) continue;
    if (cur.u === goal) break;
    for (const nb of adj.get(cur.u) ?? []) {
      const nd = cur.d + nb.weight;
      if (nd < (dist.get(nb.to) ?? Infinity)) {
        dist.set(nb.to, nd);
        prev.set(nb.to, { via: cur.u, link: nb });
        heap.push({ d: nd, u: nb.to });
      }
    }
  }
  if (!prev.has(goal) && start !== goal) return null;
  const nodes = [goal];
  const edgeIds: number[] = [];
  const areaOsmIds = new Set<number>();
  let usedArea = false;
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (!p) return null;
    if (p.link.kind === 'area') {
      usedArea = true;
      if (p.link.edgeId < 0) areaOsmIds.add(-p.link.edgeId);
    } else if (p.link.edgeId > 0) {
      edgeIds.push(p.link.edgeId);
    }
    nodes.push(p.via);
    cur = p.via;
  }
  nodes.reverse();
  edgeIds.reverse();
  return { nodes, usedArea, edgeIds, areaOsmIds: [...areaOsmIds] };
}

function nodePoint(
  id: number,
  nodes: Map<number, AreaBridgeNode>,
  portals: Map<number, Portal>,
  hubs: Map<number, LngLat>,
): LngLat | null {
  const n = nodes.get(id);
  if (n) return { lon: n.lon, lat: n.lat };
  const p = portals.get(id);
  if (p) return p.point;
  return hubs.get(id) ?? null;
}

function reconstruct(
  nodeIds: number[],
  nodes: Map<number, AreaBridgeNode>,
  portals: Map<number, Portal>,
  hubs: Map<number, LngLat>,
): LngLat[] | null {
  const out: LngLat[] = [];
  for (const id of nodeIds) {
    const p = nodePoint(id, nodes, portals, hubs);
    if (!p) return null;
    const last = out[out.length - 1];
    if (!last || haversineKm(last, p) > 1e-6) out.push(p);
  }
  return out.length >= 2 ? out : null;
}

function bindTerminal(
  pt: LngLat,
  nodeIds: number[],
  nodes: Map<number, AreaBridgeNode>,
  adj: Map<number, Adj[]>,
  maxKm: number,
): { nodeId: number; distKm: number } | null {
  let best: { nodeId: number; distKm: number } | null = null;
  for (const id of nodeIds) {
    if (!adj.has(id)) continue;
    const n = nodes.get(id);
    if (!n) continue;
    const d = haversineKm(pt, { lon: n.lon, lat: n.lat });
    if (d > maxKm) continue;
    if (!best || d < best.distKm) best = { nodeId: id, distKm: d };
  }
  return best;
}

/**
 * Route A→B on E1 NAVIGABLE edges with optional same-area water bridges.
 * Does not mutate wg_edges. Areas that do not touch are never merged.
 */
export function routeWithAreaBridge(
  a: LngLat,
  b: LngLat,
  snapshot: AreaBridgeSnapshot,
  opts?: { maxSnapKm?: number },
): AreaBridgeRouteResult {
  const maxSnap = opts?.maxSnapKm ?? 25;
  const navEdges = snapshot.edges.filter((e) => isNavigable(e.nav_status));
  if (!navEdges.length) {
    return {
      ok: false,
      provider: AREA_BRIDGE_PROVIDER,
      reason: 'no_navigable_edges',
      note: 'No NAVIGABLE E1 edges in area-bridge snapshot',
    };
  }

  const nodes = new Map(snapshot.nodes.map((n) => [n.node_id, n]));
  const areas = snapshot.areas
    .map(parseArea)
    .filter((x): x is ParsedArea => !!x);

  const portalSeq = { n: 0 };
  const portals: Portal[] = [];
  for (const area of areas) {
    for (const edge of navEdges) {
      portals.push(...portalsForEdge(edge, area, nodes, portalSeq));
    }
  }

  const adj = buildAdjacency(navEdges, portals, areas);
  const portalMap = new Map(portals.map((p) => [p.id, p]));
  const hubs = new Map<number, LngLat>();
  for (const area of areas) {
    if (area.hub) hubs.set(HUB_ID_BASE + area.osm_id, area.hub);
  }

  const e1NodeIds = snapshot.nodes.map((n) => n.node_id);
  const bindA = bindTerminal(a, e1NodeIds, nodes, adj, maxSnap);
  const bindB = bindTerminal(b, e1NodeIds, nodes, adj, maxSnap);
  if (!bindA || !bindB) {
    return {
      ok: false,
      provider: AREA_BRIDGE_PROVIDER,
      reason: 'terminal_unbound',
      note: `No E1 node within ${maxSnap} km of endpoint(s)`,
    };
  }
  if (bindA.nodeId === bindB.nodeId) {
    return {
      ok: false,
      provider: AREA_BRIDGE_PROVIDER,
      reason: 'no_path',
      note: 'Terminals collapse to the same E1 node',
    };
  }

  const path = dijkstra(adj, bindA.nodeId, bindB.nodeId);
  if (!path) {
    return {
      ok: false,
      provider: AREA_BRIDGE_PROVIDER,
      reason: 'no_path',
      note: 'NO WATER CONNECTION — no E1 path and no proven area bridge',
    };
  }

  const points = reconstruct(path.nodes, nodes, portalMap, hubs);
  if (!points) {
    return {
      ok: false,
      provider: AREA_BRIDGE_PROVIDER,
      reason: 'geometry_missing',
      note: 'Could not reconstruct route geometry',
    };
  }

  return {
    ok: true,
    provider: AREA_BRIDGE_PROVIDER,
    points,
    lengthKm: pathLengthKm(points),
    edgeIds: [...new Set(path.edgeIds)],
    areaOsmIds: path.areaOsmIds,
    usedAreaBridge: path.usedArea,
    startNodeId: bindA.nodeId,
    endNodeId: bindB.nodeId,
    note: path.usedArea
      ? `E1 + area-bridge via osm_id=${path.areaOsmIds.join(',')}`
      : 'E1-only path (area-bridge unused)',
  };
}

/** Pure E1 Dijkstra on the same snapshot (area overlay disabled). */
export function routeE1Only(
  a: LngLat,
  b: LngLat,
  snapshot: AreaBridgeSnapshot,
  opts?: { maxSnapKm?: number },
): AreaBridgeRouteResult {
  return routeWithAreaBridge(a, b, { ...snapshot, areas: [] }, opts);
}

/** Beloye lake corridor geographic gate (not a route-name special case). */
export function isBeloyeAreaBridgeCorridor(a: LngLat, b: LngLat): boolean {
  const inBox = (p: LngLat) =>
    p.lon >= 36.6 && p.lon <= 38.4 && p.lat >= 59.85 && p.lat <= 60.95;
  return inBox(a) && inBox(b);
}

/** True when two areas share no proven water connection (no touch / no bridge). */
export function areasShareBoundary(
  a: AreaBridgeArea,
  b: AreaBridgeArea,
): boolean {
  const pa = parseArea(a);
  const pb = parseArea(b);
  if (!pa || !pb) return false;
  // Vertex coincidence on boundaries = geometric touch (not distance threshold).
  const verts = (rings: Ring[]) => {
    const out: LngLat[] = [];
    for (const r of rings) for (const [lon, lat] of r) out.push({ lon, lat });
    return out;
  };
  const va = verts([...pa.outers, ...pa.holes]);
  const vb = verts([...pb.outers, ...pb.holes]);
  for (const p of va) {
    for (const q of vb) {
      if (Math.abs(p.lon - q.lon) < 1e-9 && Math.abs(p.lat - q.lat) < 1e-9) {
        return true;
      }
    }
  }
  // Also: any vertex of A in/on B or vice versa (overlapping areas).
  for (const p of va) if (pointInOrOnArea(p, pb)) return true;
  for (const p of vb) if (pointInOrOnArea(p, pa)) return true;
  return false;
}
