/**
 * E1.6 — synthetic / unit tests for LONG_SPAN_SEGMENTED_ROUTING design.
 * Does NOT enable segmented routing in production.
 */
import { describe, expect, it } from 'vitest';
import { haversineKm, type LngLat } from '../geo';

/** Design helper: propose corridor chunk endpoints along a geodesic (placeholder). */
export function proposeGeodesicChunks(
  a: LngLat,
  b: LngLat,
  maxChunkKm: number,
): LngLat[] {
  const geo = haversineKm(a, b);
  if (!(maxChunkKm > 0) || geo <= maxChunkKm) return [a, b];
  const n = Math.ceil(geo / maxChunkKm);
  const out: LngLat[] = [a];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push({
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    });
  }
  out.push(b);
  return out;
}

/** Design invariant: consecutive chunk spans must each be ≤ maxChunkKm (+eps). */
export function chunkSpansOk(points: LngLat[], maxChunkKm: number, eps = 1.5): boolean {
  for (let i = 1; i < points.length; i++) {
    if (haversineKm(points[i - 1]!, points[i]!) > maxChunkKm + eps) return false;
  }
  return true;
}

describe('LONG_SPAN_SEGMENTED_ROUTING design (not production)', () => {
  const vg: LngLat = { lon: 44.52, lat: 48.7 };
  const astr: LngLat = { lon: 48.02, lat: 46.36 };

  it('Volgograd→Astrakhan geodesic chunks stay under 120 km', () => {
    const geo = haversineKm(vg, astr);
    expect(geo).toBeGreaterThan(120);
    const chunks = proposeGeodesicChunks(vg, astr, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunkSpansOk(chunks, 100)).toBe(true);
    expect(chunks[0]).toEqual(vg);
    expect(chunks[chunks.length - 1]).toEqual(astr);
  });

  it('short routes are not split', () => {
    const a = { lon: 38.1, lat: 58.4 };
    const b = { lon: 38.6, lat: 58.35 };
    expect(proposeGeodesicChunks(a, b, 100)).toHaveLength(2);
  });
});
