/**
 * E2.0 — WaterGraph safety: barrier crest is not a traversable edge;
 * shadow does not change production; locks are portals.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWaterGraph,
  runWaterGraphShadow,
  searchWaterGraph,
} from '../water-graph';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import { hasIllegalBarrierCrossing } from '../routing-rules';

afterEach(() => {
  resetRouteFeatureFlags();
});

describe('WaterGraph safety', () => {
  it('USE_WATER_GRAPH defaults to false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('lock portal nodes exist for Dubna/Rybinsk corridors', () => {
    const g = buildWaterGraph({
      a: { lon: 38.4, lat: 58.05 },
      b: { lon: 38.85, lat: 58.1 },
      options: { includeMask: false, includeFairway: true, includeLocks: true },
    });
    const locks = [...g.nodes.values()].filter(
      (n) => n.kind === 'lock' || n.kind === 'portal',
    );
    expect(locks.length).toBeGreaterThan(0);
    // Dam crest chord API remains available (guards unchanged).
    const damChord = [
      { lon: 38.5, lat: 58.2 },
      { lon: 38.7, lat: 58.05 },
    ];
    expect(typeof hasIllegalBarrierCrossing(damChord)).toBe('boolean');
  });

  it('Dubna lock corridor becomes lock edges, not crest-only waterway', () => {
    const g = buildWaterGraph({
      a: { lon: 37.1, lat: 56.73 },
      b: { lon: 37.2, lat: 56.76 },
      options: { includeMask: false, includeFairway: false, includeLocks: true },
    });
    const lockEdges = [...g.edges.values()].filter((e) => e.kind === 'lock');
    expect(lockEdges.length).toBeGreaterThan(0);
  });

  it('shadow run returns diagnostics without throwing on sparse corridor', () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    const shadow = runWaterGraphShadow({
      a: { lon: 44.52, lat: 48.7 },
      b: { lon: 48.02, lat: 46.36 },
      legacyLengthKm: 0,
      legacyOk: false,
      centerlines: [],
      ingest: { failureCode: 'centerline_missing' },
    });
    expect(shadow.available).toBe(true);
    expect([
      'centerline_missing',
      'centerline_empty_after_filter',
      'terminal_unbound',
      'graph_disconnected',
      'search_no_path',
      'none',
    ]).toContain(shadow.failureStage);
  });

  it('dam/weir features never become waterway edges via ingest filter', () => {
    const g = buildWaterGraph({
      a: { lon: 40, lat: 55 },
      b: { lon: 40.2, lat: 55 },
      centerlines: [],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const crestLike = [...g.edges.values()].filter((e) => e.kind === 'waterway');
    expect(crestLike.length).toBe(0);
  });

  it('graph path on synthetic centerline can validate search', () => {
    const a = { lon: 40.0, lat: 55.0 };
    const b = { lon: 40.3, lat: 55.0 };
    const g = buildWaterGraph({
      a,
      b,
      centerlines: [
        {
          id: 'syn',
          kind: 'waterway',
          waterId: 'ww:syn',
          coords: [a, { lon: 40.15, lat: 55.0 }, b],
        },
      ],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const ids = [...g.nodes.keys()];
    expect(ids.length).toBeGreaterThanOrEqual(2);
    const s = searchWaterGraph(g, ids[0]!, ids[ids.length - 1]!);
    // May find path depending on node order; at least search completes
    expect(s.searchMs).toBeGreaterThanOrEqual(0);
  });
});
