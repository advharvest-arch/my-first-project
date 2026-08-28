/**
 * E2.7 — Relation-aware Belomor ingest diagnostic script.
 * Usage: cd sea-map && npx tsx scripts/e27-relation-aware-ingest.ts
 *
 * Diagnostic only. Does not enable production ingest or change USE_WATER_GRAPH.
 */
import { writeFileSync } from 'node:fs';
import {
  formatE27Markdown,
  runE27RelationAwareIngestPrototype,
} from '../src/relation-aware-ingest';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must stay false');
  }

  const report = runE27RelationAwareIngestPrototype();
  process.stdout.write(formatE27Markdown(report));
  process.stdout.write('\n## Answers\n');
  process.stdout.write(
    `1. Eliminates artificial Belomor DATA_GAP without seam? **${report.answers.eliminatesArtificialBelomorDataGapWithoutSeam}**\n`,
  );
  process.stdout.write(
    `2. Safe future production ingest candidate? **${report.answers.safeFutureProductionIngestCandidate}**\n`,
  );
  process.stdout.write(`\n${report.answers.safeCandidateRationale}\n`);

  writeFileSync('/tmp/e27-relation-aware-ingest.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e27-relation-aware-ingest.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
