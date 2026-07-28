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

/**
 * Main-stem Volga checkpoints (Caspian direction).
 * Long A→B searches without these can snap onto tributaries (e.g. Соть).
 */
const VOLGA_STEM_VIAS: LngLat[] = [
  { lon: 33.45, lat: 56.85 }, // Селижарово
  { lon: 35.92, lat: 56.86 }, // Тверь
  { lon: 37.16, lat: 56.74 }, // Дубна / Иваньково
  { lon: 38.33, lat: 57.53 }, // Углич
  { lon: 38.84, lat: 58.05 }, // Рыбинск
  { lon: 39.89, lat: 57.63 }, // Ярославль
  { lon: 40.93, lat: 57.77 }, // Кострома
  { lon: 42.13, lat: 57.44 }, // Кинешма
  { lon: 43.47, lat: 56.65 }, // Городец
  { lon: 44.0, lat: 56.33 }, // Нижний Новгород
  { lon: 46.22, lat: 56.42 }, // устье Ветлуги
];

/**
 * Moscow ↔ St. Petersburg inland waterway (канал им. Москвы → Волга → Волго-Балт → Нева).
 * Must NOT reuse VOLGA_STEM_VIAS: those include Селижарово and pull the track upstream west.
 */
const VOLGA_BALTIC_VIAS: LngLat[] = [
  { lon: 37.16, lat: 56.74 }, // Дубна
  { lon: 38.33, lat: 57.53 }, // Углич
  { lon: 38.5, lat: 58.05 }, // Рыбинск / Шексна
  { lon: 37.95, lat: 59.1 }, // Череповец
  { lon: 37.78, lat: 60.03 }, // Белозерск
  { lon: 36.55, lat: 60.85 }, // Ковжа
  { lon: 36.35, lat: 60.98 }, // устье Вытегры → Онега
  { lon: 34.5, lat: 61.0 }, // к истоку Свири
  { lon: 33.5, lat: 60.75 }, // верхняя Свирь
  { lon: 32.7, lat: 60.5 }, // средняя Свирь
  { lon: 32.2, lat: 60.35 }, // нижняя Свирь
  { lon: 31.5, lat: 60.1 }, // Ладога
  { lon: 31.03, lat: 59.95 }, // Шлиссельбург / Нева
];

function nearMoscow(p: LngLat): boolean {
  return p.lat >= 55.4 && p.lat <= 56.35 && p.lon >= 36.9 && p.lon <= 38.1;
}

function nearSpb(p: LngLat): boolean {
  return p.lat >= 59.55 && p.lat <= 60.25 && p.lon >= 29.4 && p.lon <= 31.2;
}

function isMoscowSpbCorridor(a: LngLat, b: LngLat): boolean {
  return (nearMoscow(a) && nearSpb(b)) || (nearMoscow(b) && nearSpb(a));
}

function pickViasAlong(
  a: LngLat,
  b: LngLat,
  pool: LngLat[],
  opts: { preserveOrder?: boolean } = {},
): LngLat[] {
  const minLon = Math.min(a.lon, b.lon);
  const maxLon = Math.max(a.lon, b.lon);
  const minLat = Math.min(a.lat, b.lat);
  const maxLat = Math.max(a.lat, b.lat);

  const vias = pool.filter((v) => {
    if (haversineKm(a, v) < 30 || haversineKm(b, v) < 30) return false;
    return (
      v.lon >= minLon - 2.2 &&
      v.lon <= maxLon + 2.2 &&
      v.lat >= minLat - 1.0 &&
      v.lat <= maxLat + 2.5
    );
  });

  if (opts.preserveOrder) return vias;

  const eastbound = b.lon >= a.lon;
  vias.sort((p, q) => (eastbound ? p.lon - q.lon : q.lon - p.lon));
  return vias;
}

