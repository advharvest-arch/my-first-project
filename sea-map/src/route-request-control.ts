/**
 * USER_TEST_DIAGNOSTICS_01 — route request lifecycle for UI busy/clear races.
 * Does not change routing algorithms; only coordinates in-flight UI requests.
 */

export type RouteLifecycleEvent =
  | 'RESET'
  | 'REQUEST_START'
  | 'REQUEST_BUSY_COLLAPSE'
  | 'REQUEST_END'
  | 'REQUEST_STALE_END'
  | 'REQUEST_ERROR';

export type RouteLifecycleRecord = {
  atMs: number;
  event: RouteLifecycleEvent;
  token: number;
  detail?: string;
};

const DEV_LOG_LIMIT = 32;

/**
 * Serializes UI route builds so Clear/Reset can invalidate in-flight work
 * without leaving `busy` stuck or applying stale status/geometry.
 */
export class RouteRequestControl {
  private token = 0;
  busy = false;
  pendingRebuild = false;
  private lifecycle: RouteLifecycleRecord[] = [];

  private push(event: RouteLifecycleEvent, detail?: string): void {
    this.lifecycle.push({
      atMs: Date.now(),
      event,
      token: this.token,
      detail,
    });
    while (this.lifecycle.length > DEV_LOG_LIMIT) this.lifecycle.shift();
  }

  /** Begin a new in-flight build. Caller must only call when !busy. */
  begin(detail?: string): number {
    this.token += 1;
    this.busy = true;
    this.pendingRebuild = false;
    this.push('REQUEST_START', detail);
    return this.token;
  }

  isCurrent(token: number): boolean {
    return token === this.token;
  }

  /** Another BUILD arrived while busy — coalesce into one follow-up. */
  noteBusyCollapse(detail?: string): void {
    this.pendingRebuild = true;
    this.push('REQUEST_BUSY_COLLAPSE', detail);
  }

  /**
   * Clear / Reset: drop busy, cancel pending rebuild, invalidate in-flight token
   * so stale completions do not rewrite status/geometry.
   */
  reset(detail?: string): void {
    this.token += 1;
    this.busy = false;
    this.pendingRebuild = false;
    this.push('RESET', detail);
  }

  /**
   * Finish an in-flight build. Returns whether a coalesced rebuild should run.
   * Stale tokens (after reset) never rebuild and never leave busy stuck.
   */
  end(token: number, opts?: { error?: boolean; detail?: string }): { shouldRebuild: boolean } {
    if (token !== this.token) {
      this.push(opts?.error ? 'REQUEST_ERROR' : 'REQUEST_STALE_END', opts?.detail);
      // If a reset already cleared busy, keep it false.
      return { shouldRebuild: false };
    }
    this.busy = false;
    this.push(opts?.error ? 'REQUEST_ERROR' : 'REQUEST_END', opts?.detail);
    if (this.pendingRebuild) {
      this.pendingRebuild = false;
      return { shouldRebuild: true };
    }
    return { shouldRebuild: false };
  }

  getLifecycle(): readonly RouteLifecycleRecord[] {
    return this.lifecycle;
  }

  clearLifecycle(): void {
    this.lifecycle.length = 0;
  }
}
