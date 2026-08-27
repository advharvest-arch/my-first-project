/**
 * E1.7 — water-aware long-span segmentation (feature-flagged).
 *
 * Does NOT use geodesic midpoints as joints. Seeds along the corridor are
 * search hints only; every joint must snap to waterway / fairway / lake.
 */

import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { routeWithBrouterAdaptive } from './brouter';
import { validateWaterRoute } from './validate-water-route';
import { evaluateHydroAcceptGate } from './hydro-gate';
import {
  endpointsStraddleRybinskBarrier,
  hasIllegalBarrierCrossing,
} from './routing-rules';
import { fairwayPinsNear } from './water-candidates';
import { maxWaterSnapKm } from './water-snap';

export type PrefetchCellFn = (lon: number, lat: number) => Promise<void>;

export const LONG_SPAN_TARGET_CHUNK_KM = 80;
export const LONG_SPAN_MIN_CHUNK_KM = 60;
export const LONG_SPAN_MAX_CHUNK_KM = 100;
export const LONG_SPAN_OVERLAP_KM = 12;
/** Max gap allowed at a seam after independent segment routing. */
export const SEAM_MAX_GAP_KM = 2.5;
export const LONG_SPAN_TRIGGER_KM = 120;

export type WaterSnapFn = (
  click: LngLat,
  maxKm?: number,
) => { point: LngLat; distKm: number; kind?: string; name?: string | null } | null;

export type LongSpanSegmentTrace = {
  index: number;
  a: { lon: number; lat: number };
  b: { lon: number; lat: number };
  lengthKm: number;
  method: string;
  brouterAttempts: number;
  ok: boolean;
  rejectReason: string | null;
  geoKm: number;
};

export type LongSpanSeamResult = {
  ok: boolean;
  reason: string | null;
  gapKm: number;
};

export type LongSpanPlan = {
  joints: LngLat[];
  /** Geodesic seeds used only as search hints (not joints). */
  seeds: LngLat[];
  targetChunkKm: number;
  rejectReason: string | null;
};

export type LongSpanRunResult = {
  ok: boolean;
  points: LngLat[];
  lengthKm: number;
  method: 'waterway' | 'lake' | 'route_not_found';
  waterName: string | null;
  segments: LongSpanSegmentTrace[];
  seamFailures: number;
  failedSegment: number | null;
  rejectReason: string | null;
};

function ll(p: LngLat): { lon: number; lat: number } {
  return { lon: p.lon, lat: p.lat };
}

/** Geodesic sample points — SEARCH SEEDS ONLY, never used as joints as-is. */
export function corridorSearchSeeds(a: LngLat, b: LngLat, targetChunkKm: number): LngLat[] {
  const geo = haversineKm(a, b);
  if (!(targetChunkKm > 0) || geo <= targetChunkKm) return [];
  const step = Math.min(LONG_SPAN_MAX_CHUNK_KM, Math.max(LONG_SPAN_MIN_CHUNK_KM, targetChunkKm));
  // Place seeds every (step - overlap) along geodesic for denser snap chances.
  const advance = Math.max(30, step - LONG_SPAN_OVERLAP_KM);
  const seeds: LngLat[] = [];
  for (let d = advance; d < geo - advance * 0.35; d += advance) {
    const t = d / geo;
    seeds.push({
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    });
  }
  return seeds;
}

/**
 * Snap a search seed onto water. Prefers fairway pins, then waterway/lake snap.
 * Returns null if no water within max snap — joint is NOT the geodesic seed.
 */
export function snapSeedToWater(seed: LngLat, toward: LngLat, snap: WaterSnapFn): LngLat | null {
  const maxKm = maxWaterSnapKm();
  const pins = fairwayPinsNear(seed, Math.max(maxKm, 12), toward, 3);
  if (pins.length) {
    let best = pins[0]!;
    let bestScore = Infinity;
    for (const cand of pins) {
      const d = cand.distKm;
      const align = haversineKm(cand.point, toward);
      const score = d + 0.15 * align;
      if (score < bestScore) {
        bestScore = score;
        best = cand;
      }
    }
    return best.point;
  }
  const hit = snap(seed, maxKm);
  if (hit && hit.distKm <= maxKm) return hit.point;
  // Small lateral probes around seed (still must snap — not used raw).
  const latRad = (seed.lat * Math.PI) / 180;
  const dLon = 0.08 / Math.max(0.2, Math.cos(latRad));
  for (const [dLonS, dLatS] of [
    [dLon, 0],
    [-dLon, 0],
    [0, 0.08],
    [0, -0.08],
    [dLon * 0.7, 0.07],
    [-dLon * 0.7, -0.07],
  ] as const) {
    const probe = { lon: seed.lon + dLonS, lat: seed.lat + dLatS };
    const h = snap(probe, maxKm);
    if (h && h.distKm <= maxKm) return h.point;
  }
  return null;
}

