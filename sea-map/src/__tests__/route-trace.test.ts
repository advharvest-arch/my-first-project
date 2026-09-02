/**
 * E0 — RouteTrace schema + emission unit tests.
 * Does not exercise live BRouter / Overpass (no routing behavior change).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  ROUTE_TRACE_BUFFER_LIMIT,
  ROUTE_TRACE_SCHEMA_VERSION,
  beginRouteTrace,
  candidateToTrace,
  clearRouteTraces,
  emitRouteTrace,
  getLastRouteTrace,
  getRouteTraceBuffer,
  hydroToTrace,
  ll,
  setRouteTraceSink,
  type RouteTrace,
  type RouteTraceUserCorrection,
} from '../route-trace';
import { SOURCE_CLASS_PENALTY } from '../water-candidates';
import type { HydroAcceptDecision } from '../hydro-gate';

const p = (lon: number, lat: number) => ({ lon, lat });

afterEach(() => {
  clearRouteTraces();
  setRouteTraceSink(null);
});

describe('RouteTrace schema (E0)', () => {
  it('exports schemaVersion = 1', () => {
    expect(ROUTE_TRACE_SCHEMA_VERSION).toBe(2);
  });

  it('beginRouteTrace + finish emits a complete schema without userCorrection', () => {
    const builder = beginRouteTrace([p(38.1, 58.4), p(38.6, 58.35)], 29.7);
    builder.candidates.push(
      candidateToTrace(
        'A',
        {
          point: p(38.12, 58.4),
          distKm: 1.2,
          source: 'fairway',
          rank: 1.2,
        },
        SOURCE_CLASS_PENALTY.fairway,
        0,
      ),
    );
    builder.phases.A = {
      attempted: true,
      ok: true,
      phase: 'A',
      lengthKm: 29.7,
      method: 'lake',
      openWaterVerified: true,
      sharedLake: 'Рыбинское водохранилище',
    };
    builder.validator = { ok: true, issues: [] };
    builder.hydro = hydroToTrace({
      reject: false,
      confidence: null,
      classification: null,
      siteSeedId: null,
      advisoryOnly: false,
      reason: 'no hydro site in corridor',
    } satisfies HydroAcceptDecision);
    builder.graph.legacyOverpassUsed = false;

    const trace = builder.finish({
      ok: true,
      method: 'lake',
      lengthKm: 29.7,
      rejectReason: null,
      waterName: 'Рыбинское водохранилище',
    });

    expect(trace.schemaVersion).toBe(2);
    expect(trace.requestId).toMatch(/^rt-/);
    expect(trace.request.a).toEqual(ll(p(38.1, 58.4)));
    expect(trace.request.b).toEqual(ll(p(38.6, 58.35)));
    expect(trace.request.geoKm).toBe(29.7);
    expect(trace.request.waypointCount).toBe(2);
    expect(trace.candidates).toHaveLength(1);
    expect(trace.candidates[0]!.source).toBe('fairway');
    expect(trace.candidates[0]!.classPenalty).toBe(0);
    expect(trace.candidates[0]!.stemPenalty).toBe(0);
    expect(trace.phases.A?.ok).toBe(true);
    expect(trace.phases.B).toBeNull();
    expect(trace.phases.C).toBeNull();
    expect(trace.graph.hybridAvailable).toBe(false);
    expect(trace.validator?.ok).toBe(true);
    expect(trace.hydro?.reject).toBe(false);
    expect(trace.final.ok).toBe(true);
    expect(trace.final.rejectReason).toBeNull();
    expect(trace.timing.durationMs).toBeGreaterThanOrEqual(0);
    expect(trace.timing.endedAtMs).toBeGreaterThanOrEqual(trace.timing.startedAtMs);
    // Schema-only: never populated in E0
    expect(trace.userCorrection).toBeUndefined();
  });

  it('finish uses lastRejectReason when final rejectReason omitted', () => {
    const builder = beginRouteTrace([p(49.2, 54.5), p(49.0, 54.1)], 46);
    builder.lastRejectReason = 'snap_empty';
    builder.phases.C = {
      attempted: true,
      ok: false,
      phase: 'C',
      rejectReason: 'snap_empty',
    };
    const trace = builder.finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: null,
      waterName: null,
    });
    expect(trace.final.rejectReason).toBe('snap_empty');
    expect(trace.final.ok).toBe(false);
  });

  it('longSpanOverpassSkip is optional observability on request', () => {
    const builder = beginRouteTrace([p(44.5, 48.7), p(48.0, 46.35)], 370);
    builder.request.longSpanOverpassSkip = true;
    builder.phases.overpass = {
      attempted: false,
      ok: false,
      phase: 'overpass_fetch',
      rejectReason: 'span_gt_120',
    };
    builder.lastRejectReason = 'span_gt_120';
    const trace = builder.finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'span_gt_120',
      waterName: null,
    });
    expect(trace.request.longSpanOverpassSkip).toBe(true);
    expect(trace.phases.overpass?.rejectReason).toBe('span_gt_120');
    expect(trace.final.rejectReason).toBe('span_gt_120');
  });

  it('RouteTraceUserCorrection type is schema-only (assignable but unused)', () => {
    const correction: RouteTraceUserCorrection = {
      preferredBind: { endpoint: 'A', point: { lon: 1, lat: 2 }, source: 'fairway' },
      reportedIssue: 'wrong arm',
    };
    // Prove the type exists for future AI — E0 must not attach it on emit.
    const builder = beginRouteTrace([p(1, 2), p(3, 4)], 10);
    const trace = builder.finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'test',
      waterName: null,
    });
    expect(correction.reportedIssue).toBe('wrong arm');
    expect('userCorrection' in trace && trace.userCorrection).toBeFalsy();
  });
});

describe('RouteTrace emission buffer / sink', () => {
  it('emitRouteTrace pushes into ring buffer; getLastRouteTrace returns latest', () => {
    clearRouteTraces();
    const a = beginRouteTrace([p(1, 2), p(3, 4)], 5).finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'a',
      waterName: null,
    });
    const b = beginRouteTrace([p(5, 6), p(7, 8)], 9).finish({
      ok: true,
      method: 'waterway',
      lengthKm: 12,
      rejectReason: null,
      waterName: null,
    });
    expect(getRouteTraceBuffer()).toHaveLength(2);
    expect(getLastRouteTrace()?.requestId).toBe(b.requestId);
    expect(getLastRouteTrace()?.final.method).toBe('waterway');
    expect(a.final.rejectReason).toBe('a');
  });

  it('ring buffer drops oldest beyond ROUTE_TRACE_BUFFER_LIMIT', () => {
    clearRouteTraces();
    for (let i = 0; i < ROUTE_TRACE_BUFFER_LIMIT + 5; i++) {
      emitRouteTrace({
        schemaVersion: 2,
        requestId: `rt-bulk-${i}`,
        timing: {
          startedAtMs: i,
          endedAtMs: i + 1,
          durationMs: 1,
          totalMs: 1,
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
        },
        request: {
          a: { lon: 0, lat: 0 },
          b: { lon: 1, lat: 1 },
          waypointCount: 2,
          geoKm: 1,
        },
        candidates: [],
        chosenCandidate: null,
        phases: { A: null, B: null, C: null, overpass: null },
        brouterAttempts: [],
        graph: {
          hybridAvailable: false,
          legacyOverpassUsed: false,
          legacySource: null,
          note: 'test',
        },
        validator: null,
        hydro: null,
        final: {
          ok: false,
          method: 'route_not_found',
          lengthKm: 0,
          rejectReason: `n${i}`,
          waterName: null,
        },
      } satisfies RouteTrace);
    }
    expect(getRouteTraceBuffer()).toHaveLength(ROUTE_TRACE_BUFFER_LIMIT);
    expect(getRouteTraceBuffer()[0]!.requestId).toBe('rt-bulk-5');
    expect(getLastRouteTrace()?.requestId).toBe(
      `rt-bulk-${ROUTE_TRACE_BUFFER_LIMIT + 4}`,
    );
  });

  it('setRouteTraceSink receives emissions; sink errors do not throw', () => {
    const seen: string[] = [];
    setRouteTraceSink((t) => {
      seen.push(t.requestId);
    });
    const t1 = beginRouteTrace([p(0, 0), p(1, 1)], 1).finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'x',
      waterName: null,
    });
    expect(seen).toEqual([t1.requestId]);

    setRouteTraceSink(() => {
      throw new Error('sink boom');
    });
    expect(() =>
      beginRouteTrace([p(0, 0), p(1, 1)], 1).finish({
        ok: false,
        method: 'route_not_found',
        lengthKm: 0,
        rejectReason: 'y',
        waterName: null,
      }),
    ).not.toThrow();
  });

  it('clearRouteTraces empties the buffer', () => {
    beginRouteTrace([p(0, 0), p(1, 1)], 1).finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'z',
      waterName: null,
    });
    expect(getLastRouteTrace()).not.toBeNull();
    clearRouteTraces();
    expect(getLastRouteTrace()).toBeNull();
    expect(getRouteTraceBuffer()).toHaveLength(0);
  });
});

describe('RouteTrace candidate / hydro helpers', () => {
  it('candidateToTrace copies source/class/stem/rank', () => {
    const row = candidateToTrace(
      'B',
      { point: p(49, 55), distKm: 4.3, source: 'waterway', rank: 6.1 },
      SOURCE_CLASS_PENALTY.waterway,
      2.2,
    );
    expect(row.endpoint).toBe('B');
    expect(row.classPenalty).toBe(1.6);
    expect(row.stemPenalty).toBe(2.2);
    expect(row.rank).toBe(6.1);
    expect(row.point).toEqual({ lon: 49, lat: 55 });
  });

  it('hydroToTrace mirrors HydroAcceptDecision fields', () => {
    const d: HydroAcceptDecision = {
      reject: true,
      confidence: 'high',
      classification: 'illegal_dam_crossing',
      siteSeedId: 'seed-1',
      advisoryOnly: false,
      reason: 'high-confidence illegal_dam_crossing at seed-1',
    };
    expect(hydroToTrace(d)).toEqual({
      reject: true,
      confidence: 'high',
      classification: 'illegal_dam_crossing',
      siteSeedId: 'seed-1',
      advisoryOnly: false,
      reason: d.reason,
    });
  });
});

describe('RouteTrace re-exports from waterways', () => {
  it('waterways exports trace accessors without pulling UI', async () => {
    const mod = await import('../waterways');
    expect(mod.ROUTE_TRACE_SCHEMA_VERSION).toBe(2);
    expect(typeof mod.getLastRouteTrace).toBe('function');
    expect(typeof mod.clearRouteTraces).toBe('function');
    expect(typeof mod.setRouteTraceSink).toBe('function');
  });
});
