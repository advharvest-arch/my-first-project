import { haversineKm, pathLengthKm, type LngLat } from './geo';

/** Drop consecutive duplicates and near-duplicates (default ~1.5 m). */
export function dedupeRoutePoints(points: LngLat[], minKm = 0.0015): LngLat[] {
  if (points.length < 2) return points.slice();
  const out: LngLat[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = out[out.length - 1]!;
    if (haversineKm(prev, p) >= minKm) out.push(p);
  }
  if (out.length === 1 && points.length > 1) out.push(points[points.length - 1]!);
  return out;
}

/**
 * True when consecutive points jump farther than `maxGapKm` (broken stitch).
 */
export function hasGeometryGap(points: LngLat[], maxGapKm = 25): boolean {
  for (let i = 1; i < points.length; i++) {
    if (haversineKm(points[i - 1]!, points[i]!) > maxGapKm) return true;
  }
  return false;
}

/** Ensure first/last vertices match the requested endpoints within snapKm. */
export function endpointsNearWaypoints(
  points: LngLat[],
  waypoints: LngLat[],
  snapKm: number,
): boolean {
  if (points.length < 2 || waypoints.length < 2) return false;
  const a = waypoints[0]!;
  const b = waypoints[waypoints.length - 1]!;
  return (
    haversineKm(points[0]!, a) <= snapKm &&
    haversineKm(points[points.length - 1]!, b) <= snapKm
  );
}

export type DualGeometry = {
  /** Navigable track (GPX / length). */
  routingGeometry: LngLat[];
  /** Map display line (may be refined / thinned). */
  displayGeometry: LngLat[];
  lengthKm: number;
};

/**
 * Keep routing geometry authoritative for length; display may be a visual polish
 * of the same track (never a different path invented for looks alone).
 */
export function dualGeometry(
  routing: LngLat[],
  display?: LngLat[] | null,
): DualGeometry {
  const routingGeometry = dedupeRoutePoints(routing);
  const displayGeometry =
    display && display.length >= 2 ? dedupeRoutePoints(display) : routingGeometry.slice();
  return {
    routingGeometry,
    displayGeometry,
    lengthKm: pathLengthKm(routingGeometry),
  };
}
