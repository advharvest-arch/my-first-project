import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { hydroHighConfidenceRejects } from './hydro-gate';
import {
  dualGeometry,
  endpointsNearWaypoints,
  hasGeometryGap,
} from './route-geometry';
import { hasIllegalBarrierCrossing } from './routing-rules';
import { endpointSnapKmForAccept } from './water-snap';

export type WaterRouteValidationIssue =
  | 'empty'
  | 'too_few_points'
  | 'geometry_gap'
  | 'endpoints_far'
  | 'near_geodesic_chord'
  | 'river_chord'
  | 'excessive_detour'
  | 'illegal_barrier'
  | 'not_on_water_network'
  | 'direct_forbidden';

/**
 * Max length/geo ratio for *unverified* shared-lake BRouter accepts (Phase B).
 * Giant reservoir bboxes (e.g. Чебоксарское) can label a river-stem climb as
 * method=lake when residual ≤5.5 km (STEM wrong-arm ~3.1). Real open-pool /
 * fairway hops stay ~1.4–1.6 (L05/L14/L07). Phase A verified is exempt.
 */
export const MAX_UNVERIFIED_LAKE_DETOUR_RATIO = 2.5;

export type WaterRouteValidation = {
  ok: boolean;
  issues: WaterRouteValidationIssue[];
};

export type ValidateWaterRouteOptions = {
  waypoints: LngLat[];
  lengthKm?: number;
  method?: string;
  /**
   * Max distance from route ends to *original* user waypoints (km).
   * Defaults via endpointSnapKmForAccept: waterway 3 km; lake+verified 10 km;
   * lake without verified (Phase B shared-bbox) 5.5 km stem-miss ceiling.
   */
  endpointSnapKm?: number;
  /** Max jump between consecutive vertices (km). */
  maxGapKm?: number;
  /**
   * Verified open-lake / reservoir track (shared catalog body + mask-routed
   * water path). Skips dry-land near_geodesic / geometry_gap / river_chord
   * heuristics that otherwise reject clear open-water chords.
   * Does NOT skip illegal_barrier / hydro-gate.
   * Never set for ordinary BRouter shore tracks or unverified geodesics.
   */
  openWaterVerified?: boolean;
  /**
   * Optional water-network proximity samples (km).
   * When provided and fractionNear is low → not_on_water_network.
   * Not required for open water / reservoirs.
   */
  waterProximity?: {
    /** Distance from each sample to nearest waterway/lake (km). */
    sampleDistKm: number[];
    /** Max distance still considered "on water". */
    maxDistKm?: number;
    /** Required share of samples within maxDistKm (0..1). */
    minFraction?: number;
  };
};

/**
 * Universal water-route validator — river-agnostic property checks.
 * Geographic lock repairs live in routing-rules; this only rejects bad results.
 */
