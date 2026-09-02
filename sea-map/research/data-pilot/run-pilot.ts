/**
 * CLI proof: synthetic ENC JSON → WaterGraph layers.
 * Usage (from sea-map/): npx tsx research/data-pilot/run-pilot.ts
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  coverageReport,
  draftAiLearningSignal,
  parseS57Collection,
  proofSummary,
  toWaterGraph,
} from './index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, 'fixtures', 'synthetic-volga-pilot.json');
const raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
const collection = parseS57Collection(raw);
const coverage = coverageReport(collection);
const graph = toWaterGraph(collection);
const signal = draftAiLearningSignal(
  graph,
  [
    { lon: 38.9, lat: 58.0 },
    { lon: 40.5, lat: 57.2 },
    { lon: 43.9, lat: 56.33 },
  ],
  0.4,
  null,
);

console.log('=== DATA_PILOT technical proof (synthetic) ===');
console.log(proofSummary(graph));
console.log('coverage', coverage);
console.log('AI signal draft', signal.learningHint, {
  distanceKm: signal.distanceFromOfficialFairwayKm,
  hazard: signal.nearestOfficialHazardId,
  lockOrDam: signal.nearestLockOrDamId,
});
console.log(
  coverage.missingRequired.length === 0
    ? 'PROOF_OK: required S-57 classes mapped to WaterGraph'
    : `PROOF_GAP: missing ${coverage.missingRequired.join(',')}`,
);
