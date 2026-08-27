/**
 * E1.5 — validate sources.json + run Kim bulletin + Kama segment normalization.
 * Usage: npx tsx research/open-russian-data/run-open-data.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dedupeEvents, dedupeFacts, kamaRowsToFacts, assertProvenance } from './normalize.ts';
import { extractFromPdfText } from './pdf-extract.ts';
import { scoreSource } from './source-quality.ts';
import { AI_READY_SIGNALS, eventsToWaterGraphHints, factsToWaterGraphHints } from './water-graph-hints.ts';
import type { OpenDataSource } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const retrievedAt = '2026-08-27T12:00:00Z';

function loadSources(): OpenDataSource[] {
  const raw = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
  return raw.sources as OpenDataSource[];
}

function validateSources(sources: OpenDataSource[]): void {
  for (const s of sources) {
    for (const key of [
      'id',
      'name',
      'organization',
      'url',
      'sourceType',
      'accessType',
      'dateChecked',
      'geographicCoverage',
      'machineReadable',
      'licenseProvenance',
      'usefulForRouting',
      'usefulForAI',
      'reliability',
      'notes',
    ] as const) {
      if (s[key] === undefined || s[key] === null || s[key] === '') {
        throw new Error(`source ${s.id} missing ${key}`);
      }
    }
    if (!Array.isArray(s.dataType)) throw new Error(`source ${s.id} dataType must be array`);
  }
}

function runKimFixture() {
  const text = readFileSync(join(here, 'fixtures/kim-bulletin-2024-05-17.txt'), 'utf8');
  return extractFromPdfText(text, {
    sourceId: 'kim-bulletins',
    sourceUrl:
      'https://kim-online.ru/images/docs/navigatsiya/bulleteni/2024/may/informacionnyy_byulleten_-_17052024.pdf',
    retrievedAt,
    documentDate: '2024-05-17',
  });
}

function runKamaFixture() {
  const rows = JSON.parse(readFileSync(join(here, 'fixtures/kama-segments-sample.json'), 'utf8'));
  return kamaRowsToFacts(rows, {
    sourceId: 'kama-dimensions',
    sourceUrl: 'https://kamvodput.ru/wp-content/uploads/2022/06/Участки-ВВП.xlsx',
    retrievedAt,
    documentDate: '2022-06-01',
    page: 'sheet1',
  });
}

const sources = loadSources();
validateSources(sources);

const publicSources = sources.filter((s) => s.accessType === 'public');
const closed = sources.filter((s) => s.accessType === 'closed' || s.accessType === 'restricted');

const kim = runKimFixture();
const kamaFacts = runKamaFixture();
const facts = dedupeFacts([...kim.facts, ...kamaFacts]);
const events = dedupeEvents(kim.events);
for (const f of facts) assertProvenance(f.provenance);
for (const e of events) assertProvenance(e.provenance);

const qualities = sources.map(scoreSource).sort((a, b) => b.sourceQuality - a.sourceQuality);
const hints = [...factsToWaterGraphHints(facts), ...eventsToWaterGraphHints(events)];

const outDir = join(here, 'normalized');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'water-facts.sample.json'),
  JSON.stringify({ generatedAt: retrievedAt, count: facts.length, facts }, null, 2),
);
writeFileSync(
  join(outDir, 'navigation-events.sample.json'),
  JSON.stringify({ generatedAt: retrievedAt, count: events.length, events }, null, 2),
);
writeFileSync(
  join(outDir, 'source-quality.json'),
  JSON.stringify({ generatedAt: retrievedAt, qualities }, null, 2),
);
writeFileSync(
  join(outDir, 'watergraph-hints.sample.json'),
  JSON.stringify({ generatedAt: retrievedAt, count: hints.length, hints }, null, 2),
);

console.log('=== OPEN RUSSIAN WATER DATA run ===');
console.log(`sources: ${sources.length} (public ${publicSources.length}, closed/restricted ${closed.length})`);
console.log(`facts: ${facts.length}, events: ${events.length}, hints: ${hints.length}`);
console.log('top sourceQuality:', qualities.slice(0, 5).map((q) => `${q.sourceId}=${q.sourceQuality.toFixed(2)}`));
console.log('AI-ready signals:', AI_READY_SIGNALS.length);
console.log('CLOSED ids:', closed.map((s) => s.id).join(', '));
