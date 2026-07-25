export type LngLat = { lon: number; lat: number };

const R_KM = 6371;
const R_NM = 3440.065;

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}

export function haversineKm(a: LngLat, b: LngLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function haversineNm(a: LngLat, b: LngLat): number {
  return haversineKm(a, b) * (R_NM / R_KM);
}

export function pathLengthKm(points: LngLat[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1]!, points[i]!);
  return sum;
}

export function formatDistance(km: number): { km: string; nm: string } {
  const nm = km * (R_NM / R_KM);
  return {
    km: km < 10 ? `${km.toFixed(2)} км` : `${Math.round(km).toLocaleString('ru-RU')} км`,
    nm: nm < 10 ? `${nm.toFixed(2)} м.миль` : `${Math.round(nm).toLocaleString('ru-RU')} м.миль`,
  };
}

/** Closest point on segment AB to P, and distance in km. */
export function closestOnSegment(
  p: LngLat,
  a: LngLat,
  b: LngLat,
): { point: LngLat; distKm: number; t: number } {
  const ax = a.lon;
  const ay = a.lat;
  const bx = b.lon;
  const by = b.lat;
  const px = p.lon;
  const py = p.lat;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const point = { lon: ax + t * dx, lat: ay + t * dy };
  return { point, distKm: haversineKm(p, point), t };
}
