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
  outerBBox: BBox;
  holes: Hole[];
  bbox: BBox;
};

/**
 * Natural lakes and large reservoirs with OSM multipolygon relations.
 * Straight open-water chords bend only around islands / capes / shore.
 */
const OPEN_WATER_OSM: Record<string, number> = {
  'ладожское озеро': 21149039,
  'онежское озеро': 1308279,
  'чудское озеро': 17388038,
  ильмень: 55823,
  селигер: 399081,
  'белое озеро': 1603199,
  выгозеро: 253836,
  топозеро: 253609,
  пяозеро: 53963,
  // Reservoirs — same open-water rule as natural lakes.
  'рыбинское водохранилище': 1521563,
  'иваньковское водохранилище': 72136,
  'горьковское водохранилище': 1672785,
  'чебоксарское водохранилище': 16760694,
  'куйбышевское водохранилище': 116060,
  'саратовское водохранилище': 6193700,
  'цимлянское водохранилище': 966973,
  'камское водохранилище': 14648915,
  'воткинское водохранилище': 1350708,
};

const CATALOG = waterBodies as CatalogBody[];
const lakeCache = new Map<number, LakeMask | null>();
const lakeInflight = new Map<number, Promise<LakeMask | null>>();

/** Sample spacing for water-safety checks (narrow islands / channels). */
const CLEAR_STEP_KM = 0.18;
/** A* cell size — fine enough that eroded cells keep paths off shore. */
const GRID_STEP_KM = 0.7;

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

function overlapsBBox(a: BBox, b: BBox): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
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

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (by - ay) * (cx - bx) - (bx - ax) * (cy - by);
}

function onSeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  return (
    Math.min(ax, bx) - 1e-12 <= cx &&
    cx <= Math.max(ax, bx) + 1e-12 &&
    Math.min(ay, by) - 1e-12 <= cy &&
    cy <= Math.max(ay, by) + 1e-12
  );
}

/** True if open segment a→b properly intersects ring edge (leaves/enters polygon). */
function segmentHitsRing(a: LngLat, b: LngLat, ring: Array<[number, number]>): boolean {
  const ax = a.lon;
  const ay = a.lat;
  const bx = b.lon;
  const by = b.lat;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cx = ring[j]![0];
    const cy = ring[j]![1];
    const dx = ring[i]![0];
    const dy = ring[i]![1];
    const o1 = orient(ax, ay, bx, by, cx, cy);
    const o2 = orient(ax, ay, bx, by, dx, dy);
    const o3 = orient(cx, cy, dx, dy, ax, ay);
    const o4 = orient(cx, cy, dx, dy, bx, by);
    if (o1 * o2 < 0 && o3 * o4 < 0) return true;
    if (Math.abs(o1) < 1e-14 && onSeg(ax, ay, bx, by, cx, cy)) return true;
    if (Math.abs(o2) < 1e-14 && onSeg(ax, ay, bx, by, dx, dy)) return true;
    if (Math.abs(o3) < 1e-14 && onSeg(cx, cy, dx, dy, ax, ay)) return true;
    if (Math.abs(o4) < 1e-14 && onSeg(cx, cy, dx, dy, bx, by)) return true;
  }
  return false;
}

function segmentBBox(a: LngLat, b: LngLat, pad = 0.01): BBox {
  return [
    Math.min(a.lon, b.lon) - pad,
    Math.min(a.lat, b.lat) - pad,
    Math.max(a.lon, b.lon) + pad,
    Math.max(a.lat, b.lat) + pad,
  ];
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

/**
 * Chord stays on water: endpoints in water, no shore/island edge crossings,
 * dense samples along the segment.
 */
export function openWaterLineClear(
  a: LngLat,
  b: LngLat,
  lake: LakeMask,
  stepKm = CLEAR_STEP_KM,
): boolean {
  if (!pointInOpenWater(a, lake) || !pointInOpenWater(b, lake)) return false;
  const d = haversineKm(a, b);
  if (d < 0.02) return true;

  const segBox = segmentBBox(a, b, 0.01);
  if (!overlapsBBox(segBox, lake.bbox)) return false;

  // Leaving the lake through the outer shoreline.
  if (overlapsBBox(segBox, lake.outerBBox) && segmentHitsRing(a, b, lake.outer)) {
    return false;
  }
  // Cutting an island / hole.
  for (const hole of lake.holes) {
    if (!overlapsBBox(segBox, hole.bbox)) continue;
    if (segmentHitsRing(a, b, hole.ring)) return false;
  }

  const n = Math.max(2, Math.ceil(d / stepKm));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = {
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    };
    if (!pointInOpenWater(p, lake)) return false;
  }
  return true;
}

