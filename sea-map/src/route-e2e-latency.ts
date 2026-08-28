/**
 * E2.2 PREP — End-to-end latency baseline (diagnostic only).
 *
 * Does NOT change production routing, thresholds, Phase budgets, or BRouter.
 * Separates legacy routing wall time from optional WaterGraph shadow overhead.
 */

import type { RouteTrace } from './route-trace';
import { nowPerfMs } from './route-perf-context';

export type RouteE2EStages = {
  requestControlMs: number;
  endpointBindMs: number;
  phaseAMs: number;
  phaseBMs: number;
  phaseCMs: number;
  overpassMs: number;
  validationMs: number;
  hydroMs: number;
  finalizationMs: number;
};

export type RouteE2ECounters = {
  brouterCalls: number;
  brouterCacheHits: number;
  brouterCacheMisses: number;
  /** In-flight dedup shares within one request scope. */
  brouterDedupedRequests: number;
  phaseCTrials: number;
  overpassCalls: number;
  overpassCacheHits: number;
  overpassCacheMisses: number;
};

/**
 * End-to-end latency block on RouteTrace.
 * `totalMs` = wall from UI/API start → UI/API finish (includes shadow if ran).
 * `legacyRoutingMs` = wall excluding graph shadow overhead.
 * `graphShadowMs` is NEVER treated as an optimization win — overhead only.
 */
export type RouteTraceE2E = {
  startedAt: number;
  finishedAt: number;
  totalMs: number;
  /** Wall time attributed to legacy routing path (excludes graph shadow). */
  legacyRoutingMs: number;
  stages: RouteE2EStages;
  counters: RouteE2ECounters;
  graphShadowMs: number;
  graphShadowRan: boolean;
  /** True when stages may overlap (e.g. brouterMs ⊂ phaseB/C). */
  stagesOverlap: boolean;
  /** Sum of stage buckets (may exceed legacyRoutingMs when overlapping). */
  stagesSumMs: number;
  source: 'ui' | 'measureWaterChain' | 'bench';
};

/** Aggregatable one-row diagnostic for benches / UI. */
export type RouteLatencySummary = {
  requestId: string;
  totalE2EMs: number;
  legacyRoutingMs: number;
  graphShadowMs: number;
  graphShadowRan: boolean;
  brouterMs: number;
  phaseAMs: number;
  phaseBMs: number;
  phaseCMs: number;
  overpassMs: number;
  validationHydroMs: number;
  brouterCalls: number;
  brouterCacheHits: number;
  brouterCacheMisses: number;
  brouterDedupedRequests: number;
  overpassCalls: number;
  overpassCacheHits: number;
  overpassCacheMisses: number;
  phaseCTrials: number;
  ok: boolean;
  method: string;
  rejectReason: string | null;
  /** Network BRouter calls vs logical attempts (calls include cache path tallies). */
  brouterNetworkCallsApprox: number;
};

type UiE2ESession = {
  startedAt: number;
  requestControlMs: number;
  source: RouteTraceE2E['source'];
};

let uiSession: UiE2ESession | null = null;

/** Mark BUILD ROUTE / Проложить click (or bench) start. */
export function beginRouteE2E(source: RouteTraceE2E['source'] = 'ui'): void {
  uiSession = {
    startedAt: nowPerfMs(),
    requestControlMs: 0,
    source,
  };
}

export function noteRouteE2ERequestControlMs(ms: number): void {
  if (!uiSession || !(ms > 0)) return;
  uiSession.requestControlMs += ms;
}

export function peekRouteE2ESession(): UiE2ESession | null {
  return uiSession;
}

export function clearRouteE2ESession(): void {
  uiSession = null;
}

