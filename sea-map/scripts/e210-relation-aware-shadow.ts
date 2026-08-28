/**
 * E2.10 — Belomor relation-aware WaterGraph shadow script.
 * Usage: cd sea-map && npx tsx scripts/e210-relation-aware-shadow.ts
 *
 * Optionally runs legacy measureWaterChain for compare (--legacy).
 * USE_WATER_GRAPH stays false for production; --shadow-flag enables shadow
 * only for this process after legacy returns (still does not replace legacy result).
 */
import { writeFileSync } from 'node:fs';
import { runBelomorRelationAwareShadow } from '../src/relation-aware-shadow';
import { BELOMOR_A, BELOMOR_B } from '../src/relation-aware-ingest';
import {
  getRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
  resetRouteFeatureFlags,
} from '../src/route-feature-flags';
import { measureWaterChain, getLastRouteTrace } from '../src/waterways';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    // Production default must be false; allow explicit test override only.
  }

  let legacyOk: boolean | null = null;
  let legacyLengthKm: number | null = null;
  let legacyRejectReason: string | null = null;
  let legacyRoutingMs: number | null = null;
  let e2eTotalMs: number | null = null;
  let brouterCalls: number | null = null;

  if (process.argv.includes('--legacy')) {
    const t0 = performance.now();
    // Keep USE_WATER_GRAPH false during legacy so production path is unchanged.
    resetRouteFeatureFlags();
    const path = await measureWaterChain([BELOMOR_A, BELOMOR_B]);
    legacyRoutingMs = Math.round((performance.now() - t0) * 1000) / 1000;
    e2eTotalMs = legacyRoutingMs;
    legacyOk = path.method !== 'route_not_found' && path.points.length >= 2;
    legacyLengthKm = path.lengthKm;
    const tr = getLastRouteTrace();
    legacyRejectReason = tr?.final.rejectReason ?? null;
    brouterCalls = tr?.performance?.brouterCalls ?? null;

    // Optional: run again with shadow flag for RouteTrace relationAwareShadow (diagnostic).
    if (process.argv.includes('--with-shadow-flag')) {
      setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
      try {
        await measureWaterChain([BELOMOR_A, BELOMOR_B]);
        const tr2 = getLastRouteTrace();
        process.stderr.write(
          `shadow flag trace relationAware=${Boolean(tr2?.relationAwareShadow)} pathFound=${tr2?.relationAwareShadow?.pathFound}\n`,
        );
      } finally {
        resetRouteFeatureFlags();
      }
    }
  }

  const report = runBelomorRelationAwareShadow({
    legacyOk,
    legacyLengthKm,
    legacyRejectReason,
    legacyRoutingMs,
    e2eTotalMs,
    brouterCalls,
  });

  process.stdout.write(
    [
      '# E2.10 Belomor relation-aware WaterGraph shadow',
      '',
      report.summary,
      '',
      `relationId: ${report.relationId}`,
      `ways: ${report.relationWayCount} main_stream=${report.mainStreamCount}`,
      `provider: ${report.providerSourceKind} ${report.providerSnapshotPath}`,
      '',
      '## CURRENT',
      `- components=${report.current.componentCount} gaps=${report.current.gapLengthsKm.join(',')}`,
      `- artificialGap=${report.current.artificialFixtureGapPresent} (${report.current.artificialFixtureGapKm})`,
      `- pathFound=${report.current.pathFound} safety=${report.current.graphSafetyAccepted}`,
      '',
      '## RELATION_AWARE',
      `- components=${report.relationAware.componentCount} gaps=${report.relationAware.gapCount}`,
      `- artificialGap=${report.relationAware.artificialFixtureGapPresent}`,
      `- pathFound=${report.relationAware.pathFound} pathKm=${report.relationAware.pathLengthKm}`,
      `- safetyAccepted=${report.relationAware.graphSafetyAccepted} reject=${report.relationAware.graphSafetyRejectReason}`,
      `- buildMs=${report.relationAware.graphBuildMs} searchMs=${report.relationAware.graphSearchMs}`,
      `- seamCount=${report.relationAware.seamCount}`,
      '',
      `recoveredGeometryKm: ${report.recoveredGeometryKm}`,
      `artificialGapEliminated: ${report.artificialGapEliminated}`,
      '',
      '## Legacy compare',
      JSON.stringify(report.legacyCompare, null, 2),
      '',
      '## Answers',
      `1. Safe shadow integration? ${report.answers.safeShadowIntegration}`,
      `2. Belomor DATA_GAP gone? ${report.answers.belomorDataGapGone}`,
      `3. Safety unchanged? ${report.answers.safetyUnchanged}`,
      `4. BRouter potential: ${report.answers.brouterDependencyPotential}`,
      '',
      `USE_WATER_GRAPH default: ${getRouteFeatureFlags().USE_WATER_GRAPH}`,
      '',
    ].join('\n'),
  );

  writeFileSync('/tmp/e210-relation-aware-shadow.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e210-relation-aware-shadow.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
