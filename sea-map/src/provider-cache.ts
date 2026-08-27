/**
 * E1.6 — short-TTL provider caches (BRouter).
 *
 * Success and negative caches are separate.
 * Negatives expire quickly so transient failures are not sticky.
 * Does not alter parsed geometry — only skips identical network round-trips.
 */

export type ProviderCacheKind = 'success' | 'negative';

type Entry<T> = {
  kind: ProviderCacheKind;
  value: T;
  expiresAtMs: number;
};

const SUCCESS_TTL_MS = 5 * 60_000;
const NEGATIVE_TTL_MS = 30_000;
const MAX_ENTRIES = 256;

const brouterCache = new Map<string, Entry<unknown>>();

/** Request-scoped dedupe of in-flight + resolved BRouter keys. */
type RequestScope = {
  resolved: Map<string, unknown>;
  inflight: Map<string, Promise<unknown>>;
};

let requestScope: RequestScope | null = null;

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

export function brouterCacheKey(lonlats: string): string {
  return `br:${lonlats}`;
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

/**
 * Lookup BRouter cache. Returns undefined on miss.
 * `null` is a valid negative cached value.
 */
export function getCachedBrouterResult<T>(key: string): { hit: true; value: T | null } | { hit: false } {
  if (requestScope) {
    if (requestScope.resolved.has(key)) {
      return { hit: true, value: requestScope.resolved.get(key) as T | null };
    }
  }
  prune(brouterCache);
  const e = brouterCache.get(key);
  if (!e || e.expiresAtMs <= now()) {
    if (e) brouterCache.delete(key);
    return { hit: false };
  }
  return { hit: true, value: e.value as T | null };
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

/**
 * Deduplicate concurrent identical BRouter fetches within one request scope.
 */
export async function withBrouterRequestDedup<T>(
  key: string,
  enabled: boolean,
  factory: () => Promise<T | null>,
): Promise<T | null> {
  if (!enabled || !requestScope) return factory();
  if (requestScope.resolved.has(key)) {
    return requestScope.resolved.get(key) as T | null;
  }
  const existing = requestScope.inflight.get(key);
  if (existing) return (await existing) as T | null;
  const p = factory().then((v) => {
    requestScope?.resolved.set(key, v);
    requestScope?.inflight.delete(key);
    return v;
  });
  requestScope.inflight.set(key, p);
  return p;
}
