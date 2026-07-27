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

/**
 * Fast river routing via BRouter public API (same approach as wetmeter.online).
 * Prefers the `river` profile — prebuilt waterway graph, typically &lt;1s.
 */
export async function routeWithBrouter(waypoints: LngLat[]): Promise<BrouterResult | null> {
  if (waypoints.length < 2) return null;

  const lonlats = waypoints.map((p) => `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`).join('|');
  const url =
    `${BROUTER_URL}?format=geojson&profile=river&alternativeidx=0&lonlats=` +
    encodeURIComponent(lonlats);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/geo+json, application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      features?: Array<{
        geometry?: { type?: string; coordinates?: number[][] };
        properties?: {
          'track-length'?: string | number;
          messages?: string[][];
        };
      }>;
    };
    const feature = data.features?.[0];
    const coords = feature?.geometry?.coordinates;
    if (!coords || coords.length < 2) return null;

    const points: LngLat[] = coords.map((c) => ({ lon: c[0]!, lat: c[1]! }));
    const trackM = Number(feature?.properties?.['track-length']);
    let lengthKm = Number.isFinite(trackM) && trackM > 0 ? trackM / 1000 : 0;
    if (!lengthKm) {
      for (let i = 1; i < points.length; i++) lengthKm += haversineKm(points[i - 1]!, points[i]!);
    }

    const wayTags = new Set<string>();
    const messages = feature?.properties?.messages ?? [];
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
