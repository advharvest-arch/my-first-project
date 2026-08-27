/**
 * E1.7 — feature flags (defaults preserve production identity).
 */

export type RouteFeatureFlags = {
  /**
   * When true, Phase C may stop after a clearly excellent accepted trial.
   * Default false → exhaustive ≤9 pairs (identical to pre-E1.6).
   */
  USE_ROUTE_EARLY_STOP: boolean;
  /**
   * Short-TTL BRouter success / negative result cache (cross-request).
   */
  USE_BROUTER_RESULT_CACHE: boolean;
  /**
   * Within a single measureWaterChain request, dedupe identical BRouter lonlats.
   */
  USE_BROUTER_REQUEST_DEDUP: boolean;
  /**
   * E1.7 — experimental water-aware long-span segmentation for geo > 120 km.
   * Default false → monolithic Phase B/C unchanged.
   */
  USE_LONG_SPAN_SEGMENTATION: boolean;
  /**
   * E1.7 — experimental parallel Phase C BRouter trials (capped concurrency).
   * Default false → sequential trials.
   */
  USE_PARALLEL_CANDIDATES: boolean;
  /**
   * Max concurrent BRouter trials when USE_PARALLEL_CANDIDATES (2 or 3).
   */
  PARALLEL_CANDIDATE_CONCURRENCY: 2 | 3;
  /**
   * Override Phase C max pairs for budget experiments (null = PHASE_C_MAX_PAIRS).
   * Production must leave null.
   */
  PHASE_C_MAX_PAIRS_OVERRIDE: number | null;
  /**
   * E2.0 — Hybrid WaterGraph shadow mode.
   * When true: build/search graph for RouteTrace only; legacy path remains production result.
   */
  USE_WATER_GRAPH: boolean;
};

const defaults: RouteFeatureFlags = {
  USE_ROUTE_EARLY_STOP: false,
  USE_BROUTER_RESULT_CACHE: true,
  USE_BROUTER_REQUEST_DEDUP: true,
  USE_LONG_SPAN_SEGMENTATION: false,
  USE_PARALLEL_CANDIDATES: false,
  PARALLEL_CANDIDATE_CONCURRENCY: 2,
  PHASE_C_MAX_PAIRS_OVERRIDE: null,
  USE_WATER_GRAPH: false,
};

let overrides: Partial<RouteFeatureFlags> = {};

export function getRouteFeatureFlags(): RouteFeatureFlags {
  return { ...defaults, ...overrides };
}

/** Test / DEV / benchmark only. */
export function setRouteFeatureFlagsForTests(next: Partial<RouteFeatureFlags> | null): void {
  overrides = next ? { ...next } : {};
}

export function resetRouteFeatureFlags(): void {
  overrides = {};
}
