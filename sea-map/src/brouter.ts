import { haversineKm, type LngLat } from './geo';

export type BrouterResult = {
  points: LngLat[];
  lengthKm: number;
  wayTags: string[];
};

const BROUTER_URL = 'https://brouter.de/brouter';

/**
 * Public brouter.de often kills long one-shot river searches (watchdog).
 * We try once, then bisect — halves usually succeed with a near-optimal path.
 */
const LONG_SPAN_KM = 200;
const MAX_SPLIT_DEPTH = 6;

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

function brouterTimeoutMs(spanKm: number): number {
  return Math.min(90_000, Math.max(12_000, 10_000 + spanKm * 35));
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
  if (!points || points.length < 2) return null;

  const trackM = Number(feature.properties?.['track-length']);
  let lengthKm = Number.isFinite(trackM) && trackM > 0 ? trackM / 1000 : 0;
  if (!lengthKm) {
    for (let i = 1; i < points.length; i++) lengthKm += haversineKm(points[i - 1]!, points[i]!);
  }

  const wayTags = new Set<string>();
  const messages = feature.properties?.messages ?? [];
  const tagLimit = Math.min(messages.length, 120);
  for (let i = 1; i < tagLimit; i++) {
    for (const tag of parseWayTags(messages[i]?.[9])) wayTags.add(tag);
  }

  return { points, lengthKm, wayTags: [...wayTags] };
}

async function brouterOnce(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  const span = routeSpanKm(waypoints);
  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${BROUTER_URL}?format=geojson&profile=river&alternativeidx=0&lonlats=` +
    encodeURIComponent(lonlats);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), brouterTimeoutMs(span));
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    return parseBrouterPayload(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Short/medium request with retries. Long spans: only 1 attempt — fail fast, then bisect.
 */
export async function routeWithBrouter(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  const span = routeSpanKm(waypoints);
  // Long one-shots are often killed in ~1–2s; don't burn 10s+ on retries.
  const attempts = span >= LONG_SPAN_KM ? 1 : 3;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(400 * i);
    const hit = await brouterOnce(waypoints);
    if (hit && hit.points.length >= 2 && hit.lengthKm > 0) return hit;
  }
  return null;
}

function interpolate(a: LngLat, b: LngLat, t: number): LngLat {
  return { lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t };
}

function stitchResults(parts: BrouterResult[]): BrouterResult {
  const points: LngLat[] = [];
  let lengthKm = 0;
  const wayTags = new Set<string>();
  for (const part of parts) {
    if (points.length === 0) points.push(...part.points);
    else points.push(...part.points.slice(1));
    lengthKm += part.lengthKm;
    for (const t of part.wayTags) wayTags.add(t);
  }
  return { points, lengthKm, wayTags: [...wayTags] };
}

/**
 * Try A→B; on failure bisect geographically and stitch.
 * Prefer few large halves (better path) over many geodesic vias (huge detours).
 */
async function routePairAdaptive(a: LngLat, b: LngLat, depth: number): Promise<BrouterResult | null> {
  const span = haversineKm(a, b);
  const hit = await routeWithBrouter([a, b]);
  if (hit) return hit;

  if (depth >= MAX_SPLIT_DEPTH || span < 50) return null;

  const mid = interpolate(a, b, 0.5);
  const left = await routePairAdaptive(a, mid, depth + 1);
  if (!left) return null;
  const right = await routePairAdaptive(mid, b, depth + 1);
  if (!right) return null;
  return stitchResults([left, right]);
}

/** Reliable river routing for lakes and long inland corridors (Seliger→Vokhma). */
export async function routeWithBrouterAdaptive(
  waypoints: LngLat[],
): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;

  if (waypoints.length === 2) {
    return routePairAdaptive(waypoints[0]!, waypoints[1]!, 0);
  }

  const parts: BrouterResult[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    const leg = await routePairAdaptive(waypoints[i - 1]!, waypoints[i]!, 0);
    if (!leg) return null;
    parts.push(leg);
  }
  return stitchResults(parts);
}

export async function routeWithBrouterChunked(
  waypoints: LngLat[],
): Promise<BrouterResult | null> {
  return routeWithBrouterAdaptive(waypoints);
}
