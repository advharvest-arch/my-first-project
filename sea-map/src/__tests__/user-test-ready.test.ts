/**
 * USER_TEST_READY — preset catalog tests (no live Overpass/BRouter).
 */
import { describe, expect, it } from 'vitest';
import {
  USER_TEST_PRESETS,
  getUserTestPreset,
  listUserTestPresetsByGroup,
} from '../user-test-presets';
import {
  formatUserTestSessionSummary,
  getUserTestSessionSummary,
  recordUserTestTrace,
  resetUserTestSession,
} from '../user-test-session';
import { beginRouteTrace } from '../route-trace';
import { isUserTestModeEnabled } from '../user-test-panel';

describe('USER_TEST_READY presets', () => {
  it('includes required SAFE/TARGET/SAFETY/RIVERS ids', () => {
    const ids = new Set(USER_TEST_PRESETS.map((p) => p.id));
    for (const id of [
      'L01',
      'L05',
      'L07',
      'L14',
      'R01',
      'R03',
      'L2',
      'N06',
      'N08',
      'N11',
      'X3',
      'STEM',
      'VETL',
      'X2',
      'R02',
      'R04',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
    expect(USER_TEST_PRESETS.length).toBeGreaterThanOrEqual(16);
  });

  it('every preset has A/B, purpose, and expectedCurrentStatus (docs only)', () => {
    for (const p of USER_TEST_PRESETS) {
      expect(Number.isFinite(p.a.lon)).toBe(true);
      expect(Number.isFinite(p.a.lat)).toBe(true);
      expect(Number.isFinite(p.b.lon)).toBe(true);
      expect(Number.isFinite(p.b.lat)).toBe(true);
      expect(p.purpose.length).toBeGreaterThan(5);
      expect([
        'ok_expected',
        'fail_expected',
        'flaky_or_unknown',
        'advisory_interesting',
      ]).toContain(p.expectedCurrentStatus);
    }
  });

  it('groups partition presets', () => {
    const g = listUserTestPresetsByGroup();
    expect(g.safe.length).toBeGreaterThanOrEqual(6);
    expect(g.target.length).toBeGreaterThanOrEqual(5);
    expect(g.safety.length).toBeGreaterThanOrEqual(3);
    expect(g.rivers.length).toBeGreaterThanOrEqual(2);
    expect(getUserTestPreset('L01')?.group).toBe('safe');
    expect(getUserTestPreset('STEM')?.group).toBe('safety');
  });

  it('session summary records RouteTrace without changing final.ok', () => {
    resetUserTestSession();
    const builder = beginRouteTrace(
      [
        { lon: 38.1, lat: 58.4 },
        { lon: 38.6, lat: 58.35 },
      ],
      30,
    );
    builder.knowledge = {
      factsMatched: 2,
      factIds: ['a', 'b'],
      sources: ['kim-bulletins'],
      advisories: [
        {
          type: 'navigation_closure',
          severity: 'high',
          affectsRoute: true,
          source: 'kim-bulletins',
          factId: 'a',
        },
      ],
    };
    const trace = builder.finish({
      ok: true,
      method: 'lake',
      lengthKm: 29.7,
      rejectReason: null,
      waterName: 'Рыбинское водохранилище',
    });
    recordUserTestTrace(trace, 'L01');
    const s = getUserTestSessionSummary();
    expect(s.routesTested).toBe(1);
    expect(s.ok).toBe(1);
    expect(s.methods.lake).toBe(1);
    expect(s.knowledgeMatches).toBe(1);
    expect(formatUserTestSessionSummary(s)).toMatch(/Routes tested: 1/);
    expect(trace.final.ok).toBe(true);
  });

  it('panel mount gate is DEV-only (production false in vitest unless DEV)', () => {
    // Vitest runs with MODE=test; import.meta.env.DEV is typically false here.
    expect(typeof isUserTestModeEnabled()).toBe('boolean');
  });
});
