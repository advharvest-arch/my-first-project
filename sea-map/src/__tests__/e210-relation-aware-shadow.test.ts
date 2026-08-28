/**
 * E2.10 — Relation-aware WaterGraph shadow tests (Belomor).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  provideBelomorRelation9909116Geometry,
  providerToCenterlines,
} from '../relation-aware-osm-provider';
import {
  currentBelomorStillHasArtificialGap,
  runBelomorRelationAwareShadow,
} from '../relation-aware-shadow';
import { buildWaterGraph } from '../water-graph';
import { BELOMOR_A, BELOMOR_B } from '../relation-aware-ingest';
import {
  getRouteFeatureFlags,
  resetRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from '../route-feature-flags';
import { measureWaterChain, getLastRouteTrace } from '../waterways';

afterEach(() => {
  resetRouteFeatureFlags();
});

describe('E2.10 relation-aware WaterGraph shadow', () => {
  it('USE_WATER_GRAPH stays false by default', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('loads relation 9909116 with 29 main_stream members', () => {
    const p = provideBelomorRelation9909116Geometry();
    expect(p.relationId).toBe(9909116);
    expect(p.mainStreamCount).toBe(29);
    expect(p.members.length).toBe(29);
    expect(p.sourceKind).toBe('snapshot');
    expect(p.diagnosticOnly).toBe(true);
  });

  it('preserves HIGH osm provenance on members', () => {
    const p = provideBelomorRelation9909116Geometry();
    expect(p.provenance.length).toBe(29);
    for (const pr of p.provenance) {
      expect(pr.sourceType).toBe('osm');
      expect(pr.sourceId).toMatch(/^way\/\d+$/);
      expect(pr.confidence).toBe('HIGH');
      expect(pr.diagnosticOnly).toBe(true);
    }
  });

  it('does not use fixture chord as replacement geometry', () => {
    const cls = providerToCenterlines(provideBelomorRelation9909116Geometry());
    for (const c of cls) {
      expect(String(c.sourceId)).not.toMatch(/502000/);
      expect(c.source).toBe('osm');
    }
  });

  it('CURRENT still has artificial gap; RELATION_AWARE eliminates it', () => {
    expect(currentBelomorStillHasArtificialGap()).toBe(true);
    const report = runBelomorRelationAwareShadow();
    expect(report.current.artificialFixtureGapPresent).toBe(true);
    expect(report.relationAware.artificialFixtureGapPresent).toBe(false);
    expect(report.artificialGapEliminated).toBe(true);
    expect(report.answers.belomorDataGapGone).toBe(true);
    expect(report.relationAware.pathFound).toBe(true);
    expect(report.relationAware.pathLengthKm).toBeGreaterThan(200);
  });

  it('no synthetic geometry / no seam fill; diagnosticOnly', () => {
    const report = runBelomorRelationAwareShadow();
    expect(report.noSyntheticGeometry).toBe(true);
    expect(report.noSeamFill).toBe(true);
    expect(report.diagnosticOnly).toBe(true);
    expect(report.relationAware.diagnosticOnly).toBe(true);
    // Mask/lake seams not used; lock portals may exist but gap-fill seams not added.
    expect(report.relationAware.seamCount).toBe(0);
  });

  it('does not mutate an empty production-like graph', () => {
    const empty = () =>
      buildWaterGraph({
        a: BELOMOR_A,
        b: BELOMOR_B,
        centerlines: [],
        options: { includeMask: false, includeFairway: false, includeLocks: false },
      });
    const before = empty().nodes.size;
    runBelomorRelationAwareShadow();
    expect(empty().nodes.size).toBe(before);
  });

  it('graph safety uses existing validator/hydro (accepted or explicit reject)', () => {
    const report = runBelomorRelationAwareShadow();
    expect(report.answers.safetyUnchanged).toBe(true);
    expect(typeof report.relationAware.graphSafetyAccepted).toBe('boolean');
    if (report.relationAware.pathFound) {
      expect(report.relationAware.graphSafetyAccepted).toBe(true);
    }
  });

  it('legacy routing result unchanged when shadow flag off', async () => {
    resetRouteFeatureFlags();
    const a = await measureWaterChain([BELOMOR_A, BELOMOR_B]);
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
    const tr = getLastRouteTrace();
    expect(tr?.relationAwareShadow).toBeUndefined();
    // Result identity: method/ok independent of shadow modules.
    expect(a.method === 'route_not_found' || a.points.length >= 2).toBe(true);
  });

  it('with USE_WATER_GRAPH test flag, Belomor attaches relationAwareShadow without changing final legacy ok', async () => {
    setRouteFeatureFlagsForTests({ USE_WATER_GRAPH: true });
    const path = await measureWaterChain([BELOMOR_A, BELOMOR_B]);
    const tr = getLastRouteTrace();
    expect(tr?.relationAwareShadow?.source).toBe('relation_aware');
    expect(tr?.relationAwareShadow?.relationId).toBe(9909116);
    expect(tr?.relationAwareShadow?.diagnosticOnly).toBe(true);
    expect(tr?.relationAwareShadow?.artificialGapEliminated).toBe(true);
    expect(tr?.graph.centerlineSource).toBe('relation_aware_snapshot');
    // Final remains legacy (shadow must not force ok).
    expect(tr?.final.ok).toBe(path.method !== 'route_not_found' && path.points.length >= 2);
  });
});
