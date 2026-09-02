/**
 * E1.5 — experimental PDF text → structured records (research only).
 * Does not claim production-grade OCR/table parsing.
 */

import type { ExtractedRecord } from './normalize.ts';
import { parseClosureFromBulletin, parseDimensionLine } from './normalize.ts';
import type { NavigationEvent, WaterFact } from './types.ts';

export type PdfExtractionResult = {
  facts: WaterFact[];
  events: NavigationEvent[];
  records: ExtractedRecord[];
};

export function extractFromPdfText(
  text: string,
  meta: {
    sourceId: string;
    sourceUrl: string;
    retrievedAt: string;
    documentDate?: string | null;
  },
): PdfExtractionResult {
  const facts: WaterFact[] = [];
  const records: ExtractedRecord[] = [];
  const lines = text.split(/\n/);

  let page: number | string | null = null;
  for (const line of lines) {
    const formFeed = line.includes('\f');
    if (formFeed) page = typeof page === 'number' ? page + 1 : 1;
    const dim = parseDimensionLine(line, {
      sourceId: meta.sourceId,
      sourceUrl: meta.sourceUrl,
      retrievedAt: meta.retrievedAt,
      documentDate: meta.documentDate ?? null,
      page,
      confidence: 0.72,
    });
    if (dim) {
      facts.push(dim);
      records.push({
        provenance: dim.provenance,
        normalizedValue: {
          kind: 'dimension',
          segment: dim.segment ?? null,
          guaranteedDepthCm: dim.guaranteedDepthCm ?? null,
          actualDepthCm: dim.actualDepthCm ?? null,
          widthM: dim.widthM ?? null,
        },
      });
    }
  }

  const events = parseClosureFromBulletin(text, {
    sourceId: meta.sourceId,
    sourceUrl: meta.sourceUrl,
    retrievedAt: meta.retrievedAt,
    documentDate: meta.documentDate ?? null,
    page: null,
  });

  for (const e of events) {
    records.push({
      provenance: e.provenance,
      normalizedValue: {
        kind: 'navigation_event',
        eventType: e.eventType,
        fromKm: e.fromKm ?? null,
        toKm: e.toKm ?? null,
        restriction: e.restriction ?? null,
      },
    });
  }

  return { facts, events, records };
}