function nearestOpenWater(p: LngLat, lake: LakeMask, maxKm = 10): LngLat | null {
  if (pointInOpenWater(p, lake)) return { ...p };
  const stepKm = 0.4;
  const rings = Math.ceil(maxKm / stepKm);
  const cos = Math.max(0.2, Math.cos((p.lat * Math.PI) / 180));
  let best: LngLat | null = null;
  let bestD = Infinity;
  for (let r = 1; r <= rings; r++) {
    const radKm = r * stepKm;
    const n = Math.max(12, Math.round((2 * Math.PI * radKm) / stepKm));
    for (let k = 0; k < n; k++) {
      const ang = (2 * Math.PI * k) / n;
      const cand = {
        lon: p.lon + ((radKm * Math.cos(ang)) / (111.32 * cos)),
        lat: p.lat + (radKm * Math.sin(ang)) / 110.54,
      };
      if (!pointInOpenWater(cand, lake)) continue;
      const d = haversineKm(p, cand);
      if (d < bestD) {
        bestD = d;
        best = cand;
      }
    }
    if (best && bestD <= radKm + stepKm * 0.5) return best;
  }
  return best;
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

function buildWaterGrid(lake: LakeMask, focus: BBox, stepKm = GRID_STEP_KM): Grid {
  const west = Math.max(lake.bbox[0] - 0.02, focus[0]);
  const south = Math.max(lake.bbox[1] - 0.02, focus[1]);
  const east = Math.min(lake.bbox[2] + 0.02, focus[2]);
  const north = Math.min(lake.bbox[3] + 0.02, focus[3]);
  const midLat = (south + north) / 2;
  const cos = Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
  const dLon = stepKm / (111.32 * cos);
  const dLat = stepKm / 110.54;
  const cols = Math.max(2, Math.ceil((east - west) / dLon) + 1);
  const rows = Math.max(2, Math.ceil((north - south) / dLat) + 1);
  const raw = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const p = { lon: west + c * dLon, lat: south + r * dLat };
      raw[r * cols + c] = pointInOpenWater(p, lake) ? 1 : 0;
    }
  }
  // Erode by 1 cell: keep clearance from shore / island edges so neighbor
  // chords do not nick land between cell centers.
  const walk = new Uint8Array(cols * rows);
  for (let r = 1; r < rows - 1; r++) {
    for (let c = 1; c < cols - 1; c++) {
      const id = r * cols + c;
      if (!raw[id]) continue;
      let ok = true;
      for (let dr = -1; dr <= 1 && ok; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (!raw[(r + dr) * cols + (c + dc)]) {
            ok = false;
            break;
          }
        }
      }
      if (ok) walk[id] = 1;
    }
  }
  // If erosion wiped a narrow channel, fall back to raw water for connectivity.
  let walkable = 0;
  for (let i = 0; i < walk.length; i++) walkable += walk[i]!;
  if (walkable < 8) {
    for (let i = 0; i < raw.length; i++) walk[i] = raw[i]!;
  }
  return { west, south, cols, rows, dLon, dLat, walk };
}

function cellPoint(id: number, g: Grid): LngLat {
  const c = id % g.cols;
  const r = Math.floor(id / g.cols);
  return { lon: g.west + c * g.dLon, lat: g.south + r * g.dLat };
}

