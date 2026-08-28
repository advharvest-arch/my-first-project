/**
 * E2.7 — Relation-aware waterway ingest prototype tests (diagnostic only).
 */
import { describe, expect, it } from 'vitest';
import {
  BELOMOR_RELATION_ID,
  analyzeMemberContinuity,
  buildCurrentBelomorVariant,
  buildRelationAwareBelomorVariant,
  computeCurrentFixtureBbox,
  computeRelationAwareBbox,
  loadBelomorRelation9909116,
  memberProvenance,
  processOsmWaterwayRelation,
  relationAwareCenterlines,
  relationAwareDoesNotMutateProductionGraph,
  runE27RelationAwareIngestPrototype,
} from '../relation-aware-ingest';
import { getRouteFeatureFlags } from '../route-feature-flags';
import { buildWaterGraph } from '../water-graph';
import { BELOMOR_A, BELOMOR_B } from '../relation-aware-ingest';

describe('E2.7 relation-aware waterway ingest', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('finds relation 9909116 with members', () => {
    const snap = loadBelomorRelation9909116();
    expect(snap.relation.id).toBe(BELOMOR_RELATION_ID);
    expect(snap.relation.memberCount).toBe(29);
    expect(snap.members.length).toBe(29);
  });

  it('extracts relevant main_stream members with real OSM geometry', () => {
    const snap = loadBelomorRelation9909116();
    const p = processOsmWaterwayRelation(snap);
    expect(p.mainStreamMembers.length).toBe(29);
    expect(p.relevantMembers.length).toBe(29);
    expect(p.geometryCoverageKm).toBeGreaterThan(100);
    for (const m of p.relevantMembers) {
      expect(m.coords.length).toBeGreaterThanOrEqual(2);
      expect(m.osmId).toBeGreaterThan(0);
    }
  });

  it('preserves HIGH osm provenance on every segment', () => {
    const snap = loadBelomorRelation9909116();
    const p = processOsmWaterwayRelation(snap);
    for (const s of p.segments) {
      expect(s.provenance.sourceType).toBe('osm');
      expect(s.provenance.sourceId).toBe(`way/${s.osmId}`);
      expect(s.provenance.sourceDetail).toContain('9909116');
      expect(s.provenance.confidence).toBe('HIGH');
      expect(s.provenance.diagnosticOnly).toBe(true);
    }
    const prov = memberProvenance(9909116, {
      osmId: 1020271530,
      role: 'main_stream',
      order: 8,
    });
    expect(prov.sourceId).toBe('way/1020271530');
  });

  it('does not invent geometry — segment length equals OSM polyline length', () => {
    const snap = loadBelomorRelation9909116();
    const p = processOsmWaterwayRelation(snap);
    for (const s of p.segments) {
      const m = p.relevantMembers.find((x) => x.osmId === s.osmId)!;
      expect(s.coords).toEqual(m.coords);
      expect(s.lengthKm).toBeGreaterThan(0);
    }
  });

  it('fixture chord ids are not used as relation-aware replacement geometry', () => {
    const snap = loadBelomorRelation9909116();
    const cls = relationAwareCenterlines(snap);
    expect(cls.length).toBe(29);
    for (const cl of cls) {
      expect(String(cl.sourceId)).toMatch(/^way\/\d+$/);
      expect(String(cl.sourceId)).not.toMatch(/502000/);
    }
  });

  it('CURRENT vs RELATION_AWARE graphs differ; artificial gap eliminated', () => {
    const report = runE27RelationAwareIngestPrototype();
    expect(report.current.artificialFixtureGapPresent).toBe(true);
    expect(report.relationAware.artificialFixtureGapPresent).toBe(false);
    expect(report.answers.eliminatesArtificialBelomorDataGapWithoutSeam).toBe(true);
    expect(report.relationAware.componentCount).toBe(1);
    expect(report.current.componentCount).toBeGreaterThan(1);
    expect(report.relationAware.largestComponentKm).toBeGreaterThan(
      report.current.largestComponentKm,
    );
    expect(report.relationAware.pathFound).toBe(true);
    expect(report.current.pathFound).toBe(false);
  });

  it('relation-aware build does not mutate an empty production-like graph', () => {
    const empty = () =>
      buildWaterGraph({
        a: BELOMOR_A,
        b: BELOMOR_B,
        centerlines: [],
        options: { includeMask: false, includeFairway: false, includeLocks: false },
      });
    const before = empty().nodes.size;
    buildRelationAwareBelomorVariant();
    buildCurrentBelomorVariant();
    const after = empty().nodes.size;
    expect(relationAwareDoesNotMutateProductionGraph(before, after)).toBe(true);
    expect(after).toBe(before);
  });

  it('preserves real relation discontinuities (does not auto-join)', () => {
    const snap = loadBelomorRelation9909116();
    const links = analyzeMemberContinuity(snap.members);
    expect(links.length).toBe(snap.members.length - 1);
    // Belomor relation members share endpoints — discontinuities must stay 0,
    // not be fabricated, and near-touch must not invent geometry.
    expect(links.every((l) => l.classification !== undefined)).toBe(true);
    expect(links.filter((l) => l.classification === 'DISCONTINUITY').length).toBe(0);
    expect(links.filter((l) => l.connectedBySharedEndpoint).length).toBe(
      links.length,
    );
  });

  it('CURRENT_FIXTURE_BBOX excludes western relation ways that RELATION_AWARE includes', () => {
    const snap = loadBelomorRelation9909116();
    const cur = computeCurrentFixtureBbox();
    const rel = computeRelationAwareBbox(snap.members);
    expect(rel[0]).toBeLessThan(cur[0]); // western extent
    // At least one gap-latitude western way should sit west of current west edge
    const western = snap.members.filter((m) =>
      m.coords.some((c) => c.lon < cur[0] && c.lat >= 63.95 && c.lat <= 64.12),
    );
    expect(western.length).toBeGreaterThan(0);
  });

  it('noSeam / noSynthetic flags on report', () => {
    const report = runE27RelationAwareIngestPrototype();
    expect(report.noSeam).toBe(true);
    expect(report.noSyntheticGeometry).toBe(true);
    expect(report.diagnosticOnly).toBe(true);
    expect(report.productionRoutingUnchanged).toBe(true);
  });
});
