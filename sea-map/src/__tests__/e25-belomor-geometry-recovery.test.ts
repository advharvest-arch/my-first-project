/**
 * E2.5 — Belomor geometry recovery research tests.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  defineBelomorFixtureGap,
  recoveryDoesNotMutateGraph,
  researchBelomorGeometryRecovery,
} from '../belomor-geometry-recovery';
import { getRouteFeatureFlags } from '../route-feature-flags';
import { buildWaterGraph } from '../water-graph';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
} from '../water-graph-ingest';

const here = dirname(fileURLToPath(import.meta.url));

describe('E2.5 Belomor geometry recovery', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('defines deterministic fixture gap (~19 km)', () => {
    const gap = defineBelomorFixtureGap();
    const expected = JSON.parse(
      readFileSync(
        join(here, '../__fixtures__/belomor-recovery/gap-spec.json'),
        'utf8',
      ),
    );
    expect(gap.waterId).toBe(expected.waterId);
    expect(gap.gapStart.lat).toBeCloseTo(expected.gapStart.lat, 2);
    expect(gap.gapEnd.lat).toBeCloseTo(expected.gapEnd.lat, 2);
    expect(gap.lengthKm).toBeGreaterThan(18);
    expect(gap.lengthKm).toBeLessThan(20);
    expect(gap.beforeGap.length).toBeGreaterThan(0);
    expect(gap.afterGap.length).toBeGreaterThan(0);
  });

  it('classifies FULL_GEOMETRY_FOUND from OSM relation snapshot', () => {
    const report = researchBelomorGeometryRecovery();
    expect(report.diagnosticOnly).toBe(true);
    expect(report.classification).toBe('FULL_GEOMETRY_FOUND');
    expect(report.geometryConfidence).toBe('HIGH');
    expect(report.canRecoverRealGeometryWithoutSyntheticSeam).toBe(true);
    expect(report.osmRelation.found).toBe(true);
    expect(report.osmRelation.relationId).toBe(9909116);
    expect(report.osmRelation.membersCoveringGapLatitudes.length).toBeGreaterThan(0);
  });

  it('preserves provenance on candidates and does not claim fixture-chord fill', () => {
    const report = researchBelomorGeometryRecovery();
    expect(report.importCandidates.length).toBeGreaterThan(0);
    for (const c of report.importCandidates) {
      expect(c.diagnosticOnly).toBe(true);
      expect(c.provenance.sourceType).toBe('osm');
      expect(c.provenance.sourceId).toBeTruthy();
      // Real geometry is west of fixture chord — proximity to chord is low
      expect(c.fixtureChordProximityPercent).toBeLessThan(20);
      expect(c.waterObjectMatch).toBe(true);
    }
    const osm = report.sourcesChecked.find((s) => s.sourceId?.includes('9909116'));
    expect(osm?.geometryAvailable).toBe(true);
    expect(osm?.overlapWithGapLatBand).toBe(true);
    expect(osm?.overlapWithFixtureGapChord).toBe(false);
  });

  it('knowledge is metadata-only (not geometry)', () => {
    const report = researchBelomorGeometryRecovery();
    const kn = report.sourcesChecked.find((s) => s.sourceType === 'knowledge');
    expect(kn).toBeTruthy();
    expect(kn!.geometryAvailable).toBe(false);
  });

  it('does not mutate WaterGraph / no automatic import', () => {
    const a = { lon: 34.82, lat: 62.86 };
    const b = { lon: 34.77, lat: 64.52 };
    const fc = JSON.parse(
      readFileSync(join(here, '../__fixtures__/centerlines/belomor.geojson'), 'utf8'),
    );
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fc),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const edgesBefore = g.edges.size;
    const report = researchBelomorGeometryRecovery();
    expect(recoveryDoesNotMutateGraph(report)).toBe(true);
    expect(g.edges.size).toBe(edgesBefore);
    expect(report.importCandidates.every((c) => c.diagnosticOnly)).toBe(true);
  });

  it('partial vs full coverage helpers via report fields', () => {
    const report = researchBelomorGeometryRecovery();
    // Lat-band coverage strong → FULL; chord fill weak
    const osm = report.sourcesChecked.find((s) => s.sourceType === 'osm' && s.geometryAvailable);
    expect(osm?.notes.some((n) => n.includes('gapLatBandCoverage'))).toBe(true);
    expect(report.classification).not.toBe('NO_OPEN_GEOMETRY_FOUND');
    expect(report.classification).not.toBe('METADATA_ONLY');
  });
});
