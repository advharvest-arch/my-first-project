import { describe, expect, it } from 'vitest';
import type { LngLat } from '../geo';
import {
  connectingLocks,
  findHydraulicSitesNearPath,
  getHydraulicSiteBySeedId,
  listHydraulicSites,
  siteBarrierPolylines,
} from '../hydro-index';
import {
  classifyHydraulicCrossing,
  type HydraulicBarrier,
  type NavigableLock,
} from '../hydro-barriers';

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

function siteToDetector(site: NonNullable<ReturnType<typeof getHydraulicSiteBySeedId>>): {
  barriers: HydraulicBarrier[];
  locks: NavigableLock[];
} {
  const lockIds = site.locks.map((l) => l.id);
  const barriers: HydraulicBarrier[] = siteBarrierPolylines(site).map((geometry, i) => ({
    id: `${site.id}-barrier-${i}`,
    type: 'dam' as const,
    geometry: geometry.slice(),
    nearbyLocks: lockIds,
  }));
  const locks: NavigableLock[] = site.locks.map((l) => ({
    id: l.id,
    geometry: l.chamber,
    approachGeometry: l.approach.length ? l.approach : undefined,
    boat: l.boat,
    cemT: l.cemT,
    navigable: true,
  }));
  return { barriers, locks };
}

/** Short N–S chord through the midpoint of a crest polyline (geometry only). */
function chordAcrossPolyline(line: LngLat[]): LngLat[] {
  const mid = line[Math.floor(line.length / 2)]!;
  return [p(mid.lon, mid.lat - 0.02), p(mid.lon, mid.lat), p(mid.lon, mid.lat + 0.02)];
}

