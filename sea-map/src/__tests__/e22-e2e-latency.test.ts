/**
 * E2.2 PREP — E2E latency trace unit tests (no network required).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginRouteTrace,
  clearRouteTraces,
  getLastRouteTrace,
  replaceLastRouteTrace,
} from '../route-trace';
import {
  beginRouteE2E,
  buildE2EFromTraceParts,
  clearRouteE2ESession,
  finalizeUiRouteE2E,
  noteRouteE2ERequestControlMs,
  rankLatencySources,
  summarizeRouteLatency,
  withRouteTraceE2E,
} from '../route-e2e-latency';
import { createRoutePerfCounters } from '../route-perf-context';
import { getE2EBaselineCases } from '../e2e-latency-bench';
import { getRouteFeatureFlags } from '../route-feature-flags';

afterEach(() => {
  clearRouteTraces();
  clearRouteE2ESession();
});

describe('E2.2 e2e timing fields', () => {
  it('USE_WATER_GRAPH stays false (no production graph)', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('buildE2EFromTraceParts separates legacy vs graph shadow', () => {
    const e2e = buildE2EFromTraceParts({
      startedAt: 1000,
      finishedAt: 1500,
      source: 'bench',
      phaseBMs: 200,
      brouterCalls: 3,
      brouterCacheHits: 1,
      brouterCacheMisses: 2,
      brouterDedupedRequests: 1,
      overpassCalls: 4,
      overpassCacheHits: 1,
      graphShadowMs: 80,
      graphShadowRan: true,
    });
    expect(e2e.totalMs).toBe(500);
    expect(e2e.graphShadowMs).toBe(80);
    expect(e2e.legacyRoutingMs).toBe(420);
    expect(e2e.counters.overpassCacheMisses).toBe(3);
    expect(e2e.stagesOverlap).toBe(true);
  });

  it('beginRouteTrace.finish always emits e2e (optional stages may be 0)', () => {
    const b = beginRouteTrace(
      [
        { lon: 38.1, lat: 58.4 },
        { lon: 38.6, lat: 58.35 },
      ],
      20,
    );
    b.perf = createRoutePerfCounters();
    b.perf.phaseAMs = 12;
    // phase B/C/overpass intentionally zero — optional stages must not break
    const tr = b.finish({
      ok: true,
      method: 'lake',
      lengthKm: 20,
      rejectReason: null,
      waterName: 'test',
    });
    expect(tr.e2e).toBeDefined();
    expect(tr.e2e!.totalMs).toBeGreaterThanOrEqual(0);
    expect(tr.e2e!.stages.phaseAMs).toBe(12);
    expect(tr.e2e!.stages.phaseBMs).toBe(0);
    expect(tr.e2e!.graphShadowRan).toBe(false);
    expect(tr.e2e!.graphShadowMs).toBe(0);
    expect(tr.e2e!.legacyRoutingMs).toBe(tr.e2e!.totalMs);
  });

  it('totalMs >= subset of non-overlapping accounting when shadow excluded', () => {
    const e2e = buildE2EFromTraceParts({
      startedAt: 0,
      finishedAt: 1000,
      source: 'measureWaterChain',
      phaseAMs: 100,
      validationMs: 10,
      hydroMs: 5,
      graphShadowMs: 50,
      graphShadowRan: true,
    });
    // Overlap allowed: stagesSum may exceed legacy; total includes shadow.
    expect(e2e.totalMs).toBe(1000);
    expect(e2e.legacyRoutingMs).toBe(950);
    expect(e2e.totalMs).toBeGreaterThanOrEqual(e2e.graphShadowMs);
    expect(e2e.totalMs).toBeGreaterThanOrEqual(e2e.stages.phaseAMs);
  });

  it('UI finalize seals e2e onto last trace', () => {
    beginRouteE2E('ui');
    noteRouteE2ERequestControlMs(3);
    const b = beginRouteTrace(
      [
        { lon: 38.1, lat: 58.4 },
        { lon: 38.6, lat: 58.35 },
      ],
      10,
    );
    b.perf = createRoutePerfCounters();
    b.perf.brouterMs = 40;
    b.perf.brouterCalls = 2;
    const tr = b.finish({
      ok: true,
      method: 'waterway',
      lengthKm: 12,
      rejectReason: null,
      waterName: null,
    });
    const sealed = finalizeUiRouteE2E(tr);
    expect(sealed).not.toBeNull();
    expect(sealed!.e2e!.source).toBe('ui');
    expect(sealed!.e2e!.stages.requestControlMs).toBeGreaterThanOrEqual(3);
    replaceLastRouteTrace(sealed!);
    expect(getLastRouteTrace()?.e2e?.source).toBe('ui');
  });

  it('summarizeRouteLatency + rankLatencySources work', () => {
    const tr = withRouteTraceE2E(
      beginRouteTrace(
        [
          { lon: 1, lat: 1 },
          { lon: 2, lat: 2 },
        ],
        1,
      ).finish({
        ok: false,
        method: 'route_not_found',
        lengthKm: 0,
        rejectReason: 'route_not_found',
        waterName: null,
      }),
      { finishedAt: 500, graphShadowMs: 0 },
    );
    // finish already emitted; rebuild summary from sealed
    const summary = summarizeRouteLatency(tr);
    expect(summary.rejectReason).toBe('route_not_found');
    expect(rankLatencySources(summary).length).toBeGreaterThan(0);
  });

  it('baseline case list includes required corridors', () => {
    const ids = getE2EBaselineCases().map((c) => c.id);
    for (const id of ['VG-D', 'VG-mid', 'BELOMOR', 'N06', 'N08', 'N11', 'X3', 'L01']) {
      expect(ids).toContain(id);
    }
  });
});
