/**
 * E0/E2/E1.6 — RouteTrace: structured logging for measureWaterChain / Phase A–D.
 *
 * Side-effect only: never influences accept/reject, thresholds, ranking, or UI.
 * Hybrid Water Graph layers are reserved in the schema (null until Stage E2+).
 * userCorrection is schema-only — never populated in E0.
 * E2 adds optional `knowledge` (open Russian advisory facts) — diagnostic only.
 * E1.6 adds detailed timing, performance, coverage, and failure classification
 * for future AI learning — still diagnostic only.
 */

import type { LngLat } from './geo';
import type { WaterCandidateSource } from './water-candidates';
import type { WaterRouteValidationIssue } from './validate-water-route';
import type { HydroAcceptDecision } from './hydro-gate';
import type { RouteTraceKnowledge } from './water-knowledge';
import {
  classifyRouteFailure,
  type RouteFailureSignal,
} from './route-failure-classify';
import type { RoutePerfCounters } from './route-perf-context';
import {
  buildE2EFromTraceParts,
  type RouteTraceE2E,
} from './route-e2e-latency';
import {
  snapshotFallbackDiag,
  type RouteTraceFallbackDiag,
} from './route-fallback-timeline';
import type { OverpassPreflight } from './overpass-preflight';
import type { WaterGraphTopology } from './water-graph-topology';
import type { WaterCorridorEvidenceReport } from './water-corridor-evidence';
import type { WaterGraphConnectionsReport } from './water-graph-connection';

export type { RouteTraceE2E, RouteLatencySummary, RouteE2EStages } from './route-e2e-latency';
export type { RouteTraceFallbackDiag, FallbackTimelineEvent, FallbackSummary } from './route-fallback-timeline';
export type { OverpassPreflight } from './overpass-preflight';
export type { WaterGraphTopology } from './water-graph-topology';
export type { WaterCorridorEvidenceReport, WaterCorridorEvidence } from './water-corridor-evidence';
export type {
  WaterGraphConnectionsReport,
  WaterGraphConnectionEvidence,
} from './water-graph-connection';
export {
  beginRouteE2E,
  finalizeUiRouteE2E,
  summarizeRouteLatency,
  withRouteTraceE2E,
  rankLatencySources,
  noteRouteE2ERequestControlMs,
} from './route-e2e-latency';
export { formatFallbackTimelineTable } from './route-fallback-timeline';

/** E1.6 bumps schema; v1 fields remain (durationMs / startedAtMs / endedAtMs). */
export const ROUTE_TRACE_SCHEMA_VERSION = 2 as const;

/** Max traces retained in the in-memory ring buffer. */
export const ROUTE_TRACE_BUFFER_LIMIT = 32;

export type RouteTraceLngLat = { lon: number; lat: number };

export type RouteTraceCandidate = {
  endpoint: 'A' | 'B';
  source: WaterCandidateSource;
  /** Soft class weight (SOURCE_CLASS_PENALTY). */
  classPenalty: number;
  distKm: number;
  rank: number;
  /** offFairwayStemPenalty for this candidate. */
  stemPenalty: number;
  point: RouteTraceLngLat;
};

export type RouteTraceChosenPair = {
  a: RouteTraceCandidate;
  b: RouteTraceCandidate;
  pairClassPenalty: number;
  score: number;
  via: 'brouter' | 'open_lake';
};

export type RouteTracePhaseResult = {
  attempted: boolean;
  ok: boolean;
  /** Phase label for logs. */
  phase: 'A' | 'B' | 'C' | 'overpass_cache' | 'overpass_fetch';
  lengthKm?: number;
  method?: 'waterway' | 'lake';
  openWaterVerified?: boolean;
  sharedLake?: string | null;
  residual?: { startKm: number; finishKm: number; snapKm: number; ok: boolean };
  brouterHadGeometry?: boolean;
  trials?: number;
  pairsTried?: number;
  rejectReason?: string | null;
};

export type RouteTraceBrouterAttempt = {
  label: 'original' | 'snapped' | 'phase_c';
  hadGeometry: boolean;
  lengthKm?: number;
  residual?: { startKm: number; finishKm: number; snapKm: number; ok: boolean };
  validatorIssues?: WaterRouteValidationIssue[];
};

/**
 * Hybrid graph diagnostics — E0 stub; E2.0 fills shadow WaterGraph fields.
 * `hybridAvailable` is boolean (was literal false in E0).
 */
