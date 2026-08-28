/**
 * E2.14 — Endpoint binding diagnostic tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  candidateWhenWaterwayNearButNoMaskChainForTests,
  classifyFarInlandForTests,
  getE214Cases,
  runE214Corridor,
  runE214Suite,
  formatE214MarkdownTable,
} from '../endpoint-binding-diag';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import { getLastRouteTrace } from '../route-trace';
import { USER_TEST_PRESETS } from '../user-test-presets';

afterEach(() => {
  resetRouteFeatureFlags();
});

describe('E2.14 endpoint binding diagnostic', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('defines N06/N08/Belomor/VG-mid cases', () => {
    expect(getE214Cases().map((c) => c.id)).toEqual([
      'N06',
      'N08',
      'BELOMOR',
      'VG-mid',
    ]);
  });

  it('records exact N06 endpoint B coordinates from preset', () => {
    const p = USER_TEST_PRESETS.find((x) => x.id === 'N06')!;
    const c = getE214Cases().find((x) => x.id === 'N06')!;
    expect(c.b).toEqual({ lon: 49.1, lat: 54.35 });
    expect(c.b).toEqual(p.b);
  });

  it('far-from-water case → inland_far_from_water', () => {
    expect(classifyFarInlandForTests()).toBe('inland_far_from_water');
  });

  it('waterway near but no safe chain → waterway_chain_to_mask_unproven', () => {
    expect(candidateWhenWaterwayNearButNoMaskChainForTests()).toBe(
      'waterway_chain_to_mask_unproven',
    );
  });

  it('N06 endpoint B: far from mask; candidate is not a safe long seam', async () => {
    const row = await runE214Corridor('N06');
    const b = row.endpoints.B;
    expect(b.coordinates).toEqual({ lon: 49.1, lat: 54.35 });
    expect(b.diagnosticOnly).toBe(true);
    expect(b.candidate.wouldCreateGraphEdge).toBe(false);
    expect(b.nearestMaskKm).not.toBeNull();
    expect(b.nearestMaskKm!).toBeGreaterThan(15);
    expect([
      'waterway_chain_to_mask_unproven',
      'unsafe_long_gap',
      'none',
    ]).toContain(b.candidate.type);
    expect(b.candidate.type).not.toBe('short_shore_snap_to_mask');
    expect(getLastRouteTrace()?.endpointBindingDiag?.route).toBe('N06');
    expect(
      getLastRouteTrace()?.endpointBindingDiag?.endpoints.B.nearestMaskKm,
    ).toBeGreaterThan(15);
  }, 180_000);

  it('N08 endpoint: mask-side control stays diagnosticOnly / no auto edge', async () => {
    const row = await runE214Corridor('N08');
    for (const ep of ['A', 'B'] as const) {
      const e = row.endpoints[ep];
      expect(e.candidate.wouldCreateGraphEdge).toBe(false);
      expect(e.diagnosticOnly).toBe(true);
      expect(e.candidate.type).not.toBe('negative_control_no_cross_body');
    }
    // At least one endpoint should be on/near mask (positive control for lake).
    const nearMask = [row.endpoints.A, row.endpoints.B].some(
      (e) =>
        e.locationClass === 'on_open_water_mask' ||
        e.locationClass === 'near_open_water_mask' ||
        (e.nearestMaskKm != null && e.nearestMaskKm < 5) ||
        e.candidate.type === 'already_on_mask' ||
        e.candidate.type === 'short_shore_snap_to_mask',
    );
    expect(nearMask).toBe(true);
  }, 180_000);

  it('VG-mid negative control: refuses cross-body binding', async () => {
    const row = await runE214Corridor('VG-mid');
    expect(row.endpoints.A.candidate.type).toBe(
      'negative_control_no_cross_body',
    );
    expect(row.endpoints.B.candidate.type).toBe(
      'negative_control_no_cross_body',
    );
    expect(row.endpoints.A.candidate.wouldCreateGraphEdge).toBe(false);
    expect(row.endpoints.B.candidate.wouldCreateGraphEdge).toBe(false);
  }, 180_000);

  it('refuses when USE_WATER_GRAPH forced on', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    await expect(runE214Corridor('VG-mid')).rejects.toThrow(
      /USE_WATER_GRAPH=false/,
    );
  });

  it('quick suite formats markdown table', async () => {
    const report = await runE214Suite({ routes: ['VG-mid'] });
    expect(report.diagnosticOnly).toBe(true);
    expect(report.noLongSeamInvented).toBe(true);
    const md = formatE214MarkdownTable(report);
    expect(md).toMatch(/\| route \| endpoint \|/);
    expect(md).toMatch(/VG-mid/);
    expect(report.answers.vgMidFalsePositiveRisk).toMatch(/no_cross_body|LOW/i);
  }, 180_000);
});
