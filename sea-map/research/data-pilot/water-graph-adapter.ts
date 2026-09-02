/**
 * E2 DATA_PILOT — S-57 normalized objects → research WaterGraph layers.
 * Does not build a router; only proves type/object mapping.
 */

import { normalizeFeatures, parseS57Collection } from './parse-s57-json.ts';
import {
  ADAPTER_VERSION,
  type EncAiLearningSignal,
  type LngLat,
  type NormalizedWaterObject,
  type S57Collection,
  type S57Geometry,
  type S57ObjectClass,
  type WaterGraphEdge,
  type WaterGraphEdgeKind,
  type WaterGraphLayerBundle,
  type WaterGraphNode,
  type WaterGraphNodeKind,
  type WaterGraphZone,
} from './types.ts';

function coordsToLngLat(coords: [number, number][]): LngLat[] {
  return coords.map(([lon, lat]) => ({ lon, lat }));
}

function pointOf(g: S57Geometry): LngLat | null {
  if (g.type === 'Point') return { lon: g.coordinates[0], lat: g.coordinates[1] };
  if (g.type === 'LineString' && g.coordinates[0]) {
    return { lon: g.coordinates[0][0], lat: g.coordinates[0][1] };
  }
  if (g.type === 'Polygon' && g.coordinates[0]?.[0]) {
    return { lon: g.coordinates[0][0][0], lat: g.coordinates[0][0][1] };
  }
  return null;
}

function lineOf(g: S57Geometry): LngLat[] | null {
  if (g.type === 'LineString') return coordsToLngLat(g.coordinates);
  return null;
}

