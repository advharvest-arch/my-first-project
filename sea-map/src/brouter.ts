import { haversineKm, pathLengthKm, type LngLat } from './geo';

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
 * Upper Volga only (Селигер / исток). Including these on Чебоксары→Онега
 * pulls the track upstream via Селижаровка instead of Волго-Балт.
 */
const VOLGA_UPPER_VIAS: LngLat[] = [
  { lon: 33.45, lat: 56.85 }, // Селижарово
  { lon: 35.92, lat: 56.86 }, // Тверь
];

/**
 * Main-stem Volga checkpoints (Иваньково → Чебоксары), on the shipping fairway.
 * Do NOT place vias up tributaries (Ветлуга) — that creates fake Ветлуга loops.
 */
const VOLGA_STEM_VIAS: LngLat[] = [
  { lon: 37.16, lat: 56.74 }, // Дубна / Иваньково
  { lon: 38.33, lat: 57.53 }, // Углич
  { lon: 38.7, lat: 58.05 }, // Рыбинск
  { lon: 39.89, lat: 57.63 }, // Ярославль
  { lon: 40.93, lat: 57.77 }, // Кострома
  { lon: 42.13, lat: 57.44 }, // Кинешма
  { lon: 43.47, lat: 56.65 }, // Городец
  { lon: 44.0, lat: 56.33 }, // Нижний Новгород
  { lon: 45.05, lat: 56.15 }, // Волга ниже устья Ветлуги (не на Ветлуге)
];

/**
 * Волго-Балт north of Рыбинск (Шексна → … → Нева).
 */
const VOLGA_BALTIC_NORTH_VIAS: LngLat[] = [
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

/**
 * Moscow Canal fairway into the Volga cascade (Химки → Дубна).
 */
const MOSCOW_CANAL_VIAS: LngLat[] = [
  { lon: 37.455, lat: 55.91 }, // Химкинское (судовой ход)
  { lon: 37.48, lat: 56.15 }, // Икша
  { lon: 37.51, lat: 56.35 }, // Дмитров
  { lon: 37.16, lat: 56.74 }, // Дубна
];

/**
 * Full Moscow ↔ St. Petersburg inland waterway order.
 */
const VOLGA_BALTIC_VIAS: LngLat[] = [
  ...MOSCOW_CANAL_VIAS,
  { lon: 38.33, lat: 57.53 }, // Углич
  { lon: 38.5, lat: 58.05 }, // Рыбинск / Шексна
  ...VOLGA_BALTIC_NORTH_VIAS,
];

/**
 * BRouter's river graph often leaves the Moscow Canal shipping fairway and loops
 * east through Пироговское / Пестовское / Клязьминское before rejoining near Iksha.
 * Replace that spur with the main-stem canal corridor.
 */
const MOSCOW_CANAL_EAST_SPUR = {
  lonMin: 37.545,
  latMin: 55.9,
  latMax: 56.14,
};

/** Curated fairway between the spur entry and Iksha. */
const MOSCOW_CANAL_FAIRWAY: LngLat[] = [
  { lon: 37.52, lat: 55.97 },
  { lon: 37.505, lat: 56.02 },
  { lon: 37.505, lat: 56.07 },
  { lon: 37.51, lat: 56.12 },
  { lon: 37.512, lat: 56.15 },
];

function inMoscowCanalEastSpur(p: LngLat): boolean {
  return (
    p.lon >= MOSCOW_CANAL_EAST_SPUR.lonMin &&
    p.lat >= MOSCOW_CANAL_EAST_SPUR.latMin &&
    p.lat <= MOSCOW_CANAL_EAST_SPUR.latMax
  );
}

function interpolatePoints(a: LngLat, b: LngLat, n: number): LngLat[] {
  if (n <= 0) return [];
  const out: LngLat[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    out.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t });
  }
  return out;
}

/**
 * Cut Пироговское/Пестовское/Клязьминское loops off Moscow→Dubna legs.
 */
export function repairMoscowCanalEastSpur(points: LngLat[]): LngLat[] {
  if (points.length < 8) return points;

  let spurStart = -1;
  let spurEnd = -1;
  for (let i = 0; i < points.length; i++) {
    if (inMoscowCanalEastSpur(points[i]!)) {
      if (spurStart < 0) spurStart = i;
      spurEnd = i;
    } else if (spurStart >= 0 && points[i]!.lat > MOSCOW_CANAL_EAST_SPUR.latMax) {
      break;
    }
  }
  if (spurStart < 0 || spurEnd <= spurStart) return points;

  // Anchor just before the track turns east off the fairway.
  let left = Math.max(0, spurStart - 1);
  while (left > 0 && points[left]!.lon > 37.53 && points[left]!.lat < 56.05) {
    left -= 1;
  }
  // Rejoin on the canal near Iksha (west of the reservoirs).
  let right = Math.min(points.length - 1, spurEnd + 1);
  while (
    right < points.length - 1 &&
    (points[right]!.lon > 37.54 || points[right]!.lat < 56.13)
  ) {
    right += 1;
  }

  if (right <= left + 1) return points;

  const before = points.slice(0, left + 1);
  const after = points.slice(right);
  const a = before[before.length - 1]!;
  const b = after[0]!;

  const fairway = MOSCOW_CANAL_FAIRWAY.filter(
    (p) => p.lat > a.lat + 0.005 && p.lat < b.lat - 0.005,
  );
  const bridge: LngLat[] = [];
  let prev = a;
  for (const p of fairway) {
    bridge.push(...interpolatePoints(prev, p, 2), p);
    prev = p;
  }
  bridge.push(...interpolatePoints(prev, b, 2));

  return [...before, ...bridge, ...after];
}