/**
 * Build water-aware joints A … Jn … B. Fails if any required joint cannot snap.
 */
export function planWaterAwareJoints(
  a: LngLat,
  b: LngLat,
  snap: WaterSnapFn,
  targetChunkKm = LONG_SPAN_TARGET_CHUNK_KM,
): LongSpanPlan {
  const seeds = corridorSearchSeeds(a, b, targetChunkKm);
  if (!seeds.length) {
    return { joints: [a, b], seeds: [], targetChunkKm, rejectReason: null };
  }

  const joints: LngLat[] = [a];
  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]!;
    const toward = i + 1 < seeds.length ? seeds[i + 1]! : b;
    const joint = snapSeedToWater(seed, toward, snap);
    if (!joint) {
      return {
        joints: [a, b],
        seeds,
        targetChunkKm,
        rejectReason: `joint_snap_fail@${i}`,
      };
    }
    // Skip near-duplicate joints.
    const prev = joints[joints.length - 1]!;
    if (haversineKm(prev, joint) < 15) continue;
    if (haversineKm(joint, b) < 20) continue;
    joints.push(joint);
  }
  joints.push(b);

  // Ensure consecutive joint spans are within max chunk (+tolerance).
  for (let i = 1; i < joints.length; i++) {
    const span = haversineKm(joints[i - 1]!, joints[i]!);
    if (span > LONG_SPAN_MAX_CHUNK_KM + 25) {
      return {
        joints,
        seeds,
        targetChunkKm,
        rejectReason: `chunk_too_long_${span.toFixed(0)}km@${i - 1}`,
      };
    }
  }

  return { joints, seeds, targetChunkKm, rejectReason: null };
}

export function validateSegmentSeam(
  prevEnd: LngLat,
  nextStart: LngLat,
  _opts?: { sharedJoint?: LngLat | null },
): LongSpanSeamResult {
  const gapKm = haversineKm(prevEnd, nextStart);
  if (gapKm > SEAM_MAX_GAP_KM) {
    return { ok: false, reason: `seam_gap_${gapKm.toFixed(2)}km`, gapKm };
  }
  if (endpointsStraddleRybinskBarrier(prevEnd, nextStart)) {
    return { ok: false, reason: 'seam_rybinsk_barrier', gapKm };
  }
  const bridge = [prevEnd, nextStart];
  if (hasIllegalBarrierCrossing(bridge)) {
    return { ok: false, reason: 'seam_illegal_barrier', gapKm };
  }
  return { ok: true, reason: null, gapKm };
}

function stitch(parts: LngLat[][]): LngLat[] {
  const out: LngLat[] = [];
  for (const part of parts) {
    if (!part.length) continue;
    if (!out.length) {
      out.push(...part);
      continue;
    }
    // Drop duplicate joint.
    out.push(...part.slice(1));
  }
  return out;
}

/**
 * Route A→B as sequential water-aware segments. Full chain must pass
 * validateWaterRoute + hydro-gate against original endpoints.
 */