export type RouteTraceGraphInfo = {
  hybridAvailable: boolean;
  legacyOverpassUsed: boolean;
  legacySource?: 'cache' | 'fetch' | null;
  note: string;
  /** E2.0 shadow */
  built?: boolean;
  nodeCount?: number;
  edgeCount?: number;
  layers?: {
    centerline: boolean;
    mask: boolean;
    fairway: boolean;
    lock: boolean;
  };
  componentCount?: number;
  largestComponentKm?: number;
  isolatedNodes?: number;
  deadEnds?: number;
  portalCount?: number;
  lockCount?: number;
  maskNodeCount?: number;
  waterwayNodeCount?: number;
  graphBuildMs?: number;
  centerlineMs?: number;
  maskMs?: number;
  seamMs?: number;
  fairwayMs?: number;
  searchMs?: number;
  buildMs?: number;
  totalGraphMs?: number;
  pathFound?: boolean;
  pathLengthKm?: number;
  pathCost?: number;
  edgeKinds?: string[];
  rejectReason?: string | null;
  failureStage?: string | null;
  terminalA?: { source: string; distKm: number; nodeId: string } | null;
  terminalB?: { source: string; distKm: number; nodeId: string } | null;
  expandedNodes?: number;
  legacyCompare?: {
    legacyLengthKm: number;
    graphLengthKm: number;
    deltaKm: number;
    deltaPct: number;
    agree: boolean;
    graphBetter: boolean;
    graphRejected: boolean;
    graphNoPath?: boolean;
    legacyBetter?: boolean;
    legacyNoPath?: boolean;
    classification?: string;
  };
  /** E2.1 edge kind counts */
  waterwayEdgeCount?: number;
  canalEdgeCount?: number;
  maskEdgeCount?: number;
  fairwayEdgeCount?: number;
  lockEdgeCount?: number;
  seamCount?: number;
  centerlineIngestMs?: number;
  centerlineSource?: string;
  sourceFeatureCount?: number;
  sourceWaterwayIds?: string[];
  osmFeatureCount?: number;
  acceptedFeatureCount?: number;
  rejectedFeatureCount?: number;
  rejectionReasons?: Record<string, number>;
  dataTimestampMs?: number;
  corridorBbox?: [number, number, number, number] | null;
  provenanceSources?: string[];
};

export type RouteTraceHydro = {
  reject: boolean;
  confidence: HydroAcceptDecision['confidence'];
  classification: HydroAcceptDecision['classification'];
  siteSeedId: string | null;
  advisoryOnly: boolean;
  reason: string;
};

/**
 * Schema-only: future AI / user feedback. E0 never sets this field.
 */
export type RouteTraceUserCorrection = {
  preferredBind?: { endpoint: 'A' | 'B'; point: RouteTraceLngLat; source?: WaterCandidateSource };
  reportedIssue?: string;
  note?: string;
};

export type RouteTraceRelationAwareShadow = {
  source: 'relation_aware';
  relationId: number;
  relationWayCount: number;
  nodeCount: number;
  edgeCount: number;
  componentCount: number;
  gapCount: number;
  recoveredGeometryKm: number;
  buildMs: number;
  searchMs: number;
  pathKm: number | null;
  pathFound: boolean;
  safetyResult: {
    accepted: boolean;
    rejectReason: string | null;
  };
  currentGapCount: number;
  currentArtificialGapKm: number | null;
  artificialGapEliminated: boolean;
  diagnosticOnly: true;
  legacyCompare: {
    legacyResult: string;
    graphResult: string;
    divergenceReason: string;
    e2eTotalMs: number | null;
    legacyRoutingMs: number | null;
    graphShadowMs: number;
  };
};

export type RouteTraceFinal = {
  ok: boolean;
  method: string;
  lengthKm: number;
  rejectReason: string | null;
  waterName: string | null;
};

/** E1.6 — stage timings (ms). totalMs mirrors durationMs. */
export type RouteTraceTimingDetail = {
  startedAtMs: number;
  endedAtMs: number;
  /** Backward-compatible total wall time. */
  durationMs: number;
  totalMs: number;
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
};

export type RouteTracePerformance = {
  cacheHit: boolean;
  /** Flat E1.7 counters for AI / reports. */
  brouterCalls: number;
  brouterCacheHits: number;
  brouterCacheMisses: number;
  dedupedRequests: number;
  candidateTrials: number;
  externalCalls: {
    brouter: number;
    overpass: number;
    openLake: number;
  };
  cacheHits: {
    brouter: number;
    overpass: number;
  };
  brouterCache?: {
    hit: number;
    miss: number;
    deduped: number;
  };
  candidateCount: number;
  trialCount: number;
  pairCount: number;
  earlyStopTriggered: boolean;
};

