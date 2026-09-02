/**
 * E2.16 — User-facing Hybrid Router labels only.
 * No diagnostic internals (timings, components, snap_empty, etc.).
 */

import type { RouteTraceHybridRouter } from './route-trace';
import { getRouteFeatureFlags } from './route-feature-flags';

/** What the human should see for who built the route. */
export type UserRouterSource =
  | 'watergraph'
  | 'brouter_fallback'
  | 'legacy'
  | 'not_built';

export function isHybridWaterGraphEnabled(): boolean {
  return getRouteFeatureFlags().USE_WATER_GRAPH === true;
}

/**
 * Map RouteTrace.hybridRouter (+ route ok) to a coarse user-facing source.
 * Does not expose fallbackReason, timings, or graph internals.
 */
export function userRouterSourceFromHybrid(
  hybrid: RouteTraceHybridRouter | null | undefined,
  routeOk: boolean,
): UserRouterSource {
  if (!routeOk) return 'not_built';
  if (!hybrid || hybrid.routerMode === 'legacy') return 'legacy';
  if (hybrid.selectedRouter === 'watergraph') return 'watergraph';
  if (hybrid.selectedRouter === 'brouter') return 'brouter_fallback';
  if (hybrid.selectedRouter === 'none') return 'not_built';
  return 'legacy';
}

/** Short Russian label for status line / trial panel. */
export function userRouterSourceLabelRu(source: UserRouterSource): string {
  switch (source) {
    case 'watergraph':
      return 'WaterGraph';
    case 'brouter_fallback':
      return 'BRouter (запасной)';
    case 'legacy':
      return 'обычный (BRouter)';
    case 'not_built':
      return 'маршрут не построен';
  }
}

/** English label for DEV trial panel. */
export function userRouterSourceLabelEn(source: UserRouterSource): string {
  switch (source) {
    case 'watergraph':
      return 'WaterGraph';
    case 'brouter_fallback':
      return 'BRouter fallback';
    case 'legacy':
      return 'Legacy (BRouter)';
    case 'not_built':
      return 'Route not built';
  }
}

/**
 * Append router source to a status message when Hybrid mode is on.
 * When flag is off, returns the base message unchanged (normal UX).
 */
export function statusWithRouterSource(
  baseMessage: string,
  hybrid: RouteTraceHybridRouter | null | undefined,
  routeOk: boolean,
): string {
  if (!isHybridWaterGraphEnabled()) return baseMessage;
  const label = userRouterSourceLabelRu(
    userRouterSourceFromHybrid(hybrid, routeOk),
  );
  return `${baseMessage} · маршрутизатор: ${label}`;
}

/** Apply ?wg=1 / ?useWaterGraph=1 from a query string. Returns whether hybrid was enabled. */
export function hybridEnabledFromSearchParams(
  search: string | URLSearchParams,
): boolean {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('wg') === '1' || params.get('useWaterGraph') === '1';
}
