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
  if (!Number.isFinite(km) || km < 0) return '—';
  if (km > 0 && km < 0.1) return `${Math.round(km * 1000)} м`;
  return `${km.toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} км`;
}

export function formatDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  const totalMin = Math.max(0, Math.round(hours * 60));
  if (totalMin < 60) return `${hours > 0 ? Math.max(1, totalMin) : 0} мин`;
  const d = Math.floor(totalMin / (24 * 60));
  const h = Math.floor((totalMin % (24 * 60)) / 60);
  const m = totalMin % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d} д`);
  if (h > 0) parts.push(`${h} ч`);
  if (m > 0 || parts.length === 0) parts.push(`${m} мин`);
  return parts.join(' ');
}

export function etaHours(distanceKm: number, speedKmh: number): number {
  const speed = Math.max(0.1, speedKmh);
  return distanceKm / speed;
}

/** Offset a path sideways (meters). Positive = left of travel direction. */
export function offsetPathMeters(points: LngLat[], meters: number): LngLat[] {
  if (points.length < 2 || meters === 0) return points.map((p) => ({ ...p }));

  const toLocal = (p: LngLat, origin: LngLat) => {
    const cosLat = Math.max(0.2, Math.cos(toRad(origin.lat)));
    return {
      x: (p.lon - origin.lon) * 111320 * cosLat,
      y: (p.lat - origin.lat) * 110540,
    };
  };
  const fromLocal = (x: number, y: number, origin: LngLat): LngLat => {
    const cosLat = Math.max(0.2, Math.cos(toRad(origin.lat)));
    return {
      lon: origin.lon + x / (111320 * cosLat),
      lat: origin.lat + y / 110540,
    };
  };

  // Unit tangents sampled over ~25 m so tiny segments don't flip the normal.
  const tangents: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i]!;
    let back = i;
    let fwd = i;
    while (back > 0 && haversineKm(points[back]!, cur) * 1000 < 25) back -= 1;
    while (fwd < points.length - 1 && haversineKm(points[fwd]!, cur) * 1000 < 25) fwd += 1;
    if (back === i && i > 0) back = i - 1;
    if (fwd === i && i < points.length - 1) fwd = i + 1;
    const a = toLocal(points[back]!, cur);
    const b = toLocal(points[fwd]!, cur);
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    tangents.push({ x: dx / len, y: dy / len });
  }

  // Smooth tangents to keep parallel lines stable
  const smooth = tangents.map((t, i) => {
    const prev = tangents[Math.max(0, i - 1)]!;
    const next = tangents[Math.min(tangents.length - 1, i + 1)]!;
    let x = prev.x + t.x + next.x;
    let y = prev.y + t.y + next.y;
    const len = Math.hypot(x, y) || 1;
    return { x: x / len, y: y / len };
  });

  return points.map((cur, i) => {
    const t = smooth[i]!;
    return fromLocal(-t.y * meters, t.x * meters, cur);
  });
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