export type RouteTraceCoverage = {
  waterwayCoverage: 'unknown' | 'present' | 'sparse' | 'absent';
  maskCoverage: 'unknown' | 'hit' | 'miss';
  fairwayCoverage: 'unknown' | 'hit' | 'miss';
  knowledgeCoverage: 'none' | 'partial' | 'matched';
};

/** E1.7 — long-span segmentation diagnostics. */
export type RouteTraceLongSpan = {
  enabled: boolean;
  segmented: boolean;
  segmentCount: number;
  failedSegment: number | null;
  seamFailures: number;
  rejectReason?: string | null;
};

export type RouteTraceSegment = {
  index: number;
  a: RouteTraceLngLat;
  b: RouteTraceLngLat;
  lengthKm: number;
  method: string;
  brouterAttempts: number;
  ok: boolean;
  rejectReason: string | null;
};

export type RouteTrace = {
  schemaVersion: typeof ROUTE_TRACE_SCHEMA_VERSION;
  requestId: string;
  timing: RouteTraceTimingDetail;
  request: {
    a: RouteTraceLngLat;
    b: RouteTraceLngLat;
    waypointCount: number;
    /** Haversine / route-span km between endpoints (diagnostic). */
    geoKm: number;
    /**
     * True when geoKm > 120 and Overpass fallback is skipped by design.
     * Observability only — does not change routing.
     */
    longSpanOverpassSkip?: boolean;
  };
  candidates: RouteTraceCandidate[];
  chosenCandidate: RouteTraceChosenPair | null;
  phases: {
    A: RouteTracePhaseResult | null;
    B: RouteTracePhaseResult | null;
    C: RouteTracePhaseResult | null;
    overpass: RouteTracePhaseResult | null;
  };
  brouterAttempts: RouteTraceBrouterAttempt[];
  graph: RouteTraceGraphInfo;
  validator: {
    ok: boolean;
    issues: WaterRouteValidationIssue[];
  } | null;
  hydro: RouteTraceHydro | null;
  final: RouteTraceFinal;
  /** E1.6/E1.7 — AI-ready performance signals. */
  performance?: RouteTracePerformance;
  /** E1.6 — coverage heuristics for the request corridor. */
  coverage?: RouteTraceCoverage;
  /** E1.7 — long-span segmentation summary. */
  longSpan?: RouteTraceLongSpan;
  /** E1.7 — per-segment traces when segmented routing ran. */
  segments?: RouteTraceSegment[];
  /** E1.6 — classified failure (separate from rejectReason text). */
  failure?: RouteFailureSignal;
  /**
   * E2.2 PREP — UI/API end-to-end latency baseline.
   * Diagnostic only; does not affect accept/reject.
   */
  e2e?: RouteTraceE2E;
  /**
   * E2.2.1 — chronological fallback timeline (Overpass/BRouter/Phase C).
   * Diagnostic only.
   */
  fallbackTimeline?: RouteTraceFallbackDiag;
  /**
   * E2.2.2 — signals known before Overpass fetchWaterNetwork.
   * Diagnostic only; never gates routing.
   */
  overpassPreflight?: OverpassPreflight;
  /**
   * E2.2.3 — WaterGraph topology snapshot (components / gaps / candidates).
   * Diagnostic only; never adds seams or changes routing.
   */
  waterGraphTopology?: WaterGraphTopology;
  /**
   * E2.3 — navigable corridor evidence between components.
   * Diagnostic only; never creates seams; distance ≠ connection proof.
   */
  waterCorridorEvidence?: WaterCorridorEvidenceReport;
  /**
   * E2.4 — connection model (confirmed / candidate / rejected) + provenance.
   * Diagnostic only; confirmedCreatesEdges is always false in this stage.
   */
  waterGraphConnections?: WaterGraphConnectionsReport;
  /**
   * E2.10 — Belomor relation-aware WaterGraph shadow compare (diagnostic only).
   * Never replaces legacy production result. Present only when shadow ran.
   */
  relationAwareShadow?: RouteTraceRelationAwareShadow;
  /**
   * E2 — Open Russian Knowledge Layer matches (advisory only).
   * Omitted when no facts matched / knowledge disabled.
   */
  knowledge?: RouteTraceKnowledge;
  /**
   * Schema reserved for future AI training / user feedback.
   * Always omitted (undefined) in E0 — never collect UI data here.
   */
  userCorrection?: RouteTraceUserCorrection;
};

