import { haversineKm, pathLengthKm, type LngLat } from './geo';
import waterBodies from './water-bodies.json';

type CatalogBody = {
  n: string;
  k: 'r' | 'l';
  b: [number, number, number, number];
};

type BBox = [number, number, number, number]; // west, south, east, north

type Hole = {
  ring: Array<[number, number]>;
  bbox: BBox;
};

export type LakeMask = {
  name: string;
  osmId: number;
  outer: Array<[number, number]>;
  holes: Hole[];
  bbox: BBox;
};

/**
 * Natural open lakes with OSM multipolygon relations (outers + island holes).
 * Reservoirs stay on BRouter fairways — not listed here.
 */
const OPEN_LAKE_OSM: Record<string, number> = {
  'ладожское озеро': 21149039,
  'онежское озеро': 1308279,
  'чудское озеро': 17388038,
  ильмень: 55823,
  селигер: 399081,
  'белое озеро': 1603199,
  выгозеро: 253836,
  топозеро: 253609,
  пяозеро: 53963,
};

const CATALOG = waterBodies as CatalogBody[];
const lakeCache = new Map<number, LakeMask | null>();
const lakeInflight = new Map<number, Promise<LakeMask | null>>();

function catalogKey(name: string): string {
  return name.trim().toLocaleLowerCase('ru');
}

function inBBox(p: LngLat, b: BBox, pad = 0): boolean {
  return (
    p.lon >= b[0] - pad &&
    p.lon <= b[2] + pad &&
    p.lat >= b[1] - pad &&
    p.lat <= b[3] + pad
  );
}

function ringBBox(ring: Array<[number, number]>): BBox {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < w) w = lon;
    if (lon > e) e = lon;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [w, s, e, n];
}

function pointInRing(lon: number, lat: number, ring: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0];
    const yi = ring[i]![1];
    const xj = ring[j]![0];
    const yj = ring[j]![1];
    const inter = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi;
    if (inter) inside = !inside;
  }
  return inside;
}

function overlapsBBox(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

/** True if point is on open water (inside outer, outside island holes). */
export function pointInOpenWater(p: LngLat, lake: LakeMask): boolean {
  if (!inBBox(p, lake.bbox, 0.02)) return false;
  if (!pointInRing(p.lon, p.lat, lake.outer)) return false;
  for (const hole of lake.holes) {
    if (!inBBox(p, hole.bbox, 0.002)) continue;
    if (pointInRing(p.lon, p.lat, hole.ring)) return false;
  }
  return true;
}

function segmentBBox(a: LngLat, b: LngLat, pad = 0.01): BBox {
  return [
    Math.min(a.lon, b.lon) - pad,
    Math.min(a.lat, b.lat) - pad,
    Math.max(a.lon, b.lon) + pad,
    Math.max(a.lat, b.lat) + pad,
  ];
}

/** Geodesic-ish samples along the chord stay on water (islands / peninsulas block). */
export function openWaterLineClear(
  a: LngLat,
  b: LngLat,
  lake: LakeMask,
  stepKm = 1.2,
): boolean {
  const d = haversineKm(a, b);
  if (d < 0.05) return pointInOpenWater(a, lake) && pointInOpenWater(b, lake);
  const n = Math.max(2, Math.ceil(d / stepKm));
  const segBox = segmentBBox(a, b, 0.02);
  // Fast reject: chord bbox must overlap lake water extent.
  if (!overlapsBBox(segBox, lake.bbox)) return false;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = {
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    };
    if (!pointInOpenWater(p, lake)) return false;
  }
  return true;
}

function nearestOpenWater(p: LngLat, lake: LakeMask, maxKm = 6): LngLat | null {
  if (pointInOpenWater(p, lake)) return { ...p };
  const stepKm = 0.6;
  const rings = Math.ceil(maxKm / stepKm);
  const cos = Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
  for (let r = 1; r <= rings; r++) {
    const radKm = r * stepKm;
    const n = Math.max(8, Math.round((2 * Math.PI * radKm) / stepKm));
    for (let k = 0; k < n; k++) {
      const ang = (2 * Math.PI * k) / n;
      const cand = {
        lon: p.lon + ((radKm * Math.cos(ang)) / (111.32 * cos)),
        lat: p.lat + (radKm * Math.sin(ang)) / 110.54,
      };
      if (pointInOpenWater(cand, lake)) return cand;
    }
  }
  return null;
}

