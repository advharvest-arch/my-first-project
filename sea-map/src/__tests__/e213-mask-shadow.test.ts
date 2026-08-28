/**
 * E2.13 — Lake-mask WaterGraph shadow tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getE213Cases,
  resolveLakeMaskForShadow,
  runE213Corridor,
  runE213MaskShadowSuite,
  formatE213MarkdownTable,
} from '../water-graph-mask-shadow';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import { getLastRouteTrace } from '../route-trace';
import { USER_TEST_PRESETS } from '../user-test-presets';
import { runWaterGraphShadow } from '../water-graph';

afterEach(() => {
  resetRouteFeatureFlags();
});

describe('E2.13 WaterGraph lake-mask shadow', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('defines N06/N08/Belomor/VG-mid cases', () => {
    expect(getE213Cases().map((c) => c.id)).toEqual([
      'N06',
      'N08',
      'BELOMOR',
      'VG-mid',
    ]);
  });

  it('resolves Kuibyshev mask via densify (explains E2.12 2-point miss)', async () => {
    const p = USER_TEST_PRESETS.find((x) => x.id === 'N08')!;
    const r = await resolveLakeMaskForShadow(p.a, p.b);
    expect(r.sharedName).toMatch(/Куйбышев/);
    expect(r.lake).toBeTruthy();
    expect(r.complete).toBe(true);
    expect(r.provenance?.diagnosticOnly).toBe(true);
    expect(r.note).toMatch(/densified|two_point/i);
  }, 60_000);

  it('N06 deterministic: without mask unbound; with mask mesh path validates', async () => {
    const p = USER_TEST_PRESETS.find((x) => x.id === 'N06')!;
    const r = await resolveLakeMaskForShadow(p.a, p.b);
    expect(r.lake).toBeTruthy();
    // Empty Overpass — fairway/lock only vs +mask (deterministic, no network ingest).
    const cur = runWaterGraphShadow({
      a: p.a,
      b: p.b,
      legacyLengthKm: 0,
      legacyOk: false,
      centerlines: [],
    });
    const masked = runWaterGraphShadow({
      a: p.a,
      b: p.b,
      legacyLengthKm: 0,
      legacyOk: false,
      centerlines: [],
      lake: r.lake,
      lakeComplete: true,
    });
    expect(cur.pathFound).toBe(false);
    expect(masked.layers.mask).toBe(true);
    expect(masked.edgeKindCounts.maskEdgeCount).toBeGreaterThan(0);
    expect(masked.pathFound).toBe(true);
    expect(masked.validated).toBe(true);
    expect(masked.pathLengthKm).toBeGreaterThan(20);
  }, 60_000);

  it('N08: resolved mask adds mask edges; full corridor run is diagnostic', async () => {
    const p = USER_TEST_PRESETS.find((x) => x.id === 'N08')!;
    const r = await resolveLakeMaskForShadow(p.a, p.b);
    const masked = runWaterGraphShadow({
      a: p.a,
      b: p.b,
      legacyLengthKm: 40,
      legacyOk: true,
      centerlines: [],
      lake: r.lake,
      lakeComplete: true,
    });
    expect(masked.layers.mask).toBe(true);
    expect(masked.edgeKindCounts.maskEdgeCount).toBeGreaterThan(0);
    expect(masked.pathFound).toBe(true);
  }, 60_000);

  it('Belomor control: no shared lake — mask layer stays off; path still OK via relation', async () => {
    const row = await runE213Corridor('BELOMOR');
    expect(row.maskSource).toBeNull();
    expect(row.maskShadow.layers.mask).toBe(false);
    expect(row.maskShadow.pathFound).toBe(true);
    expect(row.safetyRegression).toBe(false);
    expect(getLastRouteTrace()?.waterGraphMaskShadow?.corridor).toBe('BELOMOR');
  }, 60_000);

  it('VG-mid negative control: mask shadow must not sew Volga↔Akhtuba', async () => {
    const row = await runE213Corridor('VG-mid');
    expect(row.maskShadow.pathFound).toBe(false);
    expect(row.safetyRegression).toBe(false);
    expect(row.maskShadow.waterwayMaskConnections).toBe(0);
  }, 60_000);

  it('refuses when USE_WATER_GRAPH forced on', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    await expect(runE213Corridor('BELOMOR')).rejects.toThrow(
      /USE_WATER_GRAPH=false/,
    );
  });

  it('quick suite formats markdown', async () => {
    const report = await runE213MaskShadowSuite({
      routes: ['BELOMOR', 'VG-mid'],
    });
    const md = formatE213MarkdownTable(report);
    expect(md).toContain('BELOMOR');
    expect(report.answers.E_safetyRegression).toMatch(/^NO/);
  }, 90_000);
});