export function buildE2EFromTraceParts(input: {
  startedAt: number;
  finishedAt: number;
  source: RouteTraceE2E['source'];
  requestControlMs?: number;
  endpointBindMs?: number;
  phaseAMs?: number;
  phaseBMs?: number;
  phaseCMs?: number;
  overpassMs?: number;
  validationMs?: number;
  hydroMs?: number;
  finalizationMs?: number;
  brouterCalls?: number;
  brouterCacheHits?: number;
  brouterCacheMisses?: number;
  brouterDedupedRequests?: number;
  phaseCTrials?: number;
  overpassCalls?: number;
  overpassCacheHits?: number;
  graphShadowMs?: number;
  graphShadowRan?: boolean;
}): RouteTraceE2E {
  const stages: RouteE2EStages = {
    requestControlMs: Math.round(input.requestControlMs ?? 0),
    endpointBindMs: Math.round(input.endpointBindMs ?? 0),
    phaseAMs: Math.round(input.phaseAMs ?? 0),
    phaseBMs: Math.round(input.phaseBMs ?? 0),
    phaseCMs: Math.round(input.phaseCMs ?? 0),
    overpassMs: Math.round(input.overpassMs ?? 0),
    validationMs: Math.round(input.validationMs ?? 0),
    hydroMs: Math.round(input.hydroMs ?? 0),
    finalizationMs: Math.round(input.finalizationMs ?? 0),
  };
  const overpassCalls = input.overpassCalls ?? 0;
  const overpassCacheHits = input.overpassCacheHits ?? 0;
  const counters: RouteE2ECounters = {
    brouterCalls: input.brouterCalls ?? 0,
    brouterCacheHits: input.brouterCacheHits ?? 0,
    brouterCacheMisses: input.brouterCacheMisses ?? 0,
    brouterDedupedRequests: input.brouterDedupedRequests ?? 0,
    phaseCTrials: input.phaseCTrials ?? 0,
    overpassCalls,
    overpassCacheHits,
    overpassCacheMisses: Math.max(0, overpassCalls - overpassCacheHits),
  };
  const graphShadowMs = Math.round(input.graphShadowMs ?? 0);
  const graphShadowRan = Boolean(input.graphShadowRan);
  const totalMs = Math.max(0, Math.round(input.finishedAt - input.startedAt));
  const legacyRoutingMs = Math.max(0, totalMs - graphShadowMs);
  const stagesSumMs =
    stages.requestControlMs +
    stages.endpointBindMs +
    stages.phaseAMs +
    stages.phaseBMs +
    stages.phaseCMs +
    stages.overpassMs +
    stages.validationMs +
    stages.hydroMs +
    stages.finalizationMs;

  return {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    totalMs,
    legacyRoutingMs,
    stages,
    counters,
    graphShadowMs,
    graphShadowRan,
    // brouterMs is nested inside phase B/C wall; overpass may overlap phases.
    stagesOverlap: true,
    stagesSumMs,
    source: input.source,
  };
}

/** Attach / refresh e2e on a finished RouteTrace (mutates a shallow copy). */
export function withRouteTraceE2E(
  trace: RouteTrace,
  overrides?: Partial<{
    startedAt: number;
    finishedAt: number;
    source: RouteTraceE2E['source'];
    requestControlMs: number;
    graphShadowMs: number;
    graphShadowRan: boolean;
  }>,
): RouteTrace {
  const startedAt = overrides?.startedAt ?? trace.e2e?.startedAt ?? trace.timing.startedAtMs;
  const finishedAt = overrides?.finishedAt ?? nowPerfMs();
  const graphShadowMs =
    overrides?.graphShadowMs ??
    trace.e2e?.graphShadowMs ??
    (typeof trace.graph.totalGraphMs === 'number' && trace.graph.hybridAvailable
      ? trace.graph.totalGraphMs
      : 0);
  const graphShadowRan =
    overrides?.graphShadowRan ??
    trace.e2e?.graphShadowRan ??
    Boolean(trace.graph.hybridAvailable && (trace.graph.built || trace.graph.totalGraphMs));

  const e2e = buildE2EFromTraceParts({
    startedAt,
    finishedAt,
    source: overrides?.source ?? trace.e2e?.source ?? 'measureWaterChain',
    requestControlMs:
      overrides?.requestControlMs ??
      trace.e2e?.stages.requestControlMs ??
      0,
    endpointBindMs: (trace.timing.bindMs ?? 0) + (trace.timing.candidatesMs ?? 0),
    phaseAMs: trace.timing.phaseAMs,
    phaseBMs: trace.timing.phaseBMs,
    phaseCMs: trace.timing.phaseCMs,
    overpassMs: trace.timing.overpassMs,
    validationMs: trace.timing.validationMs,
    hydroMs: trace.timing.hydroMs,
    finalizationMs:
      (trace.timing.knowledgeMs ?? 0) + (trace.timing.finalAssemblyMs ?? 0),
    brouterCalls: trace.performance?.brouterCalls ?? 0,
    brouterCacheHits: trace.performance?.brouterCacheHits ?? 0,
    brouterCacheMisses: trace.performance?.brouterCacheMisses ?? 0,
    brouterDedupedRequests: trace.performance?.dedupedRequests ?? 0,
    phaseCTrials: trace.performance?.trialCount ?? 0,
    overpassCalls: trace.performance?.externalCalls.overpass ?? 0,
    overpassCacheHits: trace.performance?.cacheHits.overpass ?? 0,
    graphShadowMs,
    graphShadowRan,
  });

  return { ...trace, e2e };
}

