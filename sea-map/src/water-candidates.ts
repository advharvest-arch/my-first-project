/**
 * Phase C — multi-candidate endpoint binding helpers.
 * Candidate *search* may use open-water radius; acceptance ceilings stay in water-snap.ts.
 */
import { closestOnSegment, haversineKm, type LngLat } from './geo';
import { REGIONAL_FAIRWAYS } from './routing-rules';

export const PHASE_C_K = 3;
export const PHASE_C_MAX_PAIRS = 9;

/**
 * Candidate *search* radius for fairway polyline projection (not an accept
 * ceiling). Vertices alone can sit >10 km from a shore click (L07 Tolyatti).
 */
export const PHASE_C_FAIRWAY_SEARCH_KM = 25;

export type WaterCandidateSource = 'waterway' | 'lake' | 'fairway' | 'mask' | 'raw';

export type WaterCandidate = {
  point: LngLat;
  /** Distance from the original click to this candidate (km). */
  distKm: number;
  source: WaterCandidateSource;
  /**
   * Selection rank (lower = better). Combines distance with optional
   * destination alignment — not the final route score.
   */
  rank: number;
};

/** Dot-product alignment of (cand−origin) with (toward−origin), in km² units. */
export function towardAlignmentKm2(
  origin: LngLat,
  cand: LngLat,
  toward: LngLat | null | undefined,
): number {
  if (!toward) return 0;
  const cos = Math.max(0.2, Math.cos(((origin.lat + toward.lat) / 2) * (Math.PI / 180)));
  const ox = (toward.lon - origin.lon) * 111.32 * cos;
  const oy = (toward.lat - origin.lat) * 110.54;
  const olen = Math.hypot(ox, oy);
  if (olen < 0.2) return 0;
  const cx = (cand.lon - origin.lon) * 111.32 * cos;
  const cy = (cand.lat - origin.lat) * 110.54;
  return (cx * ox + cy * oy) / olen;
}

/** Lower is better for picking candidates to try. */
export function candidateRank(
  distKm: number,
  origin: LngLat,
  cand: LngLat,
  toward: LngLat | null | undefined,
): number {
  const align = towardAlignmentKm2(origin, cand, toward);
  // Prefer points that move toward the destination; still penalize raw distance.
  return distKm - 0.35 * Math.max(0, align);
}

export function fairwayPinsNear(
  p: LngLat,
  maxKm: number,
  toward: LngLat | null | undefined,
  limit: number,
  /** Cap for approach pins pulled back toward the click (Phase B residual). */
  approachResidualKm = 5.5,
): WaterCandidate[] {
  const searchKm = Math.max(maxKm, PHASE_C_FAIRWAY_SEARCH_KM);
  const hits: WaterCandidate[] = [];
  for (const fairway of REGIONAL_FAIRWAYS) {
    // Vertex pins
    for (const pin of fairway) {
      const distKm = haversineKm(p, pin);
      if (distKm > searchKm) continue;
      hits.push({
        point: { lon: pin.lon, lat: pin.lat },
        distKm,
        source: 'fairway',
        rank: candidateRank(distKm, p, pin, toward),
      });
    }
    // Closest points on fairway segments (shore clicks between vertices).
    for (let i = 1; i < fairway.length; i++) {
      const hit = closestOnSegment(p, fairway[i - 1]!, fairway[i]!);
      if (hit.distKm > searchKm) continue;
      hits.push({
        point: hit.point,
        distKm: hit.distKm,
        source: 'fairway',
        // Prefer true fairway geometry over approach rays (L07 binds here).
        rank: candidateRank(hit.distKm, p, hit.point, toward) - 1.5,
      });
      // If the fairway lies outside the short Phase B residual, also offer an
      // approach pin on the click→fairway ray (used when snap ceiling is 5.5).
      if (hit.distKm > approachResidualKm && approachResidualKm > 0.2) {
        const t = approachResidualKm / hit.distKm;
        const approach = {
          lon: p.lon + (hit.point.lon - p.lon) * t,
          lat: p.lat + (hit.point.lat - p.lat) * t,
        };
        const ad = haversineKm(p, approach);
        hits.push({
          point: approach,
          distKm: ad,
          source: 'fairway',
          rank: candidateRank(ad, p, approach, toward),
        });
      }
    }
  }
  hits.sort((a, b) => a.rank - b.rank || a.distKm - b.distKm);
  return diversifyCandidates(hits, limit, 1.2);
}

/**
 * Drop near-duplicates so k candidates span different arms / shores.
 */
export function diversifyCandidates(
  sorted: WaterCandidate[],
  limit: number,
  minSepKm: number,
): WaterCandidate[] {
  const out: WaterCandidate[] = [];
  for (const c of sorted) {
    if (out.some((o) => haversineKm(o.point, c.point) < minSepKm)) continue;
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

export function mergeCandidatePools(
  pools: WaterCandidate[][],
  limit: number,
): WaterCandidate[] {
  const all = pools.flat().sort((a, b) => a.rank - b.rank || a.distKm - b.distKm);
  return diversifyCandidates(all, limit, 0.85);
}

/**
 * Build up to maxPairs (A,B) trials. Prefer destination-aligned pairs; skip
 * near-identity with the original clicks (already tried upstream).
 */
export function selectPhaseCPairs(
  candsA: WaterCandidate[],
  candsB: WaterCandidate[],
  originalA: LngLat,
  originalB: LngLat,
  maxPairs = PHASE_C_MAX_PAIRS,
): Array<[WaterCandidate, WaterCandidate]> {
  type Pair = { a: WaterCandidate; b: WaterCandidate; rank: number };
  const pairs: Pair[] = [];
  for (const a of candsA) {
    for (const b of candsB) {
      const sameAsOriginal =
        haversineKm(a.point, originalA) < 0.15 && haversineKm(b.point, originalB) < 0.15;
      if (sameAsOriginal) continue;
      // Prefer pairs that collectively move toward each other.
      const rank = a.rank + b.rank + 0.15 * haversineKm(a.point, b.point) * 0.001;
      pairs.push({ a, b, rank });
    }
  }
  pairs.sort((x, y) => x.rank - y.rank);
  const out: Array<[WaterCandidate, WaterCandidate]> = [];
  for (const p of pairs) {
    out.push([p.a, p.b]);
    if (out.length >= maxPairs) break;
  }
  return out;
}

/** Final route score after acceptPath succeeded (hydroReject already filtered). */
export function scoreAcceptedPhaseCRoute(
  startResidualKm: number,
  finishResidualKm: number,
  lengthKm: number,
  geoKm: number,
): number {
  const detour = geoKm > 0.1 ? Math.max(0, lengthKm / geoKm - 1) : 0;
  return startResidualKm + finishResidualKm + detour;
}

/** BRouter trial counter for this process (tests / live probes). */
let phaseCBrouterTrials = 0;

export function resetPhaseCBrouterTrials(): void {
  phaseCBrouterTrials = 0;
}

export function getPhaseCBrouterTrials(): number {
  return phaseCBrouterTrials;
}

export function notePhaseCBrouterTrial(): void {
  phaseCBrouterTrials += 1;
}
