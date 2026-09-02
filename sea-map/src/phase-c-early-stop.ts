/**
 * E1.6 — Phase C early-stop decision (pure).
 *
 * When USE_ROUTE_EARLY_STOP=false, callers must never stop early.
 * When true, stop only on clearly excellent accepted trials — thresholds here
 * do NOT change MAX_WATER_SNAP / residual ceilings / hydro / STEM / VETL.
 */

export type PhaseCEarlyStopInput = {
  enabled: boolean;
  /** scoreAcceptedPhaseCRoute result (lower is better). */
  score: number;
  startResidualKm: number;
  finishResidualKm: number;
  lengthKm: number;
  geoKm: number;
  classPenalty: number;
  hydroReject: boolean;
};

/**
 * Excellent = tiny residuals, modest detour, soft fairway-ish class penalty.
 * Conservative so default-off path stays identical; when on, skips remaining
 * pairs that cannot beat an already-great accept.
 */
export const EARLY_STOP_MAX_RESIDUAL_SUM_KM = 2.0;
export const EARLY_STOP_MAX_DETOUR = 0.35;
export const EARLY_STOP_MAX_CLASS_PENALTY = 0.6;
export const EARLY_STOP_MAX_SCORE = 2.5;

export function shouldEarlyStopPhaseC(input: PhaseCEarlyStopInput): boolean {
  if (!input.enabled) return false;
  if (input.hydroReject) return false;
  if (!(input.lengthKm > 0) || !(input.geoKm > 0.1)) return false;
  const residualSum = input.startResidualKm + input.finishResidualKm;
  if (residualSum > EARLY_STOP_MAX_RESIDUAL_SUM_KM) return false;
  const detour = Math.max(0, input.lengthKm / input.geoKm - 1);
  if (detour > EARLY_STOP_MAX_DETOUR) return false;
  if (input.classPenalty > EARLY_STOP_MAX_CLASS_PENALTY) return false;
  if (input.score > EARLY_STOP_MAX_SCORE) return false;
  return true;
}
