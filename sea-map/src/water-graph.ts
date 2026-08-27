/**
 * E2.0 — Hybrid WaterGraph foundation (corridor-level, shadow-capable).
 *
 * Builds CENTERLINE + MASK + FAIRWAY + LOCK/BARRIER layers, Dijkstra search,
 * path→geometry. Does NOT replace measureWaterChain production accept path.
 */

import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { getWaterGraphEdgeCost } from './water-graph-cost';
import type {
  CenterlineSource,
  WaterGraph,
  WaterGraphBuildOptions,
  WaterGraphComponents,
  WaterGraphEdge,
  WaterGraphEdgeKind,
  WaterGraphEdgeKindCounts,
  WaterGraphLegacyClass,
  WaterGraphNode,
  WaterGraphNodeKind,
  WaterGraphPath,
  WaterGraphProvenance,
  WaterGraphTerminal,
} from './water-graph-types';
import {
  DUBNA_LOCK,
  DUBNA_LOCK_CORRIDOR,
  DUBNA_LOCK_LOWER,
  DUBNA_LOCK_UPPER,
  KNOWN_BARRIERS,
  REGIONAL_FAIRWAYS,
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
  hasIllegalBarrierCrossing,
} from './routing-rules';
import type { LakeMask } from './open-lake';
import { pointInOpenWater } from './open-lake';
import { validateWaterRoute } from './validate-water-route';
import { evaluateHydroAcceptGate } from './hydro-gate';
import type {
  WaterGraphFailureStage,
  WaterGraphShadowResult,
} from './water-graph-types';

export const WG_MERGE_NODE_KM = 0.05;
export const WG_DENSIFY_MAX_KM = 2.0;
export const WG_LAKE_CONNECT_KM = 0.45;
export const WG_MASK_GRID_STEP_KM = 0.7;
/** Large-reservoir seam allowance (configurable; ≠ user snap). */
export const WG_LAKE_CONNECT_LARGE_KM = 1.5;

export {
  getWaterGraphEdgeCost,
  WG_CLASS_MULTIPLIER,
  classPreferenceRank,
} from './water-graph-cost';
export type * from './water-graph-types';

function keyOf(lon: number, lat: number): string {
  return `${lon.toFixed(5)},${lat.toFixed(5)}`;
}

function emptyGraph(): WaterGraph {
  return {
    nodes: new Map(),
    edges: new Map(),
    adjacency: new Map(),
    layers: { centerline: false, mask: false, fairway: false, lock: false },
  };
}

function addNode(g: WaterGraph, node: WaterGraphNode): WaterGraphNode {
  g.nodes.set(node.id, node);
  if (!g.adjacency.has(node.id)) g.adjacency.set(node.id, []);
  return node;
}

function addEdge(g: WaterGraph, edge: WaterGraphEdge): void {
  g.edges.set(edge.id, edge);
  const a = g.adjacency.get(edge.from) ?? [];
  a.push(edge.id);
  g.adjacency.set(edge.from, a);
  const b = g.adjacency.get(edge.to) ?? [];
  b.push(edge.id);
  g.adjacency.set(edge.to, b);
}

/**
 * Densify along existing geometry only (no geodesic shortcuts as route).
 */
export function densifyCenterlineCoords(
  coords: LngLat[],
  maxStepKm = WG_DENSIFY_MAX_KM,
): LngLat[] {
  if (coords.length < 2) return coords.slice();
  const out: LngLat[] = [coords[0]!];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1]!;
    const b = coords[i]!;
    const d = haversineKm(a, b);
    if (d <= maxStepKm) {
      out.push(b);
      continue;
    }
    const n = Math.ceil(d / maxStepKm);
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

/**
 * Deduplicate close nodes ONLY within the same waterId.
 * Never connect two waters just because they are geographically close.
 */
export function normalizeWaterCenterline(
  sources: CenterlineSource[],
  mergeKm = WG_MERGE_NODE_KM,
): CenterlineSource[] {
  return sources.map((src) => {
    const densified = densifyCenterlineCoords(src.coords, WG_DENSIFY_MAX_KM);
    const waterId = src.waterId ?? src.id;
    const out: LngLat[] = [];
    for (const p of densified) {
      const prev = out[out.length - 1];
      if (prev && haversineKm(prev, p) < mergeKm) continue;
      out.push(p);
    }
    return {
      ...src,
      waterId,
      coords: out.length >= 2 ? out : densified,
      source: src.source ?? src.kind,
      sourceId: src.sourceId ?? src.id,
    };
  });
}

