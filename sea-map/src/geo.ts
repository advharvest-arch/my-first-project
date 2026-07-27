export type LngLat = { lon: number; lat: number };

const R_KM = 6371;

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

export function pathLengthKm(points: LngLat[]): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++) sum += haversineKm(points[i - 1]!, points[i]!);
  return sum;
}

export function formatKm(km: number): string {
  if (km < 1) return `${Math.round(km * 1000)} м`;
  if (km < 10) return `${km.toFixed(2)} км`;
  return `${Math.round(km).toLocaleString('ru-RU')} км`;
}

export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} мин`;
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  if (d <= 0) return `${h} ч`;
  return `${d} д ${h} ч`;
}

export function etaHours(distanceKm: number, speedKmh: number): number {
  const speed = Math.max(0.1, speedKmh);
  return distanceKm / speed;
}

/** Offset a path sideways (meters). Positive = left of travel direction. */
export function offsetPathMeters(points: LngLat[], meters: number): LngLat[] {
  if (points.length < 2 || meters === 0) return points.map((p) => ({ ...p }));

  const out: LngLat[] = [];
  for (let i = 0; i < points.length; i++) {
    const prev = points[Math.max(0, i - 1)]!;
    const next = points[Math.min(points.length - 1, i + 1)]!;
    const cur = points[i]!;
    // Approximate local east/north in meters
    const meanLat = toRad(cur.lat);
    const cosLat = Math.max(0.2, Math.cos(meanLat));
    const dx = (next.lon - prev.lon) * 111320 * cosLat;
    const dy = (next.lat - prev.lat) * 110540;
    const len = Math.hypot(dx, dy) || 1;
    // Left normal
    const nx = -dy / len;
    const ny = dx / len;
    out.push({
      lon: cur.lon + (nx * meters) / (111320 * cosLat),
      lat: cur.lat + (ny * meters) / 110540,
    });
  }
  return out;
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
