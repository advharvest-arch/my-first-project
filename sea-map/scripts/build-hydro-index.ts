/**
 * Build a first OSM-derived hydro-index for major Volga/Kama cascade sites.
 *
 * Usage: npx tsx scripts/build-hydro-index.ts
 *
 * - Queries Overpass only inside seed bboxes (not all of Russia).
 * - Algorithm uses geometry + tags only; names are metadata.
 * - Writes sea-map/src/hydro-index.json and prints a quality report.
 *
 * Does NOT wire into the routing pipeline.
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type LngLat = { lon: number; lat: number };

type OsmElement = {
  type: 'way' | 'node' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lon: number; lat: number }>;
  lat?: number;
  lon?: number;
};

type Seed = {
  /** Stable seed id (not used by detectors as a place-name rule). */
  seedId: string;
  /** Optional human label for reports only. */
  label?: string;
  /** south, west, north, east */
  bbox: [number, number, number, number];
};

type IndexLock = {
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

type HydraulicSiteIndex = {
  id: string;
  bbox: [number, number, number, number];
  pressureFront: LngLat[][];
  damCrest: LngLat[][];
  lockCut: LngLat[][];
  locks: IndexLock[];
  approachFairways: LngLat[][];
  sides: { a: LngLat[]; b: LngLat[] };
  navigability: { boat?: string; cemT?: string };
  source: {
    osmIds: string[];
    extractedAt: string;
    confidence: 'high' | 'med' | 'low';
    seedId: string;
  };
  metadata?: { label?: string };
  missingFields: string[];
};

type HydroIndexFile = {
  version: 1;
  generatedAt: string;
  note: string;
  sites: HydraulicSiteIndex[];
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'src', 'hydro-index.json');

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

/** Seed bboxes around known cascade hydros — query windows only. */
const SEEDS: Seed[] = [
  { seedId: 'seed-ivanovo', label: 'Dubna / Ivankovo', bbox: [56.72, 37.08, 56.76, 37.22] },
  { seedId: 'seed-uglich', label: 'Uglich', bbox: [57.50, 38.28, 57.55, 38.36] },
  { seedId: 'seed-rybinsk', label: 'Rybinsk', bbox: [58.07, 38.66, 58.14, 38.88] },
  { seedId: 'seed-gorodets', label: 'Gorodets', bbox: [56.63, 43.42, 56.70, 43.55] },
  { seedId: 'seed-cheboksary', label: 'Cheboksary', bbox: [56.10, 47.30, 56.18, 47.45] },
  { seedId: 'seed-zhiguli', label: 'Zhiguli', bbox: [53.42, 49.40, 53.50, 49.60] },
  { seedId: 'seed-saratov', label: 'Balakovo / Saratov', bbox: [51.98, 47.75, 52.08, 47.95] },
  { seedId: 'seed-volgograd', label: 'Volzhsky / Volgograd', bbox: [48.78, 44.60, 48.88, 44.80] },
  { seedId: 'seed-perm', label: 'Kama / Perm', bbox: [57.98, 56.20, 58.05, 56.45] },
  { seedId: 'seed-votkinsk', label: 'Votkinsk', bbox: [56.80, 54.05, 56.90, 54.25] },
  { seedId: 'seed-nizhnekamsk', label: 'Nizhnekamsk', bbox: [55.65, 52.25, 55.78, 52.55] },
];

function haversineKm(a: LngLat, b: LngLat): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function overpass(query: string): Promise<OsmElement[]> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    for (const endpoint of OVERPASS) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'AquaRoute-hydro-index-builder/1.0',
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(120_000),
        });
        if (!res.ok) {
          lastErr = new Error(`${endpoint} HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { elements?: OsmElement[] };
        return data.elements ?? [];
      } catch (e) {
        lastErr = e;
      }
    }
    await sleep(3000 * (attempt + 1));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function seedQuery(bbox: [number, number, number, number]): string {
  const [s, w, n, e] = bbox;
  return `
[out:json][timeout:90];
(
  way["waterway"="dam"](${s},${w},${n},${e});
  way["waterway"="weir"](${s},${w},${n},${e});
  // Embankments / dykes that form the hydraulic pressure front with dams.
  way["man_made"="dyke"](${s},${w},${n},${e});
  way["man_made"="embankment"](${s},${w},${n},${e});
  way["lock"="yes"](${s},${w},${n},${e});
  way["waterway"="lock_gate"](${s},${w},${n},${e});
  way["waterway"="canal"]["boat"](${s},${w},${n},${e});
  way["waterway"="canal"]["CEMT"](${s},${w},${n},${e});
  way["waterway"="fairway"](${s},${w},${n},${e});
  way["waterway"="canal"]["lock"="yes"](${s},${w},${n},${e});
  node["waterway"="lock_gate"](${s},${w},${n},${e});
);
out geom;
`;
}

function wayCoords(el: OsmElement): LngLat[] {
  if (el.geometry?.length) return el.geometry.map((g) => ({ lon: g.lon, lat: g.lat }));
  if (el.lat != null && el.lon != null) return [{ lon: el.lon, lat: el.lat }];
  return [];
}

function lineLenKm(coords: LngLat[]): number {
  let s = 0;
  for (let i = 1; i < coords.length; i++) s += haversineKm(coords[i - 1]!, coords[i]!);
  return s;
}

function centroid(coords: LngLat[]): LngLat {
  const n = Math.max(1, coords.length);
  return {
    lon: coords.reduce((a, p) => a + p.lon, 0) / n,
    lat: coords.reduce((a, p) => a + p.lat, 0) / n,
  };
}

function bboxOf(lines: LngLat[][]): [number, number, number, number] {
  let s = Infinity;
  let w = Infinity;
  let n = -Infinity;
  let e = -Infinity;
  for (const line of lines) {
    for (const p of line) {
      s = Math.min(s, p.lat);
      n = Math.max(n, p.lat);
      w = Math.min(w, p.lon);
      e = Math.max(e, p.lon);
    }
  }
  if (!Number.isFinite(s)) return [0, 0, 0, 0];
  const pad = 0.005;
  return [s - pad, w - pad, n + pad, e + pad];
}

function minDistPointLine(p: LngLat, line: LngLat[]): number {
  if (!line.length) return Infinity;
  let best = Infinity;
  for (const q of line) best = Math.min(best, haversineKm(p, q));
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    best = Math.min(best, haversineKm(p, mid));
  }
  return best;
}

function minDistLines(a: LngLat[], b: LngLat[]): number {
  let best = Infinity;
  for (const p of a) best = Math.min(best, minDistPointLine(p, b));
  return best;
}

type XY = { x: number; y: number };
function localFrame(origin: LngLat) {
  const cosLat = Math.max(0.2, Math.cos((origin.lat * Math.PI) / 180));
  return {
    toXY: (p: LngLat): XY => ({
      x: (p.lon - origin.lon) * 111.32 * cosLat,
      y: (p.lat - origin.lat) * 110.54,
    }),
  };
}

function sideOf(p: XY, a: XY, b: XY): number {
  const c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  if (Math.abs(c) < 1e-9) return 0;
  return c > 0 ? 1 : -1;
}

/** Longest segment axis of the merged dam crest. */
function crestAxis(crest: LngLat[][]): { origin: LngLat; a: XY; b: XY } | null {
  let best: LngLat[] | null = null;
  let bestLen = -1;
  for (const line of crest) {
    const len = lineLenKm(line);
    if (len > bestLen) {
      bestLen = len;
      best = line;
    }
  }
  if (!best || best.length < 2) return null;
  const origin = best[0]!;
  const { toXY } = localFrame(origin);
  let iBest = 1;
  let seg = -1;
  for (let i = 1; i < best.length; i++) {
    const d = Math.hypot(
      toXY(best[i]!).x - toXY(best[i - 1]!).x,
      toXY(best[i]!).y - toXY(best[i - 1]!).y,
    );
    if (d > seg) {
      seg = d;
      iBest = i;
    }
  }
  return { origin, a: toXY(best[iBest - 1]!), b: toXY(best[iBest]!) };
}

/** Classify half-planes from the overall crest span (E–W or N–S dominant). */
function frontSideMode(crest: LngLat[][]): {
  mode: 'ns' | 'ew';
  midLon: number;
  midLat: number;
} | null {
  const pts = crest.flat();
  if (pts.length < 2) return null;
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of pts) {
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  const dLon = (maxLon - minLon) * Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const dLat = maxLat - minLat;
  return {
    mode: Math.abs(dLon) >= Math.abs(dLat) ? 'ns' : 'ew',
    midLon: (minLon + maxLon) / 2,
    midLat: (minLat + maxLat) / 2,
  };
}

function sideByFront(p: LngLat, front: ReturnType<typeof frontSideMode>): number {
  if (!front) return 0;
  if (front.mode === 'ns') {
    // Front runs E–W → pools are north/south.
    if (p.lat < front.midLat - 0.0004) return -1;
    if (p.lat > front.midLat + 0.0004) return 1;
    return 0;
  }
  if (p.lon < front.midLon - 0.001) return -1;
  if (p.lon > front.midLon + 0.001) return 1;
  return 0;
}

function connectsSides(crest: LngLat[][], samples: LngLat[]): boolean {
  const front = frontSideMode(crest);
  if (!front || samples.length < 2) return false;
  let neg = false;
  let pos = false;
  for (const p of samples) {
    const s = sideByFront(p, front);
    if (s < 0) neg = true;
    if (s > 0) pos = true;
  }
  if (neg && pos) return true;

  // Fallback: geometric axis of the longest crest segment.
  const axis = crestAxis(crest);
  if (!axis) return false;
  const { toXY } = localFrame(axis.origin);
  neg = false;
  pos = false;
  for (const p of samples) {
    const s = sideOf(toXY(p), axis.a, axis.b);
    if (s < 0) neg = true;
    if (s > 0) pos = true;
  }
  return neg && pos;
}

function simplify(line: LngLat[], minKm = 0.03): LngLat[] {
  if (line.length <= 2) return line.slice();
  const out: LngLat[] = [line[0]!];
  for (let i = 1; i < line.length - 1; i++) {
    if (haversineKm(out[out.length - 1]!, line[i]!) >= minKm) out.push(line[i]!);
  }
  const last = line[line.length - 1]!;
  if (haversineKm(out[out.length - 1]!, last) > 1e-6) out.push(last);
  return out;
}

function buildSite(seed: Seed, elements: OsmElement[]): HydraulicSiteIndex {
  const dams: Array<{ id: string; coords: LngLat[]; tags: Record<string, string> }> = [];
  const weirs: Array<{ id: string; coords: LngLat[] }> = [];
  const embankments: Array<{ id: string; coords: LngLat[] }> = [];
  const lockWays: Array<{ id: string; coords: LngLat[]; tags: Record<string, string> }> = [];
  const canals: Array<{ id: string; coords: LngLat[]; tags: Record<string, string> }> = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    const coords = wayCoords(el);
    if (coords.length < 1) continue;
    const id = `${el.type[0]}${el.id}`;
    if (tags.waterway === 'dam') dams.push({ id, coords, tags });
    else if (tags.waterway === 'weir') weirs.push({ id, coords });
    else if (tags.man_made === 'dyke' || tags.man_made === 'embankment') {
      embankments.push({ id, coords });
    }
    if (tags.lock === 'yes' || tags.waterway === 'lock_gate') {
      lockWays.push({ id, coords, tags });
    }
    if (
      tags.waterway === 'canal' ||
      tags.waterway === 'fairway' ||
      tags.waterway === 'ship_canal'
    ) {
      canals.push({ id, coords, tags });
    }
  }

  const damCrest = dams
    .map((d) => simplify(d.coords))
    .filter((c) => c.length >= 2)
    .sort((a, b) => lineLenKm(b) - lineLenKm(a));

  // pressureFront = hydraulic separation: dams + weirs + embankments near crests.
  // Embankments far from any dam/weir are ignored (road dykes etc.).
  const crestSeed = [...damCrest, ...weirs.map((w) => simplify(w.coords)).filter((c) => c.length >= 2)];
  const nearEmbankments = embankments
    .map((e) => simplify(e.coords))
    .filter((c) => c.length >= 2)
    .filter((c) => {
      if (!crestSeed.length) return false;
      return minDistLines(c, crestSeed.flat()) <= 1.2;
    });
  const pressureFront = [...crestSeed, ...nearEmbankments];

  // Prefer lock=yes chambers; fall back to short boat canals near crest.
  const crestForAssoc = damCrest.length ? damCrest : pressureFront;
  const locks: IndexLock[] = [];

  // Prefer multi-point lock=yes ways over single lock_gate nodes.
  const lockWayPreferred = lockWays.filter(
    (lw) => lw.coords.length >= 2 && (lw.tags.lock === 'yes' || lw.tags.waterway === 'canal'),
  );
  const lockSource = lockWayPreferred.length ? lockWayPreferred : lockWays;

  for (const lw of lockSource) {
    const chamber = simplify(lw.coords, 0.01);
    if (!chamber.length) continue;
    const approachParts = canals
      .filter((c) => c.id !== lw.id)
      .filter((c) => minDistLines(c.coords, chamber) <= 3.0)
      .filter((c) => c.tags.boat === 'yes' || c.tags.CEMT || c.tags.lock === 'yes')
      .map((c) => simplify(c.coords))
      .filter((c) => c.length >= 2);

    const approach = approachParts.flat();
    const samples = [...chamber, ...approach];
    // Prefer crest segments near this lock when testing side connection.
    const localCrest = crestForAssoc.filter((line) => minDistLines(line, chamber) <= 4.0);
    const crestForLock = localCrest.length ? localCrest : crestForAssoc;
    const connects = crestForLock.length ? connectsSides(crestForLock, samples) : false;

    locks.push({
      id: lw.id,
      chamber,
      entrance: chamber[0] ?? null,
      exit: chamber[chamber.length - 1] ?? null,
      approach,
      connectsSiteSides: connects,
      boat: lw.tags.boat,
      lock: lw.tags.lock,
      cemT: lw.tags.CEMT,
      osmIds: [lw.id],
    });
  }

  // If no explicit lock=yes, try short CEMT/boat canals hugging the crest as lock cuts.
  if (!locks.length && crestForAssoc.length) {
    for (const c of canals) {
      if (!(c.tags.boat === 'yes' || c.tags.CEMT)) continue;
      if (lineLenKm(c.coords) > 2.5) continue;
      if (minDistLines(c.coords, crestForAssoc.flat()) > 0.8) continue;
      const chamber = simplify(c.coords, 0.01);
      const connects = connectsSides(crestForAssoc, chamber);
      locks.push({
        id: c.id,
        chamber,
        entrance: chamber[0] ?? null,
        exit: chamber[chamber.length - 1] ?? null,
        approach: [],
        connectsSiteSides: connects,
        boat: c.tags.boat,
        cemT: c.tags.CEMT,
        osmIds: [c.id],
      });
    }
  }

  const lockCut = locks
    .filter((l) => l.connectsSiteSides || minDistLines(l.chamber, crestForAssoc.flat()) <= 1.5)
    .map((l) => l.chamber);

  const approachFairways = locks
    .map((l) => l.approach)
    .filter((a) => a.length >= 2)
    .map((a) => simplify(a));

  // sides A/B from overall front half-planes (E–W crest → N/S pools).
  const sides = { a: [] as LngLat[], b: [] as LngLat[] };
  const front = frontSideMode(crestForAssoc);
  if (front) {
    const samples: LngLat[] = [];
    for (const l of locks) {
      if (l.entrance) samples.push(l.entrance);
      if (l.exit) samples.push(l.exit);
      if (l.approach.length) {
        samples.push(l.approach[0]!, l.approach[l.approach.length - 1]!);
      }
    }
    const [s, w, n, e] = seed.bbox;
    samples.push(
      { lon: (w + e) / 2, lat: s },
      { lon: (w + e) / 2, lat: n },
      { lon: w, lat: (s + n) / 2 },
      { lon: e, lat: (s + n) / 2 },
    );
    for (const pt of samples) {
      const sid = sideByFront(pt, front);
      if (sid < 0) sides.a.push(pt);
      if (sid > 0) sides.b.push(pt);
    }
  }

  const osmIds = [
    ...dams.map((d) => d.id),
    ...weirs.map((w) => w.id),
    ...embankments.map((e) => e.id),
    ...lockWays.map((l) => l.id),
    ...canals.slice(0, 40).map((c) => c.id),
  ];

  const missingFields: string[] = [];
  if (!pressureFront.length) missingFields.push('pressureFront');
  if (!damCrest.length) missingFields.push('damCrest');
  if (!lockCut.length) missingFields.push('lockCut');
  if (!locks.length) missingFields.push('locks');
  if (!approachFairways.length) missingFields.push('approachFairways');
  if (!sides.a.length || !sides.b.length) missingFields.push('sides');
  if (!locks.some((l) => l.connectsSiteSides)) missingFields.push('connectingLock');

  let confidence: 'high' | 'med' | 'low' = 'low';
  if (
    pressureFront.length &&
    damCrest.length &&
    locks.some((l) => l.connectsSiteSides) &&
    approachFairways.length
  ) {
    confidence = 'high';
  } else if (pressureFront.length && locks.length) {
    confidence = 'med';
  } else if (pressureFront.length || locks.length) {
    confidence = 'low';
  }

  const geomForBbox = [
    ...pressureFront,
    ...damCrest,
    ...lockCut,
    ...locks.map((l) => l.chamber),
  ];
  const siteBbox = geomForBbox.length ? bboxOf(geomForBbox) : seed.bbox;

  const c0 = centroid(damCrest[0] ?? pressureFront[0] ?? locks[0]?.chamber ?? [{ lon: 0, lat: 0 }]);
  const id = `hs-${c0.lon.toFixed(3)}-${c0.lat.toFixed(3)}`;

  return {
    id,
    bbox: siteBbox,
    pressureFront,
    damCrest,
    lockCut,
    locks,
    approachFairways,
    sides,
    navigability: {
      boat: locks.find((l) => l.boat)?.boat,
      cemT: locks.find((l) => l.cemT)?.cemT,
    },
    source: {
      osmIds,
      extractedAt: new Date().toISOString(),
      confidence,
      seedId: seed.seedId,
    },
    metadata: seed.label ? { label: seed.label } : undefined,
    missingFields,
  };
}

function p(lon: number, lat: number): LngLat {
  return { lon, lat };
}

function printReport(sites: HydraulicSiteIndex[]) {
  console.log('\n=== Hydro-index quality report ===');
  for (const s of sites) {
    console.log({
      id: s.id,
      label: s.metadata?.label,
      bbox: s.bbox.map((x) => +x.toFixed(4)),
      pressureFrontPolylines: s.pressureFront.length,
      pressureFrontPoints: s.pressureFront.reduce((n, l) => n + l.length, 0),
      damCrestPolylines: s.damCrest.length,
      damCrestPoints: s.damCrest.reduce((n, l) => n + l.length, 0),
      lockCount: s.locks.length,
      connectingLocks: s.locks.filter((l) => l.connectsSiteSides).length,
      approachCount: s.approachFairways.length,
      lockCutPolylines: s.lockCut.length,
      sidesA: s.sides.a.length,
      sidesB: s.sides.b.length,
      confidence: s.source.confidence,
      missingFields: s.missingFields,
    });
  }
}

async function main() {
  const sites: HydraulicSiteIndex[] = [];
  for (const seed of SEEDS) {
    console.log(`\nFetching ${seed.seedId} ${seed.label ?? ''}…`);
    try {
      const els = await overpass(seedQuery(seed.bbox));
      console.log(`  elements=${els.length}`);
      const site = buildSite(seed, els);
      sites.push(site);
      console.log(
        `  → ${site.id} confidence=${site.source.confidence} locks=${site.locks.length} missing=${site.missingFields.join(',') || 'none'}`,
      );
    } catch (e) {
      console.error(`  FAIL ${seed.seedId}`, e);
      sites.push({
        id: `hs-failed-${seed.seedId}`,
        bbox: seed.bbox,
        pressureFront: [],
        damCrest: [],
        lockCut: [],
        locks: [],
        approachFairways: [],
        sides: { a: [], b: [] },
        navigability: {},
        source: {
          osmIds: [],
          extractedAt: new Date().toISOString(),
          confidence: 'low',
          seedId: seed.seedId,
        },
        metadata: seed.label ? { label: seed.label } : undefined,
        missingFields: [
          'pressureFront',
          'damCrest',
          'lockCut',
          'locks',
          'approachFairways',
          'sides',
          'fetch',
        ],
      });
    }
    await sleep(1500);
  }

  const file: HydroIndexFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    note: 'OSM-derived hydraulic sites for AquaRoute. Detector must ignore metadata.label.',
    sites,
  };
  writeFileSync(OUT, JSON.stringify(file));
  console.log(`\nWrote ${OUT} (${Buffer.byteLength(JSON.stringify(file))} bytes, ${sites.length} sites)`);
  printReport(sites);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