export function validateWaterRoute(
  points: LngLat[],
  opts: ValidateWaterRouteOptions,
): WaterRouteValidation {
  const issues: WaterRouteValidationIssue[] = [];

  if (opts.method === 'direct' || opts.method === 'route_not_found') {
    issues.push(opts.method === 'direct' ? 'direct_forbidden' : 'empty');
    return { ok: false, issues };
  }

  if (!points.length) {
    issues.push('empty');
    return { ok: false, issues };
  }
  if (points.length < 2) {
    issues.push('too_few_points');
    return { ok: false, issues };
  }

  const a = opts.waypoints[0];
  const b = opts.waypoints[opts.waypoints.length - 1];
  if (!a || !b) {
    issues.push('empty');
    return { ok: false, issues };
  }

  const geo = haversineKm(a, b);
  const lengthKm = opts.lengthKm ?? pathLengthKm(points);
  const openWaterVerified = Boolean(opts.openWaterVerified);
  const maxGap = opts.maxGapKm ?? Math.max(25, Math.min(80, geo * 0.15 + 20));
  // Dry-land gap heuristic: skip for mask-verified open-water tracks (Phase A).
  if (!openWaterVerified && hasGeometryGap(points, maxGap)) issues.push('geometry_gap');

  // Reach original user START/FINISH — not an intermediate snapped pin.
  // Unverified lake (Phase B shared-bbox) uses the stem-miss ceiling, not full 10 km.
  const snap =
    opts.endpointSnapKm ??
    endpointSnapKmForAccept(opts.method ?? 'waterway', openWaterVerified);
  if (!endpointsNearWaypoints(points, opts.waypoints, snap)) {
    issues.push('endpoints_far');
  }

  // Collapsed snap or pure land/air chord (near-geodesic).
  // Verified open-lake chords are allowed to be short/geodesic (Phase A).
  if (!openWaterVerified && geo >= 12) {
    const ratio = lengthKm / Math.max(geo, 0.001);
    if (lengthKm < geo * 0.85) issues.push('near_geodesic_chord');
    else if (points.length <= 2) issues.push('near_geodesic_chord');
    else if (ratio <= 1.04) issues.push('near_geodesic_chord');
    else if (ratio <= 1.1 && points.length < Math.max(5, geo / 25)) {
      issues.push('near_geodesic_chord');
    }
  }

  // Suspiciously straight chord across an expected river bend:
  // long span, few vertices relative to distance, still nearly geodesic.
  if (!openWaterVerified && geo >= 40) {
    const ratio = lengthKm / Math.max(geo, 0.001);
    const expectedMinPts = Math.max(8, Math.floor(geo / 12));
    if (ratio <= 1.18 && points.length < expectedMinPts) {
      issues.push('river_chord');
    }
  }

  // Unverified lake (Phase B shared-bbox): reject river-stem / wrong-arm climbs
  // that only pass the 5.5 km residual ceiling inside a giant reservoir box.
  // Phase A mask-verified open water is exempt (openWaterVerified).
  if (
    !openWaterVerified &&
    opts.method === 'lake' &&
    geo >= 12 &&
    lengthKm / Math.max(geo, 0.001) > MAX_UNVERIFIED_LAKE_DETOUR_RATIO
  ) {
    issues.push('excessive_detour');
  }

  if (hasIllegalBarrierCrossing(points)) {
    // KNOWN_BARRIERS fallback (Dubna / Rybinsk) — unchanged.
    issues.push('illegal_barrier');
  } else if (hydroHighConfidenceRejects(points)) {
    // High-confidence hydro-index only. med/low never reject.
    // Existing applyKnownBarrierRepairs / lock vias run earlier in BRouter finalize.
    issues.push('illegal_barrier');
  }

  const prox = opts.waterProximity;
  if (prox && prox.sampleDistKm.length >= 4) {
    const maxD = prox.maxDistKm ?? 1.5;
    const minFrac = prox.minFraction ?? 0.55;
    const near = prox.sampleDistKm.filter((d) => d <= maxD).length;
    if (near / prox.sampleDistKm.length < minFrac) {
      issues.push('not_on_water_network');
    }
  }

  return { ok: issues.length === 0, issues };
}

/** Build dual geometry only when the routing track validates. */
export function acceptedDualGeometry(
  routing: LngLat[],
  display: LngLat[] | null | undefined,
  opts: ValidateWaterRouteOptions,
): { ok: true; routingGeometry: LngLat[]; displayGeometry: LngLat[]; lengthKm: number } | {
  ok: false;
  validation: WaterRouteValidation;
} {
  const dual = dualGeometry(routing, display);
  const validation = validateWaterRoute(dual.routingGeometry, {
    ...opts,
    lengthKm: dual.lengthKm,
  });
  if (!validation.ok) return { ok: false, validation };
  return {
    ok: true,
    routingGeometry: dual.routingGeometry,
    displayGeometry: dual.displayGeometry,
    lengthKm: dual.lengthKm,
  };
}
