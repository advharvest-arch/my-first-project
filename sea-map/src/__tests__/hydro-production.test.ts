/**
 * Stage 8 — production hydro-gate integration (high-confidence only).
 *
 * Validates via validateWaterRoute (the acceptPath gate). Does not call BRouter.
 */
import { describe, expect, it } from 'vitest';
import { pathLengthKm, type LngLat } from '../geo';
import {
  evaluateHydroAcceptGate,
  hydroConfidenceMayReject,
  hydroHighConfidenceRejects,
} from '../hydro-gate';
import {
  getHydraulicSiteBySeedId,
  siteBarrierPolylines,
} from '../hydro-index';
import {
  DUBNA_LOCK_CORRIDOR,
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
  VOLGA_STEM_CHAIN,
  applyKnownBarrierRepairs,
  hasIllegalBarrierCrossing,
} from '../routing-rules';
import { validateWaterRoute } from '../validate-water-route';
import { endpointReachToOriginals, maxWaterSnapKm } from '../water-snap';

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

function chordAcross(line: LngLat[], halfDeg = 0.015): LngLat[] {
  const mid = line[Math.floor(line.length / 2)]!;
  return densify(
    [p(mid.lon, mid.lat - halfDeg), p(mid.lon, mid.lat), p(mid.lon, mid.lat + halfDeg)],
    0.4,
  );
}

function validate(track: LngLat[], a: LngLat, b: LngLat) {
  return validateWaterRoute(track, {
    waypoints: [a, b],
    lengthKm: pathLengthKm(track),
    method: 'waterway',
  });
}

const RYBINSK_START = p(38.8558908, 58.0489536);
const CHEREPOVETS = p(37.9025005, 59.1221553);
const MYSHKIN = p(38.4516, 57.7847);

const RYBINSK_DAM = densify(
  [
    RYBINSK_START,
    p(38.821867, 58.088214),
    p(38.823371, 58.095732),
    p(38.821867, 58.104336),
    p(38.4, 58.55),
    p(38.1, 58.8),
    CHEREPOVETS,
  ],
  12,
);

const RYBINSK_LOCK_ROUTE = densify(
  [
    RYBINSK_START,
    p(38.72, 58.07),
    p(38.7283, 58.095),
    RYBINSK_LOCK_11,
    RYBINSK_LOCK,
    RYBINSK_LOCK_12,
    p(38.65, 58.13),
    p(38.5, 58.25),
    CHEREPOVETS,
  ],
  8,
);

const DUBNA_DAM = densify([p(37.1, 56.73), p(37.137, 56.7395), p(37.19, 56.75)], 1);
const DUBNA_LOCK = densify(DUBNA_LOCK_CORRIDOR, 0.5);
const BESIDE_RYBINSK = densify([p(38.75, 58.05), p(38.8, 58.055), p(38.85, 58.05)], 2);
const MYSHKIN_RYBINSK = densify([MYSHKIN, p(38.65, 57.92), RYBINSK_START], 10);

