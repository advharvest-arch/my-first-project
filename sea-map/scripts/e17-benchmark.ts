/**
 * E1.7 live benchmarks: baseline vs segmentation vs candidate budget vs parallel.
 * Usage: cd sea-map && npx tsx scripts/e17-benchmark.ts
 */
import { measureWaterChain, clearRouteTraces, getLastRouteTrace, snapClickToWater, warmWaterNear } from '../src/waterways';
import {
  clearProviderCaches,
  getBrouterCacheSessionStats,
  resetBrouterCacheSessionStats,
} from '../src/provider-cache';
import {
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../src/route-feature-flags';
import { USER_TEST_PRESETS } from '../src/user-test-presets';
import { runLongSpanSegmentedRoute } from '../src/long-span-segment';
import { haversineKm, type LngLat } from '../src/geo';
import { routeWithBrouterAdaptive } from '../src/brouter';

type Case = { id: string; a: LngLat; b: LngLat; class: string };

function preset(id: string, cls: string): Case {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return { id, a: p.a, b: p.b, class: cls };
}

const BASELINE: Case[] = [
  preset('L01', 'short'),
  preset('L05', 'short'),
  preset('L07', 'short'),
  preset('R01', 'medium'),
  preset('R03', 'medium'), // N03 stand-in
  {
    id: 'VG-D',
    class: 'long',
    a: { lon: 44.52, lat: 48.7 },
    b: { lon: 48.02, lat: 46.36 },
  },
  {
    id: 'VG-mid',
    class: 'long',
    a: { lon: 44.52, lat: 48.7 },
    b: { lon: 46.1, lat: 47.2 },
  },
  {
    id: 'BELOMOR',
    class: 'long',
    a: { lon: 34.82, lat: 62.86 },
    b: { lon: 34.77, lat: 64.52 },
  },
];

async function runMeasure(c: Case, label: string) {
  clearRouteTraces();
  resetBrouterCacheSessionStats();
  clearProviderCaches();
  try {
    const t0 = performance.now();
    const path = await measureWaterChain([c.a, c.b]);
    const tr = getLastRouteTrace();
    const cache = getBrouterCacheSessionStats();
    return {
      label,
      route: c.id,
      class: c.class,
      total_ms: Math.round(tr?.timing.totalMs ?? performance.now() - t0),
      brouter_ms: tr?.timing.brouterMs ?? 0,
      brouter_calls: tr?.performance?.brouterCalls ?? 0,
      brouter_attempts: tr?.brouterAttempts?.length ?? 0,
      overpass_calls: tr?.performance?.externalCalls.overpass ?? 0,
      candidates: tr?.performance?.candidateCount ?? 0,
      phase_c_trials: tr?.performance?.trialCount ?? 0,
      cache_hit: cache.hit,
      cache_miss: cache.miss,
      cache_deduped: cache.deduped,
      final_method: path.method,
      ok: path.method !== 'route_not_found' && path.points.length >= 2,
      length_km: path.lengthKm,
      geo_km: +haversineKm(c.a, c.b).toFixed(1),
      ratio:
        path.lengthKm > 0
          ? +(path.lengthKm / Math.max(haversineKm(c.a, c.b), 0.001)).toFixed(3)
          : null,
      reject: tr?.final.rejectReason ?? null,
      failure: tr?.failure?.category ?? null,
      longSpan: tr?.longSpan ?? null,
      segments: tr?.segments?.length ?? 0,
    };
  } catch (e) {
    return {
      label,
      route: c.id,
      class: c.class,
      total_ms: -1,
      ok: false,
      reject: String(e),
      failure: 'external_provider_failure',
    };
  }
}

async function belomorSegments() {
  const joints = [
    { lon: 34.82, lat: 62.86 },
    { lon: 34.75, lat: 63.2 },
    { lon: 34.7, lat: 63.5 },
    { lon: 34.8, lat: 63.9 },
    { lon: 34.77, lat: 64.52 },
  ];
  const rows = [];
  for (let i = 1; i < joints.length; i++) {
    const a = joints[i - 1]!;
    const b = joints[i]!;
    const geo = haversineKm(a, b);
    try {
      const br = await routeWithBrouterAdaptive([a, b]);
      const len = br?.lengthKm ?? 0;
      const ok = !!br && len > 0 && !(geo > 25 && len < geo * 0.45);
      rows.push({
        segment: i - 1,
        geo_km: +geo.toFixed(1),
        brouter_km: +len.toFixed(1),
        ok,
        reason: !br ? 'brouter_fail' : ok ? 'ok' : 'bogus_short',
      });
    } catch (e) {
      rows.push({
        segment: i - 1,
        geo_km: +geo.toFixed(1),
        brouter_km: 0,
        ok: false,
        reason: String(e),
      });
    }
  }
  return rows;
}

async function main() {
  const out: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    baseline: [] as unknown[],
    cache_warm: null,
    segmentation: [] as unknown[],
    candidate_budget: [] as unknown[],
    parallel: [] as unknown[],
    belomor_segments: [] as unknown[],
  };

  resetRouteFeatureFlags();
  for (const c of BASELINE) {
    process.stderr.write(`baseline ${c.id}\n`);
    (out.baseline as unknown[]).push(await runMeasure(c, 'baseline'));
  }

  // Cache warm on VG-D
  resetRouteFeatureFlags();
  clearProviderCaches();
  resetBrouterCacheSessionStats();
  const vg = BASELINE.find((c) => c.id === 'VG-D')!;
  await measureWaterChain([vg.a, vg.b]);
  const warm = await runMeasure(vg, 'cache_warm_second');
  // don't clear cache between — re-run without clear
  clearRouteTraces();
  resetBrouterCacheSessionStats();
  const t0 = performance.now();
  await measureWaterChain([vg.a, vg.b]);
  const tr = getLastRouteTrace();
  out.cache_warm = {
    first_ok: true,
    second: {
      total_ms: Math.round(tr?.timing.totalMs ?? performance.now() - t0),
      brouter_calls: tr?.performance?.brouterCalls,
      cacheHits: tr?.performance?.brouterCacheHits,
      cache: getBrouterCacheSessionStats(),
    },
    note: warm,
  };

  // Segmentation vs monolithic on long cases
  for (const id of ['VG-D', 'VG-mid', 'BELOMOR']) {
    const c = BASELINE.find((x) => x.id === id)!;
    resetRouteFeatureFlags();
    (out.segmentation as unknown[]).push(await runMeasure(c, 'monolithic'));
    setRouteFeatureFlagsForTests({ USE_LONG_SPAN_SEGMENTATION: true });
    (out.segmentation as unknown[]).push(await runMeasure(c, 'segmented_flag'));
    // Direct segmented call (independent of measureWaterChain Phase A short-circuit)
    clearProviderCaches();
    resetBrouterCacheSessionStats();
    const t1 = performance.now();
    const direct = await runLongSpanSegmentedRoute(c.a, c.b, snapClickToWater, (lon, lat) =>
      warmWaterNear({ lon, lat }),
    );
    (out.segmentation as unknown[]).push({
      label: 'segmented_direct',
      route: c.id,
      total_ms: Math.round(performance.now() - t1),
      ok: direct.ok,
      length_km: direct.lengthKm,
      segments: direct.segments,
      reject: direct.rejectReason,
      seamFailures: direct.seamFailures,
      failedSegment: direct.failedSegment,
      cache: getBrouterCacheSessionStats(),
    });
  }
  resetRouteFeatureFlags();

  // Candidate budget on L07 / L05 / N06 / N08 / VG-D
  for (const id of ['L07', 'L05', 'N06', 'N08', 'VG-D']) {
    const c =
      BASELINE.find((x) => x.id === id) ??
      (() => {
        const p = USER_TEST_PRESETS.find((x) => x.id === id);
        if (!p) return null;
        return { id, a: p.a, b: p.b, class: 'budget' } as Case;
      })();
    if (!c) continue;
    for (const n of [1, 3, 5, 9]) {
      setRouteFeatureFlagsForTests({ PHASE_C_MAX_PAIRS_OVERRIDE: n });
      (out.candidate_budget as unknown[]).push(await runMeasure(c, `budget_${n}`));
    }
  }
  resetRouteFeatureFlags();

  // Parallel prototype on L07 (often Phase C / lake)
  for (const conc of [false, 2, 3] as const) {
    if (conc === false) {
      setRouteFeatureFlagsForTests({ USE_PARALLEL_CANDIDATES: false });
      (out.parallel as unknown[]).push(await runMeasure(preset('L07', 'short'), 'seq'));
    } else {
      setRouteFeatureFlagsForTests({
        USE_PARALLEL_CANDIDATES: true,
        PARALLEL_CANDIDATE_CONCURRENCY: conc,
        PHASE_C_MAX_PAIRS_OVERRIDE: 9,
      });
      (out.parallel as unknown[]).push(
        await runMeasure(preset('L07', 'short'), `parallel_${conc}`),
      );
    }
  }
  resetRouteFeatureFlags();

  process.stderr.write('belomor segments\n');
  out.belomor_segments = await belomorSegments();

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
