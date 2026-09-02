/**
 * E2.9 — Historical ingest forensics tests (deterministic reporting only).
 */
import { describe, expect, it } from 'vitest';
import {
  belomorFirstBadCommit,
  belomorLastGoodCommit,
  buildE29Report,
  E29_CORRIDORS,
} from '../e29-historical-ingest-forensics';
import { getRouteFeatureFlags } from '../route-feature-flags';

describe('E2.9 historical ingest forensics', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('Belomor last-good / first-bad commits are set', () => {
    expect(belomorLastGoodCommit()).toBe('612dadde');
    expect(belomorFirstBadCommit()).toBe('65dfe1d');
  });

  it('Belomor evidence: project change YES, historical geometry PARTIAL', () => {
    const b = E29_CORRIDORS.find((c) => c.route === 'Belomor')!;
    expect(b.evidenceProjectChangeCausedLoss).toBe('YES');
    expect(b.evidenceHistoricalSuccessUsedThisGeometry).toBe('PARTIAL');
    expect(b.changeTypes).toContain('FIXTURE');
  });

  it('X3 and Kuibyshev lack last-good/first-bad (NO EVIDENCE of removal)', () => {
    for (const id of ['X3', 'N06', 'N08', 'L2']) {
      const c = E29_CORRIDORS.find((x) => x.route === id)!;
      expect(c.lastGoodCommit).toBeNull();
      expect(c.firstBadCommit).toBeNull();
      expect(c.evidenceProjectChangeCausedLoss).toBe('NO_EVIDENCE');
    }
  });

  it('VG-mid/VG-D are not ingest regressions to sew', () => {
    for (const id of ['VG-mid', 'VG-D']) {
      const c = E29_CORRIDORS.find((x) => x.route === id)!;
      expect(c.recoverableGeometryKm).toBe(0);
      expect(c.evidenceHistoricalSuccessUsedThisGeometry).toBe('NO_EVIDENCE');
    }
  });

  it('report flags production unchanged and lists unsafe recoveries', () => {
    const report = buildE29Report();
    expect(report.diagnosticOnly).toBe(true);
    expect(report.noSeam).toBe(true);
    expect(report.useWaterGraphMustStayFalse).toBe(true);
    expect(report.unsafeHistoricalBehaviorMustNotRecover.some((x) => x.includes('3.5'))).toBe(
      true,
    );
    expect(report.safeHistoricalBehaviorToRecover.length).toBeGreaterThan(0);
  });

  it('timeline includes 35bb549 and 65dfe1d', () => {
    const report = buildE29Report();
    const ids = report.timeline.map((t) => t.commit);
    expect(ids).toContain('35bb549');
    expect(ids).toContain('65dfe1d');
    expect(ids).toContain('612dadde');
  });
});
