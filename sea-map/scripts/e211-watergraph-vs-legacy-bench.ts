/**
 * E2.11 — WaterGraph shadow vs legacy real-corridor benchmark.
 * Usage: cd sea-map && npx tsx scripts/e211-watergraph-vs-legacy-bench.ts
 *
 * Options:
 *   --quick     Belomor + VG-mid only, cold mode (fast CI smoke)
 *   --offline   Belomor + VG-D + VG-mid fixtures only (no Overpass corridors)
 *
 * USE_WATER_GRAPH stays false. Production routing unchanged.
 */
import { writeFileSync } from 'node:fs';
import {
  formatE211MarkdownTable,
  runE211BenchmarkSuite,
  type E211CorridorId,
  type E211CacheMode,
} from '../src/watergraph-vs-legacy-bench';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('Refuse to run E2.11 with USE_WATER_GRAPH=true');
  }

  const quick = process.argv.includes('--quick');
  const offline = process.argv.includes('--offline');

  let corridors: E211CorridorId[] | undefined;
  let modes: E211CacheMode[] | undefined;

  if (quick) {
    corridors = ['BELOMOR', 'VG-mid'];
    modes = ['cold'];
  } else if (offline) {
    corridors = ['BELOMOR', 'VG-D', 'VG-mid'];
    modes = ['cold', 'warm', 'cold_cleared'];
  }

  process.stderr.write(
    `E2.11 starting corridors=${(corridors ?? ['all']).join(',')} modes=${(modes ?? ['cold', 'warm', 'cold_cleared']).join(',')}\n`,
  );

  const report = await runE211BenchmarkSuite({ corridors, modes });
  const table = formatE211MarkdownTable(report);

  process.stdout.write(
    [
      '# E2.11 WaterGraph vs legacy benchmark',
      '',
      report.answers.potentialLatencyGainNote,
      '',
      table,
      '',
      '## Divergence',
      ...(report.divergenceCases.length
        ? report.divergenceCases.map((x) => `- ${x}`)
        : ['- (none)']),
      '',
      '## Safety failures',
      ...(report.safetyFailures.length
        ? report.safetyFailures.map((x) => `- ${x}`)
        : ['- (none)']),
      '',
      '## Data gaps',
      ...(report.dataGaps.length
        ? report.dataGaps.map((x) => `- ${x}`)
        : ['- (none)']),
      '',
      '## Latency notes',
      ...report.latencyNotes.map((x) => `- ${x}`),
      '',
      `USE_WATER_GRAPH=${getRouteFeatureFlags().USE_WATER_GRAPH}`,
      '',
    ].join('\n'),
  );

  writeFileSync(
    '/tmp/e211-watergraph-vs-legacy.json',
    JSON.stringify(report, null, 2),
  );
  process.stderr.write('wrote /tmp/e211-watergraph-vs-legacy.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
