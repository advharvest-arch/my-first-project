/**
 * E2.2.3 — WaterGraph topology diagnostics unit tests.
 * Production routing / USE_WATER_GRAPH must stay unchanged.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
} from '../water-graph-ingest';
import { buildWaterGraph, runWaterGraphShadow } from '../water-graph';
import {
  diagnoseWaterGraphTopology,
  WG_TOPOLOGY_SCAN_KM,
} from '../water-graph-topology';
import { getRouteFeatureFlags } from '../route-feature-flags';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(here, '../__fixtures__/centerlines', name), 'utf8'),
  );

describe('E2.2.3 water graph topology', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('diagnoseWaterGraphTopology never mutates edge count', () => {
    const a = { lon: 45.9, lat: 47.75 };
    const b = { lon: 46.95, lat: 47.0 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('lower-volga-mid.geojson')),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const before = g.edges.size;
    const topo = diagnoseWaterGraphTopology(g, { a, b });
    expect(g.edges.size).toBe(before);
    expect(topo.diagnosticOnly).toBe(true);
    expect(topo.componentCount).toBeGreaterThanOrEqual(2);
    expect(topo.gapSummary.length).toBeGreaterThan(0);
    expect(topo.candidateSeams.every((c) => c.diagnosticOnly)).toBe(true);
  });

  it('VG-mid: Volga↔Akhtuba classified TOPOLOGY_GAP (different waterIds)', () => {
    const a = { lon: 45.9, lat: 47.75 };
    const b = { lon: 46.95, lat: 47.0 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('lower-volga-mid.geojson')),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topo = diagnoseWaterGraphTopology(g, { a, b });
    const waterwayComps = topo.components.filter(
      (c) => c.layers.waterway || c.layers.canal,
    );
    expect(waterwayComps.length).toBeGreaterThanOrEqual(2);
    const gap = topo.gapSummary.find(
      (g0) =>
        g0.fromSide.waterIds.some((w) => w.includes('волга')) &&
        g0.toSide.waterIds.some((w) => w.includes('ахтуба')),
    ) ?? topo.gapSummary.find(
      (g0) =>
        g0.fromSide.waterIds.some((w) => w.includes('ахтуба')) &&
        g0.toSide.waterIds.some((w) => w.includes('волга')),
    );
    expect(gap).toBeTruthy();
    expect(gap!.classification).toBe('TOPOLOGY_GAP');
    expect(gap!.distanceKm).toBeGreaterThan(5);
    expect(gap!.distanceKm).toBeLessThan(WG_TOPOLOGY_SCAN_KM);
  });

  it('Belomor: same-water north tear classified DATA_GAP', () => {
    const a = { lon: 34.82, lat: 62.86 };
    const b = { lon: 34.77, lat: 64.52 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('belomor.geojson')),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topo = diagnoseWaterGraphTopology(g, { a, b });
    expect(topo.componentCount).toBeGreaterThanOrEqual(2);
    const dataGap = topo.gapSummary.find((g0) => g0.classification === 'DATA_GAP');
    expect(dataGap).toBeTruthy();
    expect(dataGap!.gapContents).toContain('nothing_known');
    expect(dataGap!.fromSide.waterIds[0]).toBe(dataGap!.toSide.waterIds[0]);
  });

  it('shadow result includes topology without enabling production graph', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
    const a = { lon: 45.9, lat: 47.75 };
    const b = { lon: 46.95, lat: 47.0 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('lower-volga-mid.geojson')),
    );
    const shadow = runWaterGraphShadow({
      a,
      b,
      legacyLengthKm: 120,
      legacyOk: false,
      centerlines: ingest.centerlines,
      ingest: { failureCode: ingest.failureCode, stats: ingest.stats },
    });
    expect(shadow.topology).toBeTruthy();
    expect(shadow.topology!.diagnosticOnly).toBe(true);
    expect(shadow.topology!.componentCount).toBeGreaterThanOrEqual(2);
  });

  it('portal diagnostics expose nearest other component', () => {
    const a = { lon: 34.82, lat: 62.86 };
    const b = { lon: 34.77, lat: 64.52 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('belomor.geojson')),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topo = diagnoseWaterGraphTopology(g, { a, b });
    const portals = topo.components.flatMap((c) => c.portals);
    expect(portals.some((p) => p.degree <= 1)).toBe(true);
    expect(
      portals.some(
        (p) =>
          p.nearestOtherComponentId != null &&
          p.nearestOtherComponentDistKm != null,
      ),
    ).toBe(true);
  });
});