function finalizeBrouterResult(result: BrouterResult): BrouterResult {
  const points = repairMoscowCanalEastSpur(result.points);
  if (points === result.points) return result;
  return {
    ...result,
    points,
    lengthKm: pathLengthKm(points),
  };
}

function nearMoscow(p: LngLat): boolean {
  return p.lat >= 55.4 && p.lat <= 56.35 && p.lon >= 36.9 && p.lon <= 38.1;
}

function nearSpb(p: LngLat): boolean {
  return p.lat >= 59.55 && p.lat <= 60.25 && p.lon >= 29.4 && p.lon <= 31.2;
}

/** Селигер / верхняя Волга (west of Tver). */
function nearUpperVolga(p: LngLat): boolean {
  return p.lat >= 56.55 && p.lat <= 57.7 && p.lon >= 32.4 && p.lon <= 36.2;
}

/** Онега / Ладога / Нева / Белозерский участок Волго-Балта. */
function nearNorthwestWaterway(p: LngLat): boolean {
  if (nearSpb(p)) return true;
  // Ладога
  if (p.lat >= 59.7 && p.lat <= 61.8 && p.lon >= 29.5 && p.lon <= 33.5) return true;
  // Онега
  if (p.lat >= 60.5 && p.lat <= 63.0 && p.lon >= 33.8 && p.lon <= 37.0) return true;
  // Белое / Ковжа / Вытегра
  if (p.lat >= 59.7 && p.lat <= 61.2 && p.lon >= 35.5 && p.lon <= 38.2) return true;
  // Шексна / Череповец
  if (p.lat >= 58.9 && p.lat <= 60.3 && p.lon >= 37.4 && p.lon <= 38.7) return true;
  return false;
}

/** Волга below Dubna / mid cascade (Рыбинск→Чебоксары and related). */
function nearVolgaCascade(p: LngLat): boolean {
  return p.lat >= 55.3 && p.lat <= 59.2 && p.lon >= 37.0 && p.lon <= 49.5;
}

function isMoscowSpbCorridor(a: LngLat, b: LngLat): boolean {
  return (nearMoscow(a) && nearSpb(b)) || (nearMoscow(b) && nearSpb(a));
}

/**
 * One end on NW waterway (Онега/Ладога/СПб…), the other on Volga cascade / Moscow.
 * Must NOT use Селижарово — go Рыбинск → Шексна → … instead.
 */
