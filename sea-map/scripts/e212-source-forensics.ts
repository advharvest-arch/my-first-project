/**
 * E2.12 — Source-by-source route forensics.
 * Usage: cd sea-map && npx tsx scripts/e212-source-forensics.ts
 * Options: --quick (BELOMOR + VG-D + VG-mid only)
 */
import { writeFileSync } from 'node:fs';
import {
  formatE212MarkdownTable,
  runE212ForensicsSuite,
  type E212RouteId,
} from '../src/source-by-source-forensics';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('Refuse to run E2.12 with USE_WATER_GRAPH=true');
  }
  const quick = process.argv.includes('--quick');
  const routes: E212RouteId[] | undefined = quick
    ? ['BELOMOR', 'VG-D', 'VG-mid']
    : undefined;

  process.stderr.write(
    `E2.12 forensics starting routes=${(routes ?? ['all']).join(',')}\n`,
  );
  const report = await runE212ForensicsSuite({ routes });
  const table = formatE212MarkdownTable(report);

  process.stdout.write(
    [
      '# E2.12 Source-by-source forensics',
      '',
      table,
      '',
      '## Answers',
      `1. Belomor: ${report.answers.belomorWhyBothOk}`,
      '',
      `2. N06: ${report.answers.n06Missing}`,
      '',
      `3. N08: ${report.answers.n08Missing}`,
      '',
      `4. VG-D chord: ${report.answers.vgDChordAorB}`,
      '',
      `5. VG-mid: ${report.answers.vgMidControl}`,
      '',
      '## Legacy can / Graph cannot',
      ...report.legacyCanGraphCannot.map((x) => `- ${x}`),
      '',
      '## Graph can / Legacy cannot (or independent)',
      ...report.graphCanLegacyCannot.map((x) => `- ${x}`),
      '',
      '## UNKNOWN',
      ...(report.unknowns.length
        ? report.unknowns.map((x) => `- ${x}`)
        : ['- (none)']),
      '',
      `USE_WATER_GRAPH=${getRouteFeatureFlags().USE_WATER_GRAPH}`,
      '',
    ].join('\n'),
  );

  writeFileSync('/tmp/e212-source-forensics.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e212-source-forensics.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