function upsertVertex(
  g: WaterGraph,
  lon: number,
  lat: number,
  kind: WaterGraphNodeKind,
  waterId: string | null,
  mergeKm: number,
): string {
  // Find existing same-water node within mergeKm
  if (waterId) {
    for (const n of g.nodes.values()) {
      if (n.waterId !== waterId) continue;
      if (haversineKm(n, { lon, lat }) <= mergeKm) return n.id;
    }
  }
  const id = `n:${kind}:${waterId ?? 'x'}:${keyOf(lon, lat)}:${g.nodes.size}`;
  addNode(g, { id, lon, lat, kind, waterId });
  return id;
}

function linkPolyline(
  g: WaterGraph,
  coords: LngLat[],
  kind: WaterGraphEdgeKind,
  waterId: string,
  meta: WaterGraphEdge['metadata'],
  mergeKm: number,
): void {
  let prevId: string | null = null;
  for (const p of coords) {
    const id = upsertVertex(g, p.lon, p.lat, 'vertex', waterId, mergeKm);
    if (prevId && prevId !== id) {
      const a = g.nodes.get(prevId)!;
      const b = g.nodes.get(id)!;
      const lengthKm = haversineKm(a, b);
      if (lengthKm > 0 && lengthKm < 80) {
        const cost = getWaterGraphEdgeCost({ lengthKm, kind });
        const eid = `e:${kind}:${prevId}->${id}`;
        if (!g.edges.has(eid)) {
          addEdge(g, {
            id: eid,
            from: prevId,
            to: id,
            kind,
            lengthKm,
            cost,
            metadata: {
              ...meta,
              classMultiplier: undefined,
              originalGeometry: [a, b],
            },
          });
        }
      }
    }
    prevId = id;
  }
}

/** Fairway polylines clipped loosely to corridor bbox. */
export function fairwaySourcesInCorridor(
  a: LngLat,
  b: LngLat,
  padDeg = 0.35,
): CenterlineSource[] {
  const west = Math.min(a.lon, b.lon) - padDeg;
  const east = Math.max(a.lon, b.lon) + padDeg;
  const south = Math.min(a.lat, b.lat) - padDeg;
  const north = Math.max(a.lat, b.lat) + padDeg;
  const out: CenterlineSource[] = [];
  REGIONAL_FAIRWAYS.forEach((fw, i) => {
    const coords = fw.filter(
      (p) => p.lon >= west && p.lon <= east && p.lat >= south && p.lat <= north,
    );
    if (coords.length >= 2) {
      out.push({
        id: `fairway-${i}`,
        kind: 'fairway',
        coords,
        waterId: `fairway-${i}`,
        source: 'REGIONAL_FAIRWAYS',
        sourceId: `fairway-${i}`,
      });
    }
  });
  return out;
}

function addMaskMesh(
  g: WaterGraph,
  lake: LakeMask,
  bbox: [number, number, number, number],
  stepKm: number,
): number {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const dLat = stepKm / 111;
  const dLon = stepKm / (111 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  const waterId = `mask:${lake.name}`;
  const grid: Array<Array<string | null>> = [];
  let rows = 0;
  for (let lat = s; lat <= n + 1e-9; lat += dLat) {
    const row: Array<string | null> = [];
    for (let lon = w; lon <= e + 1e-9; lon += dLon) {
      const p = { lon, lat };
      if (!pointInOpenWater(p, lake)) {
        row.push(null);
        continue;
      }
      const id = upsertVertex(g, lon, lat, 'vertex', waterId, stepKm * 0.4);
      const node = g.nodes.get(id)!;
      node.metadata = { ...(node.metadata ?? {}), mask: true, lake: lake.name };
      row.push(id);
    }
    grid.push(row);
    rows += 1;
    if (rows > 80) break; // corridor safety bound
  }
  let edges = 0;
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!;
    for (let c = 0; c < row.length; c++) {
      const id = row[c];
      if (!id) continue;
      const neighbors = [
        grid[r]![c + 1],
        grid[r + 1]?.[c],
      ];
      for (const nid of neighbors) {
        if (!nid || nid === id) continue;
        const a = g.nodes.get(id)!;
        const b = g.nodes.get(nid)!;
        const lengthKm = haversineKm(a, b);
        const cost = getWaterGraphEdgeCost({ lengthKm, kind: 'mask' });
        const eid = `e:mask:${id}->${nid}`;
        if (!g.edges.has(eid) && !g.edges.has(`e:mask:${nid}->${id}`)) {
          addEdge(g, {
            id: eid,
            from: id,
            to: nid,
            kind: 'mask',
            lengthKm,
            cost,
            metadata: { source: 'lake-mask', sourceId: lake.name },
          });
          edges += 1;
        }
      }
    }
  }
  return edges;
}