type Grid = {
  west: number;
  south: number;
  cols: number;
  rows: number;
  dLon: number;
  dLat: number;
  walk: Uint8Array;
};

function buildWaterGrid(lake: LakeMask, focus: BBox, stepKm = 1.35): Grid {
  const west = Math.max(lake.bbox[0], focus[0]);
  const south = Math.max(lake.bbox[1], focus[1]);
  const east = Math.min(lake.bbox[2], focus[2]);
  const north = Math.min(lake.bbox[3], focus[3]);
  const midLat = (south + north) / 2;
  const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const dLon = stepKm / (111.32 * cos);
  const dLat = stepKm / 110.54;
  const cols = Math.max(2, Math.ceil((east - west) / dLon) + 1);
  const rows = Math.max(2, Math.ceil((north - south) / dLat) + 1);
  const walk = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { lon: west + c * dLon, lat: south + r * dLat };
      walk[r * cols + c] = pointInOpenWater(p, lake) ? 1 : 0;
    }
  }
  return { west, south, cols, rows, dLon, dLat, walk };
}

function cellOf(p: LngLat, g: Grid): number {
  const c = Math.round((p.lon - g.west) / g.dLon);
  const r = Math.round((p.lat - g.south) / g.dLat);
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return -1;
  return r * g.cols + c;
}

function cellPoint(id: number, g: Grid): LngLat {
  const c = id % g.cols;
  const r = Math.floor(id / g.cols);
  return { lon: g.west + c * g.dLon, lat: g.south + r * g.dLat };
}

function nearestWalkableCell(p: LngLat, g: Grid, maxR = 12): number {
  const start = cellOf(p, g);
  if (start >= 0 && g.walk[start]) return start;
  const c0 = Math.round((p.lon - g.west) / g.dLon);
  const r0 = Math.round((p.lat - g.south) / g.dLat);
  let best = -1;
  let bestD = Infinity;
  for (let rad = 0; rad <= maxR; rad++) {
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) continue;
        const id = r * g.cols + c;
        if (!g.walk[id]) continue;
        const q = cellPoint(id, g);
        const d = haversineKm(p, q);
        if (d < bestD) {
          bestD = d;
          best = id;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** 8-connected A* on open-water cells. */
function astarOpenWater(a: LngLat, b: LngLat, lake: LakeMask): LngLat[] | null {
  const pad = 0.08;
  const focus: BBox = [
    Math.min(a.lon, b.lon, lake.bbox[0]) - pad,
    Math.min(a.lat, b.lat, lake.bbox[1]) - pad,
    Math.max(a.lon, b.lon, lake.bbox[2]) + pad,
    Math.max(a.lat, b.lat, lake.bbox[3]) + pad,
  ];
  // Prefer a corridor around the chord; fall back to full lake mask.
  const chordFocus: BBox = [
    Math.min(a.lon, b.lon) - 0.35,
    Math.min(a.lat, b.lat) - 0.35,
    Math.max(a.lon, b.lon) + 0.35,
    Math.max(a.lat, b.lat) + 0.35,
  ];

  const tryGrid = (box: BBox): LngLat[] | null => {
    const g = buildWaterGrid(lake, box, 1.4);
    const start = nearestWalkableCell(a, g);
    const goal = nearestWalkableCell(b, g);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [a, b];

    const N = g.cols * g.rows;
    const came = new Int32Array(N).fill(-1);
    const gScore = new Float64Array(N).fill(Infinity);
    const fScore = new Float64Array(N).fill(Infinity);
    const open: number[] = [start];
    const inOpen = new Uint8Array(N);
    inOpen[start] = 1;
    gScore[start] = 0;
    fScore[start] = haversineKm(cellPoint(start, g), cellPoint(goal, g));

    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const;

    while (open.length) {
      // Linear pop-min — grids are small (~10–30k).
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        if (fScore[open[i]!]! < fScore[open[bi]!]!) bi = i;
      }
      const cur = open[bi]!;
      open[bi] = open[open.length - 1]!;
      open.pop();
      inOpen[cur] = 0;
      if (cur === goal) break;

      const cc = cur % g.cols;
      const rr = Math.floor(cur / g.cols);
      const curP = cellPoint(cur, g);
      for (const [dc, dr] of dirs) {
        const nc = cc + dc;
        const nr = rr + dr;
        if (nc < 0 || nr < 0 || nc >= g.cols || nr >= g.rows) continue;
        const nid = nr * g.cols + nc;
        if (!g.walk[nid]) continue;
        const np = cellPoint(nid, g);
        // Diagonal must not cut a land corner.
        if (dc !== 0 && dr !== 0) {
          const a1 = rr * g.cols + nc;
          const a2 = nr * g.cols + cc;
          if (!g.walk[a1] || !g.walk[a2]) continue;
        }
        const tent = gScore[cur]! + haversineKm(curP, np);
        if (tent >= gScore[nid]!) continue;
        came[nid] = cur;
        gScore[nid] = tent;
        fScore[nid] = tent + haversineKm(np, cellPoint(goal, g));
        if (!inOpen[nid]) {
          open.push(nid);
          inOpen[nid] = 1;
        }
      }
    }

    if (came[goal] < 0 && start !== goal) return null;
    const cells: number[] = [];
    let c = goal;
    cells.push(c);
    while (c !== start) {
      c = came[c]!;
      if (c < 0) return null;
      cells.push(c);
    }
    cells.reverse();
    return cells.map((id) => cellPoint(id, g));
  };

  return tryGrid(chordFocus) ?? tryGrid(focus);
}

/** Collapse collinear / unnecessary bends while staying on water. */
function smoothOpenWaterPath(points: LngLat[], lake: LakeMask): LngLat[] {
  if (points.length <= 2) return points;
  const out: LngLat[] = [points[0]!];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1) {
      if (openWaterLineClear(points[i]!, points[j]!, lake, 1.0)) break;
      j -= 1;
    }
    out.push(points[j]!);
    i = j;
  }
  return out;
}

