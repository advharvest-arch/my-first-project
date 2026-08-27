/**
 * E2.1 — Centerline ingest unit tests (OSM → graph, fixtures, provenance).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  classifyCenterlineKind,
  cropPolylineToBbox,
  featuresToCenterlineSources,
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
  ingestCorridorCenterlines,
  overpassElementsToFeatures,
  segmentCorridorForIngest,
  type OsmCenterlineFeature,
} from '../water-graph-ingest';
import {
  buildWaterGraph,
  runWaterGraphShadow,
  searchWaterGraph,
} from '../water-graph';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(here, '../__fixtures__/centerlines', name), 'utf8'),
  );

describe('centerline ingest basics', () => {
  it('LineString OSM → graph edges', () => {
    const features: OsmCenterlineFeature[] = [
      {
        osmId: 1,
        waterway: 'river',
        name: 'Test',
        coords: [
          { lon: 40, lat: 55 },
          { lon: 40.1, lat: 55 },
          { lon: 40.2, lat: 55 },
        ],
      },
    ];
    const a = { lon: 40, lat: 55 };
    const b = { lon: 40.2, lat: 55 };
    const ingest = ingestCenterlineFeaturesSync(a, b, features);
    expect(ingest.failureCode).toBe('none');
    expect(ingest.centerlines.length).toBeGreaterThan(0);
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    expect(g.layers.centerline).toBe(true);
    expect(g.edges.size).toBeGreaterThan(0);
  });

  it('multiple connected OSM segments share waterId and form one component', () => {
    const features: OsmCenterlineFeature[] = [
      {
        osmId: 10,
        waterway: 'river',
        name: 'Волга',
        coords: [
          { lon: 45, lat: 48 },
          { lon: 45.2, lat: 47.9 },
        ],
      },
      {
        osmId: 11,
        waterway: 'river',
        name: 'Волга',
        coords: [
          { lon: 45.2, lat: 47.9 },
          { lon: 45.4, lat: 47.8 },
        ],
      },
    ];
    const a = { lon: 45, lat: 48 };
    const b = { lon: 45.4, lat: 47.8 };
    const ingest = ingestCenterlineFeaturesSync(a, b, features);
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    expect(g.components!.connectedComponents).toBe(1);
    expect(g.components!.largestComponentKm).toBeGreaterThan(0);
  });

  it('reversed segments normalize into traversable graph', () => {
    const features: OsmCenterlineFeature[] = [
      {
        osmId: 20,
        waterway: 'river',
        name: 'R',
        coords: [
          { lon: 40, lat: 55 },
          { lon: 40.15, lat: 55 },
        ],
      },
      {
        osmId: 21,
        waterway: 'river',
        name: 'R',
        // reversed continuation
        coords: [
          { lon: 40.3, lat: 55 },
          { lon: 40.15, lat: 55 },
        ],
      },
    ];
    const a = { lon: 40, lat: 55 };
    const b = { lon: 40.3, lat: 55 };
    const ingest = ingestCenterlineFeaturesSync(a, b, features);
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const nodes = [...g.nodes.values()];
    const start = nodes.find((n) => Math.abs(n.lon - 40) < 0.01)!;
    const end = nodes.find((n) => Math.abs(n.lon - 40.3) < 0.01)!;
    const s = searchWaterGraph(g, start.id, end.id);
    expect(s.path).not.toBeNull();
  });

  it('same-waterId dedupe does not invent cross-water links', () => {
    const features: OsmCenterlineFeature[] = [
      {
        osmId: 30,
        waterway: 'river',
        name: 'A',
        coords: [
          { lon: 40, lat: 55 },
          { lon: 40.05, lat: 55 },
        ],
      },
      {
        osmId: 31,
        waterway: 'river',
        name: 'B',
        coords: [
          { lon: 40.051, lat: 55.001 },
          { lon: 40.1, lat: 55 },
        ],
      },
    ];
    const a = { lon: 40, lat: 55 };
    const b = { lon: 40.1, lat: 55 };
    const ingest = ingestCenterlineFeaturesSync(a, b, features);
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    // Two waters near each other must remain disconnected without seams/mask.
    expect(g.components!.connectedComponents).toBeGreaterThanOrEqual(2);
  });

  it('classifies river vs canal', () => {
    expect(classifyCenterlineKind('river')).toBe('waterway');
    expect(classifyCenterlineKind('canal')).toBe('canal');
    expect(classifyCenterlineKind('ship_canal')).toBe('canal');
    expect(classifyCenterlineKind('fairway')).toBe('fairway');
    expect(classifyCenterlineKind(null, 'Беломорско-Балтийский канал')).toBe(
      'canal',
    );
  });

  it('corridor crop drops outside geometry', () => {
    const runs = cropPolylineToBbox(
      [
        { lon: 0, lat: 0 },
        { lon: 1, lat: 0 },
        { lon: 2, lat: 0 },
        { lon: 3, lat: 0 },
      ],
      [0.5, -0.1, 2.5, 0.1],
    );
    expect(runs.length).toBe(1);
    expect(runs[0]!.length).toBe(2);
  });

  it('empty ingest → centerline_missing', () => {
    const r = ingestCenterlineFeaturesSync(
      { lon: 40, lat: 55 },
      { lon: 40.1, lat: 55 },
      [],
    );
    expect(r.failureCode).toBe('centerline_missing');
  });

  it('filters dam/weir crests', () => {
    const { features, rejected } = overpassElementsToFeatures([
      {
        type: 'way',
        id: 99,
        tags: { waterway: 'dam' },
        geometry: [
          { lon: 40, lat: 55 },
          { lon: 40.1, lat: 55 },
        ],
      },
    ]);
    expect(features.length).toBe(0);
    expect(rejected.some((r) => r.reason === 'dam_weir_crest')).toBe(true);
  });

  it('long-span segments without building global graph', () => {
    const segs = segmentCorridorForIngest(
      { lon: 44.52, lat: 48.7 },
      { lon: 48.02, lat: 46.36 },
      280,
    );
    expect(segs.length).toBeGreaterThan(1);
  });

  it('skipOverpass empty → centerline_missing without network', async () => {
    const r = await ingestCorridorCenterlines(
      { lon: 44.52, lat: 48.7 },
      { lon: 48.02, lat: 46.36 },
      { skipOverpass: true },
    );
    expect(r.failureCode).toBe('centerline_missing');
    expect(r.centerlines.length).toBe(0);
  });
});

describe('Lower Volga fixture', () => {
  const a = { lon: 44.52, lat: 48.7 };
  const b = { lon: 48.02, lat: 46.36 };
  const midA = { lon: 45.9, lat: 47.75 };
  const midB = { lon: 46.95, lat: 47.0 };

  it('builds centerline graph (not centerline_missing)', () => {
    const fc = fixture('lower-volga.geojson');
    const features = geojsonToCenterlineFeatures(fc);
    expect(features.length).toBeGreaterThan(0);
    const ingest = ingestCenterlineFeaturesSync(a, b, features);
    expect(ingest.failureCode).toBe('none');
    expect(ingest.stats.sourceFeatureCount).toBeGreaterThan(0);
    expect(ingest.stats.centerlineSource).toBe('fixture');

    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    expect(g.layers.centerline).toBe(true);
    expect(g.nodes.size).toBeGreaterThan(5);
    expect(g.edges.size).toBeGreaterThan(5);
    expect(g.components!.connectedComponents).toBeGreaterThanOrEqual(1);
    expect(g.components!.largestComponentKm).toBeGreaterThan(50);

    const shadow = runWaterGraphShadow({
      a,
      b,
      legacyLengthKm: 400,
      legacyOk: true,
      centerlines: ingest.centerlines,
      ingest: { failureCode: ingest.failureCode, stats: ingest.stats },
    });
    expect(shadow.failureStage).not.toBe('centerline_missing');
    expect(shadow.edgeKindCounts.waterwayEdgeCount).toBeGreaterThan(0);
    expect(shadow.provenance.sourceFeatureCount).toBeGreaterThan(0);
    expect(shadow.provenance.corridorBbox).not.toBeNull();
  });

  it('mid-corridor + Akhtuba branch visible as components', () => {
    const fc = fixture('lower-volga-mid.geojson');
    const ingest = ingestCenterlineFeaturesSync(
      midA,
      midB,
      geojsonToCenterlineFeatures(fc),
    );
    const g = buildWaterGraph({
      a: midA,
      b: midB,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    expect(g.layers.centerline).toBe(true);
    // Main stem + Akhtuba may be separate components if not joined
    expect(g.components!.connectedComponents).toBeGreaterThanOrEqual(1);
    expect(
      [...g.edges.values()].filter((e) => e.kind === 'waterway').length,
    ).toBeGreaterThan(0);
  });
});

describe('Belomor fixture', () => {
  const a = { lon: 34.82, lat: 62.86 };
  const b = { lon: 34.77, lat: 64.52 };

  it('canal centerlines ingested; not centerline_missing', () => {
    const fc = fixture('belomor.geojson');
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fc),
    );
    expect(ingest.failureCode).toBe('none');
    expect(ingest.centerlines.every((c) => c.kind === 'canal')).toBe(true);

    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    expect(g.layers.centerline).toBe(true);
    expect(g.nodes.size).toBeGreaterThan(5);
    expect(
      [...g.edges.values()].filter((e) => e.kind === 'canal').length,
    ).toBeGreaterThan(0);
    // North gap fixture → possibly >1 component
    expect(g.components!.connectedComponents).toBeGreaterThanOrEqual(1);

    const shadow = runWaterGraphShadow({
      a,
      b,
      legacyLengthKm: 180,
      legacyOk: false,
      centerlines: ingest.centerlines,
      ingest: { failureCode: ingest.failureCode, stats: ingest.stats },
    });
    expect(shadow.failureStage).not.toBe('centerline_missing');
    expect(shadow.edgeKindCounts.canalEdgeCount).toBeGreaterThan(0);
    expect(['agree', 'graphBetter', 'graphRejected', 'graphNoPath', 'legacyBetter', 'legacyNoPath', 'bothFail']).toContain(
      shadow.legacyCompare.classification,
    );
  });

  it('south / mid / north segments each have features after crop', () => {
    const fc = fixture('belomor.geojson');
    const features = geojsonToCenterlineFeatures(fc);
    const south = featuresToCenterlineSources(features, [
      34.5, 62.7, 35.1, 63.2,
    ]);
    const mid = featuresToCenterlineSources(features, [
      34.5, 63.2, 35.1, 63.9,
    ]);
    const north = featuresToCenterlineSources(features, [
      34.5, 64.0, 35.1, 64.6,
    ]);
    expect(south.accepted).toBeGreaterThan(0);
    expect(mid.accepted).toBeGreaterThan(0);
    expect(north.accepted).toBeGreaterThan(0);
  });
});

describe('provenance', () => {
  it('records source ids and bbox', () => {
    const features: OsmCenterlineFeature[] = [
      {
        osmId: 777,
        waterway: 'canal',
        name: 'К',
        coords: [
          { lon: 34.8, lat: 63 },
          { lon: 34.81, lat: 63.1 },
        ],
      },
    ];
    const ingest = ingestCenterlineFeaturesSync(
      { lon: 34.8, lat: 63 },
      { lon: 34.81, lat: 63.1 },
      features,
    );
    expect(ingest.stats.sourceWaterwayIds).toContain('777');
    expect(ingest.stats.corridorBbox.length).toBe(4);
    expect(ingest.stats.dataTimestampMs).toBeGreaterThan(0);
  });
});
