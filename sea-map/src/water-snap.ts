import { haversineKm, type LngLat } from './geo';

/**
 * Max auto-snap / endpoint-reach distance for river/canal routing.
 *
 * Chosen from live BRouter endpoint residuals (2026-08 audit):
 * - working stem / Dubna / Moscow-river: typically ≤ 1.3 km
 * - Volga–Baltic (Rybinsk→Cherepovets): up to ~2.52 km
 * - slight off-fairway Volga clicks: up to ~2.46 km
 * - Volga→Vetluga intent (wrong stem finish): ~7.4 km → must fail
 *
 * Keep a little headroom above 2.52 km without accepting multi-km stem misses.
 */
export const MAX_WATER_SNAP_DISTANCE_METERS = 3000;

/**
 * Open water / reservoir clicks often sit far from BRouter river centerlines.
 * Lake routing and lake accepts use this wider reach (Kuybyshev residual ~6.5 km).
 * Do NOT use this for ordinary waterway stem checks.
 */
export const MAX_OPEN_WATER_SNAP_DISTANCE_METERS = 10000;

export function maxWaterSnapKm(): number {
  return MAX_WATER_SNAP_DISTANCE_METERS / 1000;
}

export function maxOpenWaterSnapKm(): number {
  return MAX_OPEN_WATER_SNAP_DISTANCE_METERS / 1000;
}

export function maxSnapKmForMethod(method: 'waterway' | 'lake' | string): number {
  return method === 'lake' ? maxOpenWaterSnapKm() : maxWaterSnapKm();
}

/**
 * Max geodesic for accepting a BRouter track as method=lake when both ends
 * share an open-water catalog body (Phase B). Longer spans stay waterway so
 * giant reservoir bboxes cannot widen endpoint reach indefinitely.
 */
export const MAX_SHARED_LAKE_BROUTER_KM = 150;

/**
 * Choose BRouter accept method: shared open-water body + span within cap → lake
 * (10 km endpoint reach); otherwise waterway (3 km).
 */
export function chooseBrouterWaterMethod(
  sharedOpenLake: boolean,
  geoKm: number,
  waypointCount = 2,
): 'waterway' | 'lake' {
  if (!sharedOpenLake || waypointCount < 2) return 'waterway';
  if (!(geoKm > 0) || geoKm > MAX_SHARED_LAKE_BROUTER_KM) return 'waterway';
  return 'lake';
}

export type EndpointReach = {
  ok: boolean;
  startKm: number;
  finishKm: number;
  maxKm: number;
};

/**
 * Distance from routingGeometry ends to the *original* user START/FINISH
 * (not to an intermediate snapped waypoint).
 */
export function endpointReachToOriginals(
  routingGeometry: LngLat[],
  originalWaypoints: LngLat[],
  maxKm: number,
): EndpointReach {
  if (routingGeometry.length < 2 || originalWaypoints.length < 2) {
    return { ok: false, startKm: Infinity, finishKm: Infinity, maxKm };
  }
  const start = originalWaypoints[0]!;
  const finish = originalWaypoints[originalWaypoints.length - 1]!;
  const startKm = haversineKm(routingGeometry[0]!, start);
  const finishKm = haversineKm(routingGeometry[routingGeometry.length - 1]!, finish);
  return {
    ok: startKm <= maxKm && finishKm <= maxKm,
    startKm,
    finishKm,
    maxKm,
  };
}
