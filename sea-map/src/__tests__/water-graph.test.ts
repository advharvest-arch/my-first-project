/**
 * E2.0 — WaterGraph foundation suite (build / search / shadow).
 */
import { describe, expect, it } from 'vitest';
import {
  buildWaterGraph,
  runWaterGraphShadow,
  searchWaterGraph,
  bindWaterGraphTerminal,
} from '../water-graph';

describe('WaterGraph foundation', () => {
  it('builds layered graph with component diagnostics', () => {
    const g = buildWaterGraph({
      a: { lon: 38.45, lat: 57.78 },
      b: { lon: 38.85, lat: 58.05 },
      centerlines: [
        {
          id: 'r01',
          kind: 'fairway',
          waterId: 'fw:r01',
          coords: [
            { lon: 38.45, lat: 57.78 },
            { lon: 38.55, lat: 57.85 },
            { lon: 38.7, lat: 57.95 },
            { lon: 38.85, lat: 58.05 },
          ],
        },
      ],
      options: { includeMask: false },
    });
    expect(g.timing?.buildMs).toBeGreaterThanOrEqual(0);
    expect(g.components?.connectedComponents).toBeGreaterThanOrEqual(1);
    expect(g.layers.fairway || g.layers.centerline).toBe(true);
  });

  it('shadow compare fields are populated', () => {
    const a = { lon: 38.1, lat: 58.4 };
    const b = { lon: 38.35, lat: 58.4 };
    const shadow = runWaterGraphShadow({
      a,
      b,
      legacyLengthKm: 20,
      legacyOk: true,
      centerlines: [
        {
          id: 'legacy',
          kind: 'brouter',
          waterId: 'cl:legacy',
          coords: [a, { lon: 38.2, lat: 58.4 }, b],
        },
      ],
    });
    expect(shadow.built).toBe(true);
    expect(shadow.nodeCount).toBeGreaterThan(0);
    expect(shadow.legacyCompare.legacyLengthKm).toBe(20);
    expect(typeof shadow.legacyCompare.agree).toBe('boolean');
  });

  it('bind + search on connected centerline', () => {
    const a = { lon: 39.0, lat: 56.0 };
    const b = { lon: 39.2, lat: 56.0 };
    const g = buildWaterGraph({
      a,
      b,
      centerlines: [
        {
          id: 'line',
          kind: 'waterway',
          waterId: 'ww:line',
          coords: [a, { lon: 39.1, lat: 56.0 }, b],
        },
      ],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const tA = bindWaterGraphTerminal(g, 'A', a, []);
    const tB = bindWaterGraphTerminal(g, 'B', b, []);
    expect(tA && tB).toBeTruthy();
    const s = searchWaterGraph(g, tA!.nodeId, tB!.nodeId);
    expect(s.path?.lengthKm).toBeGreaterThan(0);
  });
});
