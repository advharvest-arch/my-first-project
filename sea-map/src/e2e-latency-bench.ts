/**
 * E2.2 PREP — Dev/test E2E latency benchmark helper.
 * Does NOT change production routing. Optional network (BRouter/Overpass).
 */

import type { LngLat } from './geo';
import {
  clearRouteTraces,
  getLastRouteTrace,
  type RouteTrace,
} from './route-trace';
import {
  beginRouteE2E,
  finalizeUiRouteE2E,
  rankLatencySources,
  summarizeRouteLatency,
  type RouteLatencySummary,
} from './route-e2e-latency';
import { clearProviderCaches } from './provider-cache';
import { measureWaterChain } from './waterways';
import { USER_TEST_PRESETS } from './user-test-presets';

export type E2EBenchCase = {
  id: string;
  a: LngLat;
  b: LngLat;
  note?: string;
};

export type E2EBenchRow = {
  routeId: string;
  coldWarm: 'cold' | 'warm';
  totalE2EMs: number;
  legacyRoutingMs: number;
  brouterMs: number;
  phaseAMs: number;
  phaseBMs: number;
  phaseCMs: number;
  overpassMs: number;
  validationHydroMs: number;
  graphShadowMs: number;
  graphShadowRan: boolean;
  brouterCalls: number;
  brouterCacheHits: number;
  brouterCacheMisses: number;
  brouterDedupedRequests: number;
  brouterNetworkCallsApprox: number;
  overpassCalls: number;
  overpassCacheHits: number;
  overpassCacheMisses: number;
  phaseCTrials: number;
  ok: boolean;
  method: string;
  rejectReason: string | null;
  summary: RouteLatencySummary;
  trace: RouteTrace | null;
};

function presetOrThrow(id: string): E2EBenchCase {
  const p = USER_TEST_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`missing preset ${id}`);
  return { id, a: p.a, b: p.b };
}

/** Canonical E2.2 baseline corridor set. */
export function getE2EBaselineCases(): E2EBenchCase[] {
  return [
    {
      id: 'VG-D',
      a: { lon: 44.52, lat: 48.7 },
      b: { lon: 48.02, lat: 46.36 },
      note: 'Lower Volga Volgograd→Astrakhan',
    },
    {
      id: 'VG-mid',
      a: { lon: 45.9, lat: 47.75 },
      b: { lon: 46.95, lat: 47.0 },
      note: 'Lower Volga mid',
    },
    {
      id: 'BELOMOR',
      a: { lon: 34.82, lat: 62.86 },
      b: { lon: 34.77, lat: 64.52 },
      note: 'Belomor canal corridor',
    },
    presetOrThrow('N06'),
    presetOrThrow('N08'),
    presetOrThrow('N11'),
    presetOrThrow('X3'),
    presetOrThrow('L01'), // short successful control
  ];
}

export async function runE2EBenchCase(
  c: E2EBenchCase,
  opts: { warm?: boolean; clearCaches?: boolean } = {},
): Promise<E2EBenchRow> {
  const warm = Boolean(opts.warm);
  if (opts.clearCaches ?? !warm) {
    clearProviderCaches();
  }
  clearRouteTraces();
  beginRouteE2E('bench');
  const path = await measureWaterChain([c.a, c.b]);
  let trace = getLastRouteTrace();
  const sealed = finalizeUiRouteE2E(trace);
  if (sealed) trace = sealed;
  const summary = summarizeRouteLatency(
    trace ??
      ({
        requestId: 'missing',
        timing: {
          startedAtMs: 0,
          endedAtMs: 0,
          durationMs: 0,
          totalMs: 0,
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
        performance: {
          cacheHit: false,
          brouterCalls: 0,
          brouterCacheHits: 0,
          brouterCacheMisses: 0,
          dedupedRequests: 0,
          candidateTrials: 0,
          externalCalls: { brouter: 0, overpass: 0, openLake: 0 },
          cacheHits: { brouter: 0, overpass: 0 },
          candidateCount: 0,
          trialCount: 0,
          pairCount: 0,
          earlyStopTriggered: false,
        },
        final: {
          ok: false,
          method: path.method,
          lengthKm: 0,
          rejectReason: 'no_trace',
          waterName: null,
        },
        graph: { hybridAvailable: false, legacyOverpassUsed: false, note: '' },
      } as RouteTrace),
  );

  return {
    routeId: c.id,
    coldWarm: warm ? 'warm' : 'cold',
    totalE2EMs: summary.totalE2EMs,
    legacyRoutingMs: summary.legacyRoutingMs,
    brouterMs: summary.brouterMs,
    phaseAMs: summary.phaseAMs,
    phaseBMs: summary.phaseBMs,
    phaseCMs: summary.phaseCMs,
    overpassMs: summary.overpassMs,
    validationHydroMs: summary.validationHydroMs,
    graphShadowMs: summary.graphShadowMs,
    graphShadowRan: summary.graphShadowRan,
    brouterCalls: summary.brouterCalls,
    brouterCacheHits: summary.brouterCacheHits,
    brouterCacheMisses: summary.brouterCacheMisses,
    brouterDedupedRequests: summary.brouterDedupedRequests,
    brouterNetworkCallsApprox: summary.brouterNetworkCallsApprox,
    overpassCalls: summary.overpassCalls,
    overpassCacheHits: summary.overpassCacheHits,
    overpassCacheMisses: summary.overpassCacheMisses,
    phaseCTrials: summary.phaseCTrials,
    ok: path.method !== 'route_not_found' && path.points.length >= 2,
    method: path.method,
    rejectReason: summary.rejectReason,
    summary,
    trace: sealed ?? getLastRouteTrace(),
  };
}

export async function runE2EBaselineSuite(): Promise<{
  rows: E2EBenchRow[];
  topSources: Array<{ name: string; ms: number }>;
}> {
  const cases = getE2EBaselineCases();
  const rows: E2EBenchRow[] = [];

  for (const c of cases) {
    rows.push(await runE2EBenchCase(c, { warm: false, clearCaches: true }));
  }

  // Warm-cache repeat of the short control (L01).
  const short = cases.find((c) => c.id === 'L01')!;
  // Cold already ran with clear; warm without clear.
  rows.push(await runE2EBenchCase(short, { warm: true, clearCaches: false }));

  const totals = new Map<string, number>();
  for (const r of rows.filter((x) => x.coldWarm === 'cold')) {
    for (const s of rankLatencySources(r.summary, { includeGraphShadow: false })) {
      totals.set(s.name, (totals.get(s.name) ?? 0) + s.ms);
    }
  }
  const topSources = [...totals.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5);

  return { rows, topSources };
}

export function formatE2EBenchTable(rows: E2EBenchRow[]): string {
  const header =
    '| route | temp | E2E | legacy | br | A | B | C | op | val/hy | shadow | brCalls | hit/miss/dedup | net≈ | ok | reject |';
  const sep =
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|---|';
  const lines = rows.map((r) => {
    const hm = `${r.brouterCacheHits}/${r.brouterCacheMisses}/${r.brouterDedupedRequests}`;
    return `| ${r.routeId} | ${r.coldWarm} | ${r.totalE2EMs} | ${r.legacyRoutingMs} | ${r.brouterMs} | ${r.phaseAMs} | ${r.phaseBMs} | ${r.phaseCMs} | ${r.overpassMs} | ${r.validationHydroMs} | ${r.graphShadowMs} | ${r.brouterCalls} | ${hm} | ${r.brouterNetworkCallsApprox} | ${r.ok ? 'Y' : 'N'} | ${r.rejectReason ?? '—'} |`;
  });
  return [header, sep, ...lines].join('\n');
}
