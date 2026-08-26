/**
 * Production accept gate for the OSM hydro-index detector.
 *
 * Rules (Stage 8):
 * - confidence=high + illegal_dam_crossing → reject (illegal_barrier)
 * - confidence=high + legal_lock_passage / beside / no_barrier → accept
 * - confidence=med|low → advisory only; NEVER reject
 * - KNOWN_BARRIERS valid passage cannot be overturned by hydro
 *
 * Does not change BRouter / snap / display / method semantics.
 * Callers should still run applyKnownBarrierRepairs before validate.
 */

import type { LngLat } from './geo';
import type { HydraulicCrossingClass } from './hydro-barriers';
import type { HydroConfidence } from './hydro-index';
import {
  evaluateNewHydroDetector,
  evaluateOldKnownBarriers,
} from './hydro-shadow';

export type HydroAcceptDecision = {
  /** True only for high-confidence illegal_dam_crossing (and not overridden). */
  reject: boolean;
  confidence: HydroConfidence | null;
  classification: HydraulicCrossingClass | null;
  siteSeedId: string | null;
  /** True when a med/low hit would have been reject-class but must stay advisory. */
  advisoryOnly: boolean;
  reason: string;
};

const REJECT_CLASS: HydraulicCrossingClass = 'illegal_dam_crossing';

/**
 * Safety invariant helper — low/med confidence must never flip acceptance.
 */
export function hydroConfidenceMayReject(confidence: HydroConfidence | null): boolean {
  return confidence === 'high';
}

/**
 * Evaluate hydro-index against a candidate routing track for accept/reject.
 * Pure + offline (bundled index). No site-name hardcoding.
 */
export function evaluateHydroAcceptGate(path: LngLat[]): HydroAcceptDecision {
  if (path.length < 2) {
    return {
      reject: false,
      confidence: null,
      classification: null,
      siteSeedId: null,
      advisoryOnly: false,
      reason: 'too few points',
    };
  }

  const old = evaluateOldKnownBarriers(path);
  const neu = evaluateNewHydroDetector(path, { padKm: 5 });
  const confidence = neu.confidence;
  const classification = neu.class;
  const siteSeedId = neu.seedId;

  // Invariant: med/low never reject — advisory only.
  if (!hydroConfidenceMayReject(confidence)) {
    const wouldHaveRejected =
      classification === REJECT_CLASS || classification === 'barrier_without_lock';
    return {
      reject: false,
      confidence,
      classification,
      siteSeedId,
      advisoryOnly: Boolean(confidence && wouldHaveRejected),
      reason:
        confidence == null
          ? 'no hydro site in corridor'
          : `${confidence}-confidence hydro → advisory only (never reject)`,
    };
  }

  // Coexistence with KNOWN_BARRIERS: a valid lock passage must not become illegal.
  if (old.verdict === 'legal_passage') {
    return {
      reject: false,
      confidence,
      classification,
      siteSeedId,
      advisoryOnly: false,
      reason: `KNOWN_BARRIERS valid passage (${old.barrierId}) — hydro cannot reject`,
    };
  }

  if (classification === REJECT_CLASS) {
    return {
      reject: true,
      confidence,
      classification,
      siteSeedId,
      advisoryOnly: false,
      reason: `high-confidence ${REJECT_CLASS} at ${siteSeedId ?? 'site'}`,
    };
  }

  return {
    reject: false,
    confidence,
    classification,
    siteSeedId,
    advisoryOnly: false,
    reason: `high-confidence ${classification} → accept`,
  };
}

/** True when the hydro gate alone would reject this path. */
export function hydroHighConfidenceRejects(path: LngLat[]): boolean {
  return evaluateHydroAcceptGate(path).reject;
}
