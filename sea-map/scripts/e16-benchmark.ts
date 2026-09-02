/**
 * E1.6 live benchmark harness (optional network).
 * Usage: cd sea-map && npx tsx scripts/e16-benchmark.ts
 * Writes timing rows for PERFORMANCE_REPORT.md — does not change routing.
 */
import { measureWaterChain, clearRouteTraces, getLastRouteTrace } from '../src/waterways';
import { clearProviderCaches } from '../src/provider-cache';
import { USER_TEST_PRESETS } from '../src/user-test-presets';
import type { LngLat } from '../src/geo';

type BenchCase = { id: string; a: LngLat; b: LngLat; class: 'short' | 'medium' | 'long' };

function preset(id: string, cls: BenchCase['class']): BenchCase {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { id, a: p.a, b: p.b, class: cls };
}

const CASES: BenchCase[] = [
  preset('L01', 'short'),
  preset('L05', 'short'),
  preset('L07', 'short'),
  preset('R01', 'medium'),
  // N03 not in USER_TEST panel — use R03 as medium lake control
  preset('R03', 'medium'),
  {
    id: 'VG-D',
    class: 'long',
    a: { lon: 44.52, lat: 48.7 },
    b: { lon: 48.02, lat: 46.36 },
  },
  {
    id: 'KIM-VOLGA',
    class: 'long',
    a: { lon: 37.48, lat: 55.86 },
    b: { lon: 37.9, lat: 56.75 },
  },
  {
    id: 'BELOMOR',
    class: 'long',
    a: { lon: 34.82, lat: 62.86 },
    b: { lon: 34.77, lat: 64.52 },
  },
];

async function runOne(c: BenchCase) {
  clearRouteTraces();
  clearProviderCaches();
  const t0 = performance.now();
  const path = await measureWaterChain([c.a, c.b]);
  const wall = performance.now() - t0;
  const tr = getLastRouteTrace();
  return {
    route: c.id,
    class: c.class,
    total_ms: Math.round(tr?.timing.totalMs ?? wall),
    brouter_ms: tr?.timing.brouterMs ?? 0,
    overpass_ms: tr?.timing.overpassMs ?? 0,
    phaseA_ms: tr?.timing.phaseAMs ?? 0,
    phaseB_ms: tr?.timing.phaseBMs ?? 0,
    phaseC_ms: tr?.timing.phaseCMs ?? 0,
    candidates: tr?.performance?.candidateCount ?? 0,
    trials: tr?.performance?.trialCount ?? 0,
    cache_hit: tr?.performance?.cacheHit ? 'Y' : 'N',
    brouter_calls: tr?.performance?.externalCalls.brouter ?? 0,
    overpass_calls: tr?.performance?.externalCalls.overpass ?? 0,
    final_method: path.method,
    ok: path.method !== 'route_not_found' && path.points.length >= 2,
    reject: tr?.final.rejectReason ?? null,
    failure: tr?.failure?.category ?? null,
  };
}

async function main() {
  const rows = [];
  for (const c of CASES) {
    process.stderr.write(`bench ${c.id}…\n`);
    try {
      rows.push(await runOne(c));
    } catch (e) {
      rows.push({
        route: c.id,
        class: c.class,
        total_ms: -1,
        brouter_ms: 0,
        overpass_ms: 0,
        phaseA_ms: 0,
        phaseB_ms: 0,
        phaseC_ms: 0,
        candidates: 0,
        trials: 0,
        cache_hit: 'N',
        brouter_calls: 0,
        overpass_calls: 0,
        final_method: 'error',
        ok: false,
        reject: String(e),
        failure: 'external_provider_failure',
      });
    }
  }
  console.log(JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));
}

main();
