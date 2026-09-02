/**
 * E1.5 — normalize open Russian navigation texts into WaterFact / NavigationEvent.
 */

import type { NavigationEvent, Provenance, WaterFact } from './types.ts';

export type ExtractedRecord = {
  provenance: Provenance;
  normalizedValue: Record<string, string | number | boolean | null>;
};

const DEPTH_WIDTH_RE =
  /^(.+?)\s+(\d+)\s*\/\s*(\d+)\s+(\d+)\s+(\d+)(?:\s+(.+))?$/;

/** Parse Kim-style "Наименьшие габариты" lines from pdftotext. */
export function parseDimensionLine(
  line: string,
  base: Omit<Provenance, 'originalText'>,
): WaterFact | null {
  const cleaned = line.replace(/\s+/g, ' ').trim();
  const m = cleaned.match(DEPTH_WIDTH_RE);
  if (!m) return null;
  const segment = m[1]!.trim();
  const guaranteedDepthCm = Number(m[2]);
  const guaranteedWidthM = Number(m[3]);
  const actualDepthCm = Number(m[4]);
  const actualWidthM = Number(m[5]);
  const note = m[6]?.trim() || null;

  const kmHits = [...segment.matchAll(/(\d+(?:[.,]\d+)?)\s*км/gi)].map((x) =>
    Number(x[1]!.replace(',', '.')),
  );

  const id = `wf-dim-${hashId(segment + guaranteedDepthCm + actualDepthCm)}`;
  const provenance: Provenance = {
    ...base,
    originalText: line.trim(),
    confidence: 0.72,
  };

  return {
    id,
    basin: 'moscow',
    waterway: inferWaterway(segment),
    segment,
    fromKm: kmHits[0] ?? null,
    toKm: kmHits[1] ?? null,
    restriction: note,
    depthCm: actualDepthCm,
    widthM: actualWidthM,
    heightM: null,
    season: null,
    lock: segment.match(/шлюз/i) ? segment : null,
    barrier: null,
    navigationStatus: 'open',
    guaranteedDepthCm,
    actualDepthCm,
    factKind: 'dimension',
    provenance,
  };
}

export function parseClosureFromBulletin(
  text: string,
  base: Omit<Provenance, 'originalText' | 'confidence'>,
): NavigationEvent[] {
  const events: NavigationEvent[] = [];
  const re =
    /запрещение движения судов на участке ([^.]{10,180}?)\((\d+(?:[.,]\d+)?)\s*км\s*[–-]\s*(\d+(?:[.,]\d+)?)\s*км\)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const locationText = match[1]!.trim();
    const fromKm = Number(match[2]!.replace(',', '.'));
    const toKm = Number(match[3]!.replace(',', '.'));
    const originalText = match[0];
    events.push({
      id: `nev-closure-${hashId(originalText)}`,
      waterway: inferWaterway(locationText),
      locationText,
      eventType: 'closure',
      validFrom: null,
      validTo: null,
      restriction: 'запрещение движения судов',
      fromKm,
      toKm,
      confidence: 0.8,
      provenance: {
        ...base,
        originalText,
        confidence: 0.8,
      },
    });
  }

  const oneWay =
    /на участке от\s+(\d+(?:[.,]\d+)?)\s*км\s+по\s+(\d+(?:[.,]\d+)?)\s*км[^.]{0,80}запрещ/gi;
  while ((match = oneWay.exec(text))) {
    const fromKm = Number(match[1]!.replace(',', '.'));
    const toKm = Number(match[2]!.replace(',', '.'));
    const originalText = match[0];
    events.push({
      id: `nev-restrict-${hashId(originalText)}`,
      waterway: 'volga',
      locationText: `${fromKm}-${toKm} км`,
      eventType: 'restriction',
      validFrom: null,
      validTo: null,
      restriction: 'ограничение движения / запрет обгона-расхождения',
      fromKm,
      toKm,
      confidence: 0.7,
      provenance: {
        ...base,
        originalText,
        confidence: 0.7,
      },
    });
  }

  return events;
}

export type KamaSegmentRow = {
  waterway: string;
  lowerBound: string;
  upperBound: string;
  lengthKm: number;
};

export function kamaRowsToFacts(
  rows: KamaSegmentRow[],
  base: Omit<Provenance, 'originalText' | 'confidence'>,
): WaterFact[] {
  return rows.map((r) => {
    const originalText = `${r.waterway}: ${r.upperBound} → ${r.lowerBound} (${r.lengthKm} км)`;
    return {
      id: `wf-seg-${hashId(originalText)}`,
      basin: 'kama',
      waterway: r.waterway,
      segment: `${r.upperBound} — ${r.lowerBound}`,
      fromKm: null,
      toKm: null,
      restriction: null,
      depthCm: null,
      widthM: null,
      heightM: null,
      season: null,
      lock: null,
      barrier: null,
      navigationStatus: 'unknown',
      guaranteedDepthCm: null,
      actualDepthCm: null,
      factKind: 'segment',
      provenance: {
        ...base,
        originalText,
        confidence: 0.85,
      },
    };
  });
}

export function dedupeFacts(facts: WaterFact[]): WaterFact[] {
  const seen = new Set<string>();
  const out: WaterFact[] = [];
  for (const f of facts) {
    const key = [
      f.basin,
      f.waterway,
      f.segment ?? '',
      f.factKind,
      f.guaranteedDepthCm ?? '',
      f.actualDepthCm ?? '',
      f.fromKm ?? '',
      f.toKm ?? '',
      f.restriction ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

export function dedupeEvents(events: NavigationEvent[]): NavigationEvent[] {
  const seen = new Set<string>();
  const out: NavigationEvent[] = [];
  for (const e of events) {
    const key = [e.eventType, e.waterway, e.fromKm ?? '', e.toKm ?? '', e.restriction ?? ''].join(
      '|',
    );
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

function inferWaterway(text: string): string {
  const t = text.toLowerCase();
  if (t.includes('канал имени москвы') || t.includes('канала имени москвы')) return 'moscow_canal';
  if (t.includes('москв')) return 'moskva';
  if (t.includes('ок')) return 'oka';
  if (t.includes('кам')) return 'kama';
  if (t.includes('дон')) return 'don';
  if (t.includes('рыбин')) return 'rybinsk_reservoir';
  if (t.includes('волг')) return 'volga';
  return 'unknown';
}

function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Validate required provenance fields. */
export function assertProvenance(p: Provenance): void {
  if (!p.sourceId || !p.sourceUrl || !p.retrievedAt || !p.originalText) {
    throw new Error('provenance requires sourceId, sourceUrl, retrievedAt, originalText');
  }
  if (!(p.confidence >= 0 && p.confidence <= 1)) {
    throw new Error('provenance.confidence must be 0..1');
  }
}
