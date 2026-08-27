/**
 * E2.0 — WaterGraph seams / normalize / densify / Dijkstra / components.
 */
import { describe, expect, it } from 'vitest';
import {
  analyzeWaterGraphComponents,
  bindWaterGraphTerminal,
  buildWaterGraph,
  buildWaterSeams,
  densifyCenterlineCoords,
  fairwaySourcesInCorridor,
  normalizeWaterCenterline,
  searchWaterGraph,
  waterGraphPathToGeometry,
  WG_LAKE_CONNECT_KM,
} from '../water-graph';
import type { CenterlineSource } from '../water-graph-types';

describe('centerline densify / normalize', () => {
  it('densifies long segments along geometry', () => {
    const coords = [
      { lon: 37.0, lat: 56.0 },
      { lon: 37.2, lat: 56.0 }, // ~12.5 km
    ];
    const d = densifyCenterlineCoords(coords, 2);
    expect(d.length).toBeGreaterThan(coords.length);
    expect(d[0]).toEqual(coords[0]);
    expect(d[d.length - 1]).toEqual(coords[1]);
  });

  it('normalize dedupes within same waterId only', () => {
    const sources: CenterlineSource[] = [
      {
        id: 'a',
        kind: 'waterway',
        waterId: 'w1',
        coords: [
          { lon: 38.1, lat: 58.4 },
          { lon: 38.1001, lat: 58.4001 },
          { lon: 38.15, lat: 58.41 },
        ],
      },
    ];
    const n = normalizeWaterCenterline(sources, 0.05);
    expect(n[0]!.coords.length).toBeGreaterThanOrEqual(2);
    expect(n[0]!.coords.length).toBeLessThanOrEqual(3);
  });
});

describe('buildWaterGraph + Dijkstra', () => {
  it('builds fairway corridor graph and finds a typed path', () => {
    // Rybinsk mid-pool corridor near L01 / fairway coverage
    const a = { lon: 38.1, lat: 58.4 };
    const b = { lon: 38.6, lat: 58.35 };
    const g = buildWaterGraph({
      a,
      b,
      centerlines: [
        {
          id: 'test-cl',
          kind: 'waterway',
          waterId: 'ww:test',
          coords: [
            a,
            { lon: 38.25, lat: 58.38 },
            { lon: 38.4, lat: 58.37 },
            b,
          ],
          source: 'test',
        },
      ],
      options: { includeMask: false, includeFairway: true, includeLocks: true },
    });
    expect(g.nodes.size).toBeGreaterThan(2);
    expect(g.edges.size).toBeGreaterThan(1);
    expect(g.layers.centerline || g.layers.fairway).toBe(true);
    expect(g.layers.lock).toBe(true);
    expect(g.components).toBeTruthy();

    const termA = bindWaterGraphTerminal(g, 'A', a, [
      {
        point: a,
        source: 'waterway',
        distKm: 0,
        classPenalty: 1.6,
        stemPenalty: 0,
        rank: 0,
      },
    ]);
    const termB = bindWaterGraphTerminal(g, 'B', b, [
      {
        point: b,
        source: 'waterway',
        distKm: 0,
        classPenalty: 1.6,
        stemPenalty: 0,
        rank: 0,
      },
    ]);
    expect(termA).toBeTruthy();
    expect(termB).toBeTruthy();
    const search = searchWaterGraph(g, termA!.nodeId, termB!.nodeId);
    expect(search.path).toBeTruthy();
    expect(search.path!.edgeKinds.length).toBeGreaterThan(0);
    const geom = waterGraphPathToGeometry(g, search.path!.nodeIds, search.path!.edgeIds);
    expect(geom.length).toBeGreaterThanOrEqual(2);
  });

  it('fairwaySourcesInCorridor returns empty far from regional fairways', () => {
    const src = fairwaySourcesInCorridor(
      { lon: 44.5, lat: 48.7 },
      { lon: 48.0, lat: 46.3 },
      0.2,
    );
    expect(src.length).toBe(0);
  });

  it('LAKE_CONNECT_KM default is 0.45', () => {
    expect(WG_LAKE_CONNECT_KM).toBe(0.45);
  });
});

describe('components + seams helpers', () => {
  it('analyzeWaterGraphComponents counts nodes', () => {
    const g = buildWaterGraph({
      a: { lon: 38.1, lat: 58.4 },
      b: { lon: 38.3, lat: 58.4 },
      centerlines: [
        {
          id: 'c',
          kind: 'canal',
          waterId: 'ww:c',
          coords: [
            { lon: 38.1, lat: 58.4 },
            { lon: 38.2, lat: 58.4 },
            { lon: 38.3, lat: 58.4 },
          ],
        },
      ],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const c = analyzeWaterGraphComponents(g);
    expect(c.connectedComponents).toBeGreaterThanOrEqual(1);
    expect(c.waterwayNodeCount + c.deadEnds).toBeGreaterThanOrEqual(0);
  });

  it('buildWaterSeams is callable on graph without mask (0 seams)', () => {
    const g = buildWaterGraph({
      a: { lon: 38.1, lat: 58.4 },
      b: { lon: 38.2, lat: 58.4 },
      centerlines: [
        {
          id: 'c',
          kind: 'waterway',
          waterId: 'ww:c',
          coords: [
            { lon: 38.1, lat: 58.4 },
            { lon: 38.2, lat: 58.4 },
          ],
        },
      ],
      options: { includeMask: false, includeLocks: false, includeFairway: false },
    });
    expect(buildWaterSeams(g)).toBe(0);
  });
});
