/**
 * Phase A/B — verified open-water accept + shared-lake BRouter lake method.
 */
import { describe, expect, it } from 'vitest';
import { pathLengthKm, type LngLat } from '../geo';
import { densifyOpenWaterPath } from '../open-lake';
import {
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
  VOLGA_STEM_CHAIN,
  DUBNA_LOCK_CORRIDOR,
  hasIllegalBarrierCrossing,
} from '../routing-rules';
import { validateWaterRoute } from '../validate-water-route';
import {
  MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM,
  MAX_SHARED_LAKE_BROUTER_KM,
  chooseBrouterWaterMethod,
  endpointReachToOriginals,
  endpointSnapKmForAccept,
  maxOpenWaterSnapKm,
  maxWaterSnapKm,
} from '../water-snap';
import { hydroHighConfidenceRejects } from '../hydro-gate';

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

function densify(points: LngLat[], stepKm = 8): LngLat[] {
  if (points.length < 2) return points.slice();
  const out: LngLat[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dlon = (b.lon - a.lon) * 111 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
    const dlat = (b.lat - a.lat) * 111;
    const d = Math.hypot(dlon, dlat);
    const n = Math.max(0, Math.floor(d / stepKm) - 1);
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
    }
    out.push(b);
  }
  return out;
}

describe('Phase A — openWaterVerified guard', () => {
  it('rejects unverified open chord as near_geodesic / geometry_gap (dry-land guard)', () => {
    const a = p(38.1, 58.4);
    const b = p(38.6, 58.35);
    const chord = [a, b];
    const v = validateWaterRoute(chord, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(chord),
      method: 'lake',
    });
    expect(v.ok).toBe(false);
    expect(
      v.issues.some((i) => i === 'near_geodesic_chord' || i === 'geometry_gap'),
    ).toBe(true);
  });

  it('Rybinsk mid↔mid verified densified chord → accept (no dry-land reject)', () => {
    const a = p(38.1, 58.4);
    const b = p(38.6, 58.35);
    const densified = densifyOpenWaterPath([a, b], 1.5);
    expect(densified.length).toBeGreaterThan(2);
    const v = validateWaterRoute(densified, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(densified),
      method: 'lake',
      openWaterVerified: true,
    });
    expect(v.issues).not.toContain('near_geodesic_chord');
    expect(v.issues).not.toContain('geometry_gap');
    expect(v.issues).not.toContain('endpoints_far');
    // Away from Rybinsk dam crest — hydro should not reject mid-pool.
    expect(v.issues).not.toContain('illegal_barrier');
    expect(v.ok).toBe(true);
  });

  it('Ilmen / Beloye / Ladoga short verified chords → accept', () => {
    const cases: Array<[LngLat, LngLat]> = [
      [p(31.15, 58.3), p(31.55, 58.28)], // Ilmen
      [p(37.3, 60.15), p(37.85, 60.15)], // Beloye
      [p(31.0, 60.5), p(31.4, 60.7)], // Ladoga short
    ];
    for (const [a, b] of cases) {
      const densified = densifyOpenWaterPath([a, b], 1.5);
      const v = validateWaterRoute(densified, {
        waypoints: [a, b],
        lengthKm: pathLengthKm(densified),
        method: 'lake',
        openWaterVerified: true,
      });
      expect(v.ok).toBe(true);
    }
  });

  it('unverified Moscow→Tula land chord still fails', () => {
    const a = p(37.6173, 55.7558);
    const b = p(37.6173, 54.1931);
    const chord = densify([a, p(37.6173, 55.5), b], 15);
    const v = validateWaterRoute(chord, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(chord),
      method: 'waterway',
    });
    expect(v.ok).toBe(false);
    expect(
      v.issues.some((i) => i === 'near_geodesic_chord' || i === 'river_chord'),
    ).toBe(true);
  });

  it('openWaterVerified does not skip hydro / KNOWN_BARRIERS dam reject', () => {
    // Historical Rybinsk dam chord (east of locks).
    const dam = densifyOpenWaterPath(
      densify(
        [
          p(38.8558908, 58.0489536),
          p(38.821867, 58.088214),
          p(38.823371, 58.095732),
          p(38.821867, 58.104336),
          p(38.4, 58.55),
        ],
        4,
      ),
      1.5,
    );
    expect(hasIllegalBarrierCrossing(dam) || hydroHighConfidenceRejects(dam)).toBe(true);
    const v = validateWaterRoute(dam, {
      waypoints: [dam[0]!, dam.at(-1)!],
      lengthKm: pathLengthKm(dam),
      method: 'lake',
      openWaterVerified: true,
    });
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('illegal_barrier');
  });
});

