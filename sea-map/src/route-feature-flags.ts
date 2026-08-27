/**
 * E1.6 — feature flags for experimental routing optimizations.
 *
 * Defaults preserve production algorithm identity.
 * Flip only after benchmarks + regression proof.
 */

export type RouteFeatureFlags = {
  /**
   * When true, Phase C may stop after a clearly excellent accepted trial.
   * Default false → exhaustive ≤9 pairs (identical to pre-E1.6).
   */
  USE_ROUTE_EARLY_STOP: boolean;
  /**
   * Short-TTL BRouter success / negative result cache (cross-request).
   * Does not change geometry when hit; negative TTL is short.
   */
  USE_BROUTER_RESULT_CACHE: boolean;
  /**
   * Within a single measureWaterChain request, dedupe identical BRouter lonlats.
   * Always safe for result identity when enabled (default true).
   */
  USE_BROUTER_REQUEST_DEDUP: boolean;
};

const defaults: RouteFeatureFlags = {
  USE_ROUTE_EARLY_STOP: false,
  USE_BROUTER_RESULT_CACHE: true,
  USE_BROUTER_REQUEST_DEDUP: true,
};

let overrides: Partial<RouteFeatureFlags> = {};

export function getRouteFeatureFlags(): RouteFeatureFlags {
  return { ...defaults, ...overrides };
}

/** Test / DEV only — never read from UI for production decisions. */
export function setRouteFeatureFlagsForTests(next: Partial<RouteFeatureFlags> | null): void {
  overrides = next ? { ...next } : {};
}

export function resetRouteFeatureFlags(): void {
  overrides = {};
}