function parseNominatimLake(
  name: string,
  osmId: number,
  geom: GeoJSON.Polygon | GeoJSON.MultiPolygon,
): LakeMask | null {
  const polys =
    geom.type === 'Polygon'
      ? [geom.coordinates]
      : geom.type === 'MultiPolygon'
        ? geom.coordinates
        : [];
  if (!polys.length) return null;

  // Largest outer ring = main lake body.
  let best: typeof polys[number] | null = null;
  let bestN = 0;
  for (const poly of polys) {
    const n = poly[0]?.length ?? 0;
    if (n > bestN) {
      bestN = n;
      best = poly;
    }
  }
  if (!best || !best[0] || best[0].length < 8) return null;

  const outer = best[0].map(([lon, lat]) => [lon, lat] as [number, number]);
  const holes: Hole[] = [];
  for (let h = 1; h < best.length; h++) {
    const ring = best[h];
    if (!ring || ring.length < 4) continue;
    const mapped = ring.map(([lon, lat]) => [lon, lat] as [number, number]);
    const bbox = ringBBox(mapped);
    // Drop tiny rocks (< ~200 m) — noise for open-water legs.
    const diag =
      haversineKm({ lon: bbox[0], lat: bbox[1] }, { lon: bbox[2], lat: bbox[3] }) * 1000;
    if (diag < 200) continue;
    holes.push({ ring: mapped, bbox });
  }

  // Also treat other multipolygon parts' outers as obstacles if they are islands
  // represented as separate polygons (rare for Nominatim lake dumps).
  for (const poly of polys) {
    if (poly === best) continue;
    const ring = poly[0];
    if (!ring || ring.length < 4) continue;
    const mapped = ring.map(([lon, lat]) => [lon, lat] as [number, number]);
    const bbox = ringBBox(mapped);
    const diag =
      haversineKm({ lon: bbox[0], lat: bbox[1] }, { lon: bbox[2], lat: bbox[3] }) * 1000;
    if (diag < 200 || diag > 80_000) continue;
    holes.push({ ring: mapped, bbox });
  }

  return {
    name,
    osmId,
    outer,
    holes,
    bbox: ringBBox(outer),
  };
}

