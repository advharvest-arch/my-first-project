/**
 * E2.13 — WaterGraph lake-mask shadow experiment.
 * Usage: cd sea-map && npx tsx scripts/e213-mask-shadow.ts
 * Options: --quick (N08 + VG-mid + Belomor only)
 */
import { writeFileSync } from 'node:fs';
import {
  formatE213MarkdownTable,
  runE213MaskShadowSuite,
  type E213RouteId,
} from '../src/water-graph-mask-shadow';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('Refuse to run E2.13 with USE_WATER_GRAPH=true');
  }
  const quick = process.argv.includes('--quick');
  const routes: E213RouteId[] | undefined = quick
    ? ['N08', 'BELOMOR', 'VG-mid']
    : undefined;

  process.stderr.write(
    `E2.13 mask shadow starting routes=${(routes ?? ['all']).join(',')}\n`,
  );
  const report = await runE213MaskShadowSuite({ routes });
  const table = formatE213MarkdownTable(report);

  process.stdout.write(
    [
      '# E2.13 WaterGraph lake-mask shadow',
      '',
      table,
      '',
      '## Answers',
      `A. ${report.answers.A_maskHelped}`,
      '',
      `B. ${report.answers.B_componentPathDelta}`,
      '',
      `C. ${report.answers.C_n06n08WithoutBrouter}`,
      '',
      `D. ${report.answers.D_remainingGap}`,
      '',
      `E. ${report.answers.E_safetyRegression}`,
      '',
      `F. ${report.answers.F_nextStep}`,
      '',
      `USE_WATER_GRAPH=${getRouteFeatureFlags().USE_WATER_GRAPH}`,
      '',
    ].join('\n'),
  );

  writeFileSync('/tmp/e213-mask-shadow.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e213-mask-shadow.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
