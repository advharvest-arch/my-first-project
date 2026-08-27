/**
 * E1.6 — unit tests for feature flags, early-stop, provider cache, failure classify.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import {
  EARLY_STOP_MAX_SCORE,
  shouldEarlyStopPhaseC,
} from '../phase-c-early-stop';
import {
  beginProviderRequestScope,
  brouterCacheKey,
  clearProviderCaches,
  endProviderRequestScope,
  getCachedBrouterResult,
  putCachedBrouterResult,
  withBrouterRequestDedup,
} from '../provider-cache';
import { classifyRouteFailure } from '../route-failure-classify';
import { beginRouteTrace, clearRouteTraces } from '../route-trace';
import { createRoutePerfCounters } from '../route-perf-context';

afterEach(() => {
  resetRouteFeatureFlags();
  clearProviderCaches();
  clearRouteTraces();
});

describe('route feature flags', () => {
  it('defaults preserve production algorithm (early-stop off)', () => {
    const f = getRouteFeatureFlags();
    expect(f.USE_ROUTE_EARLY_STOP).toBe(false);
    expect(f.USE_BROUTER_RESULT_CACHE).toBe(true);
    expect(f.USE_BROUTER_REQUEST_DEDUP).toBe(true);
    expect(f.USE_WATER_GRAPH).toBe(false);
  });

  it('test override then reset restores defaults', () => {
    setRouteFeatureFlagsForTests({ USE_ROUTE_EARLY_STOP: true });
    expect(getRouteFeatureFlags().USE_ROUTE_EARLY_STOP).toBe(true);
    resetRouteFeatureFlags();
    expect(getRouteFeatureFlags().USE_ROUTE_EARLY_STOP).toBe(false);
  });
});

describe('Phase C early-stop (flag default false ⇒ never stop)', () => {
  const excellent = {
    score: 0.4,
    startResidualKm: 0.2,
    finishResidualKm: 0.3,
    lengthKm: 30,
    geoKm: 28,
    classPenalty: 0,
    hydroReject: false,
  };

  it('disabled → false even for excellent score', () => {
    expect(shouldEarlyStopPhaseC({ enabled: false, ...excellent })).toBe(false);
  });

  it('enabled → true for excellent accepted trial', () => {
    expect(shouldEarlyStopPhaseC({ enabled: true, ...excellent })).toBe(true);
  });

  it('enabled → false when residuals / detour / score too large', () => {
    expect(
      shouldEarlyStopPhaseC({
        enabled: true,
        ...excellent,
        startResidualKm: 3,
        finishResidualKm: 3,
        score: EARLY_STOP_MAX_SCORE + 1,
      }),
    ).toBe(false);
    expect(
      shouldEarlyStopPhaseC({
        enabled: true,
        ...excellent,
        lengthKm: 80,
        geoKm: 28,
      }),
    ).toBe(false);
  });
});

describe('provider cache success / negative TTL', () => {
  it('stores success and negative separately; request scope dedupes', async () => {
    beginProviderRequestScope();
    const key = brouterCacheKey('1,2|3,4');
    putCachedBrouterResult(key, { points: [{ lon: 1, lat: 2 }], lengthKm: 1, wayTags: [] }, 'success');
    expect(getCachedBrouterResult(key).hit).toBe(true);

    let calls = 0;
    const a = withBrouterRequestDedup(key + ':x', true, async () => {
      calls += 1;
      return { ok: true };
    });
    const b = withBrouterRequestDedup(key + ':x', true, async () => {
      calls += 1;
      return { ok: true };
    });
    await Promise.all([a, b]);
    expect(calls).toBe(1);

    putCachedBrouterResult(key + ':neg', null, 'negative');
    expect(getCachedBrouterResult(key + ':neg')).toMatchObject({ hit: true, value: null });
    endProviderRequestScope();
  });
});

describe('failure classification', () => {
  it('maps span_gt_120 to data_gap / overpass', () => {
    const f = classifyRouteFailure('span_gt_120', { longSpanOverpassSkip: true });
    expect(f?.category).toBe('data_gap');
    expect(f?.stage).toBe('overpass');
  });

  it('maps snap_empty to snap_failure', () => {
    expect(classifyRouteFailure('snap_empty')?.category).toBe('snap_failure');
  });

  it('ok routes produce null', () => {
    expect(classifyRouteFailure(null, { ok: true })).toBeNull();
  });
});

describe('RouteTrace v2 attaches performance + failure', () => {
  it('finish includes timing detail and failure on reject', () => {
    const builder = beginRouteTrace(
      [
        { lon: 44.5, lat: 48.7 },
        { lon: 48.0, lat: 46.35 },
      ],
      370,
    );
    const perf = createRoutePerfCounters();
    perf.brouterMs = 1200;
    perf.brouterCalls = 2;
    builder.perf = perf;
    builder.request.longSpanOverpassSkip = true;
    builder.lastRejectReason = 'span_gt_120';
    const trace = builder.finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'span_gt_120',
      waterName: null,
    });
    expect(trace.schemaVersion).toBe(2);
    expect(trace.timing.brouterMs).toBe(1200);
    expect(trace.timing.totalMs).toBe(trace.timing.durationMs);
    expect(trace.performance?.externalCalls.brouter).toBe(2);
    expect(trace.failure?.category).toBe('data_gap');
    expect(trace.failure?.code).toBe('span_gt_120_overpass_skip');
  });
});