const OSTASHKOV_KAZAN = densify(
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

const VOLGA_VETLUGA_FAIL = densify(
  [
    p(44.0, 56.33),
    p(44.15, 56.28),
    p(44.32, 56.17),
    p(44.55, 56.07),
    p(44.77, 56.06),
    p(44.93, 56.07),
    p(45.133, 56.102),
  ],
  8,
);

const MOSCOW_TULA_FAIL = densify(
  [p(37.6173, 55.7558), p(37.6173, 55.5), p(37.6173, 54.1931)],
  15,
);

describe('Stage 8 hydro production gate', () => {
  it('safety invariant: only high confidence may reject', () => {
    expect(hydroConfidenceMayReject('high')).toBe(true);
    expect(hydroConfidenceMayReject('med')).toBe(false);
    expect(hydroConfidenceMayReject('low')).toBe(false);
    expect(hydroConfidenceMayReject(null)).toBe(false);
  });

  it('Rybinsk dam chord → rejected', () => {
    expect(hasIllegalBarrierCrossing(RYBINSK_DAM)).toBe(true);
    expect(hydroHighConfidenceRejects(RYBINSK_DAM) || hasIllegalBarrierCrossing(RYBINSK_DAM)).toBe(
      true,
    );
    const v = validate(RYBINSK_DAM, RYBINSK_START, CHEREPOVETS);
    expect(v.ok).toBe(false);
    expect(v.issues).toContain('illegal_barrier');
    // Existing repair leaves dam track (no dense Rybinsk splice).
    const after = applyKnownBarrierRepairs(RYBINSK_DAM);
    expect(validate(after, RYBINSK_START, CHEREPOVETS).issues).toContain('illegal_barrier');
  });

  it('Rybinsk lock route → accepted', () => {
    const v = validate(RYBINSK_LOCK_ROUTE, RYBINSK_START, CHEREPOVETS);
    expect(v.issues).not.toContain('illegal_barrier');
    const gate = evaluateHydroAcceptGate(RYBINSK_LOCK_ROUTE);
    expect(gate.reject).toBe(false);
    expect(gate.classification).toBe('legal_lock_passage');
    // Barrier gate is the Stage-8 contract; chord heuristics are orthogonal.
    expect(hasIllegalBarrierCrossing(RYBINSK_LOCK_ROUTE)).toBe(false);
  });

  it('Cherepovets → Rybinsk lock → accepted', () => {
    const track = [...RYBINSK_LOCK_ROUTE].reverse();
    const v = validate(track, CHEREPOVETS, RYBINSK_START);
    expect(v.issues).not.toContain('illegal_barrier');
    expect(evaluateHydroAcceptGate(track).reject).toBe(false);
    expect(hasIllegalBarrierCrossing(track)).toBe(false);
  });

  it('Dubna dam → rejected; Dubna lock → accepted', () => {
    const a = p(37.08, 56.73);
    const b = p(37.22, 56.76);
    const dam = validate(DUBNA_DAM, a, b);
    expect(dam.ok).toBe(false);
    expect(dam.issues).toContain('illegal_barrier');

    const lock = validate(DUBNA_LOCK, DUBNA_LOCK_CORRIDOR[0]!, DUBNA_LOCK_CORRIDOR.at(-1)!);
    expect(lock.issues).not.toContain('illegal_barrier');
    expect(hasIllegalBarrierCrossing(DUBNA_LOCK)).toBe(false);
    expect(evaluateHydroAcceptGate(DUBNA_LOCK).reject).toBe(false);
  });

  it('Myshkin → Rybinsk → accepted', () => {
    const v = validate(MYSHKIN_RYBINSK, MYSHKIN, RYBINSK_START);
    expect(v.issues).not.toContain('illegal_barrier');
    expect(evaluateHydroAcceptGate(MYSHKIN_RYBINSK).reject).toBe(false);
  });

  it('beside dam → accepted', () => {
    const a = BESIDE_RYBINSK[0]!;
    const b = BESIDE_RYBINSK.at(-1)!;
    const v = validate(BESIDE_RYBINSK, a, b);
    expect(v.issues).not.toContain('illegal_barrier');
    expect(evaluateHydroAcceptGate(BESIDE_RYBINSK).reject).toBe(false);
  });

  it('low-confidence Cheboksary / Votkinsk / Perm → never rejected by hydro', () => {
    for (const seed of ['seed-cheboksary', 'seed-votkinsk', 'seed-perm'] as const) {
      const site = getHydraulicSiteBySeedId(seed)!;
      expect(site.source.confidence).toBe('low');
      const lines = siteBarrierPolylines(site);
      const path =
        lines.length > 0
          ? chordAcross(lines[0]!)
          : densify(
              [
                p((site.bbox[1] + site.bbox[3]) / 2, site.bbox[0]),
                p((site.bbox[1] + site.bbox[3]) / 2, site.bbox[2]),
              ],
              1,
            );
      const gate = evaluateHydroAcceptGate(path);
      expect(gate.reject).toBe(false);
      expect(hydroHighConfidenceRejects(path)).toBe(false);
      // KNOWN_BARRIERS also do not cover these sites.
      expect(hasIllegalBarrierCrossing(path)).toBe(false);
    }
  });

  it('KNOWN_BARRIERS valid passage cannot be overturned by hydro', () => {
    const gate = evaluateHydroAcceptGate(RYBINSK_LOCK_ROUTE);
    expect(gate.reject).toBe(false);
    expect(hasIllegalBarrierCrossing(RYBINSK_LOCK_ROUTE)).toBe(false);
    // Even if hydro classified something else, legal KNOWN_BARRIER wins.
    expect(gate.reason).toMatch(/accept|valid passage|legal_lock/i);
  });

  it('Ostashkov → Kazan stem → waterway success', () => {
    const a = OSTASHKOV_KAZAN[0]!;
    const b = OSTASHKOV_KAZAN.at(-1)!;
    const v = validate(OSTASHKOV_KAZAN, a, b);
    expect(v.issues).not.toContain('illegal_barrier');
    expect(v.ok).toBe(true);
    expect(evaluateHydroAcceptGate(OSTASHKOV_KAZAN).reject).toBe(false);
  });

  it('Vetluga / Tula keep prior route_not_found semantics', () => {
    const vetlugaStart = p(44.0, 56.33);
    const vetlugaFinish = p(45.05, 56.15);
    const reach = endpointReachToOriginals(
      VOLGA_VETLUGA_FAIL,
      [vetlugaStart, vetlugaFinish],
      maxWaterSnapKm(),
    );
    expect(reach.ok).toBe(false);
    const vV = validateWaterRoute(VOLGA_VETLUGA_FAIL, {
      waypoints: [vetlugaStart, vetlugaFinish],
      lengthKm: pathLengthKm(VOLGA_VETLUGA_FAIL),
      method: 'waterway',
    });
    expect(vV.ok).toBe(false);
    expect(vV.issues).toContain('endpoints_far');
    expect(vV.issues).not.toContain('illegal_barrier');

    const msk = p(37.6173, 55.7558);
    const tula = p(37.6173, 54.1931);
    const vT = validateWaterRoute(MOSCOW_TULA_FAIL, {
      waypoints: [msk, tula],
      lengthKm: pathLengthKm(MOSCOW_TULA_FAIL),
      method: 'waterway',
    });
    expect(vT.ok).toBe(false);
    expect(vT.issues).not.toContain('illegal_barrier');
  });

  it('high-confidence crest outside KNOWN_BARRIERS is rejected by hydro gate', () => {
    const site = getHydraulicSiteBySeedId('seed-uglich')!;
    expect(site.source.confidence).toBe('high');
    const path = chordAcross(siteBarrierPolylines(site)[0]!);
    expect(hasIllegalBarrierCrossing(path)).toBe(false); // no KNOWN_BARRIER entry
    expect(hydroHighConfidenceRejects(path)).toBe(true);
    const a = path[0]!;
    const b = path.at(-1)!;
    const v = validate(path, a, b);
    expect(v.issues).toContain('illegal_barrier');
  });
});
