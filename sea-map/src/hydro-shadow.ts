/**
 * Hydro-index shadow comparison harness.
 *
 * Runs the OSM hydro-index detector in parallel with KNOWN_BARRIERS and
 * reports agreement / disagreement. Pure + offline — does NOT change
 * production routing decisions (BRouter / vias / acceptPath / validate /
 * display).
 */

import type { LngLat } from './geo';
import {
  classifyHydraulicCrossing,
  type HydraulicBarrier,
  type HydraulicCrossingClass,
  type NavigableLock,
} from './hydro-barriers';
import {
  findHydraulicSitesNearPath,
  siteBarrierPolylines,
  type HydroConfidence,
  type HydraulicSite,
} from './hydro-index';
import { KNOWN_BARRIERS } from './routing-rules';

export type OldBarrierVerdict = 'illegal' | 'legal_passage' | 'no_barrier';

export type OldBarrierShadow = {
  verdict: OldBarrierVerdict;
  barrierId: string | null;
  label: string | null;
};

export type NewHydroShadow = {
  class: HydraulicCrossingClass;
  siteId: string | null;
  seedId: string | null;
  confidence: HydroConfidence | null;
  barrierId: string | null;
  lockId: string | null;
  sitesNear: string[];
};

export type ShadowAgreement =
  | 'agree'
  | 'disagree'
  | 'new_coverage'
  | 'advisory_only';

export type HydroShadowReport = {
  caseId: string;
  site: string | null;
  confidence: HydroConfidence | null;
  oldKnownBarriers: OldBarrierVerdict;
  oldBarrierId: string | null;
  newHydro: HydraulicCrossingClass;
  agreement: ShadowAgreement;
  barrier: string | null;
  lock: string | null;
  reason: string;
  /** True iff actionable && new class is a reject-class. Never applied to routing. */
  wouldRejectIfWired: boolean;
  /** False for low-confidence sites — must not drive reject/repair. */
  actionable: boolean;
};

export type HydroShadowOptions = {
  caseId?: string;
  /** Inflate path corridor for site lookup (km). */
  padKm?: number;
  /** Prefer a specific seed when several sites are nearby. */
  preferSeedId?: string;
  /**
   * When set, classify against this site only (still looked up from the
   * bundled index — no live Overpass).
   */
  forceSite?: HydraulicSite | null;
};

const REJECT_CLASSES: ReadonlySet<HydraulicCrossingClass> = new Set([
  'illegal_dam_crossing',
  'barrier_without_lock',
]);

