import { describe, expect, it } from 'vitest';
import { pathLengthKm, type LngLat } from '../geo';
import { dedupeRoutePoints, hasGeometryGap } from '../route-geometry';
import {
  DUBNA_LOCK_CORRIDOR,
  DUBNA_LOCK_LOWER,
  DUBNA_LOCK_UPPER,
  VOLGA_NAV_FAIRWAY,
  VOLGA_STEM_CHAIN,
  crossesDubnaBarrier,
  hasIllegalBarrierCrossing,
  looksLikeSkippingDubnaLock,
  passesDubnaLockProperly,
  repairDubnaLockPassage,
} from '../routing-rules';
import { validateWaterRoute } from '../validate-water-route';

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

describe('direct is never a valid water route', () => {
  it('rejects method=direct', () => {
    const v = validateWaterRoute([p(37.5, 55.7), p(37.6, 55.8)], {
      waypoints: [p(37.5, 55.7), p(37.6, 55.8)],
      method: 'direct',
    });
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('direct_forbidden');
  });

  it('rejects empty route_not_found', () => {
    const v = validateWaterRoute([], {
      waypoints: [p(37.5, 55.7), p(37.6, 55.8)],
      method: 'route_not_found',
    });
    expect(v.ok).toBe(false);
  });

  it('rejects near-geodesic START→FINISH chord', () => {
    const a = p(44.0, 56.33);
    const b = p(47.25, 56.15);
    const v = validateWaterRoute([a, b], {
      waypoints: [a, b],
      method: 'waterway',
    });
    expect(v.ok).toBe(false);
    expect(v.issues.some((i) => i === 'near_geodesic_chord' || i === 'too_few_points')).toBe(
      true,
    );
  });
});

describe('Volga fairway geometry', () => {
  it('accepts a meandering Volga fairway slice', () => {
    const a = VOLGA_NAV_FAIRWAY[10]!;
    const b = VOLGA_NAV_FAIRWAY[40]!;
    const slice = VOLGA_NAV_FAIRWAY.slice(10, 41);
    const v = validateWaterRoute(slice, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(slice),
      method: 'waterway',
    });
    expect(v.ok).toBe(true);
  });

  it('keeps stem chain pins ordered west→east', () => {
    for (let i = 1; i < VOLGA_STEM_CHAIN.length; i++) {
      expect(VOLGA_STEM_CHAIN[i]!.lon).toBeGreaterThanOrEqual(
        VOLGA_STEM_CHAIN[i - 1]!.lon - 0.5,
      );
    }
  });
});

describe('Dubna lock №1 (regression)', () => {
  it('detects dam chord across Иваньковская плотина', () => {
    // North-of-lock chord that crosses the dam crest.
    const chord = [
      p(37.10, 56.74),
      p(37.13, 56.739),
      p(37.145, 56.74),
      p(37.19, 56.745),
    ];
    expect(crossesDubnaBarrier(chord)).toBe(true);
    expect(passesDubnaLockProperly(chord)).toBe(false);
    expect(looksLikeSkippingDubnaLock(chord)).toBe(true);
    expect(hasIllegalBarrierCrossing(chord)).toBe(true);
  });

  it('accepts the OSM lock corridor as a valid passage', () => {
    expect(passesDubnaLockProperly(DUBNA_LOCK_CORRIDOR)).toBe(true);
    expect(hasIllegalBarrierCrossing(DUBNA_LOCK_CORRIDOR)).toBe(false);
    expect(haversineNear(DUBNA_LOCK_UPPER, DUBNA_LOCK_CORRIDOR)).toBe(true);
    expect(haversineNear(DUBNA_LOCK_LOWER, DUBNA_LOCK_CORRIDOR)).toBe(true);
  });

  it('repairDubnaLockPassage splices the lock corridor into a dam chord', () => {
    const bad = [
      p(37.08, 56.74),
      p(37.13, 56.7395),
      p(37.145, 56.74),
      p(37.22, 56.76),
    ];
    const fixed = repairDubnaLockPassage(bad);
    expect(fixed.length).toBeGreaterThan(bad.length);
    expect(passesDubnaLockProperly(fixed)).toBe(true);
    expect(hasIllegalBarrierCrossing(fixed)).toBe(false);
  });
});

describe('Volga–Baltic / tributary / long stitch helpers', () => {
  it('dedupes joint duplicates after split merge', () => {
    const a = p(38.7, 58.1);
    const b = p(38.71, 58.11);
    const merged = dedupeRoutePoints([a, a, a, b, b]);
    expect(merged).toHaveLength(2);
  });

  it('flags geometry gaps on broken long stitches', () => {
    const pts = [p(33.0, 57.4), p(33.1, 57.41), p(46.7, 59.4)];
    expect(hasGeometryGap(pts, 25)).toBe(true);
  });

  it('rejects endpoints far from the requested corridor', () => {
    const waypoints = [p(37.5, 55.75), p(37.6, 55.8)];
    const track = [p(44.0, 56.3), p(44.1, 56.31), p(44.2, 56.32)];
    const v = validateWaterRoute(track, {
      waypoints,
      method: 'waterway',
      endpointSnapKm: 5,
    });
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('endpoints_far');
  });

  it('START/FINISH near river but not on it still need a water track', () => {
    // Short geodesic between two points near the fairway — validator requires
    // a real water track (waterProximity samples far from water → reject).
    const pin = VOLGA_NAV_FAIRWAY[20]!;
    const a = p(pin.lon + 0.02, pin.lat + 0.01);
    const b = p(pin.lon + 0.35, pin.lat + 0.08);
    const chord = [a, b];
    const v = validateWaterRoute(chord, {
      waypoints: [a, b],
      method: 'waterway',
      waterProximity: {
        sampleDistKm: [2.5, 3.1, 2.8, 3.4, 2.9, 3.0],
        maxDistKm: 1.5,
        minFraction: 0.55,
      },
    });
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('not_on_water_network');
  });
});

function haversineNear(target: LngLat, path: LngLat[], km = 0.12): boolean {
  return path.some((q) => {
    const dlon = (q.lon - target.lon) * 111 * Math.cos((target.lat * Math.PI) / 180);
    const dlat = (q.lat - target.lat) * 111;
    return Math.hypot(dlon, dlat) <= km;
  });
}
