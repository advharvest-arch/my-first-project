/**
 * E2.2.3 — WaterGraph topology diagnostics (observability only).
 *
 * Enumerates components, portals, diagnostic seam candidates, and gap labels.
 * NEVER adds edges, NEVER changes routing / accept / reject / thresholds.
 */

import { haversineKm, type LngLat } from './geo';
import type { LakeMask } from './open-lake';
import { nearestOpenWater, pointInOpenWater } from './open-lake';
import {
  DUBNA_LOCK,
  DUBNA_LOCK_LOWER,
  DUBNA_LOCK_UPPER,
  KNOWN_BARRIERS,
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
  hasIllegalBarrierCrossing,
} from './routing-rules';
import type {
  WaterGraph,
  WaterGraphEdgeKind,
  WaterGraphNode,
} from './water-graph-types';
import {
  getWaterKnowledgeCorpus,
  type WaterKnowledgeFact,
} from './water-knowledge';

/** Observation radius for candidate listing — NOT a connect threshold. */
export const WG_TOPOLOGY_SCAN_KM = 50;

export type GapClassification =
  | 'DATA_GAP'
  | 'TOPOLOGY_GAP'
  | 'POSSIBLE_LOCK_TRANSITION'
  | 'POSSIBLE_BARRIER'
  | 'UNKNOWN';

export type TopologyPortal = {
  nodeId: string;
  lon: number;
  lat: number;
  degree: number;
  edgeKinds: WaterGraphEdgeKind[];
  nodeKind: string;
  waterId: string | null;
  nearestOtherComponentId: string | null;
  nearestOtherComponentDistKm: number | null;
  nearestMaskDistKm: number | null;
  nearestFairwayDistKm: number | null;
  nearbyLockOrBarrier: string | null;
};

export type TopologyComponent = {
  id: string;
  nodeCount: number;
  edgeCount: number;
  lengthKm: number;
  bbox: [number, number, number, number];
  layers: {
    waterway: boolean;
    canal: boolean;
    mask: boolean;
    fairway: boolean;
    lock: boolean;
    seam: boolean;
  };
  edgeKindCounts: Partial<Record<WaterGraphEdgeKind, number>>;
  waterIds: string[];
  portalCount: number;
  portals: TopologyPortal[];
};

export type TopologySeamCandidate = {
  fromComponent: string;
  toComponent: string | null;
  toLayer: 'mask' | 'waterway' | 'canal' | 'fairway';
  distanceKm: number;
  candidateType: 'waterway_to_mask' | 'mask_to_waterway' | 'waterway_to_waterway';
  safetyFlags: string[];
  confidence: number;
  fromNodeId: string;
  toNodeId: string | null;
  diagnosticOnly: true;
};

export type TopologyLockPortalCandidate = {
  location: LngLat;
  source: string;
  nearbyComponents: string[];
  barrierPresent: boolean;
  lockPresent: boolean;
  diagnosticOnly: true;
};

export type TopologyGapSummary = {
  fromComponent: string;
  toComponent: string;
  distanceKm: number;
  fromSide: {
    layer: string;
    waterIds: string[];
    point: LngLat;
    nodeId: string;
  };
  toSide: {
    layer: string;
    waterIds: string[];
    point: LngLat;
    nodeId: string;
  };
  gapContents: string[];
  classification: GapClassification;
  note: string;
};

export type WaterGraphTopology = {
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  largestComponentKm: number;
  minComponentKm: number;
  maxComponentKm: number;
  components: TopologyComponent[];
  portalCount: number;
  candidateSeams: TopologySeamCandidate[];
  waterwayMaskCandidates: TopologySeamCandidate[];
  lockPortalCandidates: TopologyLockPortalCandidate[];
  gapSummary: TopologyGapSummary[];
  diagnosticOnly: true;
};

type CompMembers = {
  id: string;
  nodeIds: string[];
  nodes: WaterGraphNode[];
  lengthKm: number;
  edgeIds: Set<string>;
  edgeKindCounts: Partial<Record<WaterGraphEdgeKind, number>>;
  waterIds: Set<string>;
};

