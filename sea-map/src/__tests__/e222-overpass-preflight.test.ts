/**
 * E2.2.2 — Overpass preflight telemetry unit tests (no network).
 */
import { describe, expect, it } from 'vitest';
import {
  buildOverpassPreflight,
  estimateCellsAlong,
  nearestWaterFromCellMap,
  OVERPASS_PREFLIGHT_MAX_CELLS,
} from '../overpass-preflight';
import { getRouteFeatureFlags } from '../route-feature-flags';

describe('overpass preflight', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('estimates cells along corridor and caps at max', () => {
    const cells = estimateCellsAlong([
      { lon: 44.5, lat: 48.7 },
      { lon: 48.0, lat: 46.3 },
    ]);
    expect(cells.length).toBeGreaterThan(1);
    expect(OVERPASS_PREFLIGHT_MAX_CELLS).toBe(24);
  });

  it('nearestWaterFromCellMap is cache-only', () => {
    const map = new Map([
      [
        '200:275',
        [
          {
            id: 'w1',
            name: 'Тест',
            kind: 'waterway' as const,
            coords: [
              { lon: 40.0, lat: 55.0 },
              { lon: 40.1, lat: 55.0 },
            ],
          },
        ],
      ],
    ]);
    const hit = nearestWaterFromCellMap({ lon: 40.05, lat: 55.001 }, (cx, cy) =>
      map.get(`${cx}:${cy}`),
    );
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('waterway');
    expect(hit!.distKm).toBeLessThan(1);
  });

  it('buildOverpassPreflight marks empty corridor cache signals', () => {
    const pf = buildOverpassPreflight({
      a: { lon: 45.9, lat: 47.75 },
      b: { lon: 46.95, lat: 47.0 },
      triggered: true,
      reason: 'fetchWaterNetwork',
      triggerCondition: 'test',
      estimatedFallbackScope: 'cell_batch',
      sharedLakeName: null,
      phaseCRejectReason: 'snap_empty',
      phaseCCandidateCountA: 0,
      phaseCCandidateCountB: 0,
      brouterHadGeometry: false,
      getLines: () => undefined,
      isCellMissing: () => true,
    });
    expect(pf.triggered).toBe(true);
    expect(pf.localWaterwayPresent).toBe(false);
    expect(pf.localLakePresent).toBe(false);
    expect(pf.nearestKnownWaterDistanceKm).toBeNull();
    expect(pf.existingCoverageSignals).toContain('corridor_cache_empty');
    expect(pf.existingCoverageSignals).toContain('phase_c_candidates_empty');
    expect(pf.existingCoverageSignals).toContain('phase_c:snap_empty');
    expect(pf.estimatedMissingCellCount).toBeGreaterThan(0);
  });

  it('buildOverpassPreflight detects cached waterway presence', () => {
    const line = {
      id: 'w2',
      name: 'Волга',
      kind: 'waterway' as const,
      coords: [
        { lon: 38.1, lat: 58.4 },
        { lon: 38.6, lat: 58.35 },
      ],
    };
    const pf = buildOverpassPreflight({
      a: { lon: 38.1, lat: 58.4 },
      b: { lon: 38.6, lat: 58.35 },
      triggered: false,
      reason: 'accepted_before_overpass',
      triggerCondition: 'test',
      estimatedFallbackScope: 'not_reached',
      sharedLakeName: 'Rybinsk',
      getLines: () => [line],
      isCellMissing: () => false,
    });
    expect(pf.localWaterwayPresent).toBe(true);
    expect(pf.sharedLakePresent).toBe(true);
    expect(pf.cachedCorridorWaterwayCount).toBeGreaterThan(0);
    expect(pf.triggered).toBe(false);
  });
});
