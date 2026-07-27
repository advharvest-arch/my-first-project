import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { measureWaterChain, type WaterPath } from './waterways';

/** How to pick between inland and maritime networks. */
export type RoutePrefer = 'river' | 'shortest' | 'sea';

export type HybridOptions = {
  restrictions?: Passage[];
  allowArctic?: boolean;
  speedKnots?: number;
  /** Default `river`: full inland chain; sea only where inland cannot connect. */
  prefer?: RoutePrefer;
};

export type HybridPath = WaterPath & {
  networks: Array<'river' | 'sea' | 'direct'>;
  passages: Passage[];
  /** True when sea was requested but inland was kept (points not near the sea). */
  seaUnavailable?: boolean;
};

type SeaLeg = { points: LngLat[]; lengthKm: number; passages: Passage[]; maxSnapKm: number };

/** Snap farther than this → treat as "not at sea" (don't yank inland points to the coast). */
const SEA_SNAP_OK_KM = 55;

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

function wrapInland(
  inland: WaterPath,
  nLegs: number,
  extra?: Partial<HybridPath>,
): HybridPath {
  const networks = Array.from({ length: Math.max(0, nLegs) }, () =>
    inland.method === 'direct' ? ('direct' as const) : ('river' as const),
  );
  return {
    ...inland,
    networks,
    passages: [],
    ...extra,
  };
}

type LegResult = {
  network: 'river' | 'sea' | 'direct';
  points: LngLat[];
  lengthKm: number;
  passages: Passage[];
  waterName: string | null;
  method: WaterPath['method'];
};

async function resolveLeg(
  a: LngLat,
  b: LngLat,
  opts: HybridOptions,
  prefer: RoutePrefer,
): Promise<LegResult> {
  const directKm = haversineKm(a, b);

  if (prefer === 'sea') {
    const sea = await seaLeg(a, b, opts, SEA_SNAP_OK_KM);
    if (sea) {
      return {
        network: 'sea',
        points: sea.points,
        lengthKm: sea.lengthKm,
        passages: sea.passages,
        waterName: 'море',
        method: 'waterway',
      };
    }
    const inland = await measureWaterChain([a, b]);
    if (inlandOk(inland)) {
      return {
        network: 'river',
        points: inland.points,
        lengthKm: inland.lengthKm,
        passages: [],
        waterName: inland.waterName,
        method: inland.method,
      };
    }
    return {
      network: 'direct',
      points: [a, b],
      lengthKm: directKm,
      passages: [],
      waterName: null,
      method: 'direct',
    };
  }

  // river or shortest: try inland first
  const inland = await measureWaterChain([a, b]);
  const sea =
    prefer === 'shortest' || !inlandOk(inland)
      ? await seaLeg(a, b, opts, SEA_SNAP_OK_KM)
      : null;

  if (prefer === 'shortest' && inlandOk(inland) && sea) {
    const useSea = sea.lengthKm < inland.lengthKm * 0.92;
    if (useSea) {
      return {
        network: 'sea',
        points: sea.points,
        lengthKm: sea.lengthKm,
        passages: sea.passages,
        waterName: 'море',
        method: 'waterway',
      };
    }
  }

  if (inlandOk(inland)) {
    return {
      network: 'river',
      points: inland.points,
      lengthKm: inland.lengthKm,
      passages: [],
      waterName: inland.waterName,
      method: inland.method,
    };
  }

  if (sea) {
    return {
      network: 'sea',
      points: sea.points,
      lengthKm: sea.lengthKm,
      passages: sea.passages,
      waterName: 'море',
      method: 'waterway',
    };
  }

  return {
    network: 'direct',
    points: [a, b],
    lengthKm: directKm,
    passages: [],
    waterName: null,
    method: 'direct',
  };
}

function stitchLegs(legs: LegResult[]): HybridPath {
  const allPoints: LngLat[] = [];
  const waypointCumKm = [0];
  const networks: HybridPath['networks'] = [];
  const passageSet = new Set<Passage>();
  const nameBits: string[] = [];
  let lengthKm = 0;
  let anyWater = false;
  let anyLake = false;
  let anySea = false;

  for (const leg of legs) {
    networks.push(leg.network);
    if (leg.network === 'sea') anySea = true;
    if (leg.method !== 'direct') anyWater = true;
    if (leg.method === 'lake') anyLake = true;
    for (const p of leg.passages) passageSet.add(p);
    if (leg.waterName) nameBits.push(leg.waterName);

    if (allPoints.length === 0) allPoints.push(...leg.points);
    else allPoints.push(...leg.points.slice(1));
    lengthKm += leg.lengthKm;
    waypointCumKm.push(lengthKm);
  }

  return {
    points: allPoints.length >= 2 ? allPoints : legs.flatMap((l) => l.points),
    lengthKm,
    waterName: [...new Set(nameBits.filter(Boolean))].join(' · ') || null,
    method: !anyWater ? 'direct' : anyLake && !anySea ? 'lake' : 'waterway',
    waypointCumKm,
    networks,
    passages: [...passageSet],
  };
}

