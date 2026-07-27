import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { measureWaterChain, type WaterPath } from './waterways';

/** How to pick between inland and maritime networks. */
export type RoutePrefer = 'river' | 'shortest' | 'sea';

export type HybridOptions = {
  restrictions?: Passage[];
  allowArctic?: boolean;
  speedKnots?: number;
  /** Default `river`: full inland chain; sea only for failed coastal legs. */
  prefer?: RoutePrefer;
};

export type HybridPath = WaterPath & {
  networks: Array<'river' | 'sea' | 'direct'>;
  passages: Passage[];
};

type SeaLeg = { points: LngLat[]; lengthKm: number; passages: Passage[]; maxSnapKm: number };

function featureToPoints(feature: SeaRouteFeature | SeaRouteMultiFeature): LngLat[] {
  const geom = feature.geometry;
  if (geom.type === 'LineString') {
    return geom.coordinates.map(([lon, lat]) => ({ lon, lat }));
  }
  const out: LngLat[] = [];
  for (const line of geom.coordinates) {
    for (const [lon, lat] of line) {
      const last = out[out.length - 1];
      if (last && last.lon === lon && last.lat === lat) continue;
      out.push({ lon, lat });
    }
  }
  return out;
}

async function seaLeg(
  a: LngLat,
  b: LngLat,
  opts: HybridOptions,
  maxSnapDistanceKm: number,
): Promise<SeaLeg | null> {
  try {
    const { seaRoute } = await import('searoute-ts');
    const feature = seaRoute([a.lon, a.lat], [b.lon, b.lat], {
      units: 'kilometers',
      speedKnots: opts.speedKnots ?? 12,
      restrictions: opts.restrictions ?? [],
      allowArctic: opts.allowArctic ?? false,
      returnPassages: true,
      appendOriginDestination: true,
      antimeridian: 'split',
      maxSnapDistanceKm,
    });
    const points = featureToPoints(feature);
    if (points.length < 2) return null;
    const oSnap = feature.properties.originSnapKm ?? 0;
    const dSnap = feature.properties.destinationSnapKm ?? 0;
    if (oSnap > maxSnapDistanceKm || dSnap > maxSnapDistanceKm) return null;
    return {
      points,
      lengthKm: feature.properties.length,
      passages: (feature.properties.passages ?? []) as Passage[],
      maxSnapKm: Math.max(oSnap, dSnap),
    };
  } catch {
    return null;
  }
}

function inlandOk(inland: WaterPath): boolean {
  return inland.method !== 'direct' && inland.points.length >= 2 && inland.lengthKm > 0;
}

function wrapInland(inland: WaterPath, nLegs: number): HybridPath {
  const networks = Array.from({ length: Math.max(0, nLegs) }, () =>
    inland.method === 'direct' ? ('direct' as const) : ('river' as const),
  );
  return {
    ...inland,
    networks,
    passages: [],
  };
}

/**
 * River-first: one BRouter/OSM call for the whole chain (as before unification).
 * Sea is never used here — keeps inland routes stable.
 */
async function routeRiverOnly(waypoints: LngLat[]): Promise<HybridPath> {
  const inland = await measureWaterChain(waypoints);
  return wrapInland(inland, waypoints.length - 1);
}

/**
 * Sea-first via consecutive maritime legs; fall back to full inland if sea fails.
 */
async function routeSeaPreferred(
  waypoints: LngLat[],
  opts: HybridOptions,
): Promise<HybridPath> {
  const allPoints: LngLat[] = [];
  const waypointCumKm = [0];
  const networks: HybridPath['networks'] = [];
  const passageSet = new Set<Passage>();
  let lengthKm = 0;
  let allSea = true;

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const sea = await seaLeg(a, b, opts, 280);
    if (!sea) {
      allSea = false;
      break;
    }
    networks.push('sea');
    if (allPoints.length === 0) allPoints.push(...sea.points);
    else allPoints.push(...sea.points.slice(1));
    lengthKm += sea.lengthKm;
    waypointCumKm.push(lengthKm);
    for (const p of sea.passages) passageSet.add(p);
  }

  if (allSea && allPoints.length >= 2) {
    return {
      points: allPoints,
      lengthKm,
      waterName: 'море',
      method: 'waterway',
      waypointCumKm,
      networks,
      passages: [...passageSet],
    };
  }

  return routeRiverOnly(waypoints);
}

/**
 * Per-leg shortest: inland full chain split by waypoint cum-km vs sea per leg.
 * Uses one inland request for quality, then replaces individual legs with sea
 * only when sea is clearly shorter and snaps are tight enough.
 */
