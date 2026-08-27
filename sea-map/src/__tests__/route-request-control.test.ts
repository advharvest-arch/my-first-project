/**
 * USER_TEST_DIAGNOSTICS_01 — unit tests for Clear/Reset busy lifecycle.
 */
import { describe, expect, it } from 'vitest';
import { RouteRequestControl } from '../route-request-control';

describe('RouteRequestControl (RESET → BUILD race)', () => {
  it('Clear/reset while busy allows a fresh BUILD', () => {
    const ctl = new RouteRequestControl();
    const t1 = ctl.begin('first');
    expect(ctl.busy).toBe(true);

    ctl.reset('clear-btn');
    expect(ctl.busy).toBe(false);
    expect(ctl.pendingRebuild).toBe(false);
    expect(ctl.isCurrent(t1)).toBe(false);

    const t2 = ctl.begin('second');
    expect(ctl.busy).toBe(true);
    expect(ctl.isCurrent(t2)).toBe(true);

    const end1 = ctl.end(t1);
    expect(end1.shouldRebuild).toBe(false);
    // Stale end must not clear the newer in-flight busy flag.
    expect(ctl.busy).toBe(true);

    const end2 = ctl.end(t2);
    expect(end2.shouldRebuild).toBe(false);
    expect(ctl.busy).toBe(false);
  });

  it('busy collapse sets pendingRebuild; end triggers shouldRebuild', () => {
    const ctl = new RouteRequestControl();
    const t1 = ctl.begin('first');
    ctl.noteBusyCollapse('second-click');
    expect(ctl.pendingRebuild).toBe(true);
    const { shouldRebuild } = ctl.end(t1);
    expect(shouldRebuild).toBe(true);
    expect(ctl.busy).toBe(false);
    expect(ctl.pendingRebuild).toBe(false);
  });

  it('reset clears pendingRebuild so stale end does not rebuild into empty waypoints', () => {
    const ctl = new RouteRequestControl();
    const t1 = ctl.begin('first');
    ctl.noteBusyCollapse('second');
    ctl.reset('clear');
    expect(ctl.end(t1).shouldRebuild).toBe(false);
    expect(ctl.busy).toBe(false);
  });

  it('records lifecycle events for DEV diagnostics', () => {
    const ctl = new RouteRequestControl();
    const t1 = ctl.begin('a');
    ctl.reset('clear');
    const t2 = ctl.begin('b');
    ctl.end(t2);
    const events = ctl.getLifecycle().map((e) => e.event);
    expect(events).toContain('REQUEST_START');
    expect(events).toContain('RESET');
    expect(events).toContain('REQUEST_END');
    expect(ctl.isCurrent(t1)).toBe(false);
  });
});
