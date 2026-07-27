import { haversineKm, type LngLat } from './geo';

export type BrouterResult = {
  points: LngLat[];
  lengthKm: number;
  wayTags: string[];
};

const BROUTER_URL = 'https://brouter.de/brouter';

function parseWayTags(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Rough route length for timeout / strategy decisions. */
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
  // Short legs stay snappy; long Volga-scale routes need up to ~90s on a slow link.
  return Math.min(90_000, Math.max(15_000, 12_000 + span * 30));
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

/**
 * Fast river routing via BRouter public API (same approach as wetmeter.online).
 * Timeout scales with route length so long inland trips are not aborted early.
 */
export async function routeWithBrouter(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;

  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${BROUTER_URL}?format=geojson&profile=river&alternativeidx=0&lonlats=` +
    encodeURIComponent(lonlats);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), brouterTimeoutMs(waypoints));
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/geo+json, application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: Array<{
        geometry?: { type?: string; coordinates?: number[][] | number[][][] };
        properties?: {
          'track-length'?: string | number;
          messages?: string[][];
        };
      }>;
    };
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
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fallback for long / multi-stop routes: route each leg separately and stitch.
 * More reliable than one giant request when the public API times out.
 */
export async function routeWithBrouterChunked(
  waypoints: LngLat[],
): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;
  if (waypoints.length === 2) return routeWithBrouter(waypoints);

  const allPoints: LngLat[] = [];
  let lengthKm = 0;
  const wayTags = new Set<string>();

  for (let i = 1; i < waypoints.length; i++) {
    const leg = await routeWithBrouter([waypoints[i - 1]!, waypoints[i]!]);
    if (!leg || leg.points.length < 2) return null;
    if (allPoints.length === 0) allPoints.push(...leg.points);
    else allPoints.push(...leg.points.slice(1));
    lengthKm += leg.lengthKm;
    for (const t of leg.wayTags) wayTags.add(t);
  }

  return { points: allPoints, lengthKm, wayTags: [...wayTags] };
}
