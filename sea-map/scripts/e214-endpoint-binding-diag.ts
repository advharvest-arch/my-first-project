/**
 * E2.14 — N06 endpoint binding diagnostic.
 * Usage: cd sea-map && npx tsx scripts/e214-endpoint-binding-diag.ts
 * Options: --quick (N06 B focus + N08 + VG-mid; skips Belomor)
 */
import { writeFileSync } from 'node:fs';
import {
  formatE214MarkdownTable,
  runE214Suite,
  type E214RouteId,
} from '../src/endpoint-binding-diag';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('Refuse to run E2.14 with USE_WATER_GRAPH=true');
  }
  const quick = process.argv.includes('--quick');
  const routes: E214RouteId[] | undefined = quick
    ? ['N06', 'N08', 'VG-mid']
    : undefined;

  process.stderr.write(
    `E2.14 endpoint binding starting routes=${(routes ?? ['all']).join(',')}\n`,
  );
  const report = await runE214Suite({ routes });
  const table = formatE214MarkdownTable(report);

  process.stdout.write(
    [
      '# E2.14 N06 endpoint binding diagnostic',
      '',
      table,
      '',
      '## Answers',
      '',
      `1. Why is N06 B ~24 km from mask?\n${report.answers.whyBFarFromMask}`,
      '',
      `2. Real water data between B and mask?\n${report.answers.realDataBetweenBandMask}`,
      '',
      `3. What allows BRouter to build N06?\n${report.answers.whatBrouterUses}`,
      '',
      `4. Can we safely bind B to the existing network?\n${report.answers.canSafelyBindB}`,
      '',
      `5. If not — what data is needed?\n${report.answers.dataNeededIfNot}`,
      '',
      `6. Can the same mechanism sew VG-mid?\n${report.answers.vgMidFalsePositiveRisk}`,
      '',
      `USE_WATER_GRAPH=${getRouteFeatureFlags().USE_WATER_GRAPH}`,
      'wouldCreateGraphEdge=false (always)',
      '',
    ].join('\n'),
  );

  writeFileSync(
    '/tmp/e214-endpoint-binding.json',
    JSON.stringify(report, null, 2),
  );
  process.stderr.write('wrote /tmp/e214-endpoint-binding.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