/** Map a HydraulicSite to detector inputs (geometry only; ignore labels). */
export function siteToDetectorInputs(site: HydraulicSite): {
  barriers: HydraulicBarrier[];
  locks: NavigableLock[];
} {
  const lockIds = site.locks.map((l) => l.id);
  const barriers: HydraulicBarrier[] = siteBarrierPolylines(site).map((geometry, i) => ({
    id: `${site.id}-barrier-${i}`,
    type: 'dam',
    geometry,
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

/** Existing production barrier rules — read-only shadow of KNOWN_BARRIERS. */
export function evaluateOldKnownBarriers(path: LngLat[]): OldBarrierShadow {
  for (const barrier of KNOWN_BARRIERS) {
    if (!barrier.crosses(path)) continue;
    if (barrier.hasValidPassage(path)) {
      return { verdict: 'legal_passage', barrierId: barrier.id, label: barrier.label };
    }
    return { verdict: 'illegal', barrierId: barrier.id, label: barrier.label };
  }
  return { verdict: 'no_barrier', barrierId: null, label: null };
}

function severity(c: HydraulicCrossingClass): number {
  switch (c) {
    case 'illegal_dam_crossing':
      return 5;
    case 'barrier_without_lock':
      return 4;
    case 'legal_lock_passage':
      return 3;
    case 'beside_barrier':
      return 2;
    case 'no_barrier':
    default:
      return 0;
  }
}

/**
 * Hydro-index detector over nearby (or forced) sites.
 * Picks the strongest classification among candidates.
 */
export function evaluateNewHydroDetector(
  path: LngLat[],
  opts: HydroShadowOptions = {},
): NewHydroShadow {
  const padKm = opts.padKm ?? 5;
  let sites: HydraulicSite[] = [];
  if (opts.forceSite) {
    sites = [opts.forceSite];
  } else {
    sites = findHydraulicSitesNearPath(path, { padKm });
    if (opts.preferSeedId) {
      const pref = sites.find((s) => s.source.seedId === opts.preferSeedId);
      if (pref) sites = [pref, ...sites.filter((s) => s !== pref)];
    }
  }

  if (!sites.length) {
    return {
      class: 'no_barrier',
      siteId: null,
      seedId: null,
      confidence: null,
      barrierId: null,
      lockId: null,
      sitesNear: [],
    };
  }

  let best: NewHydroShadow | null = null;
  let bestScore = -1;
  for (const site of sites) {
    const { barriers, locks } = siteToDetectorInputs(site);
    if (!barriers.length && !locks.length) continue;
    const result = classifyHydraulicCrossing(
      path,
      barriers.length ? barriers : [],
      locks,
    );
    // Prefer preferred seed on ties; high-confidence sites outrank low-confidence
    // so a long cascade route is not dominated by a sparse low-conf crest hit.
    const confBoost =
      site.source.confidence === 'high' ? 10 : site.source.confidence === 'med' ? 5 : 0;
    const preferBoost =
      opts.preferSeedId && site.source.seedId === opts.preferSeedId ? 0.5 : 0;
    const score = severity(result.class) + confBoost + preferBoost;
    if (score > bestScore) {
      bestScore = score;
      best = {
        class: result.class,
        siteId: site.id,
        seedId: site.source.seedId,
        confidence: site.source.confidence,
        barrierId: result.barrier?.id ?? null,
        lockId: result.lock?.id ?? null,
        sitesNear: sites.map((s) => s.source.seedId),
      };
    }
  }

  return (
    best ?? {
      class: 'no_barrier',
      siteId: sites[0]!.id,
      seedId: sites[0]!.source.seedId,
      confidence: sites[0]!.source.confidence,
      barrierId: null,
      lockId: null,
      sitesNear: sites.map((s) => s.source.seedId),
    }
  );
}

function agreementOf(
  old: OldBarrierVerdict,
  neu: HydraulicCrossingClass,
  actionable: boolean,
): ShadowAgreement {
  if (!actionable && REJECT_CLASSES.has(neu)) return 'advisory_only';

  if (old === 'illegal' && REJECT_CLASSES.has(neu)) return 'agree';
  if (old === 'legal_passage' && neu === 'legal_lock_passage') return 'agree';
  if (old === 'no_barrier' && (neu === 'no_barrier' || neu === 'beside_barrier')) {
    return 'agree';
  }

  // Production has no KNOWN_BARRIER for most cascade sites; hydro-index may
  // still classify a crest chord. That is extended coverage, not a FP vs prod.
  if (old === 'no_barrier' && (REJECT_CLASSES.has(neu) || neu === 'legal_lock_passage')) {
    return 'new_coverage';
  }

  return 'disagree';
}

function reasonOf(
  agreement: ShadowAgreement,
  old: OldBarrierShadow,
  neu: NewHydroShadow,
  actionable: boolean,
): string {
  const bits: string[] = [];
  if (!actionable) bits.push('low-confidence site → not actionable for reject/repair');
  if (old.verdict === 'illegal' && neu.class === 'beside_barrier') {
    bits.push('false-negative risk: dam crossing → beside');
  }
  if (old.verdict === 'illegal' && neu.class === 'no_barrier') {
    bits.push('false-negative: dam crossing missed');
  }
  if (old.verdict === 'legal_passage' && (neu.class === 'no_barrier' || neu.class === 'beside_barrier')) {
    bits.push('false-negative risk: legal lock route → ' + neu.class);
  }
  if (old.verdict === 'legal_passage' && REJECT_CLASSES.has(neu.class)) {
    bits.push('false-positive risk: legal lock route rejected by hydro');
  }
  if (old.verdict === 'no_barrier' && REJECT_CLASSES.has(neu.class) && actionable) {
    bits.push('new_coverage or false-positive vs empty KNOWN_BARRIERS');
  }
  if (neu.lockId && REJECT_CLASSES.has(neu.class)) {
    bits.push('nearby lock present but passage not accepted');
  }
  if (agreement === 'agree') bits.push('old and new agree on severity class');
  if (agreement === 'new_coverage') {
    bits.push('hydro-index sees a barrier; KNOWN_BARRIERS has no entry here');
  }
  if (agreement === 'advisory_only') {
    bits.push('shadow must not reject/repair on this confidence');
  }
  if (!bits.length) bits.push(`old=${old.verdict} new=${neu.class}`);
  return bits.join('; ');
}

/**
 * Compare KNOWN_BARRIERS vs hydro-index detector for one path.
 * Never mutates routing — report only.
 */
export function compareHydroShadow(
  path: LngLat[],
  opts: HydroShadowOptions = {},
): HydroShadowReport {
  const old = evaluateOldKnownBarriers(path);
  const neu = evaluateNewHydroDetector(path, opts);
  const actionable = neu.confidence !== 'low' && neu.confidence !== null;
  const agreement = agreementOf(old.verdict, neu.class, actionable);
  const wouldRejectIfWired = actionable && REJECT_CLASSES.has(neu.class);

  return {
    caseId: opts.caseId ?? 'anon',
    site: neu.seedId ?? neu.siteId,
    confidence: neu.confidence,
    oldKnownBarriers: old.verdict,
    oldBarrierId: old.barrierId,
    newHydro: neu.class,
    agreement,
    barrier: neu.barrierId ?? old.barrierId,
    lock: neu.lockId,
    reason: reasonOf(agreement, old, neu, actionable),
    wouldRejectIfWired,
    actionable,
  };
}

export type HydroShadowCase = {
  caseId: string;
  path: LngLat[];
  preferSeedId?: string;
  forceSite?: HydraulicSite | null;
  padKm?: number;
};

export type HydroShadowRegressionSummary = {
  reports: HydroShadowReport[];
  total: number;
  byClass: Record<HydraulicCrossingClass, number>;
  agreements: number;
  disagreements: HydroShadowReport[];
  newCoverage: number;
  advisoryOnly: number;
  /** Legal route marked illegal/barrier_without_lock by hydro. */
  falsePositives: HydroShadowReport[];
  /** Old illegal missed, or old legal not seen as legal_lock_passage. */
  falseNegatives: HydroShadowReport[];
  lowConfidenceActionable: HydroShadowReport[];
};

/** Batch shadow compare — offline regression board helper. */
export function runHydroShadowRegression(cases: HydroShadowCase[]): HydroShadowRegressionSummary {
  const reports = cases.map((c) =>
    compareHydroShadow(c.path, {
      caseId: c.caseId,
      preferSeedId: c.preferSeedId,
      forceSite: c.forceSite,
      padKm: c.padKm ?? 5,
    }),
  );

  const byClass: Record<HydraulicCrossingClass, number> = {
    legal_lock_passage: 0,
    illegal_dam_crossing: 0,
    beside_barrier: 0,
    no_barrier: 0,
    barrier_without_lock: 0,
  };
  for (const r of reports) byClass[r.newHydro] += 1;

  const disagreements = reports.filter((r) => r.agreement === 'disagree');
  const falsePositives = reports.filter(
    (r) =>
      r.wouldRejectIfWired &&
      r.oldKnownBarriers === 'legal_passage' &&
      (r.newHydro === 'illegal_dam_crossing' || r.newHydro === 'barrier_without_lock'),
  );
  const falseNegatives = reports.filter(
    (r) =>
      (r.oldKnownBarriers === 'illegal' &&
        (r.newHydro === 'beside_barrier' || r.newHydro === 'no_barrier')) ||
      (r.oldKnownBarriers === 'legal_passage' &&
        r.agreement === 'disagree' &&
        (r.newHydro === 'beside_barrier' || r.newHydro === 'no_barrier')),
  );
  const lowConfidenceActionable = reports.filter(
    (r) => r.confidence === 'low' && (r.actionable || r.wouldRejectIfWired),
  );

  return {
    reports,
    total: reports.length,
    byClass,
    agreements: reports.filter((r) => r.agreement === 'agree').length,
    disagreements,
    newCoverage: reports.filter((r) => r.agreement === 'new_coverage').length,
    advisoryOnly: reports.filter((r) => r.agreement === 'advisory_only').length,
    falsePositives,
    falseNegatives,
    lowConfidenceActionable,
  };
}

/** One-line report block matching the Stage-5 case template. */
export function formatHydroShadowReport(r: HydroShadowReport): string {
  return [
    `case = ${r.caseId}`,
    `site = ${r.site ?? '-'}`,
    `confidence = ${r.confidence ?? '-'}`,
    `old KNOWN_BARRIERS result = ${r.oldKnownBarriers}${r.oldBarrierId ? ` (${r.oldBarrierId})` : ''}`,
    `new hydro result = ${r.newHydro}`,
    `agreement = ${r.agreement}`,
    `barrier = ${r.barrier ?? '-'}`,
    `lock = ${r.lock ?? '-'}`,
    `reason = ${r.reason}`,
    `actionable = ${r.actionable}`,
    `wouldRejectIfWired = ${r.wouldRejectIfWired}`,
  ].join('\n');
}
