/**
 * E1.5 — source quality scoring (NOT routing cost).
 */

import type { OpenDataSource, SourceQuality } from './types.ts';

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function scoreSource(s: OpenDataSource): SourceQuality {
  const authority =
    s.reliability === 'official' ? 1 : s.reliability === 'secondary' ? 0.55 : 0.25;

  let freshness = 0.4;
  if (s.updateFrequency?.match(/ежесут|daily|ежеднев/i)) freshness = 1;
  else if (s.updateFrequency?.match(/навигац|season|год|annual|еженед/i)) freshness = 0.75;
  else if (s.updateFrequency?.match(/статич|редко|one-off|разово/i)) freshness = 0.35;

  let geographicPrecision = 0.4;
  if (s.dataType.includes('guaranteed_dimensions') || s.dataType.includes('actual_dimensions')) {
    geographicPrecision = 0.7;
  }
  if (s.notes.match(/км|kilometr|координат|WGS/i)) geographicPrecision = Math.max(geographicPrecision, 0.75);
  if (s.dataType.includes('enc_coverage_meta') || s.dataType.includes('enc_classifier')) {
    geographicPrecision = Math.max(geographicPrecision, 0.55);
  }

  const machineReadability =
    s.machineReadable === 'yes' ? 1 : s.machineReadable === 'partial' ? 0.55 : 0.2;

  let provenanceScore = 0.5;
  if (s.accessType === 'public' && s.reliability === 'official') provenanceScore = 0.95;
  if (s.accessType === 'closed' || s.accessType === 'paid') provenanceScore = 0.1;
  if (s.accessType === 'restricted') provenanceScore = 0.35;

  const parts = [authority, freshness, geographicPrecision, machineReadability, provenanceScore];
  const sourceQuality = clamp01(parts.reduce((a, b) => a + b, 0) / parts.length);

  return {
    sourceId: s.id,
    authority: clamp01(authority),
    freshness: clamp01(freshness),
    geographicPrecision: clamp01(geographicPrecision),
    machineReadability: clamp01(machineReadability),
    provenanceScore: clamp01(provenanceScore),
    sourceQuality,
  };
}
