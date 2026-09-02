/**
 * E1.6/E1.7 — short-TTL provider caches (BRouter) + session stats.
 */

import { getRoutePerf } from './route-perf-context';
import { markFallbackEvent } from './route-fallback-timeline';

export type ProviderCacheKind = 'success' | 'negative';

export type BrouterCacheSessionStats = {
  hit: number;
  miss: number;
  deduped: number;
};

type Entry<T> = {
  kind: ProviderCacheKind;
  value: T;
  expiresAtMs: number;
};

const SUCCESS_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
const MAX_ENTRIES = 256;

const brouterCache = new Map<string, Entry<unknown>>();

type RequestScope = {
  resolved: Map<string, unknown>;
  inflight: Map<string, Promise<unknown>>;
};

let requestScope: RequestScope | null = null;
let sessionStats: BrouterCacheSessionStats = { hit: 0, miss: 0, deduped: 0 };

function now(): number {
  return Date.now();
}

function prune(map: Map<string, Entry<unknown>>): void {
  const t = now();
  for (const [k, e] of map) {
    if (e.expiresAtMs <= t) map.delete(k);
  }
  while (map.size > MAX_ENTRIES) {
    const first = map.keys().next().value;
    if (first == null) break;
    map.delete(first);
  }
}

/**
 * Exact coordinate key — 6 decimal places (~0.1 m). Nearby points are NOT merged
 * (could change the route). Profile included for future multi-profile safety.
 */
export function normalizeBrouterLonlats(
  waypoints: Array<{ lon: number; lat: number }>,
  profile = 'river',
): string {
  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  return `${profile}:${lonlats}`;
}

export function brouterCacheKey(lonlatsOrNormalized: string): string {
  return lonlatsOrNormalized.startsWith('br:')
    ? lonlatsOrNormalized
    : `br:${lonlatsOrNormalized}`;
}

export function beginProviderRequestScope(): void {
  requestScope = { resolved: new Map(), inflight: new Map() };
}

export function endProviderRequestScope(): void {
  requestScope = null;
}

export function clearProviderCaches(): void {
  brouterCache.clear();
  requestScope = null;
}

export function resetBrouterCacheSessionStats(): void {
  sessionStats = { hit: 0, miss: 0, deduped: 0 };
}

export function getBrouterCacheSessionStats(): BrouterCacheSessionStats {
  return { ...sessionStats };
}

export function getBrouterCacheStats(): {
  size: number;
  success: number;
  negative: number;
} {
  prune(brouterCache);
  let success = 0;
  let negative = 0;
  for (const e of brouterCache.values()) {
    if (e.kind === 'success') success += 1;
    else negative += 1;
  }
  return { size: brouterCache.size, success, negative };
}

export function getCachedBrouterResult<T>(
  key: string,
): { hit: true; value: T | null; source: 'request' | 'ttl' } | { hit: false } {
  if (requestScope?.resolved.has(key)) {
    sessionStats.hit += 1;
    return { hit: true, value: requestScope.resolved.get(key) as T | null, source: 'request' };
  }
  prune(brouterCache);
  const e = brouterCache.get(key);
  if (!e || e.expiresAtMs <= now()) {
    if (e) brouterCache.delete(key);
    sessionStats.miss += 1;
    return { hit: false };
  }
  sessionStats.hit += 1;
  return { hit: true, value: e.value as T | null, source: 'ttl' };
}

export function putCachedBrouterResult<T>(
  key: string,
  value: T | null,
  kind: ProviderCacheKind,
): void {
  if (requestScope) {
    requestScope.resolved.set(key, value);
  }
  const ttl = kind === 'success' ? SUCCESS_TTL_MS : NEGATIVE_TTL_MS;
  brouterCache.set(key, { kind, value, expiresAtMs: now() + ttl });
  prune(brouterCache);
}

export async function withBrouterRequestDedup<T>(
  key: string,
  enabled: boolean,
  factory: () => Promise<T | null>,
): Promise<T | null> {
  if (!enabled || !requestScope) return factory();
  if (requestScope.resolved.has(key)) {
    sessionStats.deduped += 1;
    sessionStats.hit += 1;
    const perf = getRoutePerf();
    if (perf) perf.dedupedRequests += 1;
    markFallbackEvent('brouter', 'brouter-dedup-resolved', 'deduped_resolved', {
      meta: { cache: 'resolved', deduped: true, actualHttp: false, key },
    });
    return requestScope.resolved.get(key) as T | null;
  }
  const existing = requestScope.inflight.get(key);
  if (existing) {
    sessionStats.deduped += 1;
    const perf = getRoutePerf();
    if (perf) perf.dedupedRequests += 1;
    markFallbackEvent('brouter', 'brouter-dedup-inflight', 'deduped_inflight', {
      meta: { cache: 'inflight', deduped: true, actualHttp: false, key },
    });
    return (await existing) as T | null;
  }
  const p = factory().then((v) => {
    requestScope?.resolved.set(key, v);
    requestScope?.inflight.delete(key);
    return v;
  });
  requestScope.inflight.set(key, p);
  return p;
}
