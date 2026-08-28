/**
 * E2.2.1 — VG-mid fallback timeline diagnostic runner.
 * Usage: cd sea-map && npx tsx scripts/e221-vgmid-fallback-diag.ts
 * Diagnostic only — does not change routing.
 */
import { measureWaterChain, clearRouteTraces, getLastRouteTrace, clearWaterwayCellCacheForTests } from '../src/waterways';
import { clearProviderCaches } from '../src/provider-cache';
import { formatFallbackTimelineTable } from '../src/route-fallback-timeline';
import { USER_TEST_PRESETS } from '../src/user-test-presets';
import type { LngLat } from '../src/geo';

type Case = { id: string; a: LngLat; b: LngLat };

const VG_MID: Case = {
  id: 'VG-mid',
  a: { lon: 45.9, lat: 47.75 },
  b: { lon: 46.95, lat: 47.0 },
};

function preset(id: string): Case {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(id);
  return { id, a: p.a, b: p.b };
}

async function runOne(c: Case, cold: boolean) {
  clearRouteTraces();
  if (cold) {
    clearProviderCaches();
    clearWaterwayCellCacheForTests();
  }
  const path = await measureWaterChain([c.a, c.b]);
  const tr = getLastRouteTrace();
  const fb = tr?.fallbackTimeline;
  const summary = fb?.summary;
  return {
    routeId: c.id,
    cold,
    ok: path.method !== 'route_not_found' && path.points.length >= 2,
    method: path.method,
    rejectReason: tr?.final.rejectReason ?? null,
    e2eMs: tr?.e2e?.totalMs ?? tr?.timing.totalMs ?? null,
    summary,
    events: fb?.events ?? [],
    table: fb ? formatFallbackTimelineTable(fb.events) : '',
  };
}

async function main() {
  const rows = [];
  for (let i = 1; i <= 3; i++) {
    process.stderr.write(`VG-mid cold #${i}…\n`);
    rows.push({ run: i, ...(await runOne(VG_MID, true)) });
  }
  process.stderr.write('N08 cold…\n');
  rows.push({ run: 1, ...(await runOne(preset('N08'), true)) });
  process.stderr.write('N06 cold…\n');
  rows.push({ run: 1, ...(await runOne(preset('N06'), true)) });

  process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