function isVolgaBalticLongCorridor(a: LngLat, b: LngLat): boolean {
  if (isMoscowSpbCorridor(a, b)) return true;
  const nwA = nearNorthwestWaterway(a);
  const nwB = nearNorthwestWaterway(b);
  if (nwA === nwB) return false;
  const other = nwA ? b : a;
  return nearVolgaCascade(other) || nearMoscow(other) || nearUpperVolga(other);
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

/** Онега basin (not Ладога / СПб). */
function nearOnega(p: LngLat): boolean {
  return p.lat >= 60.5 && p.lat <= 63.0 && p.lon >= 33.8 && p.lon <= 37.0;
}

function nearLadoga(p: LngLat): boolean {
  return p.lat >= 59.7 && p.lat <= 61.8 && p.lon >= 29.5 && p.lon <= 33.5;
}

/**
 * Ordered Volga→Baltic chain between A and B (or reverse).
 * From the Volga/Moscow end: cascade toward Рыбинск, then Шексна→…→Neva.
 * Never prepend Дубна/Селижарово when the start is already east on the cascade.
 */
function volgaBalticCorridorVias(a: LngLat, b: LngLat): LngLat[] {
  const nwIsB = nearNorthwestWaterway(b);
  const from = nwIsB ? a : b;
  const to = nwIsB ? b : a;

  const towardRybinsk: LngLat[] = [];

  if (nearMoscow(from)) {
    towardRybinsk.push(...MOSCOW_CANAL_VIAS);
    towardRybinsk.push(
      { lon: 38.33, lat: 57.53 }, // Углич
      { lon: 38.7, lat: 58.05 }, // Рыбинск
    );
  } else if (nearUpperVolga(from)) {
    towardRybinsk.push(...VOLGA_UPPER_VIAS);
    towardRybinsk.push(
      { lon: 37.16, lat: 56.74 }, // Дубна
      { lon: 38.33, lat: 57.53 }, // Углич
      { lon: 38.7, lat: 58.05 }, // Рыбинск
    );
  } else {
    // Mid/lower cascade (e.g. Чебоксары): only stem points between `from` and Рыбинск.
    const east = Math.max(from.lon, 38.7);
    const west = Math.min(from.lon, 38.7);
    const stem = VOLGA_STEM_VIAS.filter((v) => v.lon >= west - 0.3 && v.lon <= east + 0.3);
    // Walk toward Рыбинск (decreasing lon if starting east).
    stem.sort((p, q) => (from.lon >= 38.7 ? q.lon - p.lon : p.lon - q.lon));
    towardRybinsk.push(...stem);
  }

  // Trim the northern branch to the destination — don't continue past Онега to Ладога.
  let north = [...VOLGA_BALTIC_NORTH_VIAS];
  if (nearOnega(to) && !nearLadoga(to) && !nearSpb(to)) {
    north = north.filter((v) => v.lon >= 35.8); // stop at Ковжа / вход в Онегу
  } else if (nearLadoga(to) && !nearSpb(to)) {
    north = north.filter((v) => v.lat >= 59.0); // keep through Ладога, drop Нева if far
  }

  const pool = [...towardRybinsk, ...north];

  const seen = new Set<string>();
  const ordered: LngLat[] = [];
  for (const v of pool) {
    const key = `${v.lon.toFixed(2)},${v.lat.toFixed(2)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ordered.push(v);
  }

  const vias = pickViasAlong(from, to, ordered, { preserveOrder: true });
  return nwIsB ? vias : vias.slice().reverse();
}

function corridorViasBetween(a: LngLat, b: LngLat): LngLat[] {
  const span = haversineKm(a, b);
  if (span < 250) return [];

  if (isMoscowSpbCorridor(a, b)) {
    const forward = nearMoscow(a) && nearSpb(b);
    const vias = pickViasAlong(a, b, VOLGA_BALTIC_VIAS, { preserveOrder: true });
    return forward ? vias : vias.slice().reverse();
  }

  if (isVolgaBalticLongCorridor(a, b)) {
    return volgaBalticCorridorVias(a, b);
  }

  const minLon = Math.min(a.lon, b.lon);
  const maxLon = Math.max(a.lon, b.lon);
  if (maxLon - minLon < 4) return [];
  // Volga stem only for Caspian-direction / mid-Volga corridors.
  if (maxLon < 39 || minLon > 50) return [];
  if (maxLon < 32 || Math.max(a.lat, b.lat) < 54 || Math.min(a.lat, b.lat) > 61) return [];

  const needUpper = nearUpperVolga(a) || nearUpperVolga(b);
  const pool = needUpper ? [...VOLGA_UPPER_VIAS, ...VOLGA_STEM_VIAS] : VOLGA_STEM_VIAS;
  return pickViasAlong(a, b, pool);
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

  return finalizeBrouterResult({ points, lengthKm, wayTags: [...wayTags] });
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
  return finalizeBrouterResult({ points, lengthKm, wayTags: [...wayTags] });
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

/** Paths that climbed to Селижаровка / upper Volga when the corridor is Волго-Балт. */
function looksLikeUpperVolgaTrap(points: LngLat[], a: LngLat, b: LngLat): boolean {
  // Legitimate when an endpoint is actually on the upper Volga / Селигер.
  if (nearUpperVolga(a) || nearUpperVolga(b)) return false;
  for (const p of points) {
    if (p.lon <= 35.5 && p.lat >= 56.6 && p.lat <= 57.3) return true;
  }
  return false;
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
  const balticCorridor = isVolgaBalticLongCorridor(a, b);

  // Pin long inland legs to a known navigable corridor.
  if (depth === 0) {
    const vias = corridorViasBetween(a, b);
    if (vias.length) {
      const viaRoute = await routeAlongVias(a, b, vias, depth);
      if (viaRoute) {
        if (
          balticCorridor &&
          (looksLikeUpperVolgaTrap(viaRoute.points, a, b) ||
            (isMoscowSpbCorridor(a, b) && !looksLikeVolgaBaltic(viaRoute.points)))
        ) {
          // Fall through to bisect / reject — bad corridor snap.
        } else {
          return viaRoute;
        }
      }
    }
  }

  const hit = await routeWithBrouter([a, b]);
  if (hit) {
    if (depth === 0 && balticCorridor) {
      if (looksLikeUpperVolgaTrap(hit.points, a, b)) {
        // Reject Селижаровка / upper-Volga traps on NW corridors.
      } else if (isMoscowSpbCorridor(a, b) && !looksLikeVolgaBaltic(hit.points)) {
        // Reject cross-country / Tikhvin-style cuts that skip Шексна/Онега.
      } else {
        return hit;
      }
    } else {
      return hit;
    }
  }

  if (depth >= MAX_SPLIT_DEPTH || span < 50) return null;

  // For Volga–Baltic corridors bisect on a corridor via, not a dry geodesic midpoint.
  if (balticCorridor) {
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
