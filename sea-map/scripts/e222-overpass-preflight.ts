/**
 * E2.2.2 — Overpass preflight diagnostic (existing signals before fetch).
 * Usage: cd sea-map && npx tsx scripts/e222-overpass-preflight.ts
 * Does not change routing.
 */
import {
  measureWaterChain,
  clearRouteTraces,
  getLastRouteTrace,
  clearWaterwayCellCacheForTests,
} from '../src/waterways';
import { clearProviderCaches } from '../src/provider-cache';
import { USER_TEST_PRESETS } from '../src/user-test-presets';
import type { LngLat } from '../src/geo';
import type { OverpassPreflight } from '../src/overpass-preflight';

type Case = { id: string; a: LngLat; b: LngLat };

function preset(id: string): Case {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing ${id}`);
  return { id, a: p.a, b: p.b };
}

const CASES: Case[] = [
  { id: 'VG-mid', a: { lon: 45.9, lat: 47.75 }, b: { lon: 46.95, lat: 47.0 } },
  preset('N06'),
  preset('N08'),
  {
    id: 'BELOMOR',
    a: { lon: 34.82, lat: 62.86 },
    b: { lon: 34.77, lat: 64.52 },
  },
  preset('L01'),
];

function signals(pf: OverpassPreflight | undefined): string {
  if (!pf) return '—';
  return [
    `span=${pf.endpointDistanceKm}`,
    `near=${pf.nearestKnownWaterDistanceKm ?? '∅'}`,
    `ww=${pf.localWaterwayPresent}`,
    `lake=${pf.localLakePresent}`,
    `shared=${pf.sharedLakePresent}`,
    `cands=${pf.phaseCCandidateCountA}/${pf.phaseCCandidateCountB}`,
    `cacheLines=${pf.cachedCorridorLineCount}`,
    `missCells=${pf.estimatedMissingCellCount}/${pf.estimatedCellCount}`,
    `scope=${pf.estimatedFallbackScope}`,
  ].join('; ');
}

async function runOne(c: Case) {
  clearRouteTraces();
  clearProviderCaches();
  clearWaterwayCellCacheForTests();
  const path = await measureWaterChain([c.a, c.b]);
  const tr = getLastRouteTrace();
  const pf = tr?.overpassPreflight;
  return {
    routeId: c.id,
    snapResult: tr?.phases.C?.rejectReason ?? (tr?.final.ok ? 'n/a_ok' : tr?.final.rejectReason),
    preflight: pf ?? null,
    signals: signals(pf),
    estimatedCells: pf?.estimatedCellCount ?? null,
    missingCells: pf?.estimatedMissingCellCount ?? null,
    overpassTriggered: pf?.triggered ?? false,
    overpassReason: pf?.reason ?? null,
    finalOk: path.method !== 'route_not_found' && path.points.length >= 2,
    finalMethod: path.method,
    rejectReason: tr?.final.rejectReason ?? null,
    e2eMs: tr?.e2e?.totalMs ?? tr?.timing.totalMs ?? null,
  };
}

async function main() {
  const rows = [];
  for (const c of CASES) {
    process.stderr.write(`preflight ${c.id}…\n`);
    rows.push(await runOne(c));
  }

  const table = [
    '| route | snap result | preflight signals | estimated cells | Overpass triggered | final result | E2E |',
    '|---|---|---|---:|---|---|---:|',
    ...rows.map((r) => {
      const final = r.finalOk ? `OK/${r.finalMethod}` : `FAIL/${r.rejectReason}`;
      return `| ${r.routeId} | ${r.snapResult} | ${r.signals} | ${r.missingCells ?? '—'}/${r.estimatedCells ?? '—'} | ${r.overpassTriggered} (${r.overpassReason}) | ${final} | ${r.e2eMs} |`;
    }),
  ].join('\n');

  process.stdout.write(table + '\n\n');
  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
