/**
 * Monotonic stamp so in-flight polish cannot re-apply after a newer outcome
 * (e.g. route_not_found cleared the map).
 */
export class RouteAsyncGeneration {
  private n = 0;

  /** Begin polish for a successful route; returns the stamp for that job. */
  begin(): number {
    this.n += 1;
    return this.n;
  }

  /** Supersede in-flight polish (definitive route_not_found / clear). */
  invalidate(): void {
    this.n += 1;
  }

  isCurrent(stamp: number): boolean {
    return stamp === this.n;
  }
}
