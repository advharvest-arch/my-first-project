import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { measureWaterChain, type WaterPath } from './waterways';

/** How to pick between inland and maritime networks per leg. */
export type RoutePrefer = 'river' | 'shortest' | 'sea';

export type HybridOptions = {
  restrictions?: Passage[];
  allowArctic?: boolean;
  speedKnots?: number;
  /** Default `river`: sea only if inland cannot connect. */
  prefer?: RoutePrefer;
};

export type HybridPath = WaterPath & {
  networks: Array<'river' | 'sea' | 'direct'>;
  passages: Passage[];
};

type SeaLeg = { points: LngLat[]; lengthKm: number; passages: Passage[] };

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

async function seaLeg(a: LngLat, b: LngLat, opts: HybridOptions): Promise<SeaLeg | null> {
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
      maxSnapDistanceKm: 280,
    });
    const points = featureToPoints(feature);
    if (points.length < 2) return null;
    const snapOk =
      (feature.properties.originSnapKm ?? 0) < 220 &&
      (feature.properties.destinationSnapKm ?? 0) < 220;
    if (!snapOk) return null;
    return {
      points,
      lengthKm: feature.properties.length,
      passages: (feature.properties.passages ?? []) as Passage[],
    };
  } catch {
    return null;
  }
}

function inlandOk(inland: WaterPath): boolean {
  return inland.method !== 'direct' && inland.points.length >= 2 && inland.lengthKm > 0;
}

function seaOk(sea: SeaLeg | null): sea is SeaLeg {
  return sea != null && sea.lengthKm > 0 && sea.points.length >= 2;
}

/**
 * Choose network for one leg.
 * - river: inland whenever it connects; sea only as last resort
 * - shortest: among valid options pick the shorter length
 * - sea: maritime first; inland only if sea fails
 */
function chooseNetwork(
  prefer: RoutePrefer,
  inland: WaterPath,
  sea: SeaLeg | null,
): 'river' | 'sea' | 'direct' {
  const hasRiver = inlandOk(inland);
  const hasSea = seaOk(sea);

  if (prefer === 'river') {
    if (hasRiver) return 'river';
    if (hasSea) return 'sea';
    return 'direct';
  }

  if (prefer === 'sea') {
    if (hasSea) return 'sea';
    if (hasRiver) return 'river';
    return 'direct';
  }

  // shortest
  if (hasRiver && hasSea) {
    return sea!.lengthKm < inland.lengthKm ? 'sea' : 'river';
  }
  if (hasRiver) return 'river';
  if (hasSea) return 'sea';
  return 'direct';
}

/**
 * Continuous itinerary mixing inland waterways and maritime network per leg.
 * Sea is not queried when `prefer=river` and inland already found a waterway path.
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

  const allPoints: LngLat[] = [];
  const waypointCumKm = [0];
  const networks: HybridPath['networks'] = [];
  const passageSet = new Set<Passage>();
  const nameBits: string[] = [];
  let lengthKm = 0;
  let anyWater = false;
  let anyLake = false;

  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1]!;
    const b = waypoints[i]!;
    const directKm = haversineKm(a, b);

    let inland: WaterPath;
    let sea: SeaLeg | null = null;

    if (prefer === 'river') {
      // Don't involve the sea network unless inland cannot connect.
      inland = await measureWaterChain([a, b]);
      if (!inlandOk(inland)) sea = await seaLeg(a, b, opts);
    } else if (prefer === 'sea') {
      sea = await seaLeg(a, b, opts);
      if (!seaOk(sea)) inland = await measureWaterChain([a, b]);
      else {
        inland = {
          points: [a, b],
          lengthKm: directKm,
          waterName: null,
          method: 'direct',
        };
      }
    } else {
      // shortest — compare both when available
      ;[inland, sea] = await Promise.all([measureWaterChain([a, b]), seaLeg(a, b, opts)]);
    }

    const choice = chooseNetwork(prefer, inland, sea);
    networks.push(choice);

    let chunk: LngLat[];
    let legKm: number;

    if (choice === 'river') {
      chunk = inland.points;
      legKm = inland.lengthKm;
      anyWater = true;
      if (inland.method === 'lake') anyLake = true;
      if (inland.waterName) nameBits.push(inland.waterName);
    } else if (choice === 'sea' && sea) {
      chunk = sea.points;
      legKm = sea.lengthKm;
      anyWater = true;
      for (const p of sea.passages) passageSet.add(p);
      nameBits.push('море');
    } else {
      chunk = [a, b];
      legKm = directKm;
    }

    if (allPoints.length === 0) allPoints.push(...chunk);
    else allPoints.push(...chunk.slice(1));
    lengthKm += legKm;
    waypointCumKm.push(lengthKm);
  }

  const method: WaterPath['method'] = !anyWater ? 'direct' : anyLake ? 'lake' : 'waterway';
  const uniqueNames = [...new Set(nameBits.filter(Boolean))];

  return {
    points: allPoints.length >= 2 ? allPoints : waypoints.slice(),
    lengthKm: lengthKm || pathLengthKm(allPoints),
    waterName: uniqueNames.length ? uniqueNames.join(' · ') : null,
    method,
    waypointCumKm,
    networks,
    passages: [...passageSet],
  };
}