export type RouteTraceSink = (trace: RouteTrace) => void;

let seq = 0;
const buffer: RouteTrace[] = [];
let sink: RouteTraceSink | null = null;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

export function setRouteTraceSink(next: RouteTraceSink | null): void {
  sink = next;
}

export function clearRouteTraces(): void {
  buffer.length = 0;
}

export function getRouteTraceBuffer(): readonly RouteTrace[] {
  return buffer;
}

export function getLastRouteTrace(): RouteTrace | null {
  return buffer.length ? buffer[buffer.length - 1]! : null;
}

/** Emit a completed trace into the ring buffer (+ optional sink). */
export function emitRouteTrace(trace: RouteTrace): void {
  buffer.push(trace);
  while (buffer.length > ROUTE_TRACE_BUFFER_LIMIT) buffer.shift();
  if (sink) {
    try {
      sink(trace);
    } catch {
      // Sink errors must never affect routing.
    }
  }
}

/** Replace the most recent buffer entry (E2.2 UI e2e seal). */
export function replaceLastRouteTrace(trace: RouteTrace): void {
  if (buffer.length === 0) {
    emitRouteTrace(trace);
    return;
  }
  buffer[buffer.length - 1] = trace;
  if (sink) {
    try {
      sink(trace);
    } catch {
      // Sink errors must never affect routing.
    }
  }
}

export function ll(p: LngLat): RouteTraceLngLat {
  return { lon: p.lon, lat: p.lat };
}

export function hydroToTrace(d: HydroAcceptDecision): RouteTraceHydro {
  return {
    reject: d.reject,
    confidence: d.confidence,
    classification: d.classification,
    siteSeedId: d.siteSeedId,
    advisoryOnly: d.advisoryOnly,
    reason: d.reason,
  };
}

function emptyTiming(startedAtMs: number, endedAtMs: number): RouteTraceTimingDetail {
  const durationMs = Math.max(0, endedAtMs - startedAtMs);
  return {
    startedAtMs,
    endedAtMs,
    durationMs,
    totalMs: durationMs,
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
  };
}

export function timingFromPerf(
  startedAtMs: number,
  endedAtMs: number,
  perf: RoutePerfCounters | null,
): RouteTraceTimingDetail {
  const base = emptyTiming(startedAtMs, endedAtMs);
  if (!perf) return base;
  return {
    ...base,
    bindMs: Math.round(perf.bindMs),
    candidatesMs: Math.round(perf.candidatesMs),
    phaseAMs: Math.round(perf.phaseAMs),
    phaseBMs: Math.round(perf.phaseBMs),
    phaseCMs: Math.round(perf.phaseCMs),
    brouterMs: Math.round(perf.brouterMs),
    overpassMs: Math.round(perf.overpassMs),
    openLakeMs: Math.round(perf.openLakeMs),
    validationMs: Math.round(perf.validationMs),
    hydroMs: Math.round(perf.hydroMs),
    knowledgeMs: Math.round(perf.knowledgeMs),
    finalAssemblyMs: Math.round(perf.finalAssemblyMs),
  };
}

export function performanceFromPerf(perf: RoutePerfCounters | null): RouteTracePerformance {
  if (!perf) {
    return {
      cacheHit: false,
      brouterCalls: 0,
      brouterCacheHits: 0,
      brouterCacheMisses: 0,
      dedupedRequests: 0,
      candidateTrials: 0,
      externalCalls: { brouter: 0, overpass: 0, openLake: 0 },
      cacheHits: { brouter: 0, overpass: 0 },
      brouterCache: { hit: 0, miss: 0, deduped: 0 },
      candidateCount: 0,
      trialCount: 0,
      pairCount: 0,
      earlyStopTriggered: false,
    };
  }
  return {
    cacheHit: perf.brouterCacheHits + perf.overpassCacheHits > 0,
    brouterCalls: perf.brouterCalls,
    brouterCacheHits: perf.brouterCacheHits,
    brouterCacheMisses: perf.brouterCacheMisses,
    dedupedRequests: perf.dedupedRequests,
    candidateTrials: perf.trialCount,
    externalCalls: {
      brouter: perf.brouterCalls,
      overpass: perf.overpassCalls,
      openLake: perf.openLakeOps,
    },
    cacheHits: {
      brouter: perf.brouterCacheHits,
      overpass: perf.overpassCacheHits,
    },
    brouterCache: {
      hit: perf.brouterCacheHits,
      miss: perf.brouterCacheMisses,
      deduped: perf.dedupedRequests,
    },
    candidateCount: perf.candidateCount,
    trialCount: perf.trialCount,
    pairCount: perf.pairCount,
    earlyStopTriggered: perf.earlyStopTriggered,
  };
}

