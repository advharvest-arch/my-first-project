/**
 * E2.2.1 — fallback timeline unit tests (no network).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  beginFallbackEvent,
  beginFallbackTimeline,
  buildFallbackSummary,
  endFallbackEvent,
  endFallbackTimeline,
  markFallbackEvent,
  snapshotFallbackDiag,
} from '../route-fallback-timeline';
import { clearRouteTraces, beginRouteTrace } from '../route-trace';
import { createRoutePerfCounters } from '../route-perf-context';

afterEach(() => {
  endFallbackTimeline();
  clearRouteTraces();
});

describe('fallback timeline diag', () => {
  it('records overlapping overpass aggregate > wall', () => {
    beginFallbackTimeline();
    const a = beginFallbackEvent('overpass', 'op1', { parallelGroup: 'g1' });
    const b = beginFallbackEvent('overpass', 'op2', { parallelGroup: 'g1' });
    endFallbackEvent(a, 'ok');
    endFallbackEvent(b, 'ok');
    markFallbackEvent('snap_empty', 'snap', 'snap_empty');
    markFallbackEvent('final_reject', 'final', 'snap_empty');
    const snap = snapshotFallbackDiag(100);
    expect(snap).not.toBeNull();
    expect(snap!.summary.overpassCallCount).toBe(2);
    expect(snap!.summary.snapEmptyAtMs).not.toBeNull();
    expect(snap!.summary.finalRejectAtMs).not.toBeNull();
    expect(snap!.events[0]!.type).toBe('request_start');
  });

  it('buildFallbackSummary flags aggregateExceedsWall', () => {
    const summary = buildFallbackSummary(
      [
        {
          type: 'overpass',
          id: '1',
          startMs: 0,
          endMs: 8000,
          durationMs: 8000,
          parent: null,
          parallelGroup: 'g',
          result: 'ok',
        },
        {
          type: 'overpass',
          id: '2',
          startMs: 0,
          endMs: 9000,
          durationMs: 9000,
          parent: null,
          parallelGroup: 'g',
          result: 'ok',
        },
      ],
      10000,
    );
    expect(summary.overpassAggregateMs).toBe(17000);
    expect(summary.overpassWallMs).toBe(9000);
    expect(summary.overpassAggregateExceedsWall).toBe(true);
    expect(summary.longestOperationMs).toBe(9000);
  });

  it('trace finish attaches fallbackTimeline when session active', () => {
    beginFallbackTimeline();
    markFallbackEvent('phase_a', 'a', 'no_shared_lake');
    const b = beginRouteTrace(
      [
        { lon: 1, lat: 1 },
        { lon: 2, lat: 2 },
      ],
      1,
    );
    b.perf = createRoutePerfCounters();
    const tr = b.finish({
      ok: false,
      method: 'route_not_found',
      lengthKm: 0,
      rejectReason: 'route_not_found',
      waterName: null,
    });
    expect(tr.fallbackTimeline).toBeDefined();
    expect(tr.fallbackTimeline!.events.length).toBeGreaterThan(0);
  });
});
