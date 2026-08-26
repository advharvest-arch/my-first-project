/**
 * Stage 5 — hydro-index shadow mode (offline).
 *
 * Compares KNOWN_BARRIERS vs hydro-index detector on saved fixtures.
 * Does NOT wire into production routing.
 */
import { describe, expect, it } from 'vitest';
import type { LngLat } from '../geo';
import {
  compareHydroShadow,
  formatHydroShadowReport,
  type HydroShadowReport,
} from '../hydro-shadow';
import {
  getHydraulicSiteBySeedId,
  listHydraulicSites,
  siteBarrierPolylines,
} from '../hydro-index';
import {
  DUBNA_LOCK_CORRIDOR,
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
} from '../routing-rules';

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

/** Densify a polyline so barrier heuristics see a continuous track. */
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

/** N–S chord through midpoint of a crest polyline (geometry only). */
function chordAcross(line: LngLat[], halfDeg = 0.015): LngLat[] {
  const mid = line[Math.floor(line.length / 2)]!;
  return densify(
    [p(mid.lon, mid.lat - halfDeg), p(mid.lon, mid.lat), p(mid.lon, mid.lat + halfDeg)],
    0.4,
  );
}

const RYBINSK_START = p(38.8558908, 58.0489536);
const CHEREPOVETS = p(37.9025005, 59.1221553);
const MYSHKIN = p(38.4516, 57.7847);