async function routeShortest(waypoints: LngLat[], opts: HybridOptions): Promise<HybridPath> {
  const inland = await measureWaterChain(waypoints);

  // If inland failed entirely, try sea legs (ports / open water).
  if (!inlandOk(inland)) {
    return routeSeaPreferred(waypoints, opts);
  }

  const cum = inland.waypointCumKm;
  const n = waypoints.length;
  // Need cum distances to slice the inland geometry into legs.
  if (!cum || cum.length !== n) {
    return wrapInland(inland, n - 1);
  }

  const allPoints: LngLat[] = [];
  const waypointCumKm = [0];
  const networks: HybridPath['networks'] = [];
  const passageSet = new Set<Passage>();
  const nameBits: string[] = [];
  let lengthKm = 0;
  let anyLake = inland.method === 'lake';

  for (let i = 1; i < n; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const inlandLegKm = Math.max(0, (cum[i] ?? 0) - (cum[i - 1] ?? 0));
    const sea = await seaLeg(a, b, opts, 80);

    const useSea =
      sea != null &&
      sea.lengthKm > 0 &&
      sea.lengthKm < inlandLegKm * 0.92 &&
      sea.maxSnapKm <= 80;

    networks.push(useSea ? 'sea' : 'river');

    let chunk: LngLat[];
    let legKm: number;
    if (useSea && sea) {
      chunk = sea.points;
      legKm = sea.lengthKm;
      for (const p of sea.passages) passageSet.add(p);
      nameBits.push('море');
    } else {
      // Extract inland subpath between waypoint cum distances.
      chunk = slicePathByCumKm(inland.points, cum[i - 1]!, cum[i]!);
      if (chunk.length < 2) chunk = [a, b];
      legKm = inlandLegKm || pathLengthKm(chunk);
      if (inland.waterName) nameBits.push(inland.waterName);
    }

    if (allPoints.length === 0) allPoints.push(...chunk);
    else allPoints.push(...chunk.slice(1));
    lengthKm += legKm;
    waypointCumKm.push(lengthKm);
  }

  const usedSea = networks.includes('sea');
  const uniqueNames = [...new Set(nameBits.filter(Boolean))];

  return {
    points: allPoints.length >= 2 ? allPoints : inland.points,
    lengthKm,
    waterName: uniqueNames.length ? uniqueNames.join(' · ') : inland.waterName,
    method: anyLake && !usedSea ? 'lake' : 'waterway',
    waypointCumKm,
    networks,
    passages: [...passageSet],
  };
}

/** Walk path geometry and keep the portion between cumStart and cumEnd (km). */
function slicePathByCumKm(path: LngLat[], cumStart: number, cumEnd: number): LngLat[] {
  if (path.length < 2 || cumEnd <= cumStart) return path.slice();

  const out: LngLat[] = [];
  let acc = 0;
  let started = false;

  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const seg = haversineKm(a, b);
    const segStart = acc;
    const segEnd = acc + seg;
    acc = segEnd;

    if (segEnd < cumStart - 1e-6) continue;
    if (segStart > cumEnd + 1e-6) break;

    const t0 = seg < 1e-9 ? 0 : (Math.max(cumStart, segStart) - segStart) / seg;
    const t1 = seg < 1e-9 ? 1 : (Math.min(cumEnd, segEnd) - segStart) / seg;
    const p0 = {
      lon: a.lon + (b.lon - a.lon) * Math.min(1, Math.max(0, t0)),
      lat: a.lat + (b.lat - a.lat) * Math.min(1, Math.max(0, t0)),
    };
    const p1 = {
      lon: a.lon + (b.lon - a.lon) * Math.min(1, Math.max(0, t1)),
      lat: a.lat + (b.lat - a.lat) * Math.min(1, Math.max(0, t1)),
    };

    if (!started) {
      out.push(p0);
      started = true;
    }
    const last = out[out.length - 1]!;
    if (last.lon !== p1.lon || last.lat !== p1.lat) out.push(p1);
  }

  return out.length >= 2 ? out : path.slice();
}

/**
 * Continuous itinerary: river routes use a single inland chain (BRouter);
 * sea is only mixed in when explicitly requested (shortest / sea).
 */
export async function measureHybridChain(
  waypoints: LngLat[],
  opts: HybridOptions = {},
): Promise<HybridPath> {
  const prefer: RoutePrefer = opts.prefer ?? 'river';

  if (waypoints.length < 2) {
    return {
      points: waypoints.slice(),
      lengthKm: 0,
      waterName: null,
      method: 'direct',
      waypointCumKm: waypoints.map(() => 0),
      networks: [],
      passages: [],
    };
  }

  if (prefer === 'river') return routeRiverOnly(waypoints);
  if (prefer === 'sea') return routeSeaPreferred(waypoints, opts);
  return routeShortest(waypoints, opts);
}