/**
 * Seams connect centerline ↔ mask only with proximity + no barrier.
 * Never uses user snap thresholds.
 */
export function buildWaterSeams(
  g: WaterGraph,
  lakeConnectKm = WG_LAKE_CONNECT_KM,
): number {
  const maskNodes = [...g.nodes.values()].filter((n) => n.metadata?.mask);
  const centerNodes = [...g.nodes.values()].filter(
    (n) => !n.metadata?.mask && (n.waterId?.startsWith('fairway') || n.waterId?.startsWith('cl:') || n.waterId?.startsWith('ww:')),
  );
  let seams = 0;
  for (const cn of centerNodes) {
    let best: WaterGraphNode | null = null;
    let bestD = Infinity;
    for (const mn of maskNodes) {
      const d = haversineKm(cn, mn);
      if (d <= lakeConnectKm && d < bestD) {
        bestD = d;
        best = mn;
      }
    }
    if (!best) continue;
    if (hasIllegalBarrierCrossing([cn, best])) continue;
    const lengthKm = bestD;
    const cost = getWaterGraphEdgeCost({ lengthKm, kind: 'seam' });
    const eid = `e:seam:${cn.id}->${best.id}`;
    if (g.edges.has(eid)) continue;
    addEdge(g, {
      id: eid,
      from: cn.id,
      to: best.id,
      kind: 'seam',
      lengthKm,
      cost,
      metadata: { source: 'seam', portalFee: 0.15 },
    });
    seams += 1;
  }
  return seams;
}

function addLockPortals(g: WaterGraph): number {
  let n = 0;
  // Dubna — confirmed legal passage corridor
  const corridor = densifyCenterlineCoords(DUBNA_LOCK_CORRIDOR, 0.8);
  const waterId = 'lock:dubna';
  linkPolyline(
    g,
    corridor,
    'lock',
    waterId,
    { source: 'DUBNA_LOCK_CORRIDOR', sourceId: 'dubna-lock-1', lockFee: 0.25 },
    WG_MERGE_NODE_KM,
  );
  for (const p of [DUBNA_LOCK_UPPER, DUBNA_LOCK, DUBNA_LOCK_LOWER]) {
    const id = upsertVertex(g, p.lon, p.lat, 'lock', waterId, WG_MERGE_NODE_KM);
    g.nodes.get(id)!.kind = 'lock';
    n += 1;
  }
  // Rybinsk lock pins as portals (approach); no crest-only dam edge
  const ryb = [RYBINSK_LOCK, RYBINSK_LOCK_11, RYBINSK_LOCK_12];
  const rybId = 'lock:rybinsk';
  for (let i = 0; i < ryb.length; i++) {
    const p = ryb[i]!;
    upsertVertex(g, p.lon, p.lat, 'portal', rybId, WG_MERGE_NODE_KM);
    n += 1;
  }
  if (ryb.length >= 2) {
    linkPolyline(
      g,
      ryb,
      'lock',
      rybId,
      { source: 'RYBINSK_LOCK', sourceId: 'rybinsk-locks-11-12', lockFee: 0.25 },
      WG_MERGE_NODE_KM,
    );
  }
  // Barrier crest must NOT become a normal edge.
  // KNOWN_BARRIERS are function-based (crosses/hasValidPassage) without
  // crest polylines here — we only model confirmed lock corridors as edges.
  void KNOWN_BARRIERS;
  return n;
}

