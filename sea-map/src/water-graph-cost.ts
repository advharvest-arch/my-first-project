/**
 * E2.0 — WaterGraph edge cost model.
 * Soft class multipliers only — never ∞ for non-fairway.
 * Do not double-apply Phase D classPenalty here.
 */

import type { WaterGraphEdgeKind } from './water-graph-types';

export const WG_CLASS_MULTIPLIER: Record<WaterGraphEdgeKind, number> = {
  fairway: 0.7,
  mask: 0.85,
  waterway: 1.0,
  canal: 1.05,
  seam: 1.1,
  lock: 1.0,
  bridge_gap: 1.15,
};

export const WG_DEFAULT_PORTAL_FEE_KM = 0.15;
export const WG_DEFAULT_LOCK_FEE_KM = 0.25;

export type WaterGraphEdgeCostInput = {
  lengthKm: number;
  kind: WaterGraphEdgeKind;
  /** Optional soft stem multiplier (≥1). Default 1. */
  stemMultiplier?: number;
  portalFee?: number;
  lockFee?: number;
};

/**
 * edgeCost = lengthKm × classMultiplier × stemMultiplier + portalFee + lockFee
 */
export function getWaterGraphEdgeCost(input: WaterGraphEdgeCostInput): number {
  const lengthKm = Math.max(0, input.lengthKm);
  const classMul = WG_CLASS_MULTIPLIER[input.kind] ?? 1;
  const stemMul = Math.max(1, input.stemMultiplier ?? 1);
  let portal = 0;
  let lock = 0;
  if (input.kind === 'seam') {
    portal = input.portalFee ?? WG_DEFAULT_PORTAL_FEE_KM;
  }
  if (input.kind === 'lock') {
    lock = input.lockFee ?? WG_DEFAULT_LOCK_FEE_KM;
  }
  return lengthKm * classMul * stemMul + portal + lock;
}

/** Preference order at equal length (unit tests). */
export function classPreferenceRank(kind: WaterGraphEdgeKind): number {
  // lower is better
  switch (kind) {
    case 'fairway':
      return 0;
    case 'mask':
      return 1;
    case 'waterway':
      return 2;
    case 'canal':
      return 3;
    case 'lock':
      return 4;
    case 'seam':
      return 5;
    case 'bridge_gap':
      return 6;
    default:
      return 9;
  }
}
