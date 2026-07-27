import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { haversineKm, pathLengthKm, type LngLat } from './geo';
import { measureWaterChain, type WaterPath } from './waterways';

export type HybridOptions = {
  restrictions?: Passage[];
  allowArctic?: boolean;
  speedKnots?: number;
};

export type HybridPath = WaterPath & {
  /** Labels describing which networks were used */
  networks: Array<'river' | 'sea' | 'direct'>;
  passages: Passage[];
};

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
): Promise<{ points: LngLat[]; lengthKm: number; passages: Passage[] } | null> {
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

/**
 * Pick river vs sea for one leg.
 * Prefer inland when it follows waterways; use sea when inland fails or is a poor detour.
 */
function preferSea(
  directKm: number,
  inland: WaterPath,
  sea: { lengthKm: number } | null,
): 'river' | 'sea' | 'direct' {
  const inlandOk = inland.method !== 'direct' && inland.points.length >= 2;
  const seaOk = sea != null && sea.lengthKm > 0;

  if (inlandOk && !seaOk) return 'river';
  if (!inlandOk && seaOk) return 'sea';
  if (!inlandOk && !seaOk) return 'direct';

  // Both available: inland is suspicious if much longer than great-circle on long legs
  // (typical when BRouter/OSM can't connect and wanders), or when it's barely better than direct.
  const inlandRatio = inland.lengthKm / Math.max(directKm, 0.01);
  const seaRatio = sea!.lengthKm / Math.max(directKm, 0.01);

  if (directKm >= 40 && inlandRatio > 2.8 && seaRatio < inlandRatio * 0.85) return 'sea';
  if (directKm >= 80 && inland.method === 'lake' && seaRatio < inlandRatio) return 'sea';
  // Short coastal / river: prefer river network
  if (inlandRatio <= 2.2) return 'river';
  // Prefer shorter of the two when both look plausible
  return sea!.lengthKm < inland.lengthKm * 0.92 ? 'sea' : 'river';
}

/**
 * Continuous itinerary mixing inland waterways and maritime network per leg.
 */
export async function measureHybridChain(
  waypoints: LngLat[],
  opts: HybridOptions = {},
): Promise<HybridPath> {
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

    const [inland, sea] = await Promise.all([
      measureWaterChain([a, b]),
      seaLeg(a, b, opts),
    ]);

    const choice = preferSea(directKm, inland, sea);
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