function ringOf(g: S57Geometry): LngLat[] | null {
  if (g.type === 'Polygon' && g.coordinates[0]) return coordsToLngLat(g.coordinates[0]);
  return null;
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function edgeFrom(obj: NormalizedWaterObject, kind: WaterGraphEdgeKind): WaterGraphEdge | null {
  const coords = lineOf(obj.geometry);
  if (!coords || coords.length < 2) return null;
  return {
    id: id(`e-${kind}`),
    kind,
    coords,
    sourceS57: obj.s57Class,
    cellId: obj.cellId,
    depthMinM: obj.props.depthMinM,
    meta: {
      name: obj.props.name ?? null,
      restriction: obj.props.restriction ?? null,
    },
  };
}

function nodeFrom(
  obj: NormalizedWaterObject,
  kind: WaterGraphNodeKind,
): WaterGraphNode | null {
  const point = pointOf(obj.geometry);
  if (!point) return null;
  return {
    id: id(`n-${kind}`),
    kind,
    point,
    sourceS57: obj.s57Class,
    cellId: obj.cellId,
    verticalClearanceM: obj.props.verticalClearanceM,
    chainageKm: obj.props.chainageKm,
    restriction: obj.props.restriction,
    meta: {
      name: obj.props.name ?? null,
      seasonal: obj.props.seasonal ?? null,
    },
  };
}

function zoneFrom(
  obj: NormalizedWaterObject,
  kind: WaterGraphZone['kind'],
): WaterGraphZone | null {
  const ring = ringOf(obj.geometry);
  if (!ring || ring.length < 3) return null;
  return {
    id: id(`z-${kind}`),
    kind,
    ring,
    sourceS57: obj.s57Class,
    depthMinM: obj.props.depthMinM,
    depthMaxM: obj.props.depthMaxM,
    cellId: obj.cellId,
  };
}

/** Convert one normalized object into zero or more WaterGraph primitives. */
export function adaptObject(obj: NormalizedWaterObject): {
  edges: WaterGraphEdge[];
  nodes: WaterGraphNode[];
  zones: WaterGraphZone[];
} {
  const edges: WaterGraphEdge[] = [];
  const nodes: WaterGraphNode[] = [];
  const zones: WaterGraphZone[] = [];

  switch (obj.kind) {
    case 'official_fairway_axis': {
      const e = edgeFrom(obj, 'official_axis');
      if (e) edges.push(e);
      break;
    }
    case 'preferred_fairway': {
      const e = edgeFrom(obj, 'preferred_fairway');
      if (e) edges.push(e);
      break;
    }
    case 'lock_gate':
    case 'lock_basin': {
      const n = nodeFrom(obj, 'lock');
      if (n) nodes.push(n);
      break;
    }
    case 'dam_barrier': {
      const n = nodeFrom(obj, 'dam');
      if (n) nodes.push(n);
      break;
    }
    case 'hazard': {
      if (obj.geometry.type === 'Polygon') {
        const z = zoneFrom(obj, 'hazard_area');
        if (z) zones.push(z);
      } else {
        const n = nodeFrom(obj, 'hazard');
        if (n) nodes.push(n);
      }
      break;
    }
    case 'depth_area': {
      const z = zoneFrom(obj, 'depth_area');
      if (z) zones.push(z);
      break;
    }
    case 'dredged_area': {
      const z = zoneFrom(obj, 'dredged_area');
      if (z) zones.push(z);
      break;
    }
    case 'bridge': {
      const n = nodeFrom(obj, 'bridge');
      if (n) nodes.push(n);
      break;
    }
    case 'distance_mark': {
      const n = nodeFrom(obj, 'distance_mark');
      if (n) nodes.push(n);
      break;
    }
    default:
      break;
  }

  return { edges, nodes, zones };
}

/** Full collection → research WaterGraph layer bundle. */
export function toWaterGraph(collection: S57Collection): WaterGraphLayerBundle {
  seq = 0;
  const normalized = normalizeFeatures(collection);
  const edges: WaterGraphEdge[] = [];
  const nodes: WaterGraphNode[] = [];
  const zones: WaterGraphZone[] = [];
  const byS57Class: Partial<Record<S57ObjectClass, number>> = {};
  const byEdgeKind: Partial<Record<WaterGraphEdgeKind, number>> = {};
  const byNodeKind: Partial<Record<WaterGraphNodeKind, number>> = {};

  for (const obj of normalized) {
    byS57Class[obj.s57Class] = (byS57Class[obj.s57Class] ?? 0) + 1;
    const part = adaptObject(obj);
    for (const e of part.edges) {
      edges.push(e);
      byEdgeKind[e.kind] = (byEdgeKind[e.kind] ?? 0) + 1;
    }
    for (const n of part.nodes) {
      nodes.push(n);
      byNodeKind[n.kind] = (byNodeKind[n.kind] ?? 0) + 1;
    }
    zones.push(...part.zones);
  }

  return {
    edges,
    nodes,
    zones,
    provenance: {
      folioIds: [...collection.folioIds],
      basinLabel: collection.basinLabel,
      source: collection.source,
      adapterVersion: ADAPTER_VERSION,
      generatedAt: new Date().toISOString(),
    },
    stats: { byS57Class, byEdgeKind, byNodeKind },
  };
}

export function toWaterGraphFromUnknown(raw: unknown): WaterGraphLayerBundle {
  return toWaterGraph(parseS57Collection(raw));
}

/**
 * Design-only helper: given a chosen route sample and official axis edges,
 * produce a future AI learning signal. Does not touch RouteTrace.
 */
export function draftAiLearningSignal(
  graph: WaterGraphLayerBundle,
  chosenRouteSample: LngLat[],
  distanceFromOfficialFairwayKm: number,
  userCorrectionNote?: string | null,
): EncAiLearningSignal {
  const axis = graph.edges.find((e) => e.kind === 'official_axis');
  const hazard = graph.nodes.find((n) => n.kind === 'hazard');
  const lockOrDam = graph.nodes.find((n) => n.kind === 'lock' || n.kind === 'dam');

  let learningHint: EncAiLearningSignal['learningHint'] = 'unknown';
  if (hazard && distanceFromOfficialFairwayKm < 0.5) learningHint = 'near_hazard';
  else if (lockOrDam) learningHint = 'via_lock';
  else if (distanceFromOfficialFairwayKm <= 0.15) learningHint = 'on_official_fairway';
  else if (distanceFromOfficialFairwayKm <= 1.5) learningHint = 'near_fairway';
  else learningHint = 'off_fairway';

  return {
    chosenRouteSample,
    officialFairwaySample: axis?.coords.slice(0, 32),
    distanceFromOfficialFairwayKm,
    nearestOfficialHazardId: hazard?.id ?? null,
    nearestLockOrDamId: lockOrDam?.id ?? null,
    seasonalRestriction: lockOrDam?.meta?.seasonal
      ? String(lockOrDam.meta.seasonal)
      : null,
    userCorrectionNote: userCorrectionNote ?? null,
    learningHint,
  };
}

/** Human-readable proof summary for CLI / tests. */
export function proofSummary(graph: WaterGraphLayerBundle): string {
  const lines = [
    `DATA_PILOT adapter ${graph.provenance.adapterVersion}`,
    `source=${graph.provenance.source} basin=${graph.provenance.basinLabel}`,
    `folios=${graph.provenance.folioIds.join(',')}`,
    `edges=${graph.edges.length} nodes=${graph.nodes.length} zones=${graph.zones.length}`,
    `S-57 classes: ${JSON.stringify(graph.stats.byS57Class)}`,
    `edge kinds: ${JSON.stringify(graph.stats.byEdgeKind)}`,
    `node kinds: ${JSON.stringify(graph.stats.byNodeKind)}`,
  ];
  return lines.join('\n');
}
