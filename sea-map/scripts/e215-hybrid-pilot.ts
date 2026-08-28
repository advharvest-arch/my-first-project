/**
 * E2.15 — Hybrid WaterGraph pilot corridor report.
 * Usage: cd sea-map && npx tsx scripts/e215-hybrid-pilot.ts
 * Runs with USE_WATER_GRAPH=true for the four control corridors, then
 * verifies flag-off identity on N08.
 */
import { writeFileSync } from 'node:fs';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../src/route-feature-flags';
import {
  measureWaterChain,
  clearWaterwayCellCacheForTests,
} from '../src/waterways';
import { clearProviderCaches } from '../src/provider-cache';
import { clearRouteTraces, getLastRouteTrace } from '../src/route-trace';
import { USER_TEST_PRESETS } from '../src/user-test-presets';
import { BELOMOR_A, BELOMOR_B } from '../src/relation-aware-ingest';
import { haversineKm } from '../src/geo';

type Row = {
  route: string;
  selectedRouter: string | null;
  fallbackUsed: boolean | null;
  fallbackReason: string | null;
  waterGraphResult: string | null;
  pathOk: boolean;
  pathKm: number | null;
  geoKm: number;
  ratio: number | null;
  attemptMs: number | null;
  buildMs: number | null;
  searchMs: number | null;
  e2eMs: number | null;
};

async function runOne(
  name: string,
  a: { lon: number; lat: number },
  b: { lon: number; lat: number },
): Promise<Row> {
  clearProviderCaches();
  clearWaterwayCellCacheForTests();
  clearRouteTraces();
  const t0 = performance.now();
  const path = await measureWaterChain([a, b]);
  const e2eMs = performance.now() - t0;
  const tr = getLastRouteTrace();
  const geo = haversineKm(a, b);
  const ok = path.method !== 'route_not_found' && path.points.length >= 2;
  return {
    route: name,
    selectedRouter: tr?.hybridRouter?.selectedRouter ?? null,
    fallbackUsed: tr?.hybridRouter?.fallbackUsed ?? null,
    fallbackReason: tr?.hybridRouter?.fallbackReason ?? null,
    waterGraphResult: tr?.hybridRouter?.waterGraphResult ?? null,
    pathOk: ok,
    pathKm: ok ? path.lengthKm : null,
    geoKm: Math.round(geo * 1000) / 1000,
    ratio: ok ? Math.round((path.lengthKm / geo) * 1000) / 1000 : null,
    attemptMs: tr?.hybridRouter?.timing.attemptMs ?? null,
    buildMs: tr?.hybridRouter?.timing.buildMs ?? null,
    searchMs: tr?.hybridRouter?.timing.searchMs ?? null,
    e2eMs: Math.round(e2eMs),
  };
}

async function main() {
  const n06 = USER_TEST_PRESETS.find((p) => p.id === 'N06')!;
  const n08 = USER_TEST_PRESETS.find((p) => p.id === 'N08')!;
  const vgA = { lon: 45.9, lat: 47.75 };
  const vgB = { lon: 46.95, lat: 47.0 };

  process.stderr.write('E2.15 hybrid pilot — USE_WATER_GRAPH=true\n');
  setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
  expectFlag(true);

  const rows: Row[] = [];
  rows.push(await runOne('BELOMOR', BELOMOR_A, BELOMOR_B));
  rows.push(await runOne('N08', n08.a, n08.b));
  rows.push(await runOne('N06', n06.a, n06.b));
  rows.push(await runOne('VG-mid', vgA, vgB));

  process.stderr.write('E2.15 control — USE_WATER_GRAPH=false (N08)\n');
  resetRouteFeatureFlags();
  expectFlag(false);
  const off = await runOne('N08-flag-off', n08.a, n08.b);

  const header =
    '| route | selected | fallback | wgResult | pathKm | geoKm | ratio | attemptMs | buildMs | searchMs | e2eMs | reason |';
  const sep = '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |';
  const fmt = (r: Row) =>
    `| ${r.route} | ${r.selectedRouter} | ${r.fallbackUsed} | ${r.waterGraphResult} | ${r.pathKm ?? '—'} | ${r.geoKm} | ${r.ratio ?? '—'} | ${r.attemptMs != null ? Math.round(r.attemptMs) : '—'} | ${r.buildMs != null ? Math.round(r.buildMs) : '—'} | ${r.searchMs != null ? Math.round(r.searchMs) : '—'} | ${r.e2eMs} | ${(r.fallbackReason ?? '').replace(/\|/g, '/')} |`;

  const md = [
    '# E2.15 Hybrid WaterGraph pilot',
    '',
    header,
    sep,
    ...rows.map(fmt),
    '',
    '## Flag OFF control',
    '',
    header,
    sep,
    fmt(off),
    '',
    `Default USE_WATER_GRAPH=${getRouteFeatureFlags().USE_WATER_GRAPH}`,
    '',
  ].join('\n');

  process.stdout.write(md);
  writeFileSync(
    '/tmp/e215-hybrid-pilot.json',
    JSON.stringify({ rows, flagOff: off }, null, 2),
  );
  process.stderr.write('wrote /tmp/e215-hybrid-pilot.json\n');
}

function expectFlag(v: boolean) {
  if (getRouteFeatureFlags().USE_WATER_GRAPH !== v) {
    throw new Error(`expected USE_WATER_GRAPH=${v}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
