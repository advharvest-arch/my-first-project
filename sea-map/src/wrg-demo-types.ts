/**
 * WaterGraph Demo / Shadow — types only.
 * Does not touch production routing or USE_WATER_GRAPH.
 */

export type WrgDemoPoint = { lon: number; lat: number };

export type WrgDemoStatus =
  | 'ROUTE_FOUND'
  | 'NO_WATER_CONNECTION'
  | 'ENDPOINT_NOT_ON_WATER'
  | 'RUNTIME_UNAVAILABLE'
  | 'BAD_REQUEST'
  | string;

export type WrgDemoLineString = {
  type: 'LineString';
  coordinates: number[][];
};

export type WrgDemoRouteResult = {
  status: WrgDemoStatus;
  bind_a?: unknown;
  bind_b?: unknown;
  component_a?: number | null;
  component_b?: number | null;
  path_node_count?: number;
  path_edge_count?: number;
  path_type?: string[];
  e1_hops?: number;
  mesh_hops?: number;
  portal_hops?: number;
  e1_mesh_transitions?: number;
  distance_m?: number | null;
  runtime_ms?: number;
  bind_ms?: number;
  search_ms?: number;
  geometry?: WrgDemoLineString | { type: string; n_coords?: number } | null;
  geometry_validation?: Record<string, unknown>;
  detail?: string | null;
};

export type WrgDemoPhase = 'off' | 'pick-a' | 'pick-b' | 'routing' | 'result';

export type WrgDemoState = {
  enabled: boolean;
  phase: WrgDemoPhase;
  a: WrgDemoPoint | null;
  b: WrgDemoPoint | null;
  result: WrgDemoRouteResult | null;
  error: string | null;
};

export type WrgDemoCase = {
  id: string;
  name: string;
  a: WrgDemoPoint;
  b: WrgDemoPoint;
  expect: 'ROUTE_FOUND' | 'NO_WATER_CONNECTION' | 'ENDPOINT_NOT_ON_WATER';
  zoom: number;
};
