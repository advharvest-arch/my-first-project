/**
 * E9 — PostGIS WaterGraph provider for AquaRoute hybrid pilot.
 *
 * Routes on a snapshot export of the isolated PostGIS WaterGraph
 * (NAVIGABLE edges only from E8). Exact E1 node ids — no proximity
 * stitching, no name heuristics, no crossings as connections.
 *
 * Used only when USE_WATER_GRAPH=true. Does not change production default.
 */

import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { maxWaterSnapKm } from './water-snap';
import belomorNavigable from './__fixtures__/postgis-watergraph/belomor-navigable.json';

export const POSTGIS_WG_PROVIDER = 'postgis_watergraph' as const;

export type PostgisWgNavStatus = 'NAVIGABLE' | 'BLOCKED' | 'UNKNOWN';

export type PostgisWgNode = {
  node_id: number;
  lon: number;
  lat: number;
};

export type PostgisWgEdge = {
  edge_id: number;
  osm_type?: string | null;
  osm_id: number;
  name?: string | null;
  waterway?: string | null;
  from_node_id: number;
  to_node_id: number;
  length_m: number;
  parent_relation_ids?: number[];
  nav_status: PostgisWgNavStatus | string;
  nav_reasons?: string[];
  safety_status?: string | null;
  geom?: {
    type: string;
    coordinates: number[][];
  } | null;
};

export type PostgisWgSnapshot = {
  schemaVersion: string;
  build_id: number;
  navigation_run_id: number;
  safety_run_id: number | null;
  relation_id: number;
  policy: {
    routable_nav_status: string[];
    forbidden_nav_status: string[];
    note?: string;
  };
  nodes: PostgisWgNode[];
  edges: PostgisWgEdge[];
  vb_gap_edges?: PostgisWgEdge[];
  volga_akhtuba_sample?: Array<{
    edge_id: number;
    osm_id: number;
    name: string | null;
    from_node_id: number;
    to_node_id: number;
    nav_status: string;
  }>;
};

export type PostgisWgRouteOk = {
  ok: true;
  provider: typeof POSTGIS_WG_PROVIDER;
  points: LngLat[];
  lengthKm: number;
  edgeIds: number[];
  osmIds: number[];
  startNodeId: number;
  endNodeId: number;
  navStatusesUsed: string[];
  snapAKm: number;
  snapBKm: number;
  note: string;
};

export type PostgisWgRouteFail = {
  ok: false;
  provider: typeof POSTGIS_WG_PROVIDER;
  reason: string;
  note: string;
};

export type PostgisWgRouteResult = PostgisWgRouteOk | PostgisWgRouteFail;

type AdjEntry = { to: number; weight: number; edge: PostgisWgEdge };

const snapshot = belomorNavigable as PostgisWgSnapshot;

function isNavigable(status: string): boolean {
  return status === 'NAVIGABLE';
}

/** Only NAVIGABLE edges enter the adjacency (UNKNOWN/BLOCKED forbidden). */
export function buildNavigableAdjacency(
  edges: PostgisWgEdge[],
): Map<number, AdjEntry[]> {
  const adj = new Map<number, AdjEntry[]>();
  const add = (u: number, v: number, edge: PostgisWgEdge) => {
    const list = adj.get(u) ?? [];
    list.push({ to: v, weight: edge.length_m, edge });
    adj.set(u, list);
  };
  for (const e of edges) {
    if (!isNavigable(e.nav_status)) continue;
    add(e.from_node_id, e.to_node_id, e);
    add(e.to_node_id, e.from_node_id, e);
  }
  return adj;
}

export function getPostgisWgSnapshot(): PostgisWgSnapshot {
  return snapshot;
}

export function postgisWgNavigableEdgeCount(
  snap: PostgisWgSnapshot = snapshot,
): number {
  return snap.edges.filter((e) => isNavigable(e.nav_status)).length;
}

export function postgisWgForbiddenEdgeCount(
  snap: PostgisWgSnapshot = snapshot,
): number {
  return snap.edges.filter((e) => !isNavigable(e.nav_status)).length;
}

function geomCoords(edge: PostgisWgEdge): LngLat[] {
  const coords = edge.geom?.coordinates;
  if (!coords || coords.length < 2) return [];
  return coords.map((c) => ({ lon: c[0]!, lat: c[1]! }));
}

function orientedGeom(edge: PostgisWgEdge, fromNode: number): LngLat[] {
  const pts = geomCoords(edge);
  if (pts.length < 2) {
    // Fallback: straight between endpoints is not used for production accept —
    // without geom we cannot build a validated path.
    return [];
  }
  if (fromNode === edge.from_node_id) return pts;
  if (fromNode === edge.to_node_id) return [...pts].reverse();
  return pts;
}