export async function runLongSpanSegmentedRoute(
  a: LngLat,
  b: LngLat,
  snap: WaterSnapFn,
  prefetchCell?: PrefetchCellFn,
): Promise<LongSpanRunResult> {
  const empty = (reason: string, segments: LongSpanSegmentTrace[] = [], seamFailures = 0, failedSegment: number | null = null): LongSpanRunResult => ({
    ok: false,
    points: [],
    lengthKm: 0,
    method: 'route_not_found',
    waterName: null,
    segments,
    seamFailures,
    failedSegment,
    rejectReason: reason,
  });

  const geo = haversineKm(a, b);
  if (geo <= LONG_SPAN_TRIGGER_KM) {
    return empty('not_long_span');
  }

  // Prefetch water cells along corridor seeds so snaps are not empty-cache.
  if (prefetchCell) {
    const seeds = corridorSearchSeeds(a, b, LONG_SPAN_TARGET_CHUNK_KM);
    const points = [a, ...seeds, b];
    await Promise.all(
      points.map((p) => prefetchCell(p.lon, p.lat).catch(() => undefined)),
    );
  }

  const plan = planWaterAwareJoints(a, b, snap);
  if (plan.rejectReason) {
    return empty(plan.rejectReason);
  }
  if (plan.joints.length < 3) {
    return empty('insufficient_joints');
  }

  const segments: LongSpanSegmentTrace[] = [];
  const geometries: LngLat[][] = [];
  let seamFailures = 0;

  for (let i = 1; i < plan.joints.length; i++) {
    const sa = plan.joints[i - 1]!;
    const sb = plan.joints[i]!;
    const geoKm = haversineKm(sa, sb);
    let brouterAttempts = 0;
    brouterAttempts += 1;
    const brouted = await routeWithBrouterAdaptive([sa, sb]);
    if (!brouted || brouted.points.length < 2 || brouted.lengthKm <= 0) {
      segments.push({
        index: i - 1,
        a: ll(sa),
        b: ll(sb),
        lengthKm: 0,
        method: 'route_not_found',
        brouterAttempts,
        ok: false,
        rejectReason: 'brouter_fail',
        geoKm,
      });
      return empty('segment_brouter_fail', segments, seamFailures, i - 1);
    }

    // Bogus short track detection (Belomor mid-class).
    if (geoKm > 25 && brouted.lengthKm < geoKm * 0.45) {
      segments.push({
        index: i - 1,
        a: ll(sa),
        b: ll(sb),
        lengthKm: brouted.lengthKm,
        method: 'waterway',
        brouterAttempts,
        ok: false,
        rejectReason: 'brouter_bogus_short',
        geoKm,
      });
      return empty('segment_bogus_short', segments, seamFailures, i - 1);
    }

    const validation = validateWaterRoute(brouted.points, {
      waypoints: [sa, sb],
      lengthKm: brouted.lengthKm,
      method: 'waterway',
      endpointSnapKm: maxWaterSnapKm(),
    });
    if (!validation.ok) {
      segments.push({
        index: i - 1,
        a: ll(sa),
        b: ll(sb),
        lengthKm: brouted.lengthKm,
        method: 'waterway',
        brouterAttempts,
        ok: false,
        rejectReason: validation.issues.join(',') || 'segment_validator',
        geoKm,
      });
      return empty('segment_validator_reject', segments, seamFailures, i - 1);
    }

    const hydro = evaluateHydroAcceptGate(brouted.points);
    if (hydro.reject) {
      segments.push({
        index: i - 1,
        a: ll(sa),
        b: ll(sb),
        lengthKm: brouted.lengthKm,
        method: 'waterway',
        brouterAttempts,
        ok: false,
        rejectReason: `hydro:${hydro.reason}`,
        geoKm,
      });
      return empty('segment_hydro_reject', segments, seamFailures, i - 1);
    }

    if (geometries.length) {
      const prev = geometries[geometries.length - 1]!;
      const prevEnd = prev[prev.length - 1]!;
      const nextStart = brouted.points[0]!;
      const seam = validateSegmentSeam(prevEnd, nextStart, { sharedJoint: sa });
      if (!seam.ok) {
        seamFailures += 1;
        segments.push({
          index: i - 1,
          a: ll(sa),
          b: ll(sb),
          lengthKm: brouted.lengthKm,
          method: 'waterway',
          brouterAttempts,
          ok: false,
          rejectReason: seam.reason,
          geoKm,
        });
        return empty(seam.reason ?? 'seam_failure', segments, seamFailures, i - 1);
      }
    }

    geometries.push(brouted.points);
    segments.push({
      index: i - 1,
      a: ll(sa),
      b: ll(sb),
      lengthKm: brouted.lengthKm,
      method: 'waterway',
      brouterAttempts,
      ok: true,
      rejectReason: null,
      geoKm,
    });
  }

  const stitched = stitch(geometries);
  if (stitched.length < 2) return empty('stitch_empty', segments, seamFailures);

  const lengthKm = pathLengthKm(stitched);
  const fullValidation = validateWaterRoute(stitched, {
    waypoints: [a, b],
    lengthKm,
    method: 'waterway',
    endpointSnapKm: maxWaterSnapKm(),
  });
  if (!fullValidation.ok) {
    return empty(
      fullValidation.issues.join(',') || 'chain_validator_reject',
      segments,
      seamFailures,
    );
  }
  const fullHydro = evaluateHydroAcceptGate(stitched);
  if (fullHydro.reject) {
    return empty(`hydro:${fullHydro.reason}`, segments, seamFailures);
  }

  return {
    ok: true,
    points: stitched,
    lengthKm,
    method: 'waterway',
    waterName: null,
    segments,
    seamFailures,
    failedSegment: null,
    rejectReason: null,
  };
}
