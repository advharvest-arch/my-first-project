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
import {
  MAX_OPEN_WATER_SNAP_DISTANCE_METERS,
  MAX_WATER_SNAP_DISTANCE_METERS,
  endpointReachToOriginals,
  maxOpenWaterSnapKm,
  maxSnapKmForMethod,
  maxWaterSnapKm,
} from '../water-snap';

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

describe('MAX_WATER_SNAP_DISTANCE_METERS', () => {
  it('is 3000 m (live residual analysis: working ≤2.52 km, Vetluga miss ~7.4 km)', () => {
    expect(MAX_WATER_SNAP_DISTANCE_METERS).toBe(3000);
    expect(maxWaterSnapKm()).toBe(3);
  });

  it('keeps a wider open-water reach so reservoirs are not rejected', () => {
    expect(MAX_OPEN_WATER_SNAP_DISTANCE_METERS).toBeGreaterThan(MAX_WATER_SNAP_DISTANCE_METERS);
    expect(maxSnapKmForMethod('lake')).toBe(maxOpenWaterSnapKm());
    expect(maxSnapKmForMethod('waterway')).toBe(maxWaterSnapKm());
  });
});

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

describe('endpoint reach to original START/FINISH', () => {
  it('START/FINISH on river track within MAX snap → success', () => {
    const a = VOLGA_NAV_FAIRWAY[10]!;
    const b = VOLGA_NAV_FAIRWAY[40]!;
    const slice = VOLGA_NAV_FAIRWAY.slice(10, 41);
    const reach = endpointReachToOriginals(slice, [a, b], maxWaterSnapKm());
    expect(reach.ok).toBe(true);
    const v = validateWaterRoute(slice, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(slice),
      method: 'waterway',
    });
    expect(v.ok).toBe(true);
  });

  it('START/FINISH slightly aside (≤ MAX) → still reachable', () => {
    const a = VOLGA_NAV_FAIRWAY[20]!;
    const b = VOLGA_NAV_FAIRWAY[30]!;
    const slice = VOLGA_NAV_FAIRWAY.slice(20, 31);
    // ~1.5 km offset (~0.02° lat)
    const start = p(a.lon, a.lat + 0.012);
    const finish = p(b.lon, b.lat - 0.01);
    const reach = endpointReachToOriginals(slice, [start, finish], maxWaterSnapKm());
    expect(reach.startKm).toBeLessThanOrEqual(maxWaterSnapKm());
    expect(reach.finishKm).toBeLessThanOrEqual(maxWaterSnapKm());
    expect(reach.ok).toBe(true);
  });

  it('START/FINISH too far from routing ends → endpoints_far / not reachable', () => {
    const a = VOLGA_NAV_FAIRWAY[20]!;
    const b = VOLGA_NAV_FAIRWAY[30]!;
    const slice = VOLGA_NAV_FAIRWAY.slice(20, 31);
    // ~8–10 km inland from ends
    const start = p(a.lon + 0.12, a.lat + 0.08);
    const finish = p(b.lon - 0.12, b.lat - 0.08);
    const reach = endpointReachToOriginals(slice, [start, finish], maxWaterSnapKm());
    expect(reach.ok).toBe(false);
    const v = validateWaterRoute(slice, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(slice),
      method: 'waterway',
    });
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('endpoints_far');
  });

  /**
   * Regression: Volga → Vetluga intent.
   * Track that stays on the Volga stem and finishes ~7 km from the requested
   * tributary approach must NOT validate as a successful water route.
   */
  it('Volga → Vetluga: stem finish far from tributary FINISH → fail', () => {
    const start = p(44.0, 56.33); // Nizhny / Volga
    const finish = p(45.05, 56.15); // Vetluga-mouth intent
    // Synthetic stem track ending near Volga SE of the requested finish (audit: ~7.4 km).
    const stemFinish = p(45.133, 56.102);
    const stemTrack: LngLat[] = [
      start,
      p(44.15, 56.28),
      p(44.32, 56.17),
      p(44.55, 56.07),
      p(44.77, 56.06),
      p(44.93, 56.07),
      stemFinish,
    ];
    const reach = endpointReachToOriginals(stemTrack, [start, finish], maxWaterSnapKm());
    expect(reach.finishKm).toBeGreaterThan(maxWaterSnapKm());
    expect(reach.ok).toBe(false);

    const v = validateWaterRoute(stemTrack, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(stemTrack),
      method: 'waterway',
    });
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('endpoints_far');
  });

  it('FINISH on tributary branch that the track actually reaches → success', () => {
    const start = p(44.0, 56.33);
    const finish = p(45.05, 56.15);
    // Meandering track that ends on the requested tributary approach
    // (not a near-geodesic chord across land).
    const track: LngLat[] = [
      start,
      p(44.12, 56.34),
      p(44.22, 56.3),
      p(44.28, 56.24),
      p(44.35, 56.18),
      p(44.48, 56.16),
      p(44.62, 56.2),
      p(44.75, 56.17),
      p(44.88, 56.14),
      p(44.98, 56.16),
      finish,
    ];
    const reach = endpointReachToOriginals(track, [start, finish], maxWaterSnapKm());
    expect(reach.ok).toBe(true);
    expect(reach.finishKm).toBeLessThanOrEqual(0.05);
    const v = validateWaterRoute(track, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(track),
      method: 'waterway',
    });
    expect(v.ok).toBe(true);
    expect(v.issues).not.toContain('endpoints_far');
  });
});

describe('open water must not break on river snap radius', () => {
  it('lake method allows finish residual beyond river MAX snap', () => {
    const a = p(48.42, 54.36);
    const b = p(48.55, 54.4);
    // Fairway end ~6.5 km from open-water click (audit residual).
    const track = [a, p(48.48, 54.38), p(48.52, 54.39), p(48.48, 54.45)];
    const riverReach = endpointReachToOriginals(track, [a, b], maxWaterSnapKm());
    expect(riverReach.ok).toBe(false);
    const lakeReach = endpointReachToOriginals(track, [a, b], maxOpenWaterSnapKm());
    expect(lakeReach.ok).toBe(true);
    const v = validateWaterRoute(track, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(track),
      method: 'lake',
    });
    expect(v.issues).not.toContain('endpoints_far');
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
    const chord = [
      p(37.1, 56.74),
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

describe('Volga–Baltic / stitch helpers', () => {
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

  it('Volga–Baltic fairway-style track within MAX snap still validates', () => {
    // Rybinsk lock area → Cherepovets approach (compressed pins).
    const a = p(38.72, 58.07);
    const b = p(37.95, 59.1);
    const track = [
      a,
      p(38.65, 58.3),
      p(38.4, 58.55),
      p(38.1, 58.8),
      p(37.95, 59.0),
      b,
    ];
    const reach = endpointReachToOriginals(track, [a, b], maxWaterSnapKm());
    expect(reach.ok).toBe(true);
  });
});

function haversineNear(target: LngLat, path: LngLat[], km = 0.12): boolean {
  return path.some((q) => {
    const dlon = (q.lon - target.lon) * 111 * Math.cos((target.lat * Math.PI) / 180);
    const dlat = (q.lat - target.lat) * 111;
    return Math.hypot(dlon, dlat) <= km;
  });
}
