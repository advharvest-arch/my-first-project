/**
 * E1.5 research tests — run with:
 *   npx vitest run research/open-russian-data/tests
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertProvenance,
  dedupeFacts,
  kamaRowsToFacts,
  parseClosureFromBulletin,
  parseDimensionLine,
} from '../normalize.ts';
import { extractFromPdfText } from '../pdf-extract.ts';
import { scoreSource } from '../source-quality.ts';
import { AI_READY_SIGNALS, factsToWaterGraphHints } from '../water-graph-hints.ts';
import type { OpenDataSource } from '../types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

describe('open-russian-data sources schema', () => {
  it('requires provenance fields on every source', () => {
    const raw = JSON.parse(readFileSync(join(root, 'sources.json'), 'utf8'));
    const sources = raw.sources as OpenDataSource[];
    expect(sources.length).toBeGreaterThan(8);
    for (const s of sources) {
      expect(s.id).toBeTruthy();
      expect(s.url).toBeTruthy();
      expect(s.dateChecked).toBeTruthy();
      expect(s.licenseProvenance).toBeTruthy();
      expect(['public', 'restricted', 'paid', 'unknown', 'closed']).toContain(s.accessType);
    }
    const closed = sources.filter((s) => s.accessType === 'closed');
    expect(closed.some((s) => s.id.includes('enc'))).toBe(true);
  });

  it('scores source quality without treating it as routing cost', () => {
    const s: OpenDataSource = {
      id: 't',
      name: 't',
      organization: 'o',
      url: 'https://example.test',
      sourceType: 'bulletin_pdf',
      accessType: 'public',
      dateChecked: '2026-08-27',
      updateFrequency: 'ежесуточно',
      geographicCoverage: 'test km segments',
      dataType: ['actual_dimensions'],
      machineReadable: 'partial',
      licenseProvenance: 'official public PDF',
      usefulForRouting: 'high',
      usefulForAI: 'high',
      reliability: 'official',
      notes: 'km markers present',
    };
    const q = scoreSource(s);
    expect(q.sourceQuality).toBeGreaterThan(0.5);
    expect(q.authority).toBe(1);
  });
});

describe('normalization + PDF fixture', () => {
  it('parses dimension lines and requires provenance', () => {
    const line =
      'г. Тверь - Иваньковский г/у                            400 / 100         400            100         277.2 км';
    const fact = parseDimensionLine(line, {
      sourceId: 'kim-bulletins',
      sourceUrl: 'https://example.test/b.pdf',
      retrievedAt: '2026-08-27T00:00:00Z',
      documentDate: '2024-05-17',
      page: 1,
      confidence: 0.72,
    });
    expect(fact).not.toBeNull();
    assertProvenance(fact!.provenance);
    expect(fact!.guaranteedDepthCm).toBe(400);
    expect(fact!.widthM).toBe(100);
  });

  it('extracts NavigationEvent closures from Kim bulletin fixture', () => {
    const text = readFileSync(join(root, 'fixtures/kim-bulletin-2024-05-17.txt'), 'utf8');
    const { facts, events, records } = extractFromPdfText(text, {
      sourceId: 'kim-bulletins',
      sourceUrl:
        'https://kim-online.ru/images/docs/navigatsiya/bulleteni/2024/may/informacionnyy_byulleten_-_17052024.pdf',
      retrievedAt: '2026-08-27T00:00:00Z',
      documentDate: '2024-05-17',
    });
    expect(facts.length).toBeGreaterThan(5);
    expect(events.some((e) => e.eventType === 'closure')).toBe(true);
    expect(records.every((r) => r.provenance.originalText)).toBe(true);
    const closures = parseClosureFromBulletin(text, {
      sourceId: 'kim-bulletins',
      sourceUrl: 'https://example.test',
      retrievedAt: '2026-08-27T00:00:00Z',
      documentDate: '2024-05-17',
      page: null,
    });
    expect(closures[0]!.fromKm).toBe(44);
    expect(closures[0]!.toKm).toBe(41);
  });

  it('builds WaterFact from Kama segments and dedupes', () => {
    const rows = JSON.parse(readFileSync(join(root, 'fixtures/kama-segments-sample.json'), 'utf8'));
    const facts = kamaRowsToFacts(rows, {
      sourceId: 'kama-dimensions',
      sourceUrl: 'https://kamvodput.ru/wp-content/uploads/2022/06/Участки-ВВП.xlsx',
      retrievedAt: '2026-08-27T00:00:00Z',
      documentDate: '2022-06-01',
      page: 'sheet1',
    });
    expect(facts[0]!.factKind).toBe('segment');
    expect(dedupeFacts([...facts, ...facts]).length).toBe(facts.length);
    expect(factsToWaterGraphHints(facts).some((h) => h.kind === 'fairway_prior')).toBe(true);
  });

  it('lists AI-ready signals without implementing ML', () => {
    expect(AI_READY_SIGNALS).toContain('navigation_restriction');
    expect(AI_READY_SIGNALS).toContain('source_confidence');
  });

  it('loads OSM comparison fixture for four basins', () => {
    const cmp = JSON.parse(readFileSync(join(root, 'fixtures/osm-comparison.json'), 'utf8'));
    expect(cmp).toHaveLength(4);
    expect(cmp.every((c: { russianOpen: { hasGeometry: boolean } }) => c.russianOpen.hasGeometry === false)).toBe(
      true,
    );
  });
});