/** Historical open-water tip across the HPP body (saved regression geometry). */
const RYBINSK_DAM_TO_CHEREPOVETS = densify(
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

/** Lock №11/12 corridor Rybinsk → Cherepovets. */
const RYBINSK_LOCK_TO_CHEREPOVETS = densify(
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

const CHEREPOVETS_TO_RYBINSK_LOCK = [...RYBINSK_LOCK_TO_CHEREPOVETS].reverse();

const MYSHKIN_TO_RYBINSK = densify([MYSHKIN, p(38.65, 57.92), RYBINSK_START], 10);

const DUBNA_DAM_CHORD = densify(
  [p(37.1, 56.73), p(37.137, 56.7395), p(37.19, 56.75)],
  1,
);

const DUBNA_LOCK_PATH = densify(DUBNA_LOCK_CORRIDOR, 0.5);

const HIGH_SEEDS = [
  'seed-uglich',
  'seed-gorodets',
  'seed-zhiguli',
  'seed-saratov',
  'seed-volgograd',
  'seed-nizhnekamsk',
] as const;

const LOW_SEEDS = ['seed-cheboksary', 'seed-votkinsk', 'seed-perm'] as const;

function shadow(
  caseId: string,
  path: LngLat[],
  preferSeedId?: string,
): HydroShadowReport {
  return compareHydroShadow(path, { caseId, preferSeedId, padKm: 5 });
}

describe('hydro-shadow (Stage 5, offline)', () => {
  it('harness is pure and does not invent live network calls', () => {
    // Bundled index only — listHydraulicSites must already be populated offline.
    expect(listHydraulicSites().length).toBeGreaterThanOrEqual(8);
    const r = shadow('smoke', MYSHKIN_TO_RYBINSK, 'seed-rybinsk');
    expect(r.caseId).toBe('smoke');
    expect(formatHydroShadowReport(r)).toContain('old KNOWN_BARRIERS result');
  });

  describe('Rybinsk ↔ Cherepovets', () => {
    it('1a: historical dam crossing → illegal_dam_crossing (agree)', () => {
      const r = shadow('rybinsk-dam-to-cherepovets', RYBINSK_DAM_TO_CHEREPOVETS, 'seed-rybinsk');
      expect(r.site).toBe('seed-rybinsk');
      expect(r.confidence).toBe('high');
      expect(r.oldKnownBarriers).toBe('illegal');
      expect(r.oldBarrierId).toBe('rybinsk-locks-11-12');
      expect(r.newHydro).toBe('illegal_dam_crossing');
      expect(r.agreement).toBe('agree');
      expect(r.wouldRejectIfWired).toBe(true);
    });

    it('1b: lock route Rybinsk→Cherepovets → legal_lock_passage (agree)', () => {
      const r = shadow(
        'rybinsk-lock-to-cherepovets',
        RYBINSK_LOCK_TO_CHEREPOVETS,
        'seed-rybinsk',
      );
      expect(r.oldKnownBarriers).toBe('legal_passage');
      expect(r.newHydro).toBe('legal_lock_passage');
      expect(r.agreement).toBe('agree');
      expect(r.lock).toBeTruthy();
    });

    it('2: Cherepovets→Rybinsk lock route → legal_lock_passage', () => {
      const r = shadow(
        'cherepovets-to-rybinsk-lock',
        CHEREPOVETS_TO_RYBINSK_LOCK,
        'seed-rybinsk',
      );
      expect(r.oldKnownBarriers).toBe('legal_passage');
      expect(r.newHydro).toBe('legal_lock_passage');
      expect(r.agreement).toBe('agree');
    });

    it('3: Myshkin→Rybinsk — no_barrier / beside (agree with old none)', () => {
      const r = shadow('myshkin-to-rybinsk', MYSHKIN_TO_RYBINSK, 'seed-rybinsk');
      expect(r.oldKnownBarriers).toBe('no_barrier');
      expect(['no_barrier', 'beside_barrier']).toContain(r.newHydro);
      expect(r.agreement).toBe('agree');
      expect(r.wouldRejectIfWired).toBe(false);
    });

    it('geometry crest chord on eastern damCrest agrees illegal', () => {
      const site = getHydraulicSiteBySeedId('seed-rybinsk')!;
      const crest = site.damCrest[0]!;
      const r = shadow('rybinsk-crest-chord', chordAcross(crest), 'seed-rybinsk');
      expect(r.oldKnownBarriers).toBe('illegal');
      expect(['illegal_dam_crossing', 'barrier_without_lock']).toContain(r.newHydro);
      expect(r.agreement).toBe('agree');
    });
  });

  describe('Dubna', () => {
    it('4a: dam chord → illegal (agree)', () => {
      const r = shadow('dubna-dam-chord', DUBNA_DAM_CHORD, 'seed-ivanovo');
      expect(r.site).toBe('seed-ivanovo');
      expect(r.confidence).toBe('high');
      expect(r.oldKnownBarriers).toBe('illegal');
      expect(r.newHydro).toBe('illegal_dam_crossing');
      expect(r.agreement).toBe('agree');
    });

    it('4b: lock corridor → legal_lock_passage (agree)', () => {
      const r = shadow('dubna-lock-corridor', DUBNA_LOCK_PATH, 'seed-ivanovo');
      expect(r.oldKnownBarriers).toBe('legal_passage');
      expect(r.newHydro).toBe('legal_lock_passage');
      expect(r.agreement).toBe('agree');
      expect(r.lock).toBeTruthy();
    });
  });

  describe('High-confidence cascade sites (no KNOWN_BARRIER entry)', () => {
    for (const seed of HIGH_SEEDS) {
      it(`${seed}: crest chord → new_coverage / reject-class; not a prod FP`, () => {
        const site = getHydraulicSiteBySeedId(seed);
        expect(site).toBeTruthy();
        expect(site!.source.confidence).toBe('high');
        const lines = siteBarrierPolylines(site!);
        expect(lines.length).toBeGreaterThan(0);
        const r = shadow(`${seed}-crest-chord`, chordAcross(lines[0]!), seed);
        expect(r.confidence).toBe('high');
        expect(r.oldKnownBarriers).toBe('no_barrier');
        expect(['illegal_dam_crossing', 'barrier_without_lock', 'legal_lock_passage']).toContain(
          r.newHydro,
        );
        expect(r.agreement).toBe('new_coverage');
        expect(r.actionable).toBe(true);
        // Shadow only — wouldRejectIfWired is informational.
        expect(r.wouldRejectIfWired).toBe(true);
      });
    }
  });

  describe('Low-confidence sites — must NOT drive reject/repair', () => {
    for (const seed of LOW_SEEDS) {
      it(`${seed}: advisory_only / not actionable`, () => {
        const site = getHydraulicSiteBySeedId(seed);
        expect(site).toBeTruthy();
        expect(site!.source.confidence).toBe('low');

        const lines = siteBarrierPolylines(site!);
        const path =
          lines.length > 0
            ? chordAcross(lines[0]!)
            : densify(
                [
                  p((site!.bbox[1] + site!.bbox[3]) / 2, site!.bbox[0]),
                  p((site!.bbox[1] + site!.bbox[3]) / 2, site!.bbox[2]),
                ],
                1,
              );

        const r = compareHydroShadow(path, {
          caseId: `${seed}-shadow`,
          preferSeedId: seed,
          forceSite: site,
          padKm: 5,
        });
        expect(r.confidence).toBe('low');
        expect(r.actionable).toBe(false);
        expect(r.wouldRejectIfWired).toBe(false);
        if (r.newHydro === 'illegal_dam_crossing' || r.newHydro === 'barrier_without_lock') {
          expect(r.agreement).toBe('advisory_only');
        }
      });
    }
  });

  it('prints Stage-5 case board (informational)', () => {
    const board: HydroShadowReport[] = [
      shadow('rybinsk-dam-to-cherepovets', RYBINSK_DAM_TO_CHEREPOVETS, 'seed-rybinsk'),
      shadow('rybinsk-lock-to-cherepovets', RYBINSK_LOCK_TO_CHEREPOVETS, 'seed-rybinsk'),
      shadow('cherepovets-to-rybinsk-lock', CHEREPOVETS_TO_RYBINSK_LOCK, 'seed-rybinsk'),
      shadow('myshkin-to-rybinsk', MYSHKIN_TO_RYBINSK, 'seed-rybinsk'),
      shadow('dubna-dam-chord', DUBNA_DAM_CHORD, 'seed-ivanovo'),
      shadow('dubna-lock-corridor', DUBNA_LOCK_PATH, 'seed-ivanovo'),
    ];
    for (const seed of HIGH_SEEDS) {
      const site = getHydraulicSiteBySeedId(seed)!;
      const line = siteBarrierPolylines(site)[0]!;
      board.push(shadow(`${seed}-crest-chord`, chordAcross(line), seed));
    }
    for (const seed of LOW_SEEDS) {
      const site = getHydraulicSiteBySeedId(seed)!;
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
      board.push(
        compareHydroShadow(path, {
          caseId: `${seed}-shadow`,
          forceSite: site,
          preferSeedId: seed,
        }),
      );
    }

    // eslint-disable-next-line no-console
    console.log('\n=== HYDRO SHADOW BOARD ===\n');
    for (const r of board) {
      // eslint-disable-next-line no-console
      console.log(formatHydroShadowReport(r));
      // eslint-disable-next-line no-console
      console.log('---');
    }

    const disagrees = board.filter((r) => r.agreement === 'disagree');
    const agrees = board.filter((r) => r.agreement === 'agree');
    expect(board.length).toBeGreaterThanOrEqual(12);
    expect(agrees.length + disagrees.length).toBeGreaterThan(0);
    // Low-conf rows must never be actionable rejects.
    for (const r of board.filter((x) => x.confidence === 'low')) {
      expect(r.wouldRejectIfWired).toBe(false);
      expect(r.actionable).toBe(false);
    }
  });
});
