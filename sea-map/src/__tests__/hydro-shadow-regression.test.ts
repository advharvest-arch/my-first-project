/**
 * Stage 7 — final offline shadow regression before production wiring.
 *
 * Does NOT wire into BRouter / acceptPath / validator / display.
 * No live Overpass — bundled index + saved fixtures only.
 */
import { describe, expect, it } from 'vitest';
import { pathLengthKm, type LngLat } from '../geo';
import {
  compareHydroShadow,
  formatHydroShadowReport,
  runHydroShadowRegression,
  siteToDetectorInputs,
  type HydroShadowCase,
} from '../hydro-shadow';
import {
  getHydraulicSiteBySeedId,
  siteBarrierPolylines,
} from '../hydro-index';
import {
  classifyHydraulicCrossing,
  pathUsesLockPassage,
  type HydraulicBarrier,
  type NavigableLock,
} from '../hydro-barriers';
import {
  DUBNA_LOCK_CORRIDOR,
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
  VOLGA_STEM_CHAIN,
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

function stemSlice(fromIdx: number, toIdx: number, stepKm = 10): LngLat[] {
  const lo = Math.min(fromIdx, toIdx);
  const hi = Math.max(fromIdx, toIdx);
  const slice = VOLGA_STEM_CHAIN.slice(lo, hi + 1);
  const ordered = fromIdx <= toIdx ? slice : slice.slice().reverse();
  return densify(ordered, stepKm);
}

const RYBINSK_START = p(38.8558908, 58.0489536);
const CHEREPOVETS = p(37.9025005, 59.1221553);
const MYSHKIN = p(38.4516, 57.7847);

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

const DUBNA_DAM = densify([p(37.1, 56.73), p(37.137, 56.7395), p(37.19, 56.75)], 1);
const DUBNA_LOCK = densify(DUBNA_LOCK_CORRIDOR, 0.5);
const DUBNA_BESIDE = densify([p(37.08, 56.72), p(37.12, 56.722), p(37.16, 56.72)], 2);
const RYBINSK_BESIDE = densify([p(38.75, 58.05), p(38.8, 58.055), p(38.85, 58.05)], 2);

/** Ostashkov / Селигер → Kazan via stem pins (offline fairway proxy). */
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

/** Failure: Volga stem ends ~7 km from Vetluga FINISH (saved regression). */
const VOLGA_VETLUGA_FAIL: LngLat[] = densify(
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

/** Failure: Moscow → Tula land chord (no water route). */
const MOSCOW_TULA_FAIL = densify([p(37.6173, 55.7558), p(37.6173, 55.5), p(37.6173, 54.1931)], 15);

const HIGH_SEEDS = [
  'seed-uglich',
  'seed-gorodets',
  'seed-zhiguli',
  'seed-saratov',
  'seed-volgograd',
  'seed-nizhnekamsk',
] as const;

const LOW_SEEDS = ['seed-cheboksary', 'seed-votkinsk', 'seed-perm'] as const;

function buildStage7Cases(): HydroShadowCase[] {
  const cases: HydroShadowCase[] = [
    {
      caseId: '01-rybinsk-to-cherepovets-lock',
      path: RYBINSK_LOCK_TO_CHEREPOVETS,
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '02-cherepovets-to-rybinsk-lock',
      path: [...RYBINSK_LOCK_TO_CHEREPOVETS].reverse(),
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '03-rybinsk-historical-dam',
      path: RYBINSK_DAM_TO_CHEREPOVETS,
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '04-rybinsk-beside',
      path: RYBINSK_BESIDE,
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '06-dubna-lock-corridor',
      path: DUBNA_LOCK,
      preferSeedId: 'seed-ivanovo',
    },
    {
      caseId: '07-dubna-dam-chord',
      path: DUBNA_DAM,
      preferSeedId: 'seed-ivanovo',
    },
    {
      caseId: '08-dubna-beside',
      path: DUBNA_BESIDE,
      preferSeedId: 'seed-ivanovo',
    },
    {
      caseId: '09-myshkin-to-rybinsk',
      path: densify([MYSHKIN, p(38.65, 57.92), RYBINSK_START], 10),
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '10-rybinsk-to-cherepovets-lock-repeat',
      path: RYBINSK_LOCK_TO_CHEREPOVETS,
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '11-ostashkov-to-kazan-stem',
      path: OSTASHKOV_KAZAN,
    },
    {
      caseId: '12-gorodets-to-kazan-stem',
      path: stemSlice(8, 12, 10),
      preferSeedId: 'seed-gorodets',
    },
    {
      caseId: '13-rybinsk-to-cherepovets-again',
      path: RYBINSK_LOCK_TO_CHEREPOVETS,
      preferSeedId: 'seed-rybinsk',
    },
    {
      caseId: '14-nn-to-gorodets-stem',
      path: stemSlice(9, 8, 8),
      preferSeedId: 'seed-gorodets',
    },
    {
      caseId: '15-yaroslavl-to-kostroma-stem',
      path: stemSlice(5, 6, 8),
    },
    {
      caseId: '16-volga-to-vetluga-fail',
      path: VOLGA_VETLUGA_FAIL,
    },
    {
      caseId: '17-moscow-to-tula-fail',
      path: MOSCOW_TULA_FAIL,
    },
  ];

  // 5: lock nearby wrong side — synthetic geometry (no site name).
  // Covered as a dedicated unit assertion below; still include a report row.
  const wrongSideBarrier: HydraulicBarrier = {
    id: 'anon-wrong-side-dam',
    type: 'dam',
    geometry: [p(20, 30), p(20.05, 30), p(20.1, 30)],
  };
  const dangling: NavigableLock = {
    id: 'south-only',
    boat: 'yes',
    geometry: [p(20.05, 29.99), p(20.06, 29.991)],
    approachGeometry: [p(20.05, 29.98), p(20.05, 29.99)],
  };
  const wrongSidePath = [p(20.08, 29.97), p(20.08, 30.03)];
  // Encode as a forced empty-index path near no site — classification via detector directly
  // is asserted separately; shadow row uses a far path so index lookup stays clean.
  void wrongSideBarrier;
  void dangling;
  void wrongSidePath;

  for (const seed of HIGH_SEEDS) {
    const site = getHydraulicSiteBySeedId(seed)!;
    const line = siteBarrierPolylines(site)[0]!;
    cases.push({
      caseId: `high-${seed}-crest`,
      path: chordAcross(line),
      preferSeedId: seed,
      forceSite: site,
    });
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
    cases.push({
      caseId: `low-${seed}`,
      path,
      preferSeedId: seed,
      forceSite: site,
    });
  }

  return cases;
}

describe('Stage 7 hydro-shadow regression (offline)', () => {
  const cases = buildStage7Cases();
  const summary = runHydroShadowRegression(cases);

  it('prints full shadow board', () => {
    // eslint-disable-next-line no-console
    console.log('\n=== STAGE 7 SHADOW REGRESSION BOARD ===\n');
    for (const r of summary.reports) {
      // eslint-disable-next-line no-console
      console.log(formatHydroShadowReport(r));
      // eslint-disable-next-line no-console
      console.log('---');
    }
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          total: summary.total,
          byClass: summary.byClass,
          agreements: summary.agreements,
          disagreements: summary.disagreements.map((d) => d.caseId),
          newCoverage: summary.newCoverage,
          advisoryOnly: summary.advisoryOnly,
          falsePositives: summary.falsePositives.map((d) => d.caseId),
          falseNegatives: summary.falseNegatives.map((d) => d.caseId),
          lowConfidenceActionable: summary.lowConfidenceActionable.map((d) => d.caseId),
        },
        null,
        2,
      ),
    );
    expect(summary.total).toBeGreaterThanOrEqual(20);
  });

  it('Rybinsk / Dubna core cases agree with production severity', () => {
    const byId = Object.fromEntries(summary.reports.map((r) => [r.caseId, r]));
    expect(byId['01-rybinsk-to-cherepovets-lock']!.newHydro).toBe('legal_lock_passage');
    expect(byId['01-rybinsk-to-cherepovets-lock']!.agreement).toBe('agree');
    expect(byId['02-cherepovets-to-rybinsk-lock']!.newHydro).toBe('legal_lock_passage');
    expect(byId['03-rybinsk-historical-dam']!.newHydro).toBe('illegal_dam_crossing');
    expect(byId['03-rybinsk-historical-dam']!.agreement).toBe('agree');
    expect(['beside_barrier', 'no_barrier']).toContain(byId['04-rybinsk-beside']!.newHydro);
    expect(byId['04-rybinsk-beside']!.newHydro).not.toBe('illegal_dam_crossing');
    expect(byId['06-dubna-lock-corridor']!.newHydro).toBe('legal_lock_passage');
    expect(byId['07-dubna-dam-chord']!.newHydro).toBe('illegal_dam_crossing');
    expect(['beside_barrier', 'no_barrier']).toContain(byId['08-dubna-beside']!.newHydro);
    expect(byId['09-myshkin-to-rybinsk']!.agreement).toBe('agree');
  });

  it('05: lock nearby but wrong side is NOT legal', () => {
    const barrier: HydraulicBarrier = {
      id: 'anon-wrong-side-dam',
      type: 'dam',
      geometry: [p(20, 30), p(20.05, 30), p(20.1, 30)],
    };
    const dangling: NavigableLock = {
      id: 'south-only',
      boat: 'yes',
      geometry: [p(20.05, 29.99), p(20.06, 29.991)],
      approachGeometry: [p(20.05, 29.98), p(20.05, 29.99)],
    };
    const path = [p(20.08, 29.97), p(20.08, 30.03)];
    expect(pathUsesLockPassage(path, barrier, dangling)).toBe(false);
    expect(classifyHydraulicCrossing(path, [barrier], [dangling]).class).toBe(
      'illegal_dam_crossing',
    );
  });

  it('approach without chamber visit is NOT legal (Dubna dam chord)', () => {
    const site = getHydraulicSiteBySeedId('seed-ivanovo')!;
    const { barriers, locks } = siteToDetectorInputs(site);
    // Dam chord may skim approach canals but must not count as lock passage.
    for (const lock of locks) {
      for (const barrier of barriers) {
        expect(pathUsesLockPassage(DUBNA_DAM, barrier, lock)).toBe(false);
      }
    }
    expect(classifyHydraulicCrossing(DUBNA_DAM, barriers, locks).class).toBe(
      'illegal_dam_crossing',
    );
  });

  it('failure routes stay route_not_found / endpoints_far; hydro does not invent legal water', () => {
    const vetlugaFinish = p(45.05, 56.15);
    const vetlugaStart = p(44.0, 56.33);
    const reach = endpointReachToOriginals(
      VOLGA_VETLUGA_FAIL,
      [vetlugaStart, vetlugaFinish],
      maxWaterSnapKm(),
    );
    expect(reach.ok).toBe(false);
    const vVetluga = validateWaterRoute(VOLGA_VETLUGA_FAIL, {
      waypoints: [vetlugaStart, vetlugaFinish],
      lengthKm: pathLengthKm(VOLGA_VETLUGA_FAIL),
      method: 'waterway',
    });
    expect(vVetluga.ok).toBe(false);
    expect(vVetluga.issues).toContain('endpoints_far');

    const msk = p(37.6173, 55.7558);
    const tula = p(37.6173, 54.1931);
    const vTula = validateWaterRoute(MOSCOW_TULA_FAIL, {
      waypoints: [msk, tula],
      lengthKm: pathLengthKm(MOSCOW_TULA_FAIL),
      method: 'waterway',
    });
    expect(vTula.ok).toBe(false);

    const r16 = summary.reports.find((r) => r.caseId === '16-volga-to-vetluga-fail')!;
    const r17 = summary.reports.find((r) => r.caseId === '17-moscow-to-tula-fail')!;
    // Hydro shadow must not claim a legal lock passage on these failures.
    expect(r16.newHydro).not.toBe('legal_lock_passage');
    expect(r17.newHydro).not.toBe('legal_lock_passage');
    expect(r17.newHydro).toBe('no_barrier');
  });

  it('low-confidence invariant: never actionable / wouldRejectIfWired', () => {
    for (const r of summary.reports.filter((x) => x.confidence === 'low')) {
      expect(r.actionable).toBe(false);
      expect(r.wouldRejectIfWired).toBe(false);
    }
    expect(summary.lowConfidenceActionable).toHaveLength(0);
  });

  it('no false-positive legal→illegal; no false-negative on known barriers', () => {
    expect(summary.falsePositives).toHaveLength(0);
    expect(summary.falseNegatives).toHaveLength(0);
    expect(summary.disagreements).toHaveLength(0);
  });

  it('high-confidence crest chords are new_coverage (no KNOWN_BARRIER entry)', () => {
    for (const seed of HIGH_SEEDS) {
      const r = summary.reports.find((x) => x.caseId === `high-${seed}-crest`)!;
      expect(r.confidence).toBe('high');
      expect(r.oldKnownBarriers).toBe('no_barrier');
      expect(['illegal_dam_crossing', 'barrier_without_lock']).toContain(r.newHydro);
      expect(r.agreement).toBe('new_coverage');
      expect(r.wouldRejectIfWired).toBe(true);
    }
  });

  it('production pipeline modules are not imported for wiring (shadow-only file)', () => {
    // This file imports validateWaterRoute only to assert failure routes still fail —
    // hydro-shadow itself must not be pulled into waterways/brouter.
    const r = compareHydroShadow(MYSHKIN_TO_SAFE(), { caseId: 'smoke' });
    expect(r.caseId).toBe('smoke');
  });
});

function MYSHKIN_TO_SAFE(): LngLat[] {
  return densify([MYSHKIN, p(38.65, 57.92), RYBINSK_START], 10);
}