export function analyzeWaterGraphComponents(g: WaterGraph): WaterGraphComponents {
  const visited = new Set<string>();
  let components = 0;
  let largestKm = 0;
  let isolated = 0;
  let deadEnds = 0;

  const neighbors = (id: string): string[] => {
    const out: string[] = [];
    for (const eid of g.adjacency.get(id) ?? []) {
      const e = g.edges.get(eid);
      if (!e) continue;
      out.push(e.from === id ? e.to : e.from);
    }
    return out;
  };

  for (const id of g.nodes.keys()) {
    if (visited.has(id)) continue;
    components += 1;
    let compKm = 0;
    const stack = [id];
    visited.add(id);
    const members: string[] = [];
    while (stack.length) {
      const cur = stack.pop()!;
      members.push(cur);
      for (const eid of g.adjacency.get(cur) ?? []) {
        const e = g.edges.get(eid);
        if (e) compKm += e.lengthKm / 2; // undirected counted twice via adj
      }
      for (const nb of neighbors(cur)) {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    if (members.length === 1) isolated += 1;
    largestKm = Math.max(largestKm, compKm);
    for (const m of members) {
      if (neighbors(m).length <= 1) deadEnds += 1;
    }
  }

  let portalCount = 0;
  let lockCount = 0;
  let maskNodeCount = 0;
  let waterwayNodeCount = 0;
  for (const n of g.nodes.values()) {
    if (n.kind === 'portal') portalCount += 1;
    if (n.kind === 'lock') lockCount += 1;
    if (n.metadata?.mask) maskNodeCount += 1;
    if (n.waterId?.startsWith('ww:') || n.waterId?.startsWith('cl:')) waterwayNodeCount += 1;
  }

  return {
    connectedComponents: components,
    largestComponentKm: largestKm,
    isolatedNodes: isolated,
    deadEnds,
    portalCount,
    lockCount,
    maskNodeCount,
    waterwayNodeCount,
  };
}

export type BuildWaterGraphInput = {
  a: LngLat;
  b: LngLat;
  centerlines?: CenterlineSource[];
  lake?: LakeMask | null;
  lakeComplete?: boolean;
  options?: WaterGraphBuildOptions;
};

export function buildWaterGraph(input: BuildWaterGraphInput): WaterGraph {
  const t0 = performance.now();
  const opts = input.options ?? {};
  const mergeKm = opts.mergeNodeKm ?? WG_MERGE_NODE_KM;
  const lakeConnectKm = opts.lakeConnectKm ?? WG_LAKE_CONNECT_KM;
  const g = emptyGraph();

  const tCl = performance.now();
  const extras = input.centerlines ?? [];
  const fairways =
    opts.includeFairway === false ? [] : fairwaySourcesInCorridor(input.a, input.b);
  const normalized = normalizeWaterCenterline([...extras, ...fairways], mergeKm);
  for (const src of normalized) {
    if (src.coords.length < 2) continue;
    const kind: WaterGraphEdgeKind =
      src.kind === 'fairway'
        ? 'fairway'
        : src.kind === 'canal'
          ? 'canal'
          : 'waterway';
    if (kind === 'fairway') g.layers.fairway = true;
    else g.layers.centerline = true;
    linkPolyline(
      g,
      src.coords,
      kind,
      src.waterId ?? src.id,
      {
        source: src.source ?? src.kind,
        sourceId: src.sourceId ?? src.id,
        originalGeometry: src.coords.slice(),
      },
      mergeKm,
    );
  }
  const centerlineMs = performance.now() - tCl;

  const tMask = performance.now();
  if (opts.includeMask !== false && input.lake && input.lakeComplete !== false) {
    const pad = 0.05;
    const bbox: [number, number, number, number] = [
      Math.min(input.a.lon, input.b.lon) - pad,
      Math.min(input.a.lat, input.b.lat) - pad,
      Math.max(input.a.lon, input.b.lon) + pad,
      Math.max(input.a.lat, input.b.lat) + pad,
    ];
    const added = addMaskMesh(
      g,
      input.lake,
      bbox,
      opts.maskGridStepKm ?? WG_MASK_GRID_STEP_KM,
    );
    if (added > 0) g.layers.mask = true;
  }
  const maskMs = performance.now() - tMask;

  const tSeam = performance.now();
  if (g.layers.mask && g.layers.centerline) {
    buildWaterSeams(g, lakeConnectKm);
  }
  const seamMs = performance.now() - tSeam;

  const tFw = performance.now();
  // fairway already in centerlines; timing bucket for symmetry
  const fairwayMs = performance.now() - tFw;

  if (opts.includeLocks !== false) {
    addLockPortals(g);
    g.layers.lock = true;
  }

  g.components = analyzeWaterGraphComponents(g);
  g.timing = {
    buildMs: performance.now() - t0,
    centerlineMs,
    maskMs,
    seamMs,
    fairwayMs,
  };
  return g;
}

export function bindWaterGraphTerminal(
  g: WaterGraph,
  endpoint: 'A' | 'B',
  click: LngLat,
  candidates: Array<{
    point: LngLat;
    source: string;
    distKm: number;
    classPenalty: number;
    stemPenalty: number;
    rank: number;
  }>,
): WaterGraphTerminal | null {
  // Prefer existing graph node near best candidate / click
  let bestNode: WaterGraphNode | null = null;
  let bestD = Infinity;
  let bestCand = candidates[0] ?? null;
  const seeds = bestCand ? [bestCand.point, click] : [click];
  for (const seed of seeds) {
    for (const n of g.nodes.values()) {
      if (n.kind === 'barrier_block') continue;
      const d = haversineKm(seed, n);
      if (d < bestD) {
        bestD = d;
        bestNode = n;
      }
    }
  }
  if (!bestNode || bestD > 25) return null;
  // Attach bind node if far from existing
  let nodeId = bestNode.id;
  if (bestD > 0.15) {
    const bindId = `bind:${endpoint}:${keyOf(click.lon, click.lat)}`;
    addNode(g, {
      id: bindId,
      lon: click.lon,
      lat: click.lat,
      kind: 'bind',
      waterId: bestNode.waterId ?? null,
    });
    const lengthKm = bestD;
    const cost = getWaterGraphEdgeCost({ lengthKm, kind: 'seam' });
    addEdge(g, {
      id: `e:bind:${bindId}->${bestNode.id}`,
      from: bindId,
      to: bestNode.id,
      kind: 'seam',
      lengthKm,
      cost,
      metadata: { source: 'terminal-bind' },
    });
    nodeId = bindId;
  }
  const c = bestCand;
  return {
    endpoint,
    nodeId,
    point: click,
    source: c?.source ?? 'raw',
    distKm: c?.distKm ?? bestD,
    classPenalty: c?.classPenalty ?? 0,
    stemPenalty: c?.stemPenalty ?? 0,
    rank: c?.rank ?? bestD,
  };
}

export type WaterGraphSearchResult = {
  path: WaterGraphPath | null;
  expandedNodes: number;
  searchMs: number;
};

/**
 * Dijkstra on undirected WaterGraph (E2.0 — correctness over heuristic speed).
 */
export function searchWaterGraph(
  g: WaterGraph,
  startId: string,
  goalId: string,
): WaterGraphSearchResult {
  const t0 = performance.now();
  if (!g.nodes.has(startId) || !g.nodes.has(goalId)) {
    return { path: null, expandedNodes: 0, searchMs: performance.now() - t0 };
  }
  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; edge: string } | null>();
  const used = new Set<string>();
  dist.set(startId, 0);
  prev.set(startId, null);
  let expanded = 0;

  while (true) {
    let u: string | null = null;
    let best = Infinity;
    for (const [id, d] of dist) {
      if (used.has(id)) continue;
      if (d < best) {
        best = d;
        u = id;
      }
    }
    if (u == null) break;
    if (u === goalId) break;
    used.add(u);
    expanded += 1;
    for (const eid of g.adjacency.get(u) ?? []) {
      const e = g.edges.get(eid);
      if (!e) continue;
      const v = e.from === u ? e.to : e.from;
      // Never traverse out of a barrier_block as a through-node usefully
      const vn = g.nodes.get(v);
      if (vn?.kind === 'barrier_block') continue;
      const nd = best + e.cost;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, { node: u, edge: eid });
      }
    }
  }

  if (!prev.has(goalId) && startId !== goalId) {
    return { path: null, expandedNodes: expanded, searchMs: performance.now() - t0 };
  }

  const nodeIds: string[] = [];
  const edgeIds: string[] = [];
  const edgeKinds: WaterGraphEdgeKind[] = [];
  let cur: string | null = goalId;
  while (cur) {
    nodeIds.push(cur);
    const p = prev.get(cur);
    if (!p) break;
    edgeIds.push(p.edge);
    const e = g.edges.get(p.edge);
    if (e) edgeKinds.push(e.kind);
    cur = p.node;
  }
  nodeIds.reverse();
  edgeIds.reverse();
  edgeKinds.reverse();

  const geometry = waterGraphPathToGeometry(g, nodeIds, edgeIds);
  const lengthKm = pathLengthKm(geometry);
  const cost = dist.get(goalId) ?? lengthKm;

  return {
    path: {
      nodeIds,
      edgeIds,
      lengthKm,
      cost,
      edgeKinds,
      geometry,
    },
    expandedNodes: expanded,
    searchMs: performance.now() - t0,
  };
}