describe('hydro-index (bundled OSM extract)', () => {
  it('loads cascade sites with spatial lookup', () => {
    const sites = listHydraulicSites();
    expect(sites.length).toBeGreaterThanOrEqual(8);
    const near = findHydraulicSitesNearPath([p(38.82, 58.09), p(38.71, 58.1)], {
      padKm: 5,
    });
    expect(near.some((s) => s.source.seedId === 'seed-rybinsk')).toBe(true);
  });

  it('Rybinsk: old dam chord finds site', () => {
    const site = getHydraulicSiteBySeedId('seed-rybinsk');
    expect(site).toBeTruthy();
    expect(site!.damCrest.length).toBeGreaterThan(0);
    expect(site!.pressureFront.length).toBeGreaterThan(0);
    expect(site!.locks.length).toBeGreaterThan(0);

    // Historical open-water tip near the HPP body — spatial hit only.
    const historicalChord = [
      p(38.8559, 58.049),
      p(38.821867, 58.088214),
      p(38.823371, 58.095732),
      p(38.821867, 58.104336),
      p(38.7, 58.2),
    ];
    const found = findHydraulicSitesNearPath(historicalChord, { padKm: 5 });
    expect(found.some((s) => s.source.seedId === 'seed-rybinsk')).toBe(true);

    // Crossing classification uses index crest geometry (first eastern-body crest).
    const crest = site!.damCrest[0];
    expect(crest && crest.length >= 2).toBe(true);
    const { barriers, locks } = siteToDetector(site!);
    const result = classifyHydraulicCrossing(chordAcrossPolyline(crest!), barriers, locks);
    expect(result.class).not.toBe('legal_lock_passage');
    expect(['illegal_dam_crossing', 'barrier_without_lock']).toContain(result.class);
  });

  it('Rybinsk: lock route finds site + connecting lock candidate', () => {
    const site = getHydraulicSiteBySeedId('seed-rybinsk');
    expect(site).toBeTruthy();
    expect(connectingLocks(site!).length).toBeGreaterThan(0);

    const lockRoute = [
      p(38.8559, 58.049),
      p(38.74102, 58.091227),
      p(38.730214, 58.094791),
      p(38.714532, 58.098713),
      p(38.708493, 58.099766),
      p(38.678077, 58.10689),
      p(38.653098, 58.127862),
      p(37.95, 59.1),
    ];
    const found = findHydraulicSitesNearPath(lockRoute, { padKm: 5 });
    expect(found.some((s) => s.source.seedId === 'seed-rybinsk')).toBe(true);

    const { barriers, locks } = siteToDetector(site!);
    // Site is a candidate; lock chamber is among detector locks.
    expect(locks.some((l) => l.id === 'w117122422' || l.id === 'w117122424')).toBe(true);
    const result = classifyHydraulicCrossing(lockRoute, barriers, locks);
    // May be legal or no_barrier/beside depending on which crest polyline is primary;
    // must not falsely mark the lock corridor as illegal crest ride.
    expect(result.class).not.toBe('illegal_dam_crossing');
  });

  it('Dubna: dam chord finds site; lock corridor has lock candidate', () => {
    const site = getHydraulicSiteBySeedId('seed-ivanovo');
    expect(site).toBeTruthy();
    expect(site!.source.confidence).toBe('high');
    expect(connectingLocks(site!).length).toBeGreaterThan(0);

    const damChord = [p(37.1, 56.73), p(37.137, 56.7395), p(37.19, 56.75)];
    expect(
      findHydraulicSitesNearPath(damChord, { padKm: 5 }).some(
        (s) => s.source.seedId === 'seed-ivanovo',
      ),
    ).toBe(true);

    const { barriers, locks } = siteToDetector(site!);
    const bad = classifyHydraulicCrossing(damChord, barriers, locks);
    expect(['illegal_dam_crossing', 'barrier_without_lock']).toContain(bad.class);

    const lockPath = [
      p(37.1, 56.73),
      p(37.12, 56.729),
      p(37.1374, 56.7343),
      p(37.1395, 56.7395),
      p(37.1417, 56.742),
      p(37.15, 56.75),
    ];
    const good = classifyHydraulicCrossing(lockPath, barriers, locks);
    expect(good.class).not.toBe('illegal_dam_crossing');
    expect(locks.length).toBeGreaterThan(0);
  });

  it('route beside site → site found, crossing=false preferred', () => {
    const site = getHydraulicSiteBySeedId('seed-rybinsk');
    expect(site).toBeTruthy();
    // South of the complex, same lon band — near but not straddling.
    const beside = [p(38.75, 58.05), p(38.8, 58.055), p(38.85, 58.05)];
    const found = findHydraulicSitesNearPath(beside, { padKm: 8 });
    expect(found.some((s) => s.source.seedId === 'seed-rybinsk')).toBe(true);
    const { barriers, locks } = siteToDetector(site!);
    const result = classifyHydraulicCrossing(beside, barriers, locks);
    expect(result.class).not.toBe('illegal_dam_crossing');
    expect(['beside_barrier', 'no_barrier']).toContain(result.class);
  });

  it('unknown synthetic site does not depend on place names', () => {
    // Detector path still name-agnostic; index lookup by geometry only.
    const far = [p(10.0, 10.0), p(10.1, 10.1)];
    expect(findHydraulicSitesNearPath(far, { padKm: 5 })).toHaveLength(0);

    const barriers: HydraulicBarrier[] = [
      {
        id: 'anon-dam',
        type: 'dam',
        geometry: [p(20.0, 30.0), p(20.05, 30.0), p(20.1, 30.0)],
      },
    ];
    const locks: NavigableLock[] = [
      {
        id: 'anon-lock',
        boat: 'yes',
        geometry: [p(20.048, 29.996), p(20.048, 30.004)],
        approachGeometry: [p(20.048, 29.988), p(20.048, 29.996), p(20.048, 30.004), p(20.048, 30.012)],
      },
    ];
    const legal = [
      p(20.05, 29.985),
      p(20.048, 29.988),
      p(20.048, 30.0),
      p(20.048, 30.012),
      p(20.05, 30.02),
    ];
    expect(classifyHydraulicCrossing(legal, barriers, locks).class).toBe('legal_lock_passage');
  });

  it('metadata labels are optional and unused by lookup', () => {
    const site = getHydraulicSiteBySeedId('seed-ivanovo');
    expect(site?.metadata?.label).toBeTruthy();
    // Lookup works by seedId / bbox, not by label string matching.
    expect(getHydraulicSiteBySeedId('Dubna / Ivankovo')).toBeNull();
  });
});
