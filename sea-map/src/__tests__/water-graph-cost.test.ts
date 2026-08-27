/**
 * E2.0 — WaterGraph cost + preference unit tests.
 */
import { describe, expect, it } from 'vitest';
import {
  classPreferenceRank,
  getWaterGraphEdgeCost,
  WG_CLASS_MULTIPLIER,
} from '../water-graph-cost';

describe('WaterGraph edge cost', () => {
  it('fairway < mask < waterway < canal at equal length', () => {
    const L = 10;
    const fairway = getWaterGraphEdgeCost({ lengthKm: L, kind: 'fairway' });
    const mask = getWaterGraphEdgeCost({ lengthKm: L, kind: 'mask' });
    const waterway = getWaterGraphEdgeCost({ lengthKm: L, kind: 'waterway' });
    const canal = getWaterGraphEdgeCost({ lengthKm: L, kind: 'canal' });
    expect(fairway).toBeLessThan(mask);
    expect(mask).toBeLessThan(waterway);
    expect(waterway).toBeLessThan(canal);
    expect(fairway).toBeCloseTo(L * WG_CLASS_MULTIPLIER.fairway);
  });

  it('seam includes portal fee; lock includes lock fee', () => {
    const seam = getWaterGraphEdgeCost({ lengthKm: 1, kind: 'seam' });
    const lock = getWaterGraphEdgeCost({ lengthKm: 1, kind: 'lock' });
    expect(seam).toBeGreaterThan(1 * WG_CLASS_MULTIPLIER.seam);
    expect(lock).toBeGreaterThan(1 * WG_CLASS_MULTIPLIER.lock);
  });

  it('waterway can beat fairway when fairway is a large detour', () => {
    const shortWaterway = getWaterGraphEdgeCost({ lengthKm: 10, kind: 'waterway' });
    const longFairway = getWaterGraphEdgeCost({ lengthKm: 40, kind: 'fairway' });
    expect(shortWaterway).toBeLessThan(longFairway);
  });

  it('preference rank matches soft ordering', () => {
    expect(classPreferenceRank('fairway')).toBeLessThan(classPreferenceRank('mask'));
    expect(classPreferenceRank('mask')).toBeLessThan(classPreferenceRank('waterway'));
  });
});
