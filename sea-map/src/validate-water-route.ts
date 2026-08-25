import { haversineKm, pathLengthKm, type LngLat } from './geo';
import {
  dualGeometry,
  endpointsNearWaypoints,
  hasGeometryGap,
} from './route-geometry';
import { hasIllegalBarrierCrossing } from './routing-rules';

export type WaterRouteValidationIssue =
  | 'empty'
  | 'too_few_points'
  | 'geometry_gap'
  | 'endpoints_far'
  | 'near_geodesic_chord'
  | 'river_chord'
  | 'illegal_barrier'
  | 'not_on_water_network'
  | 'direct_forbidden';

export type WaterRouteValidation = {
  ok: boolean;
  issues: WaterRouteValidationIssue[];
};

export type ValidateWaterRouteOptions = {
  waypoints: LngLat[];
  lengthKm?: number;
  method?: string;
  /**
   * Max distance from route ends to requested waypoints (km).
   * Scales gently with span so long corridors stay tolerant.
   */
  endpointSnapKm?: number;
  /** Max jump between consecutive vertices (km). */
  maxGapKm?: number;
  /**
   * Optional water-network proximity samples (km).
   * When provided and fractionNear is low → not_on_water_network.
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
  const maxGap = opts.maxGapKm ?? Math.max(25, Math.min(80, geo * 0.15 + 20));
  if (hasGeometryGap(points, maxGap)) issues.push('geometry_gap');

  const snap =
    opts.endpointSnapKm ??
    Math.max(8, Math.min(40, 6 + geo * 0.05));
  if (!endpointsNearWaypoints(points, opts.waypoints, snap)) {
    issues.push('endpoints_far');
  }

  // Collapsed snap or pure land/air chord (near-geodesic).
  if (geo >= 12) {
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
  if (geo >= 40) {
    const ratio = lengthKm / Math.max(geo, 0.001);
    const expectedMinPts = Math.max(8, Math.floor(geo / 12));
    if (ratio <= 1.18 && points.length < expectedMinPts) {
      issues.push('river_chord');
    }
  }

  if (hasIllegalBarrierCrossing(points)) {
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
