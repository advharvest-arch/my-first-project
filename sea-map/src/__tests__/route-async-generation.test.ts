/**
 * Regression: stale polish must not restore geometry after route_not_found.
 *
 * Mirrors main.ts apply gates (generation + busy) without mounting the DOM app.
 */
import { describe, expect, it } from 'vitest';
import { RouteAsyncGeneration } from '../route-async-generation';

type PathPts = { lat: number; lon: number }[];

describe('RouteAsyncGeneration (polish vs route_not_found race)', () => {
  it('stale polish must not restore geometry after definitive route_not_found', async () => {
    const gen = new RouteAsyncGeneration();
    let lastRoutePath: PathPts | null = [{ lat: 1, lon: 1 }];
    let lastRoutingPath: PathPts | null = [{ lat: 1, lon: 1 }];
    let busy = false;

    // success / current generation → async polish starts
    const polishGen = gen.begin();
    const polishedGeometry: PathPts = [{ lat: 9, lon: 9 }, { lat: 8, lon: 8 }];
    let resolvePolish!: (v: PathPts) => void;
    const polishPromise = new Promise<PathPts>((resolve) => {
      resolvePolish = resolve;
    });

    const applyPolishIfCurrent = async () => {
      const polished = await polishPromise;
      // Same gates as main.ts polish then-handler
      if (!gen.isCurrent(polishGen)) return;
      if (busy) return;
      lastRoutePath = polished;
      lastRoutingPath = polished;
    };
    const polishApply = applyPolishIfCurrent();

    // new request finishes with route_not_found → clear + invalidate (main.ts)
    busy = true;
    gen.invalidate();
    lastRoutePath = null;
    lastRoutingPath = null;
    busy = false;

    // old polish completes and tries to apply
    resolvePolish(polishedGeometry);
    await polishApply;

    expect(lastRoutePath).toBeNull();
    expect(lastRoutingPath).toBeNull();
    expect(gen.isCurrent(polishGen)).toBe(false);
  });

  it('current polish may still apply when generation was not invalidated', async () => {
    const gen = new RouteAsyncGeneration();
    let lastRoutePath: PathPts | null = [{ lat: 1, lon: 1 }];
    let busy = false;

    const polishGen = gen.begin();
    let resolvePolish!: (v: PathPts) => void;
    const polishPromise = new Promise<PathPts>((resolve) => {
      resolvePolish = resolve;
    });

    const polishApply = (async () => {
      const polished = await polishPromise;
      if (!gen.isCurrent(polishGen)) return;
      if (busy) return;
      lastRoutePath = polished;
    })();

    resolvePolish([{ lat: 2, lon: 2 }]);
    await polishApply;

    expect(lastRoutePath).toEqual([{ lat: 2, lon: 2 }]);
  });
});
