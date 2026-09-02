/**
 * E2.2 PREP live E2E latency baseline (optional network).
 * Usage: cd sea-map && npm run bench:e22
 * Does not change routing. Writes JSON + markdown-friendly table to stdout.
 */
import {
  formatE2EBenchTable,
  runE2EBaselineSuite,
} from '../src/e2e-latency-bench';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  const flags = getRouteFeatureFlags();
  process.stderr.write(
    `E2.2 E2E baseline — USE_WATER_GRAPH=${flags.USE_WATER_GRAPH} (must stay false)\n`,
  );
  const { rows, topSources } = await runE2EBaselineSuite();
  const table = formatE2EBenchTable(rows);
  process.stdout.write(table + '\n\n');
  process.stdout.write(
    JSON.stringify(
      {
        flags: {
          USE_WATER_GRAPH: flags.USE_WATER_GRAPH,
          USE_ROUTE_EARLY_STOP: flags.USE_ROUTE_EARLY_STOP,
          USE_LONG_SPAN_SEGMENTATION: flags.USE_LONG_SPAN_SEGMENTATION,
        },
        topSources,
        rows: rows.map((r) => ({
          routeId: r.routeId,
          coldWarm: r.coldWarm,
          totalE2EMs: r.totalE2EMs,
          legacyRoutingMs: r.legacyRoutingMs,
          brouterMs: r.brouterMs,
          phaseAMs: r.phaseAMs,
          phaseBMs: r.phaseBMs,
          phaseCMs: r.phaseCMs,
          overpassMs: r.overpassMs,
          validationHydroMs: r.validationHydroMs,
          graphShadowMs: r.graphShadowMs,
          graphShadowRan: r.graphShadowRan,
          brouterCalls: r.brouterCalls,
          brouterCacheHits: r.brouterCacheHits,
          brouterCacheMisses: r.brouterCacheMisses,
          brouterDedupedRequests: r.brouterDedupedRequests,
          brouterNetworkCallsApprox: r.brouterNetworkCallsApprox,
          overpassCalls: r.overpassCalls,
          phaseCTrials: r.phaseCTrials,
          ok: r.ok,
          method: r.method,
          rejectReason: r.rejectReason,
          e2e: r.trace?.e2e ?? null,
        })),
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
