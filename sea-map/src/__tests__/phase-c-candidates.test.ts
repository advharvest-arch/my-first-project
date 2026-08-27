/**
 * Phase C — multi-candidate endpoint binding.
 */
import { describe, expect, it } from 'vitest';
import { haversineKm, pathLengthKm, type LngLat } from '../geo';
import { densifyOpenWaterPath } from '../open-lake';
import {
  PHASE_C_K,
  PHASE_C_MAX_PAIRS,
  PHASE_C_FAIRWAY_SEARCH_KM,
  PHASE_C_HYDRO_REJECT_SCORE,
  SOURCE_CLASS_PENALTY,
  candidateRank,
  diversifyCandidates,
  fairwayPinsNear,
  nearestFairwayDistKm,
  offFairwayStemPenalty,
  pairClassPenalty,
  selectPhaseCPairs,
  scoreAcceptedPhaseCRoute,
  sourceClassPenalty,
  towardAlignmentKm2,
  type WaterCandidate,
} from '../water-candidates';
import {
  MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM,
  MAX_SHARED_LAKE_BROUTER_KM,
  chooseBrouterWaterMethod,
  endpointSnapKmForAccept,
  maxOpenWaterSnapKm,
  maxWaterSnapKm,
} from '../water-snap';
import { validateWaterRoute } from '../validate-water-route';
import { hasIllegalBarrierCrossing } from '../routing-rules';
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

describe('Phase C — candidate helpers', () => {
  it('budget constants: k=3, max pairs=9', () => {
    expect(PHASE_C_K).toBe(3);
    expect(PHASE_C_MAX_PAIRS).toBe(9);
  });

  it('towardAlignment prefers destination-side pins', () => {
    const origin = p(49.0, 55.75); // Kazan-ish
    const toward = p(49.4, 53.55); // Tolyatti-ish (south)
    const south = p(49.05, 55.56);
    const north = p(49.05, 55.9);
    expect(towardAlignmentKm2(origin, south, toward)).toBeGreaterThan(
      towardAlignmentKm2(origin, north, toward),
    );
    expect(
      candidateRank(haversineKm(origin, south), origin, south, toward, 'waterway'),
    ).toBeLessThan(
      candidateRank(haversineKm(origin, north), origin, north, toward, 'waterway'),
    );
  });

  it('L02/L07 fairway pins exist within open-water search radius when near fairway', () => {
    // Near Volga fairway at Kazan / Tolyatti corridor ends.
    const kazan = p(49.05, 55.75);
    const tolyatti = p(49.4, 53.55); // live L07 finish — between fairway vertices
    const nearKazan = fairwayPinsNear(kazan, maxOpenWaterSnapKm(), tolyatti, 3);
    const nearTolyatti = fairwayPinsNear(tolyatti, maxOpenWaterSnapKm(), kazan, 3);
    expect(nearKazan.length).toBeGreaterThan(0);
    expect(nearTolyatti.length).toBeGreaterThan(0);
    expect(nearTolyatti[0]!.distKm).toBeLessThanOrEqual(12);
    // Destination bias: Tolyatti-side pin should sit in the south pool.
    expect(nearTolyatti[0]!.point.lat).toBeLessThan(54.0);
  });

  it('selectPhaseCPairs caps at 9 and skips original identity pair', () => {
    const a0 = p(38.35, 58.55);
    const b0 = p(37.95, 59.05);
    const mk = (pt: LngLat, source: WaterCandidate['source'], rank: number): WaterCandidate => ({
      point: pt,
      distKm: haversineKm(a0, pt),
      source,
      rank,
    });
    const candsA = [
      mk(a0, 'raw', 0),
      mk(p(38.4, 58.5), 'fairway', 1),
      mk(p(38.5, 58.4), 'waterway', 2),
    ];
    const candsB = [
      mk(b0, 'raw', 0),
      mk(p(38.0, 59.0), 'fairway', 1),
      mk(p(38.1, 58.9), 'waterway', 2),
    ];
    // Fix distKm for B-side
    for (const c of candsB) c.distKm = haversineKm(b0, c.point);
    const pairs = selectPhaseCPairs(candsA, candsB, a0, b0, PHASE_C_MAX_PAIRS);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThanOrEqual(9);
    expect(
      pairs.every(
        ([a, b]) => !(haversineKm(a.point, a0) < 0.15 && haversineKm(b.point, b0) < 0.15),
      ),
    ).toBe(true);
  });

  it('diversifyCandidates enforces separation', () => {
    const base = p(38.4, 58.3);
    const cands: WaterCandidate[] = [];
    for (let i = 0; i < 6; i++) {
      const pt = p(38.4 + i * 0.002, 58.3);
      cands.push({
        point: pt,
        distKm: haversineKm(base, pt),
        source: 'waterway',
        rank: i,
      });
    }
    const out = diversifyCandidates(cands, 3, 1.0);
    expect(out.length).toBeLessThanOrEqual(3);
    for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        expect(haversineKm(out[i]!.point, out[j]!.point)).toBeGreaterThanOrEqual(1.0);
      }
    }
  });

  it('scoreAcceptedPhaseCRoute ranks lower residual + detour better', () => {
    const good = scoreAcceptedPhaseCRoute(0.5, 0.5, 100, 90);
    const bad = scoreAcceptedPhaseCRoute(4, 4, 200, 90);
    expect(good).toBeLessThan(bad);
  });
});