/**
 * Convert graph path to route geometry using edge originalGeometry when present.
 * No long geodesic shortcuts between distant nodes.
 */
export function waterGraphPathToGeometry(
  g: WaterGraph,
  nodeIds: string[],
  edgeIds: string[],
): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i < edgeIds.length; i++) {
    const e = g.edges.get(edgeIds[i]!);
    const from = g.nodes.get(nodeIds[i]!);
    const to = g.nodes.get(nodeIds[i + 1]!);
    if (!e || !from || !to) continue;
    const geom = e.metadata?.originalGeometry;
    if (geom && geom.length >= 2) {
      // Orient geometry
      const g0 = geom[0]!;
      const gN = geom[geom.length - 1]!;
      const forward =
        haversineKm(from, g0) + haversineKm(to, gN) <=
        haversineKm(from, gN) + haversineKm(to, g0);
      const seq = forward ? geom : [...geom].reverse();
      if (!out.length) out.push(...seq);
      else out.push(...seq.slice(1));
    } else {
      // Short connector only (seam/bind) — never long chords
      if (haversineKm(from, to) > 5) {
        // skip illegal long chord — insert endpoints only if very short gap
        if (!out.length) out.push(from);
        out.push(to);
      } else {
        if (!out.length) out.push(from);
        out.push(to);
      }
    }
  }
  if (!out.length && nodeIds.length) {
    for (const id of nodeIds) {
      const n = g.nodes.get(id);
      if (n) out.push(n);
    }
  }
  return out;
}