export function inferCoverage(opts: {
  sharedLake?: string | null;
  candidates: RouteTraceCandidate[];
  knowledgeFacts?: number;
  finalOk: boolean;
  method: string;
}): RouteTraceCoverage {
  const hasFairway = opts.candidates.some((c) => c.source === 'fairway');
  const hasMask = opts.candidates.some((c) => c.source === 'mask');
  const hasWaterway = opts.candidates.some(
    (c) => c.source === 'waterway' || c.source === 'fairway',
  );
  return {
    waterwayCoverage: hasWaterway
      ? 'present'
      : opts.finalOk
        ? 'present'
        : opts.candidates.length
          ? 'sparse'
          : 'unknown',
    maskCoverage: opts.sharedLake ? 'hit' : hasMask ? 'hit' : 'miss',
    fairwayCoverage: hasFairway ? 'hit' : 'miss',
    knowledgeCoverage:
      (opts.knowledgeFacts ?? 0) > 2
        ? 'matched'
        : (opts.knowledgeFacts ?? 0) > 0
          ? 'partial'
          : 'none',
  };
}

/** Mutable builder used inside measureWaterChain — finish() emits once. */
export type RouteTraceBuilder = {
  readonly requestId: string;
  readonly startedAtMs: number;
  request: RouteTrace['request'];
  candidates: RouteTraceCandidate[];
  chosenCandidate: RouteTraceChosenPair | null;
  phases: RouteTrace['phases'];
  brouterAttempts: RouteTraceBrouterAttempt[];
  graph: RouteTraceGraphInfo;
  validator: RouteTrace['validator'];
  hydro: RouteTraceHydro | null;
  /** E2 advisory knowledge — set before finish; never affects accept/reject. */
  knowledge: RouteTraceKnowledge | null;
  lastRejectReason: string | null;
  /** Optional perf counters attached at finish. */
  perf: RoutePerfCounters | null;
  /** E1.7 long-span diagnostics. */
  longSpan: RouteTraceLongSpan | null;
  segments: RouteTraceSegment[];
  /** E2.2 — WaterGraph shadow wall (excluded from legacyRoutingMs). */
  graphShadowMs: number;
  graphShadowRan: boolean;
  /** E2.2.2 — Overpass preflight (set before/at Overpass decision). */
  overpassPreflight: OverpassPreflight | null;
  /** E2.2.3 — WaterGraph topology (diagnostic only). */
  waterGraphTopology: WaterGraphTopology | null;
  /** E2.3 — corridor evidence (diagnostic only). */
  waterCorridorEvidence: WaterCorridorEvidenceReport | null;
  /** E2.4 — connection model (diagnostic only). */
  waterGraphConnections: WaterGraphConnectionsReport | null;
  /** E2.10 — Belomor relation-aware shadow (diagnostic only). */
  relationAwareShadow: RouteTraceRelationAwareShadow | null;
  finish: (final: RouteTraceFinal) => RouteTrace;
};

const DEFAULT_GRAPH: RouteTraceGraphInfo = {
  hybridAvailable: false,
  legacyOverpassUsed: false,
  legacySource: null,
  note: 'E2.0: WaterGraph shadow available behind USE_WATER_GRAPH; production uses legacy',
};