/**
 * Finalize UI E2E onto the last emitted trace (after setStatus / panel render).
 * Safe no-op if no session / no trace.
 */
export function finalizeUiRouteE2E(trace: RouteTrace | null): RouteTrace | null {
  if (!trace) {
    clearRouteE2ESession();
    return null;
  }
  const session = uiSession;
  const finishedAt = nowPerfMs();
  const next = withRouteTraceE2E(trace, {
    startedAt: session?.startedAt ?? trace.timing.startedAtMs,
    finishedAt,
    source: session?.source ?? 'ui',
    requestControlMs: session?.requestControlMs ?? 0,
  });
  clearRouteE2ESession();
  return next;
}

export function summarizeRouteLatency(trace: RouteTrace): RouteLatencySummary {
  const e2e =
    trace.e2e ??
    withRouteTraceE2E(trace, { finishedAt: trace.timing.endedAtMs }).e2e!;
  const brouterCalls = e2e.counters.brouterCalls;
  const networkApprox = Math.max(
    0,
    brouterCalls - e2e.counters.brouterCacheHits - e2e.counters.brouterDedupedRequests,
  );
  return {
    requestId: trace.requestId,
    totalE2EMs: e2e.totalMs,
    legacyRoutingMs: e2e.legacyRoutingMs,
    graphShadowMs: e2e.graphShadowMs,
    graphShadowRan: e2e.graphShadowRan,
    brouterMs: trace.timing.brouterMs,
    phaseAMs: e2e.stages.phaseAMs,
    phaseBMs: e2e.stages.phaseBMs,
    phaseCMs: e2e.stages.phaseCMs,
    overpassMs: e2e.stages.overpassMs,
    validationHydroMs: e2e.stages.validationMs + e2e.stages.hydroMs,
    brouterCalls,
    brouterCacheHits: e2e.counters.brouterCacheHits,
    brouterCacheMisses: e2e.counters.brouterCacheMisses,
    brouterDedupedRequests: e2e.counters.brouterDedupedRequests,
    overpassCalls: e2e.counters.overpassCalls,
    overpassCacheHits: e2e.counters.overpassCacheHits,
    overpassCacheMisses: e2e.counters.overpassCacheMisses,
    phaseCTrials: e2e.counters.phaseCTrials,
    ok: trace.final.ok,
    method: trace.final.method,
    rejectReason: trace.final.rejectReason,
    brouterNetworkCallsApprox: networkApprox,
  };
}

/** Rank stage contribution for reports (excludes graph shadow by default). */
export function rankLatencySources(
  summary: RouteLatencySummary,
  opts?: { includeGraphShadow?: boolean },
): Array<{ name: string; ms: number }> {
  const rows: Array<{ name: string; ms: number }> = [
    { name: 'brouterMs', ms: summary.brouterMs },
    { name: 'phaseCMs', ms: summary.phaseCMs },
    { name: 'phaseBMs', ms: summary.phaseBMs },
    { name: 'phaseAMs', ms: summary.phaseAMs },
    { name: 'overpassMs', ms: summary.overpassMs },
    { name: 'validation+hydroMs', ms: summary.validationHydroMs },
  ];
  if (opts?.includeGraphShadow) {
    rows.push({ name: 'graphShadowMs', ms: summary.graphShadowMs });
  }
  return rows.sort((a, b) => b.ms - a.ms);
}