async function fetchLakeMask(name: string, osmId: number): Promise<LakeMask | null> {
  if (lakeCache.has(osmId)) return lakeCache.get(osmId)!;
  const pending = lakeInflight.get(osmId);
  if (pending) return pending;

  const job = (async (): Promise<LakeMask | null> => {
    const url =
      `https://nominatim.openstreetmap.org/lookup?osm_ids=R${osmId}` +
      `&format=geojson&polygon_geojson=1&polygon_threshold=0.008`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'AquaRoute/1.4 (inland waterways; https://advharvest-arch.github.io)',
        },
      });
      if (!res.ok) throw new Error(`Nominatim ${res.status}`);
      const gj = (await res.json()) as GeoJSON.FeatureCollection;
      const feat = gj.features?.[0];
      const geom = feat?.geometry;
      if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) {
        lakeCache.set(osmId, null);
        return null;
      }
      const mask = parseNominatimLake(name, osmId, geom);
      lakeCache.set(osmId, mask);
      return mask;
    } catch {
      lakeCache.set(osmId, null);
      return null;
    } finally {
      lakeInflight.delete(osmId);
    }
  })();

  lakeInflight.set(osmId, job);
  return job;
}

export type SharedOpenLake = {
  name: string;
  osmId: number;
  catalog: CatalogBody;
};

/** Same natural open lake (catalog + OSM mask id), not a reservoir. */
export function findSharedOpenLake(points: LngLat[]): SharedOpenLake | null {
  if (points.length < 2) return null;
  for (const body of CATALOG) {
    if (body.k !== 'l') continue;
    const key = catalogKey(body.n);
    const osmId = OPEN_LAKE_OSM[key];
    if (!osmId) continue;
    if (/водохран/i.test(body.n)) continue;
    if (!points.every((p) => inBBox(p, body.b, 0.05))) continue;
    return { name: body.n, osmId, catalog: body };
  }
  return null;
}

/**
 * Straight open-water chords between waypoints, bending only to clear
 * islands / peninsulas / shore (grid A* on the lake mask).
 */
export async function routeAcrossOpenLake(
  waypoints: LngLat[],
): Promise<{ points: LngLat[]; lengthKm: number; waterName: string } | null> {
  const shared = findSharedOpenLake(waypoints);
  if (!shared) return null;

  const lake = await fetchLakeMask(shared.name, shared.osmId);
  if (!lake) return null;

  const snapped: LngLat[] = [];
  for (const p of waypoints) {
    const s = nearestOpenWater(p, lake, 8);
    if (!s) return null;
    snapped.push(s);
  }

  const path: LngLat[] = [];
  for (let i = 0; i < snapped.length; i++) {
    const cur = snapped[i]!;
    if (i === 0) {
      path.push(waypoints[0]!, cur);
      continue;
    }
    const prev = snapped[i - 1]!;
    let leg: LngLat[];
    if (openWaterLineClear(prev, cur, lake)) {
      leg = [prev, cur];
    } else {
      const routed = astarOpenWater(prev, cur, lake);
      if (!routed || routed.length < 2) return null;
      leg = smoothOpenWaterPath(routed, lake);
    }
    // Drop duplicate joint.
    for (let k = 1; k < leg.length; k++) path.push(leg[k]!);
  }
  const lastWp = waypoints[waypoints.length - 1]!;
  const last = path[path.length - 1]!;
  if (haversineKm(last, lastWp) > 0.05) path.push(lastWp);

  // Final global smooth (still water-safe).
  const smooth = smoothOpenWaterPath(path, lake);
  const lengthKm = pathLengthKm(smooth);
  if (!(lengthKm > 0)) return null;

  // Guard: never accept a path that still cuts a long land chord.
  for (let i = 1; i < smooth.length; i++) {
    if (!openWaterLineClear(smooth[i - 1]!, smooth[i]!, lake, 1.5)) {
      // Keep unsmoothed path if smooth introduced a cut (shouldn't).
      return { points: path, lengthKm: pathLengthKm(path), waterName: shared.name };
    }
  }

  return { points: smooth, lengthKm, waterName: shared.name };
}