function nearestWalkableCell(p: LngLat, g: Grid, maxR = 20): number {
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
        const d = haversineKm(p, cellPoint(id, g));
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

/** 8-connected A* with water-safe edge checks between cell centers. */
function astarOpenWater(a: LngLat, b: LngLat, lake: LakeMask): LngLat[] | null {
  const pad = 0.15;
  const fullFocus: BBox = [
    lake.bbox[0] - pad,
    lake.bbox[1] - pad,
    lake.bbox[2] + pad,
    lake.bbox[3] + pad,
  ];
  const chordFocus: BBox = [
    Math.min(a.lon, b.lon) - 0.55,
    Math.min(a.lat, b.lat) - 0.55,
    Math.max(a.lon, b.lon) + 0.55,
    Math.max(a.lat, b.lat) + 0.55,
  ];

  const tryGrid = (box: BBox): LngLat[] | null => {
    const g = buildWaterGrid(lake, box, GRID_STEP_KM);
    const start = nearestWalkableCell(a, g);
    const goal = nearestWalkableCell(b, g);
    if (start < 0 || goal < 0) return null;
    if (start === goal) {
      return openWaterLineClear(a, b, lake) ? [a, b] : null;
    }

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

    const edgeOk = new Map<string, boolean>();
    const canTraverse = (from: number, to: number): boolean => {
      const key = from < to ? `${from}:${to}` : `${to}:${from}`;
      const cached = edgeOk.get(key);
      if (cached != null) return cached;
      const ok = openWaterLineClear(cellPoint(from, g), cellPoint(to, g), lake);
      edgeOk.set(key, ok);
      return ok;
    };

    while (open.length) {
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
        if (dc !== 0 && dr !== 0) {
          const a1 = rr * g.cols + nc;
          const a2 = nr * g.cols + cc;
          if (!g.walk[a1] || !g.walk[a2]) continue;
        }
        // Even orthogonal eroded cells can clip thin headlands — verify.
        if (!canTraverse(cur, nid)) continue;
        const np = cellPoint(nid, g);
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

  return tryGrid(chordFocus) ?? tryGrid(fullFocus);
}

/** Collapse bends only along water-clear chords. */
function smoothOpenWaterPath(points: LngLat[], lake: LakeMask): LngLat[] {
  if (points.length <= 2) return points;
  const out: LngLat[] = [points[0]!];
  let i = 0;
  while (i < points.length - 1) {
    let j = points.length - 1;
    while (j > i + 1) {
      if (openWaterLineClear(points[i]!, points[j]!, lake)) break;
      j -= 1;
    }
    out.push(points[j]!);
    i = j;
  }
  return out;
}

function pathWaterSafe(points: LngLat[], lake: LakeMask): boolean {
  for (let i = 1; i < points.length; i++) {
    if (!openWaterLineClear(points[i - 1]!, points[i]!, lake)) return false;
  }
  return true;
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

  let best: (typeof polys)[number] | null = null;
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
  const pushHole = (ring: Array<[number, number]>) => {
    if (ring.length < 4) return;
    const bbox = ringBBox(ring);
    const diag =
      haversineKm({ lon: bbox[0], lat: bbox[1] }, { lon: bbox[2], lat: bbox[3] }) * 1000;
    // Keep small islets — they still block straight chords.
    if (diag < 80) return;
    holes.push({ ring, bbox });
  };

  for (let h = 1; h < best.length; h++) {
    const ring = best[h];
    if (!ring) continue;
    pushHole(ring.map(([lon, lat]) => [lon, lat] as [number, number]));
  }

  for (const poly of polys) {
    if (poly === best) continue;
    const ring = poly[0];
    if (!ring) continue;
    pushHole(ring.map(([lon, lat]) => [lon, lat] as [number, number]));
  }

  return {
    name,
    osmId,
    outer,
    outerBBox: ringBBox(outer),
    holes,
    bbox: ringBBox(outer),
  };
}

async function fetchLakeMask(name: string, osmId: number): Promise<LakeMask | null> {
  if (lakeCache.has(osmId)) return lakeCache.get(osmId)!;
  const pending = lakeInflight.get(osmId);
  if (pending) return pending;

  const job = (async (): Promise<LakeMask | null> => {
    // Low threshold: simplified shores must not cut across peninsulas / islands.
    const url =
      `https://nominatim.openstreetmap.org/lookup?osm_ids=R${osmId}` +
      `&format=geojson&polygon_geojson=1&polygon_threshold=0.001`;
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

function openWaterBodiesByArea(): SharedOpenLake[] {
  const out: SharedOpenLake[] = [];
  for (const body of CATALOG) {
    if (body.k !== 'l') continue;
    const osmId = OPEN_WATER_OSM[catalogKey(body.n)];
    if (!osmId) continue;
    out.push({ name: body.n, osmId, catalog: body });
  }
  out.sort((a, b) => catalogArea(b.catalog) - catalogArea(a.catalog));
  return out;
}

function catalogArea(body: CatalogBody): number {
  const [w, s, e, n] = body.b;
  return Math.max(0, e - w) * Math.max(0, n - s);
}

/** Same lake/reservoir (catalog + OSM mask) for pure open-water legs. */
export function findSharedOpenLake(points: LngLat[]): SharedOpenLake | null {
  if (points.length < 2) return null;
  for (const body of openWaterBodiesByArea()) {
    if (!points.every((p) => inBBox(p, body.catalog.b, 0.05))) continue;
    return body;
  }
  return null;
}

function routeLegOnLake(a: LngLat, b: LngLat, lake: LakeMask): LngLat[] | null {
  if (openWaterLineClear(a, b, lake)) return [a, b];
  const routed = astarOpenWater(a, b, lake);
  if (!routed || routed.length < 2) return null;
  // Attach true endpoints if they are on water and reachable by a short clear chord.
  const path: LngLat[] = [];
  if (openWaterLineClear(a, routed[0]!, lake)) path.push(a);
  else path.push(routed[0]!);
  for (let i = 1; i < routed.length - 1; i++) path.push(routed[i]!);
  const last = routed[routed.length - 1]!;
  if (openWaterLineClear(last, b, lake)) {
    if (haversineKm(path[path.length - 1]!, last) > 0.05) path.push(last);
    path.push(b);
  } else {
    path.push(last);
  }
  const smooth = smoothOpenWaterPath(path, lake);
  if (pathWaterSafe(smooth, lake)) return smooth;
  if (pathWaterSafe(path, lake)) return path;
  return null;
}

/**
 * Replace BRouter shore-hugging spans inside a lake/reservoir with straight
 * open-water chords (around islands / capes only).
 */
function replaceSpansOnMask(points: LngLat[], lake: LakeMask, catalogBBox: BBox): LngLat[] {
  if (points.length < 4) return points;

  // Soft membership: catalog bbox (route corridor) or near/in the water mask.
  const onBody = points.map((p) => {
    if (inBBox(p, catalogBBox, 0.04)) return true;
    if (pointInOpenWater(p, lake)) return true;
    return nearestOpenWater(p, lake, 2.5) != null;
  });

  const onCount = onBody.filter(Boolean).length;
  if (onCount < 4) return points;

  type Span = { lo: number; hi: number };
  const spans: Span[] = [];
  let i = 0;
  while (i < points.length) {
    while (i < points.length && !onBody[i]) i += 1;
    if (i >= points.length) break;
    let lastOn = i;
    let gap = 0;
    let j = i + 1;
    while (j < points.length) {
      if (onBody[j]) {
        lastOn = j;
        gap = 0;
        j += 1;
        continue;
      }
      gap += 1;
      if (gap > 4) break;
      j += 1;
    }
    if (lastOn - i >= 3) spans.push({ lo: i, hi: lastOn });
    i = Math.max(lastOn + 1, i + 1);
  }

  if (!spans.length) return points;

  let out = points.slice();
  for (let s = spans.length - 1; s >= 0; s--) {
    const { lo, hi } = spans[s]!;
    if (hi <= lo) continue;

    // Snap span ends onto open water (entry / exit of the lake).
    let enter = -1;
    let leave = -1;
    let a: LngLat | null = null;
    let b: LngLat | null = null;
    for (let k = lo; k <= hi; k++) {
      const snap = nearestOpenWater(out[k]!, lake, 5);
      if (!snap) continue;
      if (enter < 0) {
        enter = k;
        a = snap;
      }
      leave = k;
      b = snap;
    }
    if (enter < 0 || leave <= enter || !a || !b) continue;

    const detourPts = out.slice(enter, leave + 1);
    const detourKm = pathLengthKm(detourPts);
    const chordKm = haversineKm(a, b);
    if (detourKm < 5 || chordKm < 2.5) continue;
    if (detourKm <= chordKm * 1.08 && detourPts.length <= 5) continue;

    const open = routeLegOnLake(a, b, lake);
    if (!open || open.length < 2) continue;
    const openKm = pathLengthKm(open);
    const improves =
      openKm <= detourKm * 0.97 ||
      (detourKm > chordKm * 1.15 && openKm <= detourKm * 1.02);
    if (!improves) continue;
    if (openKm > chordKm * 2.8) continue;

    out = [...out.slice(0, enter), ...open, ...out.slice(leave + 1)];
  }
  return out;
}

/**
 * After river routing, straighten every lake/reservoir span the track crosses.
 * `cachedOnly` skips Nominatim — use on the critical path so the track paints
 * as soon as BRouter answers; call again without it in background polish.
 */
export async function straightenOpenWaterSpans(
  points: LngLat[],
  opts: { cachedOnly?: boolean } = {},
): Promise<LngLat[]> {
  if (points.length < 4) return points;

  let pathBBox: BBox = [180, 90, -180, -90];
  for (const p of points) {
    if (p.lon < pathBBox[0]) pathBBox[0] = p.lon;
    if (p.lat < pathBBox[1]) pathBBox[1] = p.lat;
    if (p.lon > pathBBox[2]) pathBBox[2] = p.lon;
    if (p.lat > pathBBox[3]) pathBBox[3] = p.lat;
  }

  let result = points;
  for (const body of openWaterBodiesByArea()) {
    const b = body.catalog.b;
    if (
      pathBBox[2] < b[0] - 0.05 ||
      pathBBox[0] > b[2] + 0.05 ||
      pathBBox[3] < b[1] - 0.05 ||
      pathBBox[1] > b[3] + 0.05
    ) {
      continue;
    }
    let hits = 0;
    for (const p of result) {
      if (inBBox(p, b, 0.04)) hits += 1;
      if (hits >= 4) break;
    }
    if (hits < 4) continue;

    let lake: LakeMask | null = null;
    if (opts.cachedOnly) {
      if (!lakeCache.has(body.osmId)) continue;
      lake = lakeCache.get(body.osmId) ?? null;
    } else {
      lake = await fetchLakeMask(body.name, body.osmId);
    }
    if (!lake) continue;
    result = replaceSpansOnMask(result, lake, body.catalog.b);
  }
  return result;
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
    const s = nearestOpenWater(p, lake, 12);
    if (!s) return null;
    snapped.push(s);
  }

  // Route only on water. Do not draw click→snap stubs across shore.
  const path: LngLat[] = [snapped[0]!];
  for (let i = 1; i < snapped.length; i++) {
    const leg = routeLegOnLake(snapped[i - 1]!, snapped[i]!, lake);
    if (!leg || leg.length < 2) return null;
    for (let k = 1; k < leg.length; k++) path.push(leg[k]!);
  }

  if (!pathWaterSafe(path, lake)) return null;

  const lengthKm = pathLengthKm(path);
  if (!(lengthKm > 0)) return null;
  return { points: path, lengthKm, waterName: shared.name };
}