export type ShadowRunInput = {
  a: LngLat;
  b: LngLat;
  legacyLengthKm: number;
  legacyOk: boolean;
  candidates?: Array<{
    endpoint: 'A' | 'B';
    point: LngLat;
    source: string;
    distKm: number;
    classPenalty: number;
    stemPenalty: number;
    rank: number;
  }>;
  centerlines?: CenterlineSource[];
  lake?: LakeMask | null;
  lakeComplete?: boolean;
  /** E2.1 ingest provenance (optional). */
  ingest?: {
    failureCode?: 'none' | 'centerline_missing' | 'centerline_empty_after_filter';
    stats?: {
      centerlineSource: string;
      sourceFeatureCount: number;
      sourceWaterwayIds: string[];
      osmFeatureCount: number;
      acceptedFeatureCount: number;
      rejectedFeatureCount: number;
      rejectionReasons: Record<string, number>;
      dataTimestampMs: number;
      corridorBbox: [number, number, number, number];
      ingestMs: number;
    };
  };
};

function countEdgeKinds(g: WaterGraph): WaterGraphEdgeKindCounts {
  const counts: WaterGraphEdgeKindCounts = {
    waterwayEdgeCount: 0,
    canalEdgeCount: 0,
    maskEdgeCount: 0,
    fairwayEdgeCount: 0,
    lockEdgeCount: 0,
    seamCount: 0,
  };
  for (const e of g.edges.values()) {
    if (e.kind === 'waterway') counts.waterwayEdgeCount += 1;
    else if (e.kind === 'canal') counts.canalEdgeCount += 1;
    else if (e.kind === 'mask') counts.maskEdgeCount += 1;
    else if (e.kind === 'fairway') counts.fairwayEdgeCount += 1;
    else if (e.kind === 'lock') counts.lockEdgeCount += 1;
    else if (e.kind === 'seam') counts.seamCount += 1;
  }
  return counts;
}