function neighborsOf(g: WaterGraph, id: string): string[] {
  const out: string[] = [];
  for (const eid of g.adjacency.get(id) ?? []) {
    const e = g.edges.get(eid);
    if (!e) continue;
    out.push(e.from === id ? e.to : e.from);
  }
  return out;
}

function degreeOf(g: WaterGraph, id: string): number {
  return neighborsOf(g, id).length;
}

function edgeKindsAt(g: WaterGraph, id: string): WaterGraphEdgeKind[] {
  const kinds = new Set<WaterGraphEdgeKind>();
  for (const eid of g.adjacency.get(id) ?? []) {
    const e = g.edges.get(eid);
    if (e) kinds.add(e.kind);
  }
  return [...kinds];
}

function componentLayerLabel(c: CompMembers): string {
  const counts = c.edgeKindCounts;
  const ranked: Array<[WaterGraphEdgeKind, number]> = (
    Object.entries(counts) as Array<[WaterGraphEdgeKind, number]>
  ).sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? 'unknown';
}

function bboxOf(nodes: WaterGraphNode[]): [number, number, number, number] {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const n of nodes) {
    minLon = Math.min(minLon, n.lon);
    minLat = Math.min(minLat, n.lat);
    maxLon = Math.max(maxLon, n.lon);
    maxLat = Math.max(maxLat, n.lat);
  }
  if (!nodes.length) return [0, 0, 0, 0];
  return [minLon, minLat, maxLon, maxLat];
}

function collectComponents(g: WaterGraph): CompMembers[] {
  const visited = new Set<string>();
  const comps: CompMembers[] = [];
  let idx = 0;
  for (const id of g.nodes.keys()) {
    if (visited.has(id)) continue;
    const nodeIds: string[] = [];
    const edgeIds = new Set<string>();
    const edgeKindCounts: Partial<Record<WaterGraphEdgeKind, number>> = {};
    const waterIds = new Set<string>();
    let lengthKm = 0;
    const stack = [id];
    visited.add(id);
    while (stack.length) {
      const cur = stack.pop()!;
      nodeIds.push(cur);
      const n = g.nodes.get(cur);
      if (n?.waterId) waterIds.add(n.waterId);
      for (const eid of g.adjacency.get(cur) ?? []) {
        const e = g.edges.get(eid);
        if (!e || edgeIds.has(eid)) continue;
        edgeIds.add(eid);
        lengthKm += e.lengthKm;
        edgeKindCounts[e.kind] = (edgeKindCounts[e.kind] ?? 0) + 1;
      }
      for (const nb of neighborsOf(g, cur)) {
        if (!visited.has(nb)) {
          visited.add(nb);
          stack.push(nb);
        }
      }
    }
    const nodes = nodeIds
      .map((nid) => g.nodes.get(nid)!)
      .filter(Boolean);
    comps.push({
      id: `comp-${idx++}`,
      nodeIds,
      nodes,
      lengthKm: Math.round(lengthKm * 1000) / 1000,
      edgeIds,
      edgeKindCounts,
      waterIds,
    });
  }
  comps.sort((a, b) => b.lengthKm - a.lengthKm);
  // Re-id by size order for stable reports
  comps.forEach((c, i) => {
    c.id = `comp-${i}`;
  });
  return comps;
}

function nearestBetweenComponents(
  a: CompMembers,
  b: CompMembers,
): { distKm: number; aNode: WaterGraphNode; bNode: WaterGraphNode } | null {
  if (!a.nodes.length || !b.nodes.length) return null;
  let best = Infinity;
  let aNode = a.nodes[0]!;
  let bNode = b.nodes[0]!;
  // Stride sample for very large comps; fixtures are small enough for full scan.
  const strideA = Math.max(1, Math.floor(a.nodes.length / 120));
  const strideB = Math.max(1, Math.floor(b.nodes.length / 120));
  for (let i = 0; i < a.nodes.length; i += strideA) {
    const na = a.nodes[i]!;
    for (let j = 0; j < b.nodes.length; j += strideB) {
      const nb = b.nodes[j]!;
      const d = haversineKm(na, nb);
      if (d < best) {
        best = d;
        aNode = na;
        bNode = nb;
      }
    }
  }
  return { distKm: Math.round(best * 1000) / 1000, aNode, bNode };
}

