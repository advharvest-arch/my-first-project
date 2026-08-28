/**
 * E2.11 — WaterGraph vs legacy benchmark tests (deterministic / offline-friendly).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  getE211Corridors,
  runE211BenchmarkSuite,
  runE211CorridorOnce,
  formatE211MarkdownTable,
} from '../watergraph-vs-legacy-bench';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import { getLastRouteTrace } from '../route-trace';

afterEach(() => {
  resetRouteFeatureFlags();
});

describe('E2.11 WaterGraph vs legacy benchmark', () => {
  it('USE_WATER_GRAPH stays false by default', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('defines required positive + negative corridors', () => {
    const ids = getE211Corridors().map((c) => c.id);
    expect(ids).toEqual(['BELOMOR', 'N06', 'N08', 'L2', 'VG-D', 'VG-mid']);
    const vgMid = getE211Corridors().find((c) => c.id === 'VG-mid')!;
    expect(vgMid.role).toBe('negative_control');
  });

  it('Belomor relation-aware shadow is GRAPH_PROMISING vs legacy', async () => {
    const belomor = getE211Corridors().find((c) => c.id === 'BELOMOR')!;
    const row = await runE211CorridorOnce(belomor, 'cold');
    expect(row.useWaterGraphFlag).toBe(false);
    expect(row.legacy.accepted).toBe(true);
    expect(row.graph.pathFound).toBe(true);
    expect(row.graph.safetyAccepted).toBe(true);
    expect(row.graph.edgeKinds.seamEdges).toBe(0);
    expect(row.comparison.both_ok).toBe(true);
    expect(row.verdict).toBe('GRAPH_PROMISING');
    expect(getLastRouteTrace()?.waterGraphBenchmark?.corridor).toBe('BELOMOR');
    expect(getLastRouteTrace()?.waterGraphBenchmark?.diagnosticOnly).toBe(true);
  }, 60_000);

  it('VG-mid negative control does not accept Volga↔Akhtuba sew', async () => {
    const vg = getE211Corridors().find((c) => c.id === 'VG-mid')!;
    const row = await runE211CorridorOnce(vg, 'cold');
    expect(row.graph.pathFound).toBe(false);
    expect(row.verdict).toBe('CONTROL_CORRECTLY_REJECTED');
    expect(row.graph.edgeKinds.seamEdges).toBe(0);
  }, 60_000);

  it('VG-D fixture run records legacy_only or both_ok without seams', async () => {
    const vgd = getE211Corridors().find((c) => c.id === 'VG-D')!;
    const row = await runE211CorridorOnce(vgd, 'cold');
    expect(row.graph.edgeKinds.seamEdges).toBe(0);
    expect(row.diagnosticOnly).toBe(true);
    expect([
      'GRAPH_PROMISING',
      'GRAPH_NEEDS_DATA',
      'GRAPH_REJECTS_SAFE_ROUTE',
      'GRAPH_TOPOLOGY_RISK',
    ]).toContain(row.verdict);
    // Probe showed near_geodesic_chord — reject safe route or topology, not sew.
    if (row.legacy.accepted && !row.graph.pathFound) {
      expect(row.comparison.legacy_only).toBe(true);
    }
  }, 60_000);

  it('offline suite (Belomor/VG-D/VG-mid) builds markdown table', async () => {
    const report = await runE211BenchmarkSuite({
      corridors: ['BELOMOR', 'VG-D', 'VG-mid'],
      modes: ['cold'],
    });
    expect(report.useWaterGraphMustStayFalse).toBe(true);
    expect(report.summaryTable).toHaveLength(3);
    const md = formatE211MarkdownTable(report);
    expect(md).toContain('BELOMOR');
    expect(md).toContain('verdict');
    expect(report.answers.controlsOk).toContain('VG-mid');
    expect(report.answers.promisingCorridors).toContain('BELOMOR');
  }, 120_000);

  it('refuses to run when USE_WATER_GRAPH is forced on', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    const belomor = getE211Corridors().find((c) => c.id === 'BELOMOR')!;
    await expect(runE211CorridorOnce(belomor, 'cold')).rejects.toThrow(
      /USE_WATER_GRAPH=false/,
    );
  });
});