/**
 * Prefer one BRouter call for pure inland chains (fast + stable).
 * If that fails (e.g. a sea waypoint was added), fall back to per-leg stitching.
 */
async function routeRiverPreferred(
  waypoints: LngLat[],
  opts: HybridOptions,
): Promise<HybridPath> {
  const inland = await measureWaterChain(waypoints);
  if (inlandOk(inland)) return wrapInland(inland, waypoints.length - 1);

  const legs: LegResult[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    legs.push(await resolveLeg(waypoints[i - 1]!, waypoints[i]!, opts, 'river'));
  }
  return stitchLegs(legs);
}

async function routeSeaPreferred(
  waypoints: LngLat[],
  opts: HybridOptions,
): Promise<HybridPath> {
  // Keep a good inland result ready — switching to «Море» must not destroy a river route
  // when points are far from the maritime network.
  const inlandPromise = measureWaterChain(waypoints);

  const legs: LegResult[] = [];
  let seaLegs = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const leg = await resolveLeg(waypoints[i - 1]!, waypoints[i]!, opts, 'sea');
    legs.push(leg);
    if (leg.network === 'sea') seaLegs += 1;
  }

  const inland = await inlandPromise;

  // No leg could use the sea → keep full inland chain if it works.
  if (seaLegs === 0 && inlandOk(inland)) {
    return wrapInland(inland, waypoints.length - 1, { seaUnavailable: true });
  }

  // Partial sea: if inland full chain is much better overall, keep it and warn.
  if (inlandOk(inland)) {
    const stitchedKm = legs.reduce((s, l) => s + l.lengthKm, 0);
    if (seaLegs < legs.length && inland.lengthKm < stitchedKm * 0.9) {
      return wrapInland(inland, waypoints.length - 1, { seaUnavailable: seaLegs === 0 });
    }
  }

  const stitched = stitchLegs(legs);
  if (seaLegs === 0) stitched.seaUnavailable = true;
  return stitched;
}

async function routeShortest(
  waypoints: LngLat[],
  opts: HybridOptions,
): Promise<HybridPath> {
  const inland = await measureWaterChain(waypoints);
  if (inlandOk(inland) && waypoints.length === 2) {
    // Fast path: one inland + one sea comparison
    const sea = await seaLeg(waypoints[0]!, waypoints[1]!, opts, SEA_SNAP_OK_KM);
    if (sea && sea.lengthKm < inland.lengthKm * 0.92) {
      return {
        points: sea.points,
        lengthKm: sea.lengthKm,
        waterName: 'море',
        method: 'waterway',
        waypointCumKm: [0, sea.lengthKm],
        networks: ['sea'],
        passages: sea.passages,
      };
    }
    return wrapInland(inland, 1);
  }

  if (inlandOk(inland)) {
    // Multi-point: start from inland; only replace a leg with sea when clearly shorter
    const cum = inland.waypointCumKm;
    if (cum && cum.length === waypoints.length) {
      const legs: LegResult[] = [];
      for (let i = 1; i < waypoints.length; i++) {
        const a = waypoints[i - 1]!;
        const b = waypoints[i]!;
        const inlandLegKm = Math.max(0, cum[i]! - cum[i - 1]!);
        const sea = await seaLeg(a, b, opts, SEA_SNAP_OK_KM);
        if (sea && sea.lengthKm < inlandLegKm * 0.92) {
          legs.push({
            network: 'sea',
            points: sea.points,
            lengthKm: sea.lengthKm,
            passages: sea.passages,
            waterName: 'море',
            method: 'waterway',
          });
        } else {
          const chunk = slicePathByCumKm(inland.points, cum[i - 1]!, cum[i]!);
          legs.push({
            network: 'river',
            points: chunk.length >= 2 ? chunk : [a, b],
            lengthKm: inlandLegKm || pathLengthKm(chunk),
            passages: [],
            waterName: inland.waterName,
            method: inland.method,
          });
        }
      }
      return stitchLegs(legs);
    }
    return wrapInland(inland, waypoints.length - 1);
  }

  // Inland failed — per-leg with sea allowed where snap is OK
  const legs: LegResult[] = [];
  for (let i = 1; i < waypoints.length; i++) {
    legs.push(await resolveLeg(waypoints[i - 1]!, waypoints[i]!, opts, 'shortest'));
  }
  return stitchLegs(legs);
}

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

  if (prefer === 'river') return routeRiverPreferred(waypoints, opts);
  if (prefer === 'sea') return routeSeaPreferred(waypoints, opts);
  return routeShortest(waypoints, opts);
}
