import { haversineKm, type LngLat } from './geo';

export type BrouterResult = {
  points: LngLat[];
  lengthKm: number;
  wayTags: string[];
};

const BROUTER_URL = 'https://brouter.de/brouter';

/** Above this span, one-shot BRouter is often killed by the public watchdog. */
const ADAPTIVE_SPLIT_KM = 180;
const MAX_SPLIT_DEPTH = 4;

function parseWayTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

export function routeSpanKm(waypoints: LngLat[]): number {
  if (waypoints.length < 2) return 0;
  let chain = 0;
  let farthest = 0;
  const a0 = waypoints[0]!;
  for (let i = 1; i < waypoints.length; i++) {
    chain += haversineKm(waypoints[i - 1]!, waypoints[i]!);
    farthest = Math.max(farthest, haversineKm(a0, waypoints[i]!));
  }
  return Math.max(chain, farthest);
}

function brouterTimeoutMs(waypoints: LngLat[]): number {
  const span = routeSpanKm(waypoints);
  // Long inland corridors (Seliger→Vetluga scale) need room; public API is bursty.
  return Math.min(120_000, Math.max(15_000, 12_000 + span * 40));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function flattenCoords(geometry: {
  type?: string;
  coordinates?: number[][] | number[][][];
}): LngLat[] | null {
  const coords = geometry.coordinates;
  if (!coords || !coords.length) return null;
  if (geometry.type === 'MultiLineString') {
    const out: LngLat[] = [];
    for (const line of coords as number[][][]) {
      for (const c of line) {
        const lon = c[0]!;
        const lat = c[1]!;
        const last = out[out.length - 1];
        if (last && last.lon === lon && last.lat === lat) continue;
        out.push({ lon, lat });
      }
    }
    return out.length >= 2 ? out : null;
  }
  const line = coords as number[][];
  if (line.length < 2) return null;
  return line.map((c) => ({ lon: c[0]!, lat: c[1]! }));
}

function parseBrouterPayload(text: string): BrouterResult | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('operation killed') || trimmed.startsWith('<')) {
    return null;
  }
  let data: {
    features?: Array<{
      geometry?: { type?: string; coordinates?: number[][] | number[][][] };
      properties?: {
        'track-length'?: string | number;
        messages?: string[][];
      };
    }>;
  };
  try {
    data = JSON.parse(trimmed) as typeof data;
  } catch {
    return null;
  }
  const feature = data.features?.[0];
  if (!feature?.geometry) return null;
  const points = flattenCoords(feature.geometry);
  if (!points) return null;

  const trackM = Number(feature.properties?.['track-length']);
  let lengthKm = Number.isFinite(trackM) && trackM > 0 ? trackM / 1000 : 0;
  if (!lengthKm) {
    for (let i = 1; i < points.length; i++) lengthKm += haversineKm(points[i - 1]!, points[i]!);
  }

  const wayTags = new Set<string>();
  const messages = feature.properties?.messages ?? [];
  for (let i = 1; i < messages.length; i++) {
    for (const tag of parseWayTags(messages[i]?.[9])) wayTags.add(tag);
  }

  return { points, lengthKm, wayTags: [...wayTags] };
}

/**
 * Single BRouter request. Public server often returns 400 "watchdog" on first try
 * for long river graphs — caller should retry / split.
 */
async function brouterOnce(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;

  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${BROUTER_URL}?format=geojson&profile=river&alternativeidx=0&lonlats=` +
    encodeURIComponent(lonlats);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), brouterTimeoutMs(waypoints));
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    // 400 + watchdog body still happens with a "successful" connection.
    if (!res.ok) return parseBrouterPayload(text);
    return parseBrouterPayload(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Retry a single BRouter request (watchdog / flaky public API). */
export async function routeWithBrouter(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  const span = routeSpanKm(waypoints);
  const attempts = span > ADAPTIVE_SPLIT_KM ? 4 : 2;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(350 * i);
    const hit = await brouterOnce(waypoints);
    if (hit && hit.points.length >= 2 && hit.lengthKm > 0) return hit;
  }
  return null;
}

/**
 * For long corridors the public BRouter often kills the full request.
 * Bisect geographically and stitch — each half usually succeeds.
 */
export async function routeWithBrouterAdaptive(
  waypoints: LngLat[],
  depth = 0,
): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;

  const direct = await routeWithBrouter(waypoints);
  if (direct) return direct;

  if (waypoints.length > 2) {
    const chunked = await routeWithBrouterChunked(waypoints);
    if (chunked) return chunked;
  }

  if (waypoints.length !== 2 || depth >= MAX_SPLIT_DEPTH) return null;
  const a = waypoints[0]!;
  const b = waypoints[1]!;
  const span = haversineKm(a, b);
  if (span < ADAPTIVE_SPLIT_KM) return null;

  const mid: LngLat = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
  const left = await routeWithBrouterAdaptive([a, mid], depth + 1);
  if (!left) return null;
  const right = await routeWithBrouterAdaptive([mid, b], depth + 1);
  if (!right) return null;

  const points = left.points.concat(right.points.slice(1));
  const wayTags = [...new Set([...left.wayTags, ...right.wayTags])];
  return {
    points,
    lengthKm: left.lengthKm + right.lengthKm,
    wayTags,
  };
}

/** Stitch per-leg BRouter results when the full-chain request fails. */
export async function routeWithBrouterChunked(
  waypoints: LngLat[],
): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  if (waypoints.length === 2) return routeWithBrouter(waypoints);

  const allPoints: LngLat[] = [];
  let lengthKm = 0;
  const wayTags = new Set<string>();

  for (let i = 1; i < waypoints.length; i++) {
    const leg = await routeWithBrouterAdaptive([waypoints[i - 1]!, waypoints[i]!]);
    if (!leg || leg.points.length < 2) return null;
    if (allPoints.length === 0) allPoints.push(...leg.points);
    else allPoints.push(...leg.points.slice(1));
    lengthKm += leg.lengthKm;
    for (const t of leg.wayTags) wayTags.add(t);
  }

  return { points: allPoints, lengthKm, wayTags: [...wayTags] };
}