describe('Phase B — shared-lake BRouter lake method', () => {
  it('chooseBrouterWaterMethod: shared ≤150 km → lake; over cap / no share → waterway', () => {
    expect(chooseBrouterWaterMethod(true, 30)).toBe('lake');
    expect(chooseBrouterWaterMethod(true, 113)).toBe('lake');
    expect(chooseBrouterWaterMethod(true, MAX_SHARED_LAKE_BROUTER_KM)).toBe('lake');
    expect(chooseBrouterWaterMethod(true, MAX_SHARED_LAKE_BROUTER_KM + 1)).toBe('waterway');
    expect(chooseBrouterWaterMethod(false, 40)).toBe('waterway');
    expect(chooseBrouterWaterMethod(true, 40, 1)).toBe('waterway');
  });

  it('endpointSnapKmForAccept: Phase A 10 km; Phase B shared-lake 5.5 km; waterway 3 km', () => {
    expect(endpointSnapKmForAccept('lake', true)).toBe(maxOpenWaterSnapKm());
    expect(endpointSnapKmForAccept('lake', false)).toBe(MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM);
    expect(endpointSnapKmForAccept('waterway', false)).toBe(maxWaterSnapKm());
    expect(MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM).toBeLessThan(7.4);
    expect(MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM).toBeGreaterThan(4.2);
  });

  it('Cheboksary-like residuals: waterway fail, Phase B lake accept under 5.5 km', () => {
    const a = p(45.45, 56.35);
    const b = p(47.25, 56.14);
    // Meandering reservoir track (not a land chord) with ~4 km endpoint residuals.
    const start = p(45.5, 56.32);
    const end = p(47.3, 56.11);
    const track = densify(
      [
        start,
        p(45.7, 56.4),
        p(45.95, 56.25),
        p(46.3, 56.35),
        p(46.55, 56.12),
        p(46.9, 56.28),
        p(47.1, 56.08),
        end,
      ],
      6,
    );
    const phaseBSnap = endpointSnapKmForAccept('lake', false);
    const reach3 = endpointReachToOriginals(track, [a, b], maxWaterSnapKm());
    const reachPhaseB = endpointReachToOriginals(track, [a, b], phaseBSnap);
    expect(reach3.ok).toBe(false);
    expect(reachPhaseB.ok).toBe(true);
    expect(Math.max(reachPhaseB.startKm, reachPhaseB.finishKm)).toBeLessThanOrEqual(
      MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM,
    );

    const asWaterway = validateWaterRoute(track, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(track),
      method: 'waterway',
    });
    expect(asWaterway.ok).toBe(false);
    expect(asWaterway.issues).toContain('endpoints_far');

    // Unverified lake = Phase B ceiling (not full 10 km).
    const asLake = validateWaterRoute(track, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(track),
      method: 'lake',
    });
    expect(asLake.issues).not.toContain('endpoints_far');
    expect(asLake.ok).toBe(true);
  });

  it('Rybinsk mid→lock-like track: Phase B lake method accepts; dam chord still illegal', () => {
    const a = p(38.4, 58.3);
    const b = p(38.72, 58.05);
    const lockTrack = densify(
      [
        p(38.42, 58.28),
        p(38.5, 58.2),
        p(38.65, 58.13),
        RYBINSK_LOCK_11,
        RYBINSK_LOCK,
        RYBINSK_LOCK_12,
        p(38.73, 58.06),
      ],
      6,
    );
    const reachPhaseB = endpointReachToOriginals(
      lockTrack,
      [a, b],
      endpointSnapKmForAccept('lake', false),
    );
    expect(reachPhaseB.ok).toBe(true);
    const v = validateWaterRoute(lockTrack, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(lockTrack),
      method: 'lake',
    });
    expect(v.issues).not.toContain('endpoints_far');
    expect(v.issues).not.toContain('illegal_barrier');
    expect(hasIllegalBarrierCrossing(lockTrack)).toBe(false);
  });

  it('Volga→Vetluga stem miss: Phase B lake reject (regression) + waterway reject', () => {
    // Live bug: both ends inside giant Чебоксарское bbox → method=lake;
    // residual ~7.44 km passed full open-water 10 km snap. Must fail under
    // Phase B 5.5 km ceiling while still failing under river 3 km.
    const start = p(44.0, 56.33);
    const finish = p(45.05, 56.15);
    const stemFinish = p(45.133, 56.102);
    const stemTrack = densify(
      [
        start,
        p(44.15, 56.28),
        p(44.32, 56.17),
        p(44.55, 56.07),
        p(44.77, 56.06),
        p(44.93, 56.07),
        stemFinish,
      ],
      8,
    );
    const residual = endpointReachToOriginals(
      stemTrack,
      [start, finish],
      maxOpenWaterSnapKm(),
    );
    expect(residual.finishKm).toBeGreaterThan(7);
    expect(residual.finishKm).toBeLessThan(8);
    expect(residual.finishKm).toBeGreaterThan(MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM);
    // Old bug: full open snap would accept.
    expect(residual.ok).toBe(true);

    const reachPhaseB = endpointReachToOriginals(
      stemTrack,
      [start, finish],
      endpointSnapKmForAccept('lake', false),
    );
    expect(reachPhaseB.ok).toBe(false);

    const asPhaseBLake = validateWaterRoute(stemTrack, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(stemTrack),
      method: 'lake',
    });
    expect(asPhaseBLake.ok).toBe(false);
    expect(asPhaseBLake.issues).toContain('endpoints_far');

    // Phase A verified would still allow 10 km — this case is not Phase A.
    const asPhaseA = validateWaterRoute(stemTrack, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(stemTrack),
      method: 'lake',
      openWaterVerified: true,
    });
    expect(asPhaseA.issues).not.toContain('endpoints_far');

    const asWaterway = validateWaterRoute(stemTrack, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(stemTrack),
      method: 'waterway',
    });
    expect(asWaterway.ok).toBe(false);
    expect(asWaterway.issues).toContain('endpoints_far');
  });

  it('control corridors remain free of illegal_barrier (Myshkin / Ostashkov–Kazan / Dubna)', () => {
    const myshkin = densify(
      [p(38.4516, 57.7847), p(38.65, 57.92), p(38.8558908, 58.0489536)],
      10,
    );
    expect(
      validateWaterRoute(myshkin, {
        waypoints: [myshkin[0]!, myshkin.at(-1)!],
        lengthKm: pathLengthKm(myshkin),
        method: 'waterway',
      }).issues,
    ).not.toContain('illegal_barrier');

    const ostKazan = densify(
      [
        p(33.080173, 57.438374),
        VOLGA_STEM_CHAIN[0]!,
        VOLGA_STEM_CHAIN[1]!,
        ...DUBNA_LOCK_CORRIDOR,
        VOLGA_STEM_CHAIN[3]!,
        RYBINSK_LOCK,
        VOLGA_STEM_CHAIN[5]!,
        VOLGA_STEM_CHAIN[8]!,
        VOLGA_STEM_CHAIN[9]!,
        VOLGA_STEM_CHAIN[11]!,
        VOLGA_STEM_CHAIN[12]!,
        p(49.1221, 55.7887),
      ],
      12,
    );
    expect(
      validateWaterRoute(ostKazan, {
        waypoints: [ostKazan[0]!, ostKazan.at(-1)!],
        lengthKm: pathLengthKm(ostKazan),
        method: 'waterway',
      }).issues,
    ).not.toContain('illegal_barrier');

    const dubna = densify(DUBNA_LOCK_CORRIDOR, 0.5);
    expect(hasIllegalBarrierCrossing(dubna)).toBe(false);
    expect(
      validateWaterRoute(dubna, {
        waypoints: [dubna[0]!, dubna.at(-1)!],
        lengthKm: pathLengthKm(dubna),
        method: 'waterway',
      }).issues,
    ).not.toContain('illegal_barrier');
  });
});
