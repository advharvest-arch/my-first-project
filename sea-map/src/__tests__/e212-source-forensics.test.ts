/**
 * E2.12 — Source-by-source forensics tests.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getE212Cases,
  runE212Corridor,
  runE212ForensicsSuite,
  formatE212MarkdownTable,
} from '../source-by-source-forensics';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import { getLastRouteTrace } from '../route-trace';

afterEach(() => {
  resetRouteFeatureFlags();
});

describe('E2.12 source-by-source forensics', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('defines Belomor/N06/N08/VG-D/VG-mid cases', () => {
    expect(getE212Cases().map((c) => c.id)).toEqual([
      'BELOMOR',
      'N06',
      'N08',
      'VG-D',
      'VG-mid',
    ]);
  });

  it('Belomor: both OK share independent full-canal data', async () => {
    const c = getE212Cases().find((x) => x.id === 'BELOMOR')!;
    const row = await runE212Corridor(c);
    expect(row.verdict).toBe('GRAPH_AND_LEGACY_SHARE_DATA');
    expect(row.osmRelations).toContain('9909116');
    expect(row.osmWays).toBe(29);
    expect(row.seamCount).toBe(0);
    expect(getLastRouteTrace()?.waterGraphForensics?.route).toBe('BELOMOR');
  }, 60_000);

  it('VG-D: near_geodesic_chord is geometry-suspect, not single long edge', async () => {
    const c = getE212Cases().find((x) => x.id === 'VG-D')!;
    const row = await runE212Corridor(c);
    expect(row.graphRejectReason).toContain('near_geodesic_chord');
    expect(row.chord).toBeTruthy();
    expect(row.chord!.interpretation).toBe(
      'near_geodesic_overall_no_long_edge',
    );
    expect(row.chord!.maxEdgeKm!).toBeLessThan(20);
    expect(row.chord!.ratioRawOverGeo!).toBeLessThanOrEqual(1.04);
    expect(row.verdict).toBe('GRAPH_GEOMETRY_SUSPECT');
    expect(row.seamCount).toBe(0);
  }, 60_000);

  it('VG-mid control: no seam, CONTROL_CORRECT', async () => {
    const c = getE212Cases().find((x) => x.id === 'VG-mid')!;
    const row = await runE212Corridor(c);
    expect(row.verdict).toBe('CONTROL_CORRECT');
    expect(row.seamCount).toBe(0);
    expect(row.graphPathKm).toBeNull();
  }, 60_000);

  it('quick offline suite builds markdown table', async () => {
    const report = await runE212ForensicsSuite({
      routes: ['BELOMOR', 'VG-D', 'VG-mid'],
    });
    const md = formatE212MarkdownTable(report);
    expect(md).toContain('BELOMOR');
    expect(md).toContain('GRAPH_AND_LEGACY_SHARE_DATA');
    expect(report.answers.vgDChordAorB).toMatch(/ratio=/);
    expect(report.useWaterGraphMustStayFalse).toBe(true);
  }, 120_000);

  it('refuses when USE_WATER_GRAPH forced on', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    const c = getE212Cases().find((x) => x.id === 'BELOMOR')!;
    await expect(runE212Corridor(c)).rejects.toThrow(/USE_WATER_GRAPH=false/);
  });
});
