/**
 * E9 — PostGIS WaterGraph → AquaRoute integration pilot.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { attemptWaterGraphRoute } from '../watergraph-hybrid-router';
import { BELOMOR_A, BELOMOR_B } from '../relation-aware-ingest';
import { haversineKm } from '../geo';
import {
  getPostgisWgSnapshot,
  postgisWgForbiddenEdgeCount,
  postgisWgNavigableEdgeCount,
  postgisWgVbGapBlocked,
  postgisWgVolgaAkhtubaDisconnected,
  routePostgisWaterGraph,
  POSTGIS_WG_PROVIDER,
} from '../postgis-watergraph-provider';
import * as postgisProvider from '../postgis-watergraph-provider';

afterEach(() => {
  resetRouteFeatureFlags();
  clearRouteTraces();
  vi.restoreAllMocks();
});

describe('E9 PostGIS WaterGraph integration pilot', () => {
  it('USE_WATER_GRAPH production default remains false', () => {
    resetRouteFeatureFlags();
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('snapshot is NAVIGABLE-only (UNKNOWN forbidden in corridor export)', () => {
    expect(postgisWgNavigableEdgeCount()).toBe(29);
    expect(postgisWgForbiddenEdgeCount()).toBe(0);
    const snap = getPostgisWgSnapshot();
    expect(snap.edges.every((e) => e.nav_status === 'NAVIGABLE')).toBe(true);
  });

  it('PostGIS provider routes Belomor on NAVIGABLE edges only', () => {
    const r = routePostgisWaterGraph(BELOMOR_A, BELOMOR_B);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe(POSTGIS_WG_PROVIDER);
    expect(r.edgeIds.length).toBe(29);
    expect(r.navStatusesUsed).toEqual(['NAVIGABLE']);
    expect(r.lengthKm).toBeGreaterThan(200);
    expect(r.lengthKm).toBeLessThan(240);
    const geo = haversineKm(BELOMOR_A, BELOMOR_B);
    expect(r.lengthKm / geo).toBeGreaterThan(1.05);
  });

  it('UNKNOWN edges are never used (injecting UNKNOWN removes routability)', () => {
    const snap = structuredClone(getPostgisWgSnapshot());
    // Flip one edge to UNKNOWN — provider must refuse the corridor export
    // or, if we only flip after filtering, path must not include it.
    const victim = snap.edges[10]!;
    victim.nav_status = 'UNKNOWN';
    const r = routePostgisWaterGraph(BELOMOR_A, BELOMOR_B, { snapshot: snap });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/unknown|blocked|non-NAVIGABLE|no_navigable|no_path/i);
    }
  });

  it('VB gap is not crossed', () => {
    const g = postgisWgVbGapBlocked();
    expect(g.sharedNodes).toBe(false);
    expect(g.navigablePath).toBe(false);
    expect(g.pass).toBe(true);
  });

  it('Volga/Akhtuba are not connected via NAVIGABLE samples', () => {
    const v = postgisWgVolgaAkhtubaDisconnected();
    expect(v.sharedNavigableNodes).toBe(0);
    expect(v.pass).toBe(true);
  });

  it('flag=false → legacy behavior (no hybrid / PostGIS attempt)', async () => {
    resetRouteFeatureFlags();
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const path = await measureWaterChain([BELOMOR_A, BELOMOR_B]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.routerMode).toBe('legacy');
    expect(tr?.hybridRouter?.waterGraphAttempted).toBe(false);
    expect(tr?.hybridRouter?.selectedRouter).toBe('legacy');
    // Legacy may still build via BRouter/Overpass — just not via hybrid WG.
    expect(path.method === 'route_not_found' || path.points.length >= 2).toBe(
      true,
    );
  }, 240_000);

  it('flag=true Belomor → PostGIS WaterGraph route via AquaRoute flow', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    const path = await measureWaterChain([BELOMOR_A, BELOMOR_B]);
    const tr = getLastRouteTrace();
    expect(tr?.hybridRouter?.routerMode).toBe('hybrid_pilot');
    expect(tr?.hybridRouter?.waterGraphAttempted).toBe(true);
    expect(tr?.hybridRouter?.selectedRouter).toBe('watergraph');
    expect(tr?.hybridRouter?.fallbackUsed).toBe(false);
    expect(tr?.hybridRouter?.centerlineSource).toBe(POSTGIS_WG_PROVIDER);
    expect(path.method).not.toBe('route_not_found');
    expect(path.lengthKm).toBeGreaterThan(200);
    expect(path.points.length).toBeGreaterThan(20);
  }, 120_000);

  it('WG failure → BRouter fallback (PostGIS forced miss)', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
    vi.spyOn(postgisProvider, 'routePostgisWaterGraph').mockReturnValue({
      ok: false,
      provider: POSTGIS_WG_PROVIDER,
      reason: 'no_path',
      note: 'forced miss for E9 fallback test',
    });
    // Inland points: other WG candidates also fail → BRouter/legacy phases.
    const inlandA = { lon: 40.0, lat: 55.0 };
    const inlandB = { lon: 40.5, lat: 55.2 };
    const attempt = await attemptWaterGraphRoute(inlandA, inlandB);
    expect(attempt.ok).toBe(false);
    expect(attempt.diag.fallbackUsed).toBe(true);
    expect(attempt.diag.selectedRouter).toBe('brouter');
  }, 120_000);

  it('attemptWaterGraphRoute Belomor uses postgis provider', async () => {
    const ok = await attemptWaterGraphRoute(BELOMOR_A, BELOMOR_B);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.diag.centerlineSource).toBe(POSTGIS_WG_PROVIDER);
      expect(ok.diag.selectedRouter).toBe('watergraph');
      expect(ok.path.lengthKm).toBeGreaterThan(200);
    }
  });
});