/**
 * Bind terminal to a NAVIGABLE graph node within snap.
 * Prefer degree-1 (corridor ends) when available so mid-chain snaps
 * do not silently truncate a continuous NAVIGABLE corridor.
 */
function bindTerminal(
  nodes: PostgisWgNode[],
  adj: Map<number, AdjEntry[]>,
  pt: LngLat,
  maxKm: number,
): { node: PostgisWgNode; distKm: number } | null {
  const inSnap = nodes
    .map((n) => ({
      node: n,
      distKm: haversineKm(pt, { lon: n.lon, lat: n.lat }),
      degree: adj.get(n.node_id)?.length ?? 0,
    }))
    .filter((x) => x.distKm <= maxKm && x.degree > 0);
  if (!inSnap.length) return null;
  const ends = inSnap.filter((x) => x.degree === 1);
  const pool = ends.length ? ends : inSnap;
  pool.sort((a, b) => a.distKm - b.distKm);
  const best = pool[0]!;
  return { node: best.node, distKm: best.distKm };
}

function dijkstra(
  adj: Map<number, AdjEntry[]>,
  start: number,
  goal: number,
): { nodeIds: number[]; edges: PostgisWgEdge[] } | null {
  if (!adj.has(start) || !adj.has(goal)) return null;
  const dist = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, { via: number; edge: PostgisWgEdge }>();
  const heap: Array<{ d: number; u: number }> = [{ d: 0, u: start }];
  const push = (d: number, u: number) => {
    heap.push({ d, u });
    heap.sort((a, b) => a.d - b.d);
  };
  while (heap.length) {
    const cur = heap.shift()!;
    if (cur.d !== dist.get(cur.u)) continue;
    if (cur.u === goal) break;
    for (const nb of adj.get(cur.u) ?? []) {
      const nd = cur.d + nb.weight;
      if (nd < (dist.get(nb.to) ?? Infinity)) {
        dist.set(nb.to, nd);
        prev.set(nb.to, { via: cur.u, edge: nb.edge });
        push(nd, nb.to);
      }
    }
  }
  if (!prev.has(goal) && start !== goal) return null;
  const nodeIds = [goal];
  const edges: PostgisWgEdge[] = [];
  let cur = goal;
  while (cur !== start) {
    const p = prev.get(cur);
    if (!p) return null;
    edges.push(p.edge);
    nodeIds.push(p.via);
    cur = p.via;
  }
  nodeIds.reverse();
  edges.reverse();
  return { nodeIds, edges };
}

function reconstructPoints(
  nodeIds: number[],
  edges: PostgisWgEdge[],
): LngLat[] | null {
  if (edges.length === 0) return null;
  const out: LngLat[] = [];
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i]!;
    const from = nodeIds[i]!;
    const geom = orientedGeom(edge, from);
    if (geom.length < 2) return null;
    if (out.length === 0) out.push(...geom);
    else out.push(...geom.slice(1));
  }
  return out;
}

/**
 * Route A→B on PostGIS WaterGraph snapshot (NAVIGABLE only).
 * Terminals bind to nearest exported graph nodes within legacy waterway snap.
 * No new topology edges are invented.
 */