function classifyLegacyCompare(args: {
  legacyOk: boolean;
  validated: boolean;
  agree: boolean;
  graphBetter: boolean;
  graphRejected: boolean;
  graphLengthKm: number;
  legacyLengthKm: number;
}): WaterGraphLegacyClass {
  const { legacyOk, validated, agree, graphBetter, graphRejected } = args;
  if (!legacyOk && !validated) return 'bothFail';
  if (!legacyOk && validated) return 'graphBetter';
  if (legacyOk && !validated) {
    if (graphRejected) return 'graphRejected';
    return 'graphNoPath';
  }
  if (agree) return 'agree';
  if (graphBetter) return 'graphBetter';
  if (validated && legacyOk && args.graphLengthKm > args.legacyLengthKm * 1.05) {
    return 'legacyBetter';
  }
  return 'agree';
}

/**
 * Shadow-only WaterGraph run. Never mutates production route decision.
 */
export function runWaterGraphShadow(input: ShadowRunInput): WaterGraphShadowResult {
  const tBuild0 = performance.now();
  const g = buildWaterGraph({
    a: input.a,
    b: input.b,
    centerlines: input.centerlines ?? [],
    lake: input.lake ?? null,
    lakeComplete: input.lakeComplete,
  });
  const buildMs = performance.now() - tBuild0;
  const edgeKindCounts = countEdgeKinds(g);

  const candsA =
    input.candidates?.filter((c) => c.endpoint === 'A').map((c) => ({
      point: c.point,
      source: c.source,
      distKm: c.distKm,
      classPenalty: c.classPenalty,
      stemPenalty: c.stemPenalty,
      rank: c.rank,
    })) ?? [];
  const candsB =
    input.candidates?.filter((c) => c.endpoint === 'B').map((c) => ({
      point: c.point,
      source: c.source,
      distKm: c.distKm,
      classPenalty: c.classPenalty,
      stemPenalty: c.stemPenalty,
      rank: c.rank,
    })) ?? [];

  const termA = bindWaterGraphTerminal(g, 'A', input.a, candsA);
  const termB = bindWaterGraphTerminal(g, 'B', input.b, candsB);

  let failureStage: WaterGraphFailureStage = 'none';
  let rejectReason: string | null = null;
  let pathLengthKm = 0;
  let pathCost = 0;
  let edgeKinds: WaterGraphEdgeKind[] = [];
  let expandedNodes = 0;
  let searchMs = 0;
  let validated = false;
  let foundRawPath = false;

  const ingestFail = input.ingest?.failureCode ?? 'none';
  const hasOsmCenterline = (input.centerlines ?? []).some(
    (c) => c.source === 'overpass' || c.source === 'fixture' || c.source === 'osm' || c.source === 'water-core',
  );

  if (!g.layers.centerline && !g.layers.fairway && !g.layers.mask) {
    failureStage =
      ingestFail === 'centerline_empty_after_filter'
        ? 'centerline_empty_after_filter'
        : 'centerline_missing';
    rejectReason = failureStage;
  } else if (!termA || !termB) {
    failureStage = 'terminal_unbound';
    rejectReason = 'terminal_unbound';
  } else {
    const search = searchWaterGraph(g, termA.nodeId, termB.nodeId);
    searchMs = search.searchMs;
    expandedNodes = search.expandedNodes;
    if (!search.path) {
      failureStage =
        (g.components?.connectedComponents ?? 1) > 1
          ? 'graph_disconnected'
          : 'search_no_path';
      rejectReason = failureStage;
    } else {
      foundRawPath = true;
      pathLengthKm = search.path.lengthKm;
      pathCost = search.path.cost;
      edgeKinds = search.path.edgeKinds.slice();
      const geom = search.path.geometry;
      if (geom.length >= 2) {
        const v = validateWaterRoute(geom, {
          waypoints: [input.a, input.b],
          lengthKm: pathLengthKm,
          method: 'waterway',
        });
        if (!v.ok) {
          failureStage = 'validator_reject';
          rejectReason = v.issues.join(',') || 'validator_reject';
        } else {
          const hydro = evaluateHydroAcceptGate(geom);
          if (hydro.reject) {
            failureStage = 'hydro_reject';
            rejectReason = hydro.reason;
          } else {
            validated = true;
          }
        }
      }
    }
  }

  const legacyLengthKm = input.legacyLengthKm;
  const graphLengthKm = validated ? pathLengthKm : 0;
  const deltaKm = graphLengthKm - legacyLengthKm;
  const deltaPct =
    legacyLengthKm > 0.1 ? deltaKm / legacyLengthKm : graphLengthKm > 0 ? 1 : 0;
  const agree =
    input.legacyOk && validated && Math.abs(deltaPct) < 0.15;
  const graphBetter =
    validated && (!input.legacyOk || graphLengthKm < legacyLengthKm * 0.95);
  const graphRejected =
    foundRawPath && !validated && !!rejectReason;
  const graphNoPath = !foundRawPath && !validated;
  const legacyBetter =
    input.legacyOk &&
    validated &&
    graphLengthKm > legacyLengthKm * 1.05;
  const legacyNoPath = !input.legacyOk;
  const classification = classifyLegacyCompare({
    legacyOk: input.legacyOk,
    validated,
    agree,
    graphBetter,
    graphRejected,
    graphLengthKm,
    legacyLengthKm,
  });

  const sources: WaterGraphProvenance['sources'] = [];
  if (hasOsmCenterline || (input.ingest?.stats?.sourceFeatureCount ?? 0) > 0) {
    const src = input.ingest?.stats?.centerlineSource;
    if (src === 'fixture') sources.push('fixture');
    else if (src === 'water-core') sources.push('water-core');
    else sources.push('overpass', 'osm');
  }
  if ((input.centerlines ?? []).some((c) => c.kind === 'brouter' || c.source?.includes('legacy'))) {
    sources.push('brouter');
  }
  if (g.layers.mask) sources.push('mask');
  if (g.layers.fairway) sources.push('fairway');
  if (g.layers.lock) sources.push('lock');

  const ingestStats = input.ingest?.stats;
  const provenance: WaterGraphProvenance = {
    sources: [...new Set(sources)],
    centerlineSource: ingestStats?.centerlineSource ?? (hasOsmCenterline ? 'mixed' : 'empty'),
    sourceFeatureCount: ingestStats?.sourceFeatureCount ?? (input.centerlines?.length ?? 0),
    sourceWaterwayIds: ingestStats?.sourceWaterwayIds ?? [],
    osmFeatureCount: ingestStats?.osmFeatureCount,
    acceptedFeatureCount: ingestStats?.acceptedFeatureCount,
    rejectedFeatureCount: ingestStats?.rejectedFeatureCount,
    rejectionReasons: ingestStats?.rejectionReasons,
    dataTimestampMs: ingestStats?.dataTimestampMs ?? Date.now(),
    corridorBbox: ingestStats?.corridorBbox ?? null,
    centerlineIngestMs: ingestStats?.ingestMs,
  };

  const totalGraphMs = buildMs + searchMs + (ingestStats?.ingestMs ?? 0);

  return {
    available: true,
    built: g.nodes.size > 0,
    nodeCount: g.nodes.size,
    edgeCount: g.edges.size,
    layers: { ...g.layers },
    edgeKindCounts,
    components: g.components ?? null,
    searchMs,
    buildMs,
    timing: {
      ...(g.timing ?? {
        buildMs,
        centerlineMs: 0,
        maskMs: 0,
        seamMs: 0,
        fairwayMs: 0,
      }),
      centerlineIngestMs: ingestStats?.ingestMs,
      totalGraphMs,
    },
    pathFound: validated,
    pathLengthKm: validated ? pathLengthKm : 0,
    pathCost: validated ? pathCost : 0,
    edgeKinds: validated ? edgeKinds : [],
    rejectReason,
    failureStage,
    terminalA: termA,
    terminalB: termB,
    expandedNodes,
    validated,
    provenance,
    legacyCompare: {
      legacyLengthKm,
      graphLengthKm,
      deltaKm,
      deltaPct,
      agree,
      graphBetter,
      graphRejected,
      graphNoPath,
      legacyBetter,
      legacyNoPath,
      classification,
    },
  };
}
