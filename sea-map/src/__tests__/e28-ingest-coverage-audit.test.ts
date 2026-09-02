/**
 * E2.8 — Ingest coverage audit tests (diagnostic only).
 */
import { describe, expect, it } from 'vitest';
import {
  auditDoesNotMutateEmptyGraph,
  belomorClassification,
  runE28IngestCoverageAudit,
  vgMidClassification,
} from '../ingest-coverage-audit';
import { getRouteFeatureFlags } from '../route-feature-flags';
import { buildWaterGraph } from '../water-graph';
import { BELOMOR_A, BELOMOR_B } from '../relation-aware-ingest';

describe('E2.8 ingest coverage audit', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('classifies Belomor as INGEST_ARTIFACT', () => {
    expect(belomorClassification()).toBe('INGEST_ARTIFACT');
  });

  it('classifies VG-mid as SEPARATE_WATER_OBJECT', () => {
    expect(vgMidClassification()).toBe('SEPARATE_WATER_OBJECT');
  });

  it('report is diagnosticOnly with no seam / no synthetic', () => {
    const report = runE28IngestCoverageAudit();
    expect(report.diagnosticOnly).toBe(true);
    expect(report.noSeam).toBe(true);
    expect(report.noSyntheticGeometry).toBe(true);
    expect(report.productionRoutingUnchanged).toBe(true);
    expect(report.useWaterGraphMustStayFalse).toBe(true);
  });

  it('provenance is real OSM ids / diagnosticOnly', () => {
    const report = runE28IngestCoverageAudit();
    for (const c of report.corridors) {
      for (const p of c.provenance) {
        expect(p.diagnosticOnly).toBe(true);
        expect(p.sourceType).toBe('osm');
        if (p.sourceId) {
          expect(p.sourceId).not.toMatch(/502000|401000|fake/i);
        }
      }
    }
  });

  it('covers all required corridors', () => {
    const report = runE28IngestCoverageAudit();
    const routes = report.corridors.map((c) => c.route);
    for (const r of ['Belomor', 'N06', 'N08', 'L2', 'X3', 'VG-D', 'VG-mid']) {
      expect(routes).toContain(r);
    }
  });

  it('VG-mid recoverable join km is 0 (must not sew)', () => {
    const report = runE28IngestCoverageAudit();
    const vg = report.corridors.find((c) => c.route === 'VG-mid')!;
    expect(vg.recoverableGeometryKm).toBe(0);
    expect(vg.relationAwareHelps).toBe(false);
    expect(vg.widerBboxHelps).toBe(false);
  });

  it('Belomor recoverable geometry > 0 and relation-aware helps', () => {
    const report = runE28IngestCoverageAudit();
    const b = report.corridors.find((c) => c.route === 'Belomor')!;
    expect(b.recoverableGeometryKm).toBeGreaterThan(18);
    expect(b.relationAwareHelps).toBe(true);
    expect(b.widerBboxHelps).toBe(true);
  });

  it('X3 is INGEST_ARTIFACT with Vetluga relation evidence', () => {
    const report = runE28IngestCoverageAudit();
    const x = report.corridors.find((c) => c.route === 'X3')!;
    expect(x.classification).toBe('INGEST_ARTIFACT');
    expect(x.relationFound).toBe(true);
    expect(x.relationIds).toContain(382593);
  });

  it('does not mutate empty production-like graph', () => {
    const empty = () =>
      buildWaterGraph({
        a: BELOMOR_A,
        b: BELOMOR_B,
        centerlines: [],
        options: { includeMask: false, includeFairway: false, includeLocks: false },
      });
    const before = empty().nodes.size;
    runE28IngestCoverageAudit();
    const after = empty().nodes.size;
    expect(auditDoesNotMutateEmptyGraph(before, after)).toBe(true);
  });

  it('classification counts are consistent', () => {
    const report = runE28IngestCoverageAudit();
    const sum = Object.values(report.classificationCounts).reduce((a, b) => a + b, 0);
    expect(sum).toBe(report.corridors.length);
    expect(report.classificationCounts.INGEST_ARTIFACT).toBeGreaterThanOrEqual(2);
    expect(report.classificationCounts.SEPARATE_WATER_OBJECT).toBeGreaterThanOrEqual(1);
    expect(report.answers.systemicOsmIngestLoss).toBe(true);
  });
});