export function routePostgisWaterGraph(
  a: LngLat,
  b: LngLat,
  opts?: { maxSnapKm?: number; snapshot?: PostgisWgSnapshot },
): PostgisWgRouteResult {
  const snap = opts?.snapshot ?? snapshot;
  const maxSnap = opts?.maxSnapKm ?? maxWaterSnapKm();
  const navEdges = snap.edges.filter((e) => isNavigable(e.nav_status));
  if (!navEdges.length) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'no_navigable_edges',
      note: 'PostGIS WG snapshot has no NAVIGABLE edges',
    };
  }

  // Refuse to route if snapshot still contains UNKNOWN/BLOCKED Belomor edges
  // that would be needed — Belomor export is all NAVIGABLE; keep the guard.
  const forbidden = snap.edges.filter((e) => !isNavigable(e.nav_status));
  if (forbidden.length) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'unknown_or_blocked_edges_present',
      note: `Refusing graph with ${forbidden.length} non-NAVIGABLE edges in corridor export`,
    };
  }

  const adj = buildNavigableAdjacency(navEdges);
  const navNodes = snap.nodes.filter((n) => adj.has(n.node_id));
  const bindA = bindTerminal(navNodes, adj, a, maxSnap);
  const bindB = bindTerminal(navNodes, adj, b, maxSnap);
  if (!bindA || !bindB) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'terminal_unbound',
      note: `No NAVIGABLE node within ${maxSnap} km of endpoint(s)`,
    };
  }
  if (bindA.node.node_id === bindB.node.node_id) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'terminals_collapse',
      note: 'A and B bound to the same node',
    };
  }

  const path = dijkstra(adj, bindA.node.node_id, bindB.node.node_id);
  if (!path || !path.edges.length) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'no_path',
      note: 'No NAVIGABLE path between bound terminals (no stitch across gaps)',
    };
  }

  const statuses = [...new Set(path.edges.map((e) => e.nav_status))];
  if (statuses.some((s) => s !== 'NAVIGABLE')) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'unknown_edge_in_path',
      note: 'Path contained non-NAVIGABLE edge — forbidden',
    };
  }

  const points = reconstructPoints(path.nodeIds, path.edges);
  if (!points || points.length < 2) {
    return {
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'geometry_missing',
      note: 'Edge geometry missing — cannot build route',
    };
  }

  const lengthKm = pathLengthKm(points);
  return {
    ok: true,
    provider: POSTGIS_WG_PROVIDER,
    points,
    lengthKm,
    edgeIds: path.edges.map((e) => e.edge_id),
    osmIds: path.edges.map((e) => e.osm_id),
    startNodeId: bindA.node.node_id,
    endNodeId: bindB.node.node_id,
    navStatusesUsed: statuses,
    snapAKm: bindA.distKm,
    snapBKm: bindB.distKm,
    note: `PostGIS WG NAVIGABLE route (${path.edges.length} edges, build ${snap.build_id})`,
  };
}

/** Regression: VB gap ways share no E1 node and have no NAVIGABLE path between them. */
export function postgisWgVbGapBlocked(
  snap: PostgisWgSnapshot = snapshot,
): {
  sharedNodes: boolean;
  navigablePath: boolean;
  pass: boolean;
} {
  const gap = snap.vb_gap_edges ?? [];
  if (gap.length < 2) {
    return { sharedNodes: false, navigablePath: false, pass: true };
  }
  const a = gap[0]!;
  const b = gap[1]!;
  const shared = [a.from_node_id, a.to_node_id].some((n) =>
    [b.from_node_id, b.to_node_id].includes(n),
  );
  // Gap ways themselves may be NAVIGABLE individually — must not connect across.
  const allEdges = [...snap.edges, ...gap];
  const adj = buildNavigableAdjacency(allEdges);
  let navigablePath = false;
  for (const na of [a.from_node_id, a.to_node_id]) {
    for (const nb of [b.from_node_id, b.to_node_id]) {
      if (na === nb) continue;
      if (dijkstra(adj, na, nb)) {
        navigablePath = true;
        break;
      }
    }
  }
  return {
    sharedNodes: shared,
    navigablePath,
    pass: !shared && !navigablePath,
  };
}

/** Regression: Volga and Akhtuba NAVIGABLE samples share no nodes. */
export function postgisWgVolgaAkhtubaDisconnected(
  snap: PostgisWgSnapshot = snapshot,
): { sharedNavigableNodes: number; pass: boolean } {
  const sample = snap.volga_akhtuba_sample ?? [];
  const akh = sample.filter(
    (e) =>
      e.nav_status === 'NAVIGABLE' &&
      e.name &&
      /ахтуб|akhtub/i.test(e.name),
  );
  const vol = sample.filter(
    (e) =>
      e.nav_status === 'NAVIGABLE' &&
      e.name &&
      (/волг|volga/i.test(e.name) && !/ахтуб|akhtub/i.test(e.name)),
  );
  const aNodes = new Set(
    akh.flatMap((e) => [e.from_node_id, e.to_node_id]),
  );
  const vNodes = new Set(
    vol.flatMap((e) => [e.from_node_id, e.to_node_id]),
  );
  let shared = 0;
  for (const n of aNodes) if (vNodes.has(n)) shared += 1;
  return { sharedNavigableNodes: shared, pass: shared === 0 };
}

/** Geographic coverage: Belomor endpoints near exported graph. */
export function isPostgisBelomorCorridor(
  a: LngLat,
  b: LngLat,
  maxKm = 80,
): boolean {
  // Reuse same geographic anchors as hybrid Belomor (not route-name gating).
  const A = { lon: 34.82, lat: 62.86 };
  const B = { lon: 34.77, lat: 64.52 };
  const nearA =
    haversineKm(a, A) <= maxKm || haversineKm(a, B) <= maxKm;
  const nearB =
    haversineKm(b, A) <= maxKm || haversineKm(b, B) <= maxKm;
  return nearA && nearB;
}
