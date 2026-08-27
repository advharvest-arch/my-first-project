/**
 * E0/E2 — RouteTrace: structured logging for measureWaterChain / Phase A–D.
 *
 * Side-effect only: never influences accept/reject, thresholds, ranking, or UI.
 * Hybrid Water Graph layers are reserved in the schema (null until Stage E2+).
 * userCorrection is schema-only — never populated in E0.
 * E2 adds optional `knowledge` (open Russian advisory facts) — diagnostic only.
 */

import type { LngLat } from './geo';
import type { WaterCandidateSource } from './water-candidates';
import type { WaterRouteValidationIssue } from './validate-water-route';
import type { HydroAcceptDecision } from './hydro-gate';
import type { RouteTraceKnowledge } from './water-knowledge';

export const ROUTE_TRACE_SCHEMA_VERSION = 1 as const;

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
 * Hybrid graph placeholder — E0 records legacy Overpass usage only.
 * Full layer stats arrive with WaterGraph (E2+).
 */
export type RouteTraceGraphInfo = {
  hybridAvailable: false;
  legacyOverpassUsed: boolean;
  legacySource?: 'cache' | 'fetch' | null;
  note: string;
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

export type RouteTraceFinal = {
  ok: boolean;
  method: string;
  lengthKm: number;
  rejectReason: string | null;
  waterName: string | null;
};

export type RouteTrace = {
  schemaVersion: typeof ROUTE_TRACE_SCHEMA_VERSION;
  requestId: string;
  timing: {
    startedAtMs: number;
    endedAtMs: number;
    durationMs: number;
  };
  request: {
    a: RouteTraceLngLat;
    b: RouteTraceLngLat;
    waypointCount: number;
    geoKm: number;
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
  finish: (final: RouteTraceFinal) => RouteTrace;
};

const DEFAULT_GRAPH: RouteTraceGraphInfo = {
  hybridAvailable: false,
  legacyOverpassUsed: false,
  legacySource: null,
  note: 'E0: hybrid WaterGraph not built; Overpass local graph is legacy fallback only',
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
    finish(final: RouteTraceFinal): RouteTrace {
      const endedAtMs = nowMs();
      const trace: RouteTrace = {
        schemaVersion: ROUTE_TRACE_SCHEMA_VERSION,
        requestId: builder.requestId,
        timing: {
          startedAtMs: builder.startedAtMs,
          endedAtMs,
          durationMs: Math.max(0, endedAtMs - builder.startedAtMs),
        },
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
          rejectReason: final.ok ? null : final.rejectReason ?? builder.lastRejectReason,
        },
        // userCorrection intentionally omitted (schema-only in E0)
      };
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