export function beginRouteTrace(waypoints: LngLat[], geoKm = 0): RouteTraceBuilder {
  seq += 1;
  const startedAtMs = nowMs();
  const a = waypoints[0]!;
  const b = waypoints[waypoints.length - 1]!;

  const builder: RouteTraceBuilder = {
    requestId: `rt-${Date.now()}-${seq}`,
    startedAtMs,
    request: {
      a: ll(a),
      b: ll(b),
      waypointCount: waypoints.length,
      geoKm,
    },
    candidates: [],
    chosenCandidate: null,
    phases: { A: null, B: null, C: null, overpass: null },
    brouterAttempts: [],
    graph: { ...DEFAULT_GRAPH },
    validator: null,
    hydro: null,
    knowledge: null,
    lastRejectReason: null,
    perf: null,
    longSpan: null,
    segments: [],
    graphShadowMs: 0,
    graphShadowRan: false,
    overpassPreflight: null,
    waterGraphTopology: null,
    waterCorridorEvidence: null,
    waterGraphConnections: null,
    relationAwareShadow: null,
    finish(final: RouteTraceFinal): RouteTrace {
      const endedAtMs = nowMs();
      const rejectReason = final.ok ? null : final.rejectReason ?? builder.lastRejectReason;
      const timing = timingFromPerf(builder.startedAtMs, endedAtMs, builder.perf);
      const performance = performanceFromPerf(builder.perf);
      const coverage = inferCoverage({
        sharedLake: builder.phases.A?.sharedLake ?? builder.phases.B?.sharedLake ?? null,
        candidates: builder.candidates,
        knowledgeFacts: builder.knowledge?.factsMatched,
        finalOk: final.ok,
        method: final.method,
      });
      const failure =
        classifyRouteFailure(rejectReason, {
          ok: final.ok,
          longSpanOverpassSkip: builder.request.longSpanOverpassSkip,
        }) ?? undefined;

      const e2e = buildE2EFromTraceParts({
        startedAt: builder.startedAtMs,
        finishedAt: endedAtMs,
        source: 'measureWaterChain',
        endpointBindMs: (timing.bindMs ?? 0) + (timing.candidatesMs ?? 0),
        phaseAMs: timing.phaseAMs,
        phaseBMs: timing.phaseBMs,
        phaseCMs: timing.phaseCMs,
        overpassMs: timing.overpassMs,
        validationMs: timing.validationMs,
        hydroMs: timing.hydroMs,
        finalizationMs: (timing.knowledgeMs ?? 0) + (timing.finalAssemblyMs ?? 0),
        brouterCalls: performance.brouterCalls,
        brouterCacheHits: performance.brouterCacheHits,
        brouterCacheMisses: performance.brouterCacheMisses,
        brouterDedupedRequests: performance.dedupedRequests,
        phaseCTrials: performance.trialCount,
        overpassCalls: performance.externalCalls.overpass,
        overpassCacheHits: performance.cacheHits.overpass,
        graphShadowMs: builder.graphShadowMs,
        graphShadowRan: builder.graphShadowRan,
      });

      const trace: RouteTrace = {
        schemaVersion: ROUTE_TRACE_SCHEMA_VERSION,
        requestId: builder.requestId,
        timing,
        request: builder.request,
        candidates: builder.candidates.slice(),
        chosenCandidate: builder.chosenCandidate,
        phases: {
          A: builder.phases.A,
          B: builder.phases.B,
          C: builder.phases.C,
          overpass: builder.phases.overpass,
        },
        brouterAttempts: builder.brouterAttempts.slice(),
        graph: { ...builder.graph },
        validator: builder.validator,
        hydro: builder.hydro,
        final: {
          ...final,
          rejectReason,
        },
        performance,
        coverage,
        e2e,
        // userCorrection intentionally omitted (schema-only in E0)
      };
      const fallback = snapshotFallbackDiag(timing.totalMs);
      if (fallback) trace.fallbackTimeline = fallback;
      if (builder.overpassPreflight) trace.overpassPreflight = builder.overpassPreflight;
      if (builder.waterGraphTopology) trace.waterGraphTopology = builder.waterGraphTopology;
      if (builder.waterCorridorEvidence) {
        trace.waterCorridorEvidence = builder.waterCorridorEvidence;
      }
      if (builder.waterGraphConnections) {
        trace.waterGraphConnections = builder.waterGraphConnections;
      }
      if (builder.relationAwareShadow) {
        trace.relationAwareShadow = builder.relationAwareShadow;
      }
      if (builder.longSpan) trace.longSpan = builder.longSpan;
      if (builder.segments.length) trace.segments = builder.segments.slice();
      if (failure && !final.ok) trace.failure = failure;
      if (builder.knowledge) trace.knowledge = builder.knowledge;
      emitRouteTrace(trace);
      return trace;
    },
  };

  return builder;
}

export function candidateToTrace(
  endpoint: 'A' | 'B',
  c: {
    point: LngLat;
    distKm: number;
    source: WaterCandidateSource;
    rank: number;
  },
  classPenalty: number,
  stemPenalty: number,
): RouteTraceCandidate {
  return {
    endpoint,
    source: c.source,
    classPenalty,
    distKm: c.distKm,
    rank: c.rank,
    stemPenalty,
    point: ll(c.point),
  };
}