function nearestMaskDist(
  p: LngLat,
  g: WaterGraph,
  lake: LakeMask | null,
): number | null {
  let best: number | null = null;
  for (const n of g.nodes.values()) {
    if (!n.metadata?.mask) continue;
    const d = haversineKm(p, n);
    if (best === null || d < best) best = d;
  }
  if (lake) {
    if (pointInOpenWater(p, lake)) return 0;
    const near = nearestOpenWater(p, lake, WG_TOPOLOGY_SCAN_KM);
    if (near) {
      const d = haversineKm(p, near);
      if (best === null || d < best) best = d;
    }
  }
  return best === null ? null : Math.round(best * 1000) / 1000;
}

function nearestFairwayDist(p: LngLat, g: WaterGraph): number | null {
  let best: number | null = null;
  for (const n of g.nodes.values()) {
    if (!n.waterId?.startsWith('fairway')) continue;
    const d = haversineKm(p, n);
    if (best === null || d < best) best = d;
  }
  return best === null ? null : Math.round(best * 1000) / 1000;
}

const KNOWN_LOCK_POINTS: Array<{ id: string; p: LngLat; kind: 'lock' | 'barrier' }> = [
  { id: 'DUBNA_LOCK', p: DUBNA_LOCK, kind: 'lock' },
  { id: 'DUBNA_LOCK_UPPER', p: DUBNA_LOCK_UPPER, kind: 'lock' },
  { id: 'DUBNA_LOCK_LOWER', p: DUBNA_LOCK_LOWER, kind: 'lock' },
  { id: 'RYBINSK_LOCK', p: RYBINSK_LOCK, kind: 'lock' },
  { id: 'RYBINSK_LOCK_11', p: RYBINSK_LOCK_11, kind: 'lock' },
  { id: 'RYBINSK_LOCK_12', p: RYBINSK_LOCK_12, kind: 'lock' },
];

function nearbyKnownLockOrBarrier(p: LngLat, maxKm = 15): string | null {
  let best: { id: string; d: number } | null = null;
  for (const k of KNOWN_LOCK_POINTS) {
    const d = haversineKm(p, k.p);
    if (d > maxKm) continue;
    if (!best || d < best.d) best = { id: k.id, d };
  }
  return best ? `${best.id}@${best.d.toFixed(2)}km` : null;
}

