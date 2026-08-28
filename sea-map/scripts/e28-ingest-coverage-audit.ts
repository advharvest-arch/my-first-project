/**
 * E2.8 — Ingest coverage audit script.
 * Usage: cd sea-map && npx tsx scripts/e28-ingest-coverage-audit.ts
 */
import { writeFileSync } from 'node:fs';
import {
  formatE28Markdown,
  runE28IngestCoverageAudit,
} from '../src/ingest-coverage-audit';
import { getRouteFeatureFlags } from '../src/route-feature-flags';

async function main() {
  if (getRouteFeatureFlags().USE_WATER_GRAPH) {
    throw new Error('USE_WATER_GRAPH must stay false');
  }
  const report = runE28IngestCoverageAudit();
  process.stdout.write(formatE28Markdown(report));
  writeFileSync('/tmp/e28-ingest-coverage-audit.json', JSON.stringify(report, null, 2));
  process.stderr.write('wrote /tmp/e28-ingest-coverage-audit.json\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