describe('Phase D — class-weighted candidates (soft fairway preference)', () => {
  it('class order: fairway < mask < lake < waterway < raw', () => {
    expect(sourceClassPenalty('fairway')).toBeLessThan(sourceClassPenalty('mask'));
    expect(sourceClassPenalty('mask')).toBeLessThan(sourceClassPenalty('lake'));
    expect(sourceClassPenalty('lake')).toBeLessThan(sourceClassPenalty('waterway'));
    expect(sourceClassPenalty('waterway')).toBeLessThan(sourceClassPenalty('raw'));
    expect(SOURCE_CLASS_PENALTY.fairway).toBe(0);
  });

  it('same geometry: fairway ranks better than waterway (soft, finite)', () => {
    const origin = p(49.05, 55.75);
    const toward = p(49.4, 53.55);
    const pin = p(49.0526, 55.7514); // on VOLGA_NAV_FAIRWAY near Kazan
    const d = haversineKm(origin, pin);
    const fair = candidateRank(d, origin, pin, toward, 'fairway');
    const way = candidateRank(d, origin, pin, toward, 'waterway');
    expect(fair).toBeLessThan(way);
    expect(Number.isFinite(way)).toBe(true);
    expect(Number.isFinite(fair)).toBe(true);
  });

  it('off-fairway waterway gets stem soft penalty; fairway/mask exempt', () => {
    // STEM finish — northern tributary, ~30 km off Volga fairway.
    const stemB = p(45.05, 56.35);
    expect(nearestFairwayDistKm(stemB)).toBeGreaterThan(20);
    expect(offFairwayStemPenalty(stemB, 'waterway')).toBeGreaterThan(1.5);
    expect(offFairwayStemPenalty(stemB, 'fairway')).toBe(0);
    expect(offFairwayStemPenalty(stemB, 'mask')).toBe(0);

    // On-fairway Kazan pin — no stem tax for waterway either.
    const onFw = p(49.0526, 55.7514);
    expect(nearestFairwayDistKm(onFw)).toBeLessThan(1);
    expect(offFairwayStemPenalty(onFw, 'waterway')).toBe(0);
  });

  it('fairway is not a hard filter: waterway remains eligible with finite rank', () => {
    const origin = p(45.05, 56.35);
    const toward = p(45.5, 56.2);
    const far = p(45.05, 56.349);
    const rank = candidateRank(0.1, origin, far, toward, 'waterway');
    expect(Number.isFinite(rank)).toBe(true);
    expect(rank).toBeLessThan(20);
  });

  it('selectPhaseCPairs prefers fairway×fairway over waterway×waterway', () => {
    const a0 = p(49.0, 55.75);
    const b0 = p(49.4, 53.55);
    // Same pin locations — only source/class differs, so soft class must decide.
    const pinA = p(49.05, 55.74);
    const pinB = p(49.43, 53.5);
    const mk = (
      pt: LngLat,
      source: WaterCandidate['source'],
      origin: LngLat,
      toward: LngLat,
    ): WaterCandidate => {
      const distKm = haversineKm(origin, pt);
      return {
        point: pt,
        distKm,
        source,
        rank: candidateRank(distKm, origin, pt, toward, source),
      };
    };
    const candsA = [mk(pinA, 'fairway', a0, b0), mk(pinA, 'waterway', a0, b0)];
    const candsB = [mk(pinB, 'fairway', b0, a0), mk(pinB, 'waterway', b0, a0)];
    const pairs = selectPhaseCPairs(candsA, candsB, a0, b0, 4);
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs[0]![0].source).toBe('fairway');
    expect(pairs[0]![1].source).toBe('fairway');
  });

  it('scoreAcceptedPhaseCRoute: hydroReject → ∞; soft class prefers fairway pair', () => {
    expect(
      scoreAcceptedPhaseCRoute(1, 1, 100, 80, { hydroReject: true }),
    ).toBe(PHASE_C_HYDRO_REJECT_SCORE);

    const fw = scoreAcceptedPhaseCRoute(1, 1, 100, 80, {
      classPenalty: pairClassPenalty(
        { point: p(0, 0), distKm: 0, source: 'fairway', rank: 0 },
        { point: p(1, 1), distKm: 0, source: 'fairway', rank: 0 },
      ),
    });
    const ww = scoreAcceptedPhaseCRoute(1, 1, 100, 80, {
      classPenalty: pairClassPenalty(
        { point: p(0, 0), distKm: 0, source: 'waterway', rank: 0 },
        { point: p(1, 1), distKm: 0, source: 'waterway', rank: 0 },
      ),
    });
    expect(fw).toBeLessThan(ww);
    expect(Number.isFinite(fw)).toBe(true);
  });

  it('STEM-like off-fairway finish: stem waterway worse class+stem than fairway', () => {
    const a = p(45.5, 56.2);
    const b = p(45.05, 56.35);
    const fairNearB = p(45.1, 56.084); // Volga fairway south of stem
    const stemB = p(45.05, 56.349);
    expect(offFairwayStemPenalty(stemB, 'waterway')).toBeGreaterThan(
      offFairwayStemPenalty(fairNearB, 'fairway'),
    );
    // Equal distance so class + stem tax decide (fairway soft preference).
    const rFair = candidateRank(5, b, fairNearB, a, 'fairway');
    const rStem = candidateRank(5, b, stemB, a, 'waterway');
    expect(rStem).toBeGreaterThan(rFair);
    expect(
      pairClassPenalty(
        { point: fairNearB, distKm: 5, source: 'fairway', rank: rFair },
        { point: stemB, distKm: 5, source: 'waterway', rank: rStem },
      ),
    ).toBeGreaterThan(sourceClassPenalty('fairway') * 2);
  });
});

