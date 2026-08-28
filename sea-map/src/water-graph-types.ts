/**
 * E2.0 — Hybrid WaterGraph types (corridor-level).
 * Shadow-mode foundation; does not replace measureWaterChain accept path.
 */

import type { LngLat } from './geo';

export type WaterGraphNodeKind =
  | 'vertex'
  | 'bind'
  | 'portal'
  | 'lock'
  | 'barrier_block';

export type WaterGraphEdgeKind =
  | 'waterway'
  | 'canal'
  | 'mask'
  | 'fairway'
  | 'seam'
  | 'lock'
  | 'bridge_gap';

export type WaterGraphNode = {
  id: string;
  lon: number;
  lat: number;
  kind: WaterGraphNodeKind;
  /** Same-water identity for safe merges (never merge across identities). */
  waterId?: string | null;
  metadata?: Record<string, unknown>;
};

export type WaterGraphEdge = {
  id: string;
  from: string;
  to: string;
  kind: WaterGraphEdgeKind;
  lengthKm: number;
  cost: number;
  metadata?: {
    source?: string;
    sourceId?: string | null;
    originalGeometry?: LngLat[];
    portalFee?: number;
    lockFee?: number;
    classMultiplier?: number;
    [k: string]: unknown;
  };
};

export type WaterGraphTerminal = {
  endpoint: 'A' | 'B';
  nodeId: string;
  point: LngLat;
  source: string;
  distKm: number;
  classPenalty: number;
  stemPenalty: number;
  rank: number;
};

export type WaterGraphPath = {
  nodeIds: string[];
  edgeIds: string[];
  lengthKm: number;
  cost: number;
  edgeKinds: WaterGraphEdgeKind[];
  geometry: LngLat[];
  metadata?: Record<string, unknown>;
};

export type WaterGraphLayers = {
  centerline: boolean;
  mask: boolean;
  fairway: boolean;
  lock: boolean;
};

export type WaterGraphComponents = {
  connectedComponents: number;
  largestComponentKm: number;
  isolatedNodes: number;
  deadEnds: number;
  portalCount: number;
  lockCount: number;
  maskNodeCount: number;
  waterwayNodeCount: number;
};

export type WaterGraph = {
  nodes: Map<string, WaterGraphNode>;
  edges: Map<string, WaterGraphEdge>;
  /** Undirected adjacency: nodeId → edgeIds */
  adjacency: Map<string, string[]>;
  layers: WaterGraphLayers;
  components?: WaterGraphComponents;
  timing?: {
    buildMs: number;
    centerlineMs: number;
    maskMs: number;
    seamMs: number;
    fairwayMs: number;
  };
  metadata?: Record<string, unknown>;
};

export type CenterlineSource = {
  id: string;
  kind: 'waterway' | 'canal' | 'fairway' | 'brouter';
  coords: LngLat[];
  name?: string | null;
  source?: string;
  sourceId?: string | null;
  waterId?: string | null;
};

export type WaterGraphBuildOptions = {
  lakeConnectKm?: number;
  densifyMaxKm?: number;
  mergeNodeKm?: number;
  maskGridStepKm?: number;
  /** When false, skip mask mesh even if lake provided. */
  includeMask?: boolean;
  includeFairway?: boolean;
  includeLocks?: boolean;
};

export type WaterGraphFailureStage =
  | 'centerline_missing'
  | 'centerline_empty_after_filter'
  | 'terminal_unbound'
  | 'graph_disconnected'
  | 'search_no_path'
  | 'validator_reject'
  | 'hydro_reject'
  | 'none';

/** E2.1 shadow comparison classification. */
export type WaterGraphLegacyClass =
  | 'agree'
  | 'graphBetter'
  | 'graphRejected'
  | 'graphNoPath'
  | 'legacyBetter'
  | 'legacyNoPath'
  | 'bothFail';

export type WaterGraphEdgeKindCounts = {
  waterwayEdgeCount: number;
  canalEdgeCount: number;
  maskEdgeCount: number;
  fairwayEdgeCount: number;
  lockEdgeCount: number;
  seamCount: number;
};

export type WaterGraphProvenance = {
  sources: Array<'osm' | 'overpass' | 'brouter' | 'mask' | 'fairway' | 'lock' | 'fixture' | 'water-core'>;
  centerlineSource: string;
  sourceFeatureCount: number;
  sourceWaterwayIds: string[];
  osmFeatureCount?: number;
  acceptedFeatureCount?: number;
  rejectedFeatureCount?: number;
  rejectionReasons?: Record<string, number>;
  dataTimestampMs: number;
  corridorBbox: [number, number, number, number] | null;
  centerlineIngestMs?: number;
};

export type WaterGraphShadowResult = {
  available: true;
  built: boolean;
  nodeCount: number;
  edgeCount: number;
  layers: WaterGraphLayers;
  edgeKindCounts: WaterGraphEdgeKindCounts;
  components: WaterGraphComponents | null;
  /** E2.2.3 topology diagnostics (no seams added). */
  topology?: import('./water-graph-topology').WaterGraphTopology | null;
  searchMs: number;
  buildMs: number;
  timing?: WaterGraph['timing'] & {
    centerlineIngestMs?: number;
    totalGraphMs?: number;
  };
  pathFound: boolean;
  pathLengthKm: number;
  pathCost: number;
  edgeKinds: WaterGraphEdgeKind[];
  rejectReason: string | null;
  failureStage: WaterGraphFailureStage;
  terminalA: WaterGraphTerminal | null;
  terminalB: WaterGraphTerminal | null;
  expandedNodes: number;
  validated: boolean;
  provenance: WaterGraphProvenance;
  legacyCompare: {
    legacyLengthKm: number;
    graphLengthKm: number;
    deltaKm: number;
    deltaPct: number;
    agree: boolean;
    graphBetter: boolean;
    graphRejected: boolean;
    graphNoPath: boolean;
    legacyBetter: boolean;
    legacyNoPath: boolean;
    classification: WaterGraphLegacyClass;
  };
};
