/**
 * Bundled OSM-derived hydraulic site index + spatial lookup.
 *
 * NOT wired into the production routing pipeline.
 * Detectors must ignore metadata.label — geometry only.
 */

import type { LngLat } from './geo';
import hydroIndexData from './hydro-index.json';

export type HydroConfidence = 'high' | 'med' | 'low';

export type HydroIndexLock = {
  id: string;
  chamber: LngLat[];
  entrance: LngLat | null;
  exit: LngLat | null;
  approach: LngLat[];
  connectsSiteSides: boolean;
  boat?: string;
  lock?: string;
  cemT?: string;
  osmIds: string[];
};

export type HydraulicSite = {
  id: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
  pressureFront: LngLat[][];
  damCrest: LngLat[][];
  lockCut: LngLat[][];
  locks: HydroIndexLock[];
  approachFairways: LngLat[][];
  sides: { a: LngLat[]; b: LngLat[] };
  navigability: { boat?: string; cemT?: string };
  source: {
    osmIds: string[];
    extractedAt: string;
    confidence: HydroConfidence;
    seedId: string;
  };
  metadata?: { label?: string };
  missingFields: string[];
};

export type HydroIndexFile = {
  version: number;
  generatedAt: string;
  note: string;
  sites: HydraulicSite[];
};

const indexFile = hydroIndexData as unknown as HydroIndexFile;

export function getHydroIndex(): HydroIndexFile {
  return indexFile;
}

/** Deduped crest / pressure-front polylines suitable as detector barriers. */
export function siteBarrierPolylines(site: HydraulicSite): LngLat[][] {
  const out: LngLat[][] = [];
  const seen = new Set<string>();
  for (const line of [...site.pressureFront, ...site.damCrest]) {
    if (line.length < 2) continue;
    const key = line.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(line);
  }
  return out;
}

export function listHydraulicSites(): HydraulicSite[] {
  return indexFile.sites;
}

export function getHydraulicSiteById(id: string): HydraulicSite | null {
  return indexFile.sites.find((s) => s.id === id) ?? null;
}

export function getHydraulicSiteBySeedId(seedId: string): HydraulicSite | null {
  return indexFile.sites.find((s) => s.source.seedId === seedId) ?? null;
}

function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  const [as, aw, an, ae] = a;
  const [bs, bw, bn, be] = b;
  return as <= bn && an >= bs && aw <= be && ae >= bw;
}

function pathBbox(path: LngLat[], padDeg: number): [number, number, number, number] {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const p of path) {
    s = Math.min(s, p.lat);
    n = Math.max(n, p.lat);
    w = Math.min(w, p.lon);
    e = Math.max(e, p.lon);
  }
  return [s - padDeg, w - padDeg, n + padDeg, e + padDeg];
}

/**
 * Spatial lookup: sites whose bbox intersects an inflated path corridor.
 * `padKm` ≈ degrees via crude 1°≈111 km conversion.
 */
export function findHydraulicSitesNearPath(
  path: LngLat[],
  opts: { padKm?: number; minConfidence?: HydroConfidence } = {},
): HydraulicSite[] {
  if (path.length < 1) return [];
  const padKm = opts.padKm ?? 5;
  const padDeg = padKm / 111;
  const corridor = pathBbox(path, padDeg);
  const order = { low: 0, med: 1, high: 2 } as const;
  const minC = opts.minConfidence ? order[opts.minConfidence] : 0;
  return indexFile.sites.filter((site) => {
    if (order[site.source.confidence] < minC) return false;
    // Skip empty failed shells.
    if (!site.pressureFront.length && !site.locks.length && !site.damCrest.length) {
      return false;
    }
    return bboxIntersects(site.bbox, corridor);
  });
}

export function findHydraulicSitesNearPoint(
  point: LngLat,
  opts: { padKm?: number } = {},
): HydraulicSite[] {
  return findHydraulicSitesNearPath([point], opts);
}

/** Connecting lock candidates for a site (geometry metadata only). */
export function connectingLocks(site: HydraulicSite): HydroIndexLock[] {
  return site.locks.filter((l) => l.connectsSiteSides);
}
