/**
 * E2.15 — Hybrid WaterGraph pilot tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  decideHybridFromShadow,
  legacyHybridDiag,
  attemptWaterGraphRoute,
} from '../watergraph-hybrid-router';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import {
  measureWaterChain,
  clearWaterwayCellCacheForTests,
} from '../waterways';
import { clearProviderCaches } from '../provider-cache';
import { clearRouteTraces, getLastRouteTrace } from '../route-trace';
import { USER_TEST_PRESETS } from '../user-test-presets';
import { BELOMOR_A, BELOMOR_B } from '../relation-aware-ingest';
import { runWaterGraphShadow } from '../water-graph';
import { haversineKm } from '../geo';

afterEach(() => {
  resetRouteFeatureFlags();
  clearRouteTraces();
});

function preset(id: string) {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing ${id}`);
  return p;
}

describe('E2.15 Hybrid WaterGraph pilot', () => {
  it('USE_WATER_GRAPH defaults to false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('feature flag OFF → legacy behavior (no hybrid attempt)', async () => {
    resetRouteFeatureFlags();
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const p = preset('N08');
    const path = await measureWaterChain([p.a, p.b]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.routerMode).toBe('legacy');
    expect(tr?.hybridRouter?.waterGraphAttempted).toBe(false);
    expect(tr?.hybridRouter?.selectedRouter).toBe('legacy');
    expect(path.method === 'route_not_found' || path.points.length >= 2).toBe(
      true,
    );
  }, 180_000);

  it('decideHybrid: WaterGraph success → selected watergraph', () => {
    const d = decideHybridFromShadow({
      shadow: {
        pathFound: true,
        validated: true,
        failureStage: 'none',
        rejectReason: null,
        pathLengthKm: 40,
      },
      attemptMs: 10,
      ingestMs: 1,
      maskResolveMs: 1,
      centerlineSource: 'overpass',
      maskSource: 'lake:1',
    });
    expect(d.accept).toBe(true);
    expect(d.diag.selectedRouter).toBe('watergraph');
    expect(d.diag.fallbackUsed).toBe(false);
    expect(d.diag.waterGraphSafetyResult).toBe('accepted');
  });

  it('decideHybrid: disconnected → BRouter fallback reason', () => {
    const d = decideHybridFromShadow({
      shadow: {
        pathFound: false,
        validated: false,
        failureStage: 'graph_disconnected',
        rejectReason: 'graph_disconnected',
        pathLengthKm: 0,
      },
      attemptMs: 10,
      ingestMs: 1,
      maskResolveMs: 1,
      centerlineSource: 'overpass',
      maskSource: null,
    });
    expect(d.accept).toBe(false);
    expect(d.diag.selectedRouter).toBe('brouter');
    expect(d.diag.fallbackUsed).toBe(true);
    expect(d.diag.waterGraphResult).toBe('disconnected');
    expect(d.diag.fallbackReason).toMatch(/watergraph_disconnected/);
  });

  it('decideHybrid: safety reject → BRouter fallback', () => {
    const d = decideHybridFromShadow({
      shadow: {
        pathFound: false,
        validated: false,
        failureStage: 'validator_reject',
        rejectReason: 'near_geodesic_chord',
        pathLengthKm: 0,
      },
      attemptMs: 5,
      ingestMs: 1,
      maskResolveMs: 1,
      centerlineSource: 'overpass',
      maskSource: null,
    });
    expect(d.accept).toBe(false);
    expect(d.diag.waterGraphResult).toBe('safety_reject');
    expect(d.diag.waterGraphSafetyResult).toBe('rejected');
    expect(d.diag.fallbackReason).toMatch(/watergraph_safety_reject/);
  });

  it('empty centerlines shadow cannot invent Volga↔Akhtuba path', () => {
    const a = { lon: 45.9, lat: 47.75 };
    const b = { lon: 46.95, lat: 47.0 };
    const shadow = runWaterGraphShadow({
      a,
      b,
      legacyLengthKm: 0,
      legacyOk: false,
      centerlines: [],
    });
    expect(shadow.pathFound).toBe(false);
    const d = decideHybridFromShadow({
      shadow,
      attemptMs: 1,
      ingestMs: 0,
      maskResolveMs: 0,
      centerlineSource: 'empty',
      maskSource: null,
    });
    expect(d.accept).toBe(false);
    expect(d.diag.fallbackUsed).toBe(true);
  });

  it('flag ON Belomor → WaterGraph selected (validated)', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const path = await measureWaterChain([BELOMOR_A, BELOMOR_B]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.routerMode).toBe('hybrid_pilot');
    expect(tr?.hybridRouter?.waterGraphAttempted).toBe(true);
    expect(tr?.hybridRouter?.selectedRouter).toBe('watergraph');
    expect(tr?.hybridRouter?.fallbackUsed).toBe(false);
    expect(tr?.hybridRouter?.waterGraphSafetyResult).toBe('accepted');
    expect(path.method).not.toBe('route_not_found');
    expect(path.points.length).toBeGreaterThan(10);
    expect(path.lengthKm).toBeGreaterThan(150);
    // Not a geodesic chord.
    const geo = haversineKm(BELOMOR_A, BELOMOR_B);
    expect(path.lengthKm / geo).toBeGreaterThan(1.05);
  }, 180_000);

  it('flag ON N08 → WaterGraph selected via densified mask', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const p = preset('N08');
    const path = await measureWaterChain([p.a, p.b]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.selectedRouter).toBe('watergraph');
    expect(tr?.hybridRouter?.fallbackUsed).toBe(false);
    expect(path.method).not.toBe('route_not_found');
    expect(path.lengthKm).toBeGreaterThan(20);
    expect(path.lengthKm).toBeLessThan(80);
  }, 180_000);

  it('flag ON N06 → WaterGraph miss → BRouter fallback (no artificial bind)', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const p = preset('N06');
    const path = await measureWaterChain([p.a, p.b]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.waterGraphAttempted).toBe(true);
    expect(tr?.hybridRouter?.fallbackUsed).toBe(true);
    expect(tr?.hybridRouter?.selectedRouter).toBe('brouter');
    expect(tr?.hybridRouter?.fallbackReason).toBeTruthy();
    // Legacy still works via BRouter.
    expect(path.method).not.toBe('route_not_found');
    expect(path.points.length).toBeGreaterThan(2);
  }, 240_000);

  it('flag ON VG-mid → no WaterGraph sew; legacy failure preserved if BRouter fails', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const a = { lon: 45.9, lat: 47.75 };
    const b = { lon: 46.95, lat: 47.0 };
    const path = await measureWaterChain([a, b]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.waterGraphAttempted).toBe(true);
    expect(tr?.hybridRouter?.selectedRouter).not.toBe('watergraph');
    // Must not invent a WaterGraph Volga↔Akhtuba path.
    if (tr?.hybridRouter?.selectedRouter === 'none') {
      expect(path.method).toBe('route_not_found');
    } else {
      // BRouter fallback may still fail or produce a non-cross-body path;
      // critical: hybrid did not accept a graph path.
      expect(tr?.hybridRouter?.fallbackUsed).toBe(true);
    }
  }, 240_000);

  it('attemptWaterGraphRoute alone: Belomor ok; far inland fails without creating edges', async () => {
    const ok = await attemptWaterGraphRoute(BELOMOR_A, BELOMOR_B);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.diag.selectedRouter).toBe('watergraph');
      expect(ok.path.lengthKm).toBeGreaterThan(150);
    }

    const inland = await attemptWaterGraphRoute(
      { lon: 40.0, lat: 55.0 },
      { lon: 40.5, lat: 55.2 },
    );
    expect(inland.ok).toBe(false);
    expect(inland.diag.fallbackUsed).toBe(true);
    expect(legacyHybridDiag().routerMode).toBe('legacy');
  }, 180_000);
});