function midpoint(a: LngLat, b: LngLat): LngLat {
  return { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
}

function gapContentsFor(
  a: LngLat,
  b: LngLat,
  g: WaterGraph,
  lake: LakeMask | null,
  comps: CompMembers[],
  fromId: string,
  toId: string,
): string[] {
  const contents = new Set<string>();
  const mid = midpoint(a, b);
  const span = haversineKm(a, b);
  const probeR = Math.max(2, Math.min(span / 2, 20));

  if (lake) {
    if (pointInOpenWater(mid, lake) || nearestOpenWater(mid, lake, probeR)) {
      contents.add('mask');
      contents.add('lake');
    }
  }
  for (const n of g.nodes.values()) {
    if (haversineKm(mid, n) > probeR) continue;
    // Skip nodes that belong to the pair being measured — they are the shores, not gap fill.
    const inFrom = comps.find((c) => c.id === fromId)?.nodeIds.includes(n.id);
    const inTo = comps.find((c) => c.id === toId)?.nodeIds.includes(n.id);
    if (inFrom || inTo) continue;
    if (n.metadata?.mask) {
      contents.add('mask');
      continue;
    }
    const kinds = edgeKindsAt(g, n.id);
    if (kinds.includes('waterway')) contents.add('waterway');
    if (kinds.includes('canal')) contents.add('canal');
    if (kinds.includes('fairway')) contents.add('fairway');
    if (kinds.includes('lock') || n.kind === 'lock') contents.add('lock');
    if (kinds.includes('bridge_gap')) contents.add('bridge');
  }

  // Other components intersecting the gap corridor (not the pair itself)
  for (const c of comps) {
    if (c.id === fromId || c.id === toId) continue;
    for (const n of c.nodes) {
      if (haversineKm(mid, n) <= probeR) {
        contents.add(`other_component:${c.id}`);
        break;
      }
    }
  }

  if (hasIllegalBarrierCrossing([a, b])) contents.add('known_barrier');
  // Soft check: barrier crosses function on chord
  for (const barrier of KNOWN_BARRIERS) {
    if (barrier.crosses([a, mid, b])) contents.add(`barrier:${barrier.id}`);
  }

  if (nearbyKnownLockOrBarrier(mid, probeR + 5)) contents.add('known_lock_nearby');

  if (contents.size === 0) contents.add('nothing_known');
  return [...contents];
}

function classifyGap(input: {
  from: CompMembers;
  to: CompMembers;
  distKm: number;
  contents: string[];
  a: LngLat;
  b: LngLat;
}): { classification: GapClassification; note: string } {
  const sameWater = [...input.from.waterIds].some((w) => input.to.waterIds.has(w));
  const fromLayer = componentLayerLabel(input.from);
  const toLayer = componentLayerLabel(input.to);
  const hasLockHint =
    input.contents.some((c) => c.includes('lock') || c.includes('barrier:')) ||
    nearbyKnownLockOrBarrier(midpoint(input.a, input.b), 20) != null;
  const hasBarrier =
    input.contents.includes('known_barrier') ||
    input.contents.some((c) => c.startsWith('barrier:'));

  if (hasBarrier) {
    return {
      classification: 'POSSIBLE_BARRIER',
      note: 'KNOWN_BARRIERS chord check fired across gap',
    };
  }
  if (hasLockHint && (fromLayer === 'lock' || toLayer === 'lock' || input.contents.includes('known_lock_nearby'))) {
    return {
      classification: 'POSSIBLE_LOCK_TRANSITION',
      note: 'Existing lock/portal data near gap (diagnostic only)',
    };
  }
  if (
    sameWater &&
    (fromLayer === 'waterway' || fromLayer === 'canal') &&
    (toLayer === 'waterway' || toLayer === 'canal')
  ) {
    const filled =
      input.contents.includes('mask') ||
      input.contents.includes('lake') ||
      input.contents.some((c) => c.startsWith('other_component:'));
    if (!filled) {
      return {
        classification: 'DATA_GAP',
        note: `Same waterId (${[...input.from.waterIds].join(',')}) but missing centerline between ends`,
      };
    }
  }
  if (
    !sameWater &&
    (fromLayer === 'waterway' || fromLayer === 'canal') &&
    (toLayer === 'waterway' || toLayer === 'canal')
  ) {
    return {
      classification: 'TOPOLOGY_GAP',
      note: 'Different waterIds — same-water merge rules intentionally leave components disconnected',
    };
  }
  if (
    (fromLayer === 'waterway' || fromLayer === 'canal' || fromLayer === 'fairway') &&
    (toLayer === 'mask' || input.contents.includes('mask') || input.contents.includes('lake'))
  ) {
    return {
      classification: 'TOPOLOGY_GAP',
      note: 'Centerline/fairway↔mask adjacency without seam edge (diagnostic candidate only)',
    };
  }
  if (
    (toLayer === 'waterway' || toLayer === 'canal' || toLayer === 'fairway') &&
    (fromLayer === 'mask' || input.contents.includes('mask') || input.contents.includes('lake'))
  ) {
    return {
      classification: 'TOPOLOGY_GAP',
      note: 'Mask↔centerline/fairway adjacency without seam edge (diagnostic candidate only)',
    };
  }
  if (fromLayer === 'mask' && toLayer === 'mask') {
    return {
      classification: 'TOPOLOGY_GAP',
      note: 'Disconnected mask mesh islands inside same lake',
    };
  }
  if (fromLayer === 'lock' || toLayer === 'lock') {
    return {
      classification: 'UNKNOWN',
      note: `Remote/auxiliary layer pair ${fromLayer}↔${toLayer}`,
    };
  }
  return {
    classification: 'UNKNOWN',
    note: `Unclassified ${fromLayer}↔${toLayer} gap`,
  };
}

function safetyFlagsForPair(a: LngLat, b: LngLat): string[] {
  const flags: string[] = [];
  if (hasIllegalBarrierCrossing([a, b])) flags.push('illegal_barrier_crossing');
  for (const barrier of KNOWN_BARRIERS) {
    if (barrier.crosses([a, b])) flags.push(`crosses:${barrier.id}`);
  }
  const d = haversineKm(a, b);
  if (d > 5) flags.push('gap_gt_5km');
  if (d > 15) flags.push('gap_gt_15km');
  return flags;
}

function confidenceForDistance(distKm: number): number {
  // Soft diagnostic score only — not a routing threshold.
  if (distKm <= 0.5) return 0.85;
  if (distKm <= 2) return 0.65;
  if (distKm <= 5) return 0.45;
  if (distKm <= 15) return 0.25;
  return 0.1;
}

function knowledgeLockFactsNear(
  a: LngLat,
  b: LngLat,
  padKm = 80,
): WaterKnowledgeFact[] {
  const mid = midpoint(a, b);
  const out: WaterKnowledgeFact[] = [];
  for (const f of getWaterKnowledgeCorpus()) {
    if (!f.lock && !f.barrier && f.type !== 'lock' && f.type !== 'barrier') continue;
    const g = f.geometry?.coordinates;
    if (!g) {
      // bbox-only facts: keep if corridor bbox overlaps fact bbox
      if (f.bbox) {
        const [w, s, e, n] = f.bbox;
        const inLon = mid.lon >= w - 0.5 && mid.lon <= e + 0.5;
        const inLat = mid.lat >= s - 0.5 && mid.lat <= n + 0.5;
        if (inLon && inLat) out.push(f);
      }
      continue;
    }
    const p = { lon: g[0]!, lat: g[1]! };
    if (haversineKm(mid, p) <= padKm || haversineKm(a, p) <= padKm || haversineKm(b, p) <= padKm) {
      out.push(f);
    }
  }
  return out;
}

/**
 * Full topology snapshot for a built WaterGraph.
 * Does not mutate the graph / add seams.
 */
export function diagnoseWaterGraphTopology(
  g: WaterGraph,
  opts?: {
    a?: LngLat;
    b?: LngLat;
    lake?: LakeMask | null;
    scanKm?: number;
  },
): WaterGraphTopology {
  const scanKm = opts?.scanKm ?? WG_TOPOLOGY_SCAN_KM;
  const lake = opts?.lake ?? null;
  const comps = collectComponents(g);

  const lengthKmList = comps.map((c) => c.lengthKm);
  const largestComponentKm = lengthKmList.length ? Math.max(...lengthKmList) : 0;
  const minComponentKm = lengthKmList.length ? Math.min(...lengthKmList) : 0;
  const maxComponentKm = largestComponentKm;

  // Pairwise nearest distances (for portals + gaps)
  const pairNearest = new Map<
    string,
    { distKm: number; aNode: WaterGraphNode; bNode: WaterGraphNode }
  >();
  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const ca = comps[i]!;
      const cb = comps[j]!;
      const near = nearestBetweenComponents(ca, cb);
      if (!near) continue;
      pairNearest.set(`${ca.id}|${cb.id}`, near);
      pairNearest.set(`${cb.id}|${ca.id}`, {
        distKm: near.distKm,
        aNode: near.bNode,
        bNode: near.aNode,
      });
    }
  }

  const topologyComps: TopologyComponent[] = comps.map((c) => {
    const portalNodes = c.nodeIds.filter((nid) => {
      const n = g.nodes.get(nid)!;
      const deg = degreeOf(g, nid);
      return deg <= 1 || n.kind === 'portal' || n.kind === 'lock' || n.kind === 'bind';
    });

    const portals: TopologyPortal[] = portalNodes.map((nid) => {
      const n = g.nodes.get(nid)!;
      let nearestOther: string | null = null;
      let nearestDist: number | null = null;
      for (const other of comps) {
        if (other.id === c.id) continue;
        // Prefer true portal→other-node distance
        let best = Infinity;
        const stride = Math.max(1, Math.floor(other.nodes.length / 80));
        for (let i = 0; i < other.nodes.length; i += stride) {
          const d = haversineKm(n, other.nodes[i]!);
          if (d < best) best = d;
        }
        if (nearestDist === null || best < nearestDist) {
          nearestDist = Math.round(best * 1000) / 1000;
          nearestOther = other.id;
        }
      }
      return {
        nodeId: nid,
        lon: n.lon,
        lat: n.lat,
        degree: degreeOf(g, nid),
        edgeKinds: edgeKindsAt(g, nid),
        nodeKind: n.kind,
        waterId: n.waterId ?? null,
        nearestOtherComponentId: nearestOther,
        nearestOtherComponentDistKm: nearestDist,
        nearestMaskDistKm: nearestMaskDist(n, g, lake),
        nearestFairwayDistKm: nearestFairwayDist(n, g),
        nearbyLockOrBarrier: nearbyKnownLockOrBarrier(n),
      };
    });

    const layers = {
      waterway: (c.edgeKindCounts.waterway ?? 0) > 0,
      canal: (c.edgeKindCounts.canal ?? 0) > 0,
      mask: (c.edgeKindCounts.mask ?? 0) > 0,
      fairway: (c.edgeKindCounts.fairway ?? 0) > 0,
      lock: (c.edgeKindCounts.lock ?? 0) > 0,
      seam: (c.edgeKindCounts.seam ?? 0) > 0,
    };

    return {
      id: c.id,
      nodeCount: c.nodeIds.length,
      edgeCount: c.edgeIds.size,
      lengthKm: c.lengthKm,
      bbox: bboxOf(c.nodes),
      layers,
      edgeKindCounts: { ...c.edgeKindCounts },
      waterIds: [...c.waterIds],
      portalCount: portals.length,
      portals,
    };
  });

  const candidateSeams: TopologySeamCandidate[] = [];
  const waterwayMaskCandidates: TopologySeamCandidate[] = [];
  const gapSummary: TopologyGapSummary[] = [];

  for (let i = 0; i < comps.length; i++) {
    for (let j = i + 1; j < comps.length; j++) {
      const ca = comps[i]!;
      const cb = comps[j]!;
      const near = pairNearest.get(`${ca.id}|${cb.id}`);
      if (!near) continue;
      if (near.distKm > scanKm) continue;

      const fromLayer = componentLayerLabel(ca);
      const toLayer = componentLayerLabel(cb);
      const contents = gapContentsFor(
        near.aNode,
        near.bNode,
        g,
        lake,
        comps,
        ca.id,
        cb.id,
      );
      const { classification, note } = classifyGap({
        from: ca,
        to: cb,
        distKm: near.distKm,
        contents,
        a: near.aNode,
        b: near.bNode,
      });

      gapSummary.push({
        fromComponent: ca.id,
        toComponent: cb.id,
        distanceKm: near.distKm,
        fromSide: {
          layer: fromLayer,
          waterIds: [...ca.waterIds],
          point: { lon: near.aNode.lon, lat: near.aNode.lat },
          nodeId: near.aNode.id,
        },
        toSide: {
          layer: toLayer,
          waterIds: [...cb.waterIds],
          point: { lon: near.bNode.lon, lat: near.bNode.lat },
          nodeId: near.bNode.id,
        },
        gapContents: contents,
        classification,
        note,
      });

      const flags = safetyFlagsForPair(near.aNode, near.bNode);
      const conf = confidenceForDistance(near.distKm);

      const isWw = (x: string) => x === 'waterway' || x === 'canal' || x === 'fairway';
      if (isWw(fromLayer) && isWw(toLayer) && fromLayer !== 'fairway' && toLayer !== 'fairway') {
        candidateSeams.push({
          fromComponent: ca.id,
          toComponent: cb.id,
          toLayer: toLayer === 'canal' ? 'canal' : 'waterway',
          distanceKm: near.distKm,
          candidateType: 'waterway_to_waterway',
          safetyFlags: flags,
          confidence: conf,
          fromNodeId: near.aNode.id,
          toNodeId: near.bNode.id,
          diagnosticOnly: true,
        });
      }
      // Fairway↔waterway/canal also listed as ww→ww diagnostic (no edge added).
      if (
        (fromLayer === 'fairway' && (toLayer === 'waterway' || toLayer === 'canal')) ||
        (toLayer === 'fairway' && (fromLayer === 'waterway' || fromLayer === 'canal'))
      ) {
        candidateSeams.push({
          fromComponent: ca.id,
          toComponent: cb.id,
          toLayer: toLayer === 'canal' ? 'canal' : toLayer === 'fairway' ? 'fairway' : 'waterway',
          distanceKm: near.distKm,
          candidateType: 'waterway_to_waterway',
          safetyFlags: [...flags, 'involves_fairway'],
          confidence: conf,
          fromNodeId: near.aNode.id,
          toNodeId: near.bNode.id,
          diagnosticOnly: true,
        });
      }

      const maskSide =
        fromLayer === 'mask'
          ? { mask: ca, other: cb, maskNode: near.aNode, otherNode: near.bNode }
          : toLayer === 'mask'
            ? { mask: cb, other: ca, maskNode: near.bNode, otherNode: near.aNode }
            : null;

      if (maskSide && isWw(componentLayerLabel(maskSide.other))) {
        const otherLayer = componentLayerLabel(maskSide.other);
        const cand: TopologySeamCandidate = {
          fromComponent: maskSide.other.id,
          toComponent: maskSide.mask.id,
          toLayer: 'mask',
          distanceKm: near.distKm,
          candidateType: 'waterway_to_mask',
          safetyFlags: [
            ...flags,
            ...(otherLayer === 'fairway' ? ['from_fairway'] : []),
          ],
          confidence: conf,
          fromNodeId: maskSide.otherNode.id,
          toNodeId: maskSide.maskNode.id,
          diagnosticOnly: true,
        };
        waterwayMaskCandidates.push(cand);
        candidateSeams.push(cand);
        candidateSeams.push({
          ...cand,
          fromComponent: maskSide.mask.id,
          toComponent: maskSide.other.id,
          toLayer:
            otherLayer === 'canal'
              ? 'canal'
              : otherLayer === 'fairway'
                ? 'fairway'
                : 'waterway',
          candidateType: 'mask_to_waterway',
          fromNodeId: maskSide.maskNode.id,
          toNodeId: maskSide.otherNode.id,
        });
      }

      // Portal→mask even when mask is not its own component (lake geometry only)
      if (lake && !maskSide) {
        for (const side of [
          { comp: ca, node: near.aNode },
          { comp: cb, node: near.bNode },
        ]) {
          if (!isWw(componentLayerLabel(side.comp))) continue;
          const dMask = nearestMaskDist(side.node, g, lake);
          if (dMask === null || dMask > scanKm) continue;
          const cand: TopologySeamCandidate = {
            fromComponent: side.comp.id,
            toComponent: null,
            toLayer: 'mask',
            distanceKm: dMask,
            candidateType: 'waterway_to_mask',
            safetyFlags: safetyFlagsForPair(side.node, side.node),
            confidence: confidenceForDistance(dMask),
            fromNodeId: side.node.id,
            toNodeId: null,
            diagnosticOnly: true,
          };
          waterwayMaskCandidates.push(cand);
          candidateSeams.push(cand);
        }
      }
    }
  }

  // Also: waterway portals near lake mask without needing another component
  if (lake) {
    for (const c of comps) {
      if (!isWaterwayLike(c)) continue;
      for (const nid of c.nodeIds) {
        if (degreeOf(g, nid) > 1) continue;
        const n = g.nodes.get(nid)!;
        const dMask = nearestMaskDist(n, g, lake);
        if (dMask === null || dMask > Math.min(scanKm, 10)) continue;
        const already = waterwayMaskCandidates.some(
          (x) => x.fromNodeId === nid && x.candidateType === 'waterway_to_mask',
        );
        if (already) continue;
        const cand: TopologySeamCandidate = {
          fromComponent: c.id,
          toComponent: null,
          toLayer: 'mask',
          distanceKm: dMask,
          candidateType: 'waterway_to_mask',
          safetyFlags: [],
          confidence: confidenceForDistance(dMask),
          fromNodeId: nid,
          toNodeId: null,
          diagnosticOnly: true,
        };
        waterwayMaskCandidates.push(cand);
        candidateSeams.push(cand);
      }
    }
  }

  gapSummary.sort((a, b) => a.distanceKm - b.distanceKm);
  candidateSeams.sort((a, b) => a.distanceKm - b.distanceKm);
  waterwayMaskCandidates.sort((a, b) => a.distanceKm - b.distanceKm);

  const lockPortalCandidates: TopologyLockPortalCandidate[] = [];
  const corridorA = opts?.a;
  const corridorB = opts?.b;
  const lockSearchPts = corridorA && corridorB ? [corridorA, corridorB] : [];

  for (const k of KNOWN_LOCK_POINTS) {
    const nearCorridor =
      !lockSearchPts.length ||
      lockSearchPts.some((p) => haversineKm(p, k.p) <= 250) ||
      comps.some((c) => c.nodes.some((n) => haversineKm(n, k.p) <= 30));
    if (!nearCorridor) continue;
    const nearbyComponents = comps
      .filter((c) => c.nodes.some((n) => haversineKm(n, k.p) <= 30))
      .map((c) => c.id);
    const barrierPresent = KNOWN_BARRIERS.some((b) =>
      b.crosses([k.p, { lon: k.p.lon + 0.01, lat: k.p.lat }]),
    );
    lockPortalCandidates.push({
      location: { ...k.p },
      source: k.id,
      nearbyComponents,
      barrierPresent,
      lockPresent: k.kind === 'lock',
      diagnosticOnly: true,
    });
  }

  // Graph-native lock/portal nodes
  for (const n of g.nodes.values()) {
    if (n.kind !== 'lock' && n.kind !== 'portal') continue;
    const nearbyComponents = comps
      .filter((c) => c.nodeIds.includes(n.id) || c.nodes.some((x) => haversineKm(x, n) <= 5))
      .map((c) => c.id);
    const already = lockPortalCandidates.some(
      (c) => haversineKm(c.location, n) < 0.05,
    );
    if (already) continue;
    lockPortalCandidates.push({
      location: { lon: n.lon, lat: n.lat },
      source: `graph:${n.kind}:${n.waterId ?? n.id}`,
      nearbyComponents,
      barrierPresent: false,
      lockPresent: n.kind === 'lock',
      diagnosticOnly: true,
    });
  }

  if (corridorA && corridorB) {
    for (const f of knowledgeLockFactsNear(corridorA, corridorB)) {
      const coords = f.geometry?.coordinates;
      const location = coords
        ? { lon: coords[0]!, lat: coords[1]! }
        : midpoint(corridorA, corridorB);
      const nearbyComponents = comps
        .filter((c) =>
          c.nodes.some((n) => haversineKm(n, location) <= 40),
        )
        .map((c) => c.id);
      lockPortalCandidates.push({
        location,
        source: `knowledge:${f.id}:${f.lock ?? f.barrier ?? f.type}`,
        nearbyComponents,
        barrierPresent: Boolean(f.barrier),
        lockPresent: Boolean(f.lock),
        diagnosticOnly: true,
      });
    }
  }

  const portalCount = topologyComps.reduce((s, c) => s + c.portalCount, 0);

  return {
    nodeCount: g.nodes.size,
    edgeCount: g.edges.size,
    componentCount: comps.length,
    largestComponentKm: Math.round(largestComponentKm * 1000) / 1000,
    minComponentKm: Math.round(minComponentKm * 1000) / 1000,
    maxComponentKm: Math.round(maxComponentKm * 1000) / 1000,
    components: topologyComps,
    portalCount,
    candidateSeams,
    waterwayMaskCandidates,
    lockPortalCandidates,
    gapSummary,
    diagnosticOnly: true,
  };
}

function isWaterwayLike(c: CompMembers): boolean {
  return (
    (c.edgeKindCounts.waterway ?? 0) +
      (c.edgeKindCounts.canal ?? 0) +
      (c.edgeKindCounts.fairway ?? 0) >
    0
  );
}