describe('Phase C — acceptance ceilings unchanged', () => {
  it('Phase A 10 / Phase B 5.5 / river 3 still apply', () => {
    expect(endpointSnapKmForAccept('lake', true)).toBe(maxOpenWaterSnapKm());
    expect(endpointSnapKmForAccept('lake', false)).toBe(MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM);
    expect(endpointSnapKmForAccept('waterway', false)).toBe(maxWaterSnapKm());
  });

  it('VETL stem residual still fails Phase B lake budget', () => {
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
    const residual = haversineKm(stemFinish, finish);
    expect(residual).toBeGreaterThan(MAX_SHARED_LAKE_BROUTER_ENDPOINT_KM);
    const asPhaseB = validateWaterRoute(stemTrack, {
      waypoints: [start, finish],
      lengthKm: pathLengthKm(stemTrack),
      method: 'lake',
    });
    expect(asPhaseB.ok).toBe(false);
    expect(asPhaseB.issues).toContain('endpoints_far');
  });

  it('L01 densified verified open chord still accepts', () => {
    const a = p(38.1, 58.4);
    const b = p(38.6, 58.35);
    const densified = densifyOpenWaterPath([a, b], 1.5);
    const v = validateWaterRoute(densified, {
      waypoints: [a, b],
      lengthKm: pathLengthKm(densified),
      method: 'lake',
      openWaterVerified: true,
    });
    expect(v.ok).toBe(true);
  });

  it('DAM chord still illegal under openWaterVerified', () => {
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

  it('L07 long shared-lake may use Phase-C residual up to fairway search (VETL stays 5.5)', () => {
    expect(MAX_SHARED_LAKE_BROUTER_KM).toBe(150);
    // L07 geo ~246 > 150; VETL geo ~70 < 150
    const l07geo = haversineKm(p(49.0, 55.75), p(49.4, 53.55));
    const vetlGeo = haversineKm(p(44.0, 56.33), p(45.05, 56.15));
    expect(l07geo).toBeGreaterThan(MAX_SHARED_LAKE_BROUTER_KM);
    expect(vetlGeo).toBeLessThan(MAX_SHARED_LAKE_BROUTER_KM);
    expect(PHASE_C_FAIRWAY_SEARCH_KM).toBeGreaterThanOrEqual(10.2);
  });
});
