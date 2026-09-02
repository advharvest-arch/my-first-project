/**
 * E2.6 — Historical routing regression archaeology tests (deterministic reporting only).
 */
import { describe, expect, it } from 'vitest';
import {
  buildE26Report,
  evidenceClassFor,
  formatE26Markdown,
  pipelineChangesSafeToRestore,
  E26_MODERN_BASELINES,
  E26_HISTORICAL_FINDINGS,
} from '../e26-historical-routing-regression';
import { getRouteFeatureFlags } from '../route-feature-flags';

describe('E2.6 historical routing regression archaeology', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('covers all control routes', () => {
    const routes = ['VG-mid', 'N06', 'N08', 'Belomor', 'X3', 'L2'];
    for (const r of routes) {
      expect(E26_MODERN_BASELINES.some((b) => b.route === r)).toBe(true);
      expect(E26_HISTORICAL_FINDINGS.some((f) => f.route === r)).toBe(true);
      expect(evidenceClassFor(r)).not.toBeNull();
    }
  });

  it('classifies VG-mid and X3 as NO_EVIDENCE of historical success', () => {
    expect(evidenceClassFor('VG-mid')).toBe('NO_EVIDENCE');
    expect(evidenceClassFor('X3')).toBe('NO_EVIDENCE');
  });

  it('classifies Belomor full as CONFIRMED_WORKING with fixture PIPELINE_ARTIFACT', () => {
    expect(evidenceClassFor('Belomor')).toBe('CONFIRMED_WORKING');
    const bel = E26_HISTORICAL_FINDINGS.find((f) => f.route === 'Belomor')!;
    expect(bel.gapKind).toBe('PIPELINE_ARTIFACT');
    expect(bel.firstKnownRegressionCommit).toBe('65dfe1d');
  });

  it('N06/N08/L2 are PROBABLY_WORKING (E1 mask era)', () => {
    expect(evidenceClassFor('N06')).toBe('PROBABLY_WORKING');
    expect(evidenceClassFor('N08')).toBe('PROBABLY_WORKING');
    expect(evidenceClassFor('L2')).toBe('PROBABLY_WORKING');
  });

  it('buildE26Report is stable and flags production unchanged', () => {
    const report = buildE26Report();
    expect(report.schemaVersion).toBe('e2.6-historical-routing-regression');
    expect(report.useWaterGraphMustStayFalse).toBe(true);
    expect(report.productionRoutingUnchanged).toBe(true);
    expect(report.belomor.osmRelationId).toBe(9909116);
    expect(report.comparisonTable).toHaveLength(6);
    expect(report.answers.restorablesWithoutWeakeningSafety.length).toBeGreaterThan(0);
  });

  it('restore-safe candidates exclude safety softenings', () => {
    const safe = pipelineChangesSafeToRestore();
    expect(safe.every((c) => c.safeToConsiderRestoringWithoutWeakeningSafety)).toBe(true);
    expect(safe.some((c) => c.commit === '4f60ab8')).toBe(false);
    expect(safe.some((c) => c.commit === 'edd2603')).toBe(false);
    expect(safe.some((c) => c.commit === '54eb6e5')).toBe(false);
    expect(safe.some((c) => c.commit === '65dfe1d' || c.commit === '35bb549')).toBe(true);
  });

  it('markdown formatter includes required sections', () => {
    const md = formatE26Markdown();
    expect(md).toContain('E2.6');
    expect(md).toContain('Modern baselines');
    expect(md).toContain('Historical success evidence');
    expect(md).toContain('Belomor');
    expect(md).toContain('Key answers');
  });

  it('modern VG-mid baseline remains FAIL snap_empty', () => {
    const vg = E26_MODERN_BASELINES.find((b) => b.route === 'VG-mid')!;
    expect(vg.result).toBe('FAIL');
    expect(vg.rejectReason).toBe('snap_empty');
  });
});
