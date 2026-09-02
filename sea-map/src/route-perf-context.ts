/**
 * E1.6 — per-request performance counters for RouteTrace.
 * Module-scoped during measureWaterChain; never affects accept/reject.
 */

export type RoutePerfCounters = {
  bindMs: number;
  candidatesMs: number;
  phaseAMs: number;
  phaseBMs: number;
  phaseCMs: number;
  brouterMs: number;
  overpassMs: number;
  openLakeMs: number;
  validationMs: number;
  hydroMs: number;
  knowledgeMs: number;
  finalAssemblyMs: number;
  brouterCalls: number;
  brouterCacheHits: number;
  brouterCacheMisses: number;
  dedupedRequests: number;
  overpassCalls: number;
  overpassCacheHits: number;
  openLakeOps: number;
  candidateCount: number;
  trialCount: number;
  pairCount: number;
  earlyStopTriggered: boolean;
};

export function createRoutePerfCounters(): RoutePerfCounters {
  return {
    bindMs: 0,
    candidatesMs: 0,
    phaseAMs: 0,
    phaseBMs: 0,
    phaseCMs: 0,
    brouterMs: 0,
    overpassMs: 0,
    openLakeMs: 0,
    validationMs: 0,
    hydroMs: 0,
    knowledgeMs: 0,
    finalAssemblyMs: 0,
    brouterCalls: 0,
    brouterCacheHits: 0,
    brouterCacheMisses: 0,
    dedupedRequests: 0,
    overpassCalls: 0,
    overpassCacheHits: 0,
    openLakeOps: 0,
    candidateCount: 0,
    trialCount: 0,
    pairCount: 0,
    earlyStopTriggered: false,
  };
}

let current: RoutePerfCounters | null = null;

export function getRoutePerf(): RoutePerfCounters | null {
  return current;
}

export function setRoutePerf(next: RoutePerfCounters | null): void {
  current = next;
}

export function nowPerfMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function addPerfMs(
  key: keyof Pick<
    RoutePerfCounters,
    | 'bindMs'
    | 'candidatesMs'
    | 'phaseAMs'
    | 'phaseBMs'
    | 'phaseCMs'
    | 'brouterMs'
    | 'overpassMs'
    | 'openLakeMs'
    | 'validationMs'
    | 'hydroMs'
    | 'knowledgeMs'
    | 'finalAssemblyMs'
  >,
  ms: number,
): void {
  if (!current || !(ms > 0)) return;
  current[key] += ms;
}

export async function timeAsync<T>(
  key: Parameters<typeof addPerfMs>[0],
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = nowPerfMs();
  try {
    return await fn();
  } finally {
    addPerfMs(key, nowPerfMs() - t0);
  }
}

export function timeSync<T>(key: Parameters<typeof addPerfMs>[0], fn: () => T): T {
  const t0 = nowPerfMs();
  try {
    return fn();
  } finally {
    addPerfMs(key, nowPerfMs() - t0);
  }
}