function corridorViasBetween(a: LngLat, b: LngLat): LngLat[] {
  const span = haversineKm(a, b);
  if (span < 250) return [];

  if (isMoscowSpbCorridor(a, b)) {
    // Keep the curated Moscow→SPb order (Белое → Онега → Свирь → Ладога → Нева).
    const forward = nearMoscow(a) && nearSpb(b);
    const vias = pickViasAlong(a, b, VOLGA_BALTIC_VIAS, { preserveOrder: true });
    return forward ? vias : vias.slice().reverse();
  }

  const minLon = Math.min(a.lon, b.lon);
  const maxLon = Math.max(a.lon, b.lon);
  if (maxLon - minLon < 4) return [];
  // Volga stem only for Caspian-direction corridors (need eastern extent past Rybinsk).
  if (maxLon < 39 || minLon > 50) return [];
  if (maxLon < 32 || Math.max(a.lat, b.lat) < 54 || Math.min(a.lat, b.lat) > 61) return [];

  return pickViasAlong(a, b, VOLGA_STEM_VIAS);
}

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

function looksLikeVolgaBaltic(points: LngLat[]): boolean {
  let hasOnegaBand = false;
  let hasSheksnaBand = false;
  for (const p of points) {
    if (p.lat >= 60.6 && p.lon >= 34.0 && p.lon <= 37.5) hasOnegaBand = true;
    if (p.lat >= 58.9 && p.lat <= 60.2 && p.lon >= 37.5 && p.lon <= 38.8) hasSheksnaBand = true;
  }
  return hasOnegaBand && hasSheksnaBand;
}

/**
 * Route A→…vias…→B. If one via is not on the river graph, skip it and
 * continue — never abandon the whole corridor (direct A→B often takes a
 * wrong shortcut, e.g. Moscow→SPb cutting across to Ladoga).
 */
async function routeAlongVias(
  a: LngLat,
  b: LngLat,
  vias: LngLat[],
  depth: number,
): Promise<BrouterResult | null> {
  const targets = [...vias, b];
  const parts: BrouterResult[] = [];
  let from = a;
  for (let i = 0; i < targets.length; i++) {
    const to = targets[i]!;
    const isLast = i === targets.length - 1;
    const leg = await routePairAdaptive(from, to, depth + 1);
    if (leg) {
      parts.push(leg);
      from = to;
      continue;
    }
    if (isLast) return null;
    // Skip unreachable intermediate via.
  }
  if (from.lon !== b.lon || from.lat !== b.lat) {
    const tail = await routePairAdaptive(from, b, depth + 1);
    if (!tail) return null;
    parts.push(tail);
  }
  return parts.length ? stitchResults(parts) : null;
}

/**
 * Try A→B; on failure bisect geographically and stitch.
 * Prefer few large halves (better path) over many geodesic vias (huge detours).
 */
async function routePairAdaptive(a: LngLat, b: LngLat, depth: number): Promise<BrouterResult | null> {
  const span = haversineKm(a, b);
  const moscowSpb = isMoscowSpbCorridor(a, b);

  // Pin long inland legs to a known navigable corridor.
  if (depth === 0) {
    const vias = corridorViasBetween(a, b);
    if (vias.length) {
      const viaRoute = await routeAlongVias(a, b, vias, depth);
      if (viaRoute) return viaRoute;
    }
  }

  const hit = await routeWithBrouter([a, b]);
  if (hit) {
    if (depth === 0 && moscowSpb && !looksLikeVolgaBaltic(hit.points)) {
      // Reject cross-country / Tikhvin-style cuts that skip Шексна/Онега.
    } else {
      return hit;
    }
  }

  if (depth >= MAX_SPLIT_DEPTH || span < 50) return null;

  // For Moscow↔SPb bisect on a corridor via, not a dry geodesic midpoint.
  if (moscowSpb) {
    const vias = corridorViasBetween(a, b);
    if (vias.length >= 2) {
      const mid = vias[Math.floor(vias.length / 2)]!;
      const left = await routePairAdaptive(a, mid, depth + 1);
      if (left) {
        const right = await routePairAdaptive(mid, b, depth + 1);
        if (right) return stitchResults([left, right]);
      }
    }
    if (depth >= 2) return null;
  }

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
