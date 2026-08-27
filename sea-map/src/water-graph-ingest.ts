/**
 * E2.1 — Open water centerline ingest for Hybrid WaterGraph (shadow).
 *
 * Sources: Overpass OSM waterways, optional GeoJSON/feature fixtures,
 * optional water-core-shaped rows. BRouter is NOT used as truth here
 * (legacy may still inject brouter geometry separately as fallback).
 *
 * Does not change production accept path / thresholds.
 */

import { haversineKm, pathLengthKm, type LngLat } from './geo';
import type { CenterlineSource } from './water-graph-types';

/** Corridor pad for centerline crop (degrees). Independent of user snap. */
export const WG_INGEST_CORRIDOR_PAD_DEG = 0.35;
/** Soft cap: beyond this geodesic span, ingest samples mid-segments (no global graph). */
export const WG_INGEST_MAX_SPAN_KM = 280;
/** Max Overpass bbox cells to fan out (same spirit as legacy ≤24). */
export const WG_INGEST_MAX_CELLS = 24;
export const WG_INGEST_CELL_DEG = 0.2;

export type OsmWaterwayTag =
  | 'river'
  | 'canal'
  | 'fairway'
  | 'ship_canal'
  | 'link'
  | 'tidal_channel'
  | 'stream'
  | string;

export type OsmCenterlineFeature = {
  osmId: number | string;
  waterway: OsmWaterwayTag | null;
  name?: string | null;
  coords: LngLat[];
  /** MultiLineString parts after split, if any. */
  parts?: LngLat[][];
};

export type CenterlineRejection = {
  osmId: string;
  reason:
    | 'too_few_points'
    | 'zero_length'
    | 'outside_corridor'
    | 'disallowed_waterway'
    | 'dam_weir_crest'
    | 'empty_geometry';
};

export type CenterlineIngestStats = {
  osmFeatureCount: number;
  acceptedFeatureCount: number;
  rejectedFeatureCount: number;
  rejectionReasons: Record<string, number>;
  sourceFeatureCount: number;
  sourceWaterwayIds: string[];
  centerlineSource: 'overpass' | 'fixture' | 'water-core' | 'mixed' | 'empty';
  dataTimestampMs: number;
  corridorBbox: [number, number, number, number];
  ingestMs: number;
  /** Segment mode used for long spans. */
  longSpanSegmented: boolean;
  segmentCount: number;
};

export type CenterlineIngestResult = {
  centerlines: CenterlineSource[];
  stats: CenterlineIngestStats;
  failureCode: 'none' | 'centerline_missing' | 'centerline_empty_after_filter';
};

export type OverpassElementLike = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lon: number; lat: number }>;
  members?: Array<{
    type: string;
    role?: string;
    geometry?: Array<{ lon: number; lat: number }>;
  }>;
};

const OVERPASS_ENDPOINTS = [
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const ALLOWED_WATERWAY = new Set([
  'river',
  'canal',
  'fairway',
  'ship_canal',
  'link',
  'tidal_channel',
]);

const BLOCKED_WATERWAY = new Set(['riverbank', 'weir', 'dam', 'waterfall']);

function emptyStats(
  bbox: [number, number, number, number],
): CenterlineIngestStats {
  return {
    osmFeatureCount: 0,
    acceptedFeatureCount: 0,
    rejectedFeatureCount: 0,
    rejectionReasons: {},
    sourceFeatureCount: 0,
    sourceWaterwayIds: [],
    centerlineSource: 'empty',
    dataTimestampMs: Date.now(),
    corridorBbox: bbox,
    ingestMs: 0,
    longSpanSegmented: false,
    segmentCount: 1,
  };
}

export function corridorBbox(
  a: LngLat,
  b: LngLat,
  padDeg = WG_INGEST_CORRIDOR_PAD_DEG,
): [number, number, number, number] {
  return [
    Math.min(a.lon, b.lon) - padDeg,
    Math.min(a.lat, b.lat) - padDeg,
    Math.max(a.lon, b.lon) + padDeg,
    Math.max(a.lat, b.lat) + padDeg,
  ];
}

export function pointInBbox(
  p: LngLat,
  bbox: [number, number, number, number],
): boolean {
  return p.lon >= bbox[0] && p.lat >= bbox[1] && p.lon <= bbox[2] && p.lat <= bbox[3];
}

/** Crop polyline to points inside bbox; keep contiguous runs ≥2 pts. */
export function cropPolylineToBbox(
  coords: LngLat[],
  bbox: [number, number, number, number],
): LngLat[][] {
  const runs: LngLat[][] = [];
  let cur: LngLat[] = [];
  for (const p of coords) {
    if (pointInBbox(p, bbox)) {
      cur.push(p);
    } else if (cur.length >= 2) {
      runs.push(cur);
      cur = [];
    } else {
      cur = [];
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

export function classifyCenterlineKind(
  waterway: string | null | undefined,
  name?: string | null,
): CenterlineSource['kind'] {
  const w = (waterway ?? '').toLowerCase();
  if (w === 'fairway') return 'fairway';
  if (w === 'canal' || w === 'ship_canal') return 'canal';
  const n = (name ?? '').toLowerCase();
  if (n.includes('канал') || n.includes('canal')) return 'canal';
  return 'waterway';
}

function isAllowedWaterway(
  tags: Record<string, string> | undefined,
): { ok: boolean; reason?: CenterlineRejection['reason'] } {
  if (!tags?.waterway) return { ok: false, reason: 'disallowed_waterway' };
  const w = tags.waterway;
  if (BLOCKED_WATERWAY.has(w)) return { ok: false, reason: 'dam_weir_crest' };
  if (ALLOWED_WATERWAY.has(w)) return { ok: true };
  // Named stream only — same as legacy Overpass filter.
  if (w === 'stream' && (tags.name || tags['name:ru'])) return { ok: true };
  if (tags.boat === 'yes' || tags.motorboat === 'yes' || tags.CEMT) return { ok: true };
  return { ok: false, reason: 'disallowed_waterway' };
}

function lineLengthKm(coords: LngLat[]): number {
  return pathLengthKm(coords);
}

/**
 * Parse Overpass elements into OSM centerline features (waterways only).
 * Lake/reservoir areas are skipped — mask layer owns open water.
 */
export function overpassElementsToFeatures(
  elements: OverpassElementLike[],
): { features: OsmCenterlineFeature[]; rejected: CenterlineRejection[] } {
  const features: OsmCenterlineFeature[] = [];
  const rejected: CenterlineRejection[] = [];

  for (const el of elements) {
    const tags = el.tags ?? {};
    // Skip pure water areas — not centerlines.
    if (
      tags.natural === 'water' ||
      tags.landuse === 'reservoir' ||
      tags.landuse === 'basin' ||
      tags.water === 'lake' ||
      tags.water === 'reservoir'
    ) {
      if (!tags.waterway) continue;
    }

    const allow = isAllowedWaterway(tags);
    if (!allow.ok) {
      if (tags.waterway) {
        rejected.push({
          osmId: String(el.id),
          reason: allow.reason ?? 'disallowed_waterway',
        });
      }
      continue;
    }

    const name = tags['name:ru'] ?? tags.name ?? null;
    const waterway = tags.waterway ?? null;

    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      features.push({
        osmId: el.id,
        waterway,
        name,
        coords: el.geometry.map((g) => ({ lon: g.lon, lat: g.lat })),
      });
      continue;
    }

    if (el.type === 'relation' && el.members) {
      const parts: LngLat[][] = [];
      for (const m of el.members) {
        if (!m.geometry || m.geometry.length < 2) continue;
        parts.push(m.geometry.map((g) => ({ lon: g.lon, lat: g.lat })));
      }
      if (parts.length === 0) {
        rejected.push({ osmId: String(el.id), reason: 'empty_geometry' });
        continue;
      }
      features.push({
        osmId: el.id,
        waterway,
        name,
        coords: parts[0]!,
        parts,
      });
    }
  }

  return { features, rejected };
}

/** GeoJSON FeatureCollection → OSM features (LineString / MultiLineString). */
export function geojsonToCenterlineFeatures(fc: {
  type?: string;
  features?: Array<{
    id?: number | string;
    properties?: Record<string, unknown> | null;
    geometry?: {
      type: string;
      coordinates: number[][] | number[][][];
    } | null;
  }>;
}): OsmCenterlineFeature[] {
  const out: OsmCenterlineFeature[] = [];
  for (const f of fc.features ?? []) {
    const props = f.properties ?? {};
    const osmId = (props.osmId as number | string | undefined) ?? f.id ?? out.length;
    const waterway = (props.waterway as string | undefined) ?? null;
    const name = (props.name as string | null | undefined) ?? null;
    const g = f.geometry;
    if (!g) continue;
    if (g.type === 'LineString') {
      const coords = (g.coordinates as number[][]).map(([lon, lat]) => ({
        lon: lon!,
        lat: lat!,
      }));
      out.push({ osmId, waterway, name, coords });
    } else if (g.type === 'MultiLineString') {
      const parts = (g.coordinates as number[][][]).map((line) =>
        line.map(([lon, lat]) => ({ lon: lon!, lat: lat! })),
      );
      out.push({
        osmId,
        waterway,
        name,
        coords: parts[0] ?? [],
        parts,
      });
    }
  }
  return out;
}

/**
 * Convert OSM features → CenterlineSource[] with corridor crop + filters.
 * Does NOT connect nearby features across different waterIds.
 */
export function featuresToCenterlineSources(
  features: OsmCenterlineFeature[],
  bbox: [number, number, number, number],
  opts?: {
    sourceLabel?: string;
    includeStreamWithoutName?: boolean;
  },
): {
  centerlines: CenterlineSource[];
  accepted: number;
  rejected: CenterlineRejection[];
  rejectionReasons: Record<string, number>;
} {
  const centerlines: CenterlineSource[] = [];
  const rejected: CenterlineRejection[] = [];
  const rejectionReasons: Record<string, number> = {};
  const bump = (r: string) => {
    rejectionReasons[r] = (rejectionReasons[r] ?? 0) + 1;
  };

  const seenGeom = new Set<string>();

  for (const feat of features) {
    const idStr = String(feat.osmId);
    const w = feat.waterway;

    if (w && BLOCKED_WATERWAY.has(w)) {
      rejected.push({ osmId: idStr, reason: 'dam_weir_crest' });
      bump('dam_weir_crest');
      continue;
    }
    if (w === 'stream' && !feat.name && !opts?.includeStreamWithoutName) {
      rejected.push({ osmId: idStr, reason: 'disallowed_waterway' });
      bump('disallowed_waterway');
      continue;
    }
    if (
      w &&
      !ALLOWED_WATERWAY.has(w) &&
      w !== 'stream' &&
      w !== 'fairway'
    ) {
      // Unknown waterway tags: allow only if already named navigable-ish
      if (!feat.name) {
        rejected.push({ osmId: idStr, reason: 'disallowed_waterway' });
        bump('disallowed_waterway');
        continue;
      }
    }

    const rawParts =
      feat.parts && feat.parts.length > 0 ? feat.parts : [feat.coords];
    let anyAccepted = false;

    for (let pi = 0; pi < rawParts.length; pi++) {
      const part = rawParts[pi]!;
      if (part.length < 2) {
        rejected.push({ osmId: idStr, reason: 'too_few_points' });
        bump('too_few_points');
        continue;
      }
      if (lineLengthKm(part) < 1e-5) {
        rejected.push({ osmId: idStr, reason: 'zero_length' });
        bump('zero_length');
        continue;
      }

      const cropped = cropPolylineToBbox(part, bbox);
      if (cropped.length === 0) {
        rejected.push({ osmId: idStr, reason: 'outside_corridor' });
        bump('outside_corridor');
        continue;
      }

      for (let ci = 0; ci < cropped.length; ci++) {
        const coords = cropped[ci]!;
        // Dedup identical geometry fingerprints (overlap between ways).
        const fp = `${idStr}:${coords[0]!.lon.toFixed(5)},${coords[0]!.lat.toFixed(5)}:${coords[coords.length - 1]!.lon.toFixed(5)},${coords[coords.length - 1]!.lat.toFixed(5)}:${coords.length}`;
        if (seenGeom.has(fp)) continue;
        seenGeom.add(fp);

        const kind = classifyCenterlineKind(feat.waterway, feat.name);
        const waterId =
          feat.name && feat.name.trim().length > 0
            ? `ww:${feat.name.trim().toLowerCase()}`
            : `osm:${idStr}`;

        centerlines.push({
          id: `osm:${idStr}${rawParts.length > 1 || cropped.length > 1 ? `:${pi}:${ci}` : ''}`,
          kind,
          coords,
          name: feat.name ?? null,
          source: opts?.sourceLabel ?? 'overpass',
          sourceId: idStr,
          waterId,
        });
        anyAccepted = true;
      }
    }

    if (!anyAccepted && !rejected.some((r) => r.osmId === idStr)) {
      rejected.push({ osmId: idStr, reason: 'outside_corridor' });
      bump('outside_corridor');
    }
  }

  return {
    centerlines,
    accepted: centerlines.length,
    rejected,
    rejectionReasons,
  };
}

function densifyChord(a: LngLat, b: LngLat, stepKm: number): LngLat[] {
  const d = haversineKm(a, b);
  if (d <= stepKm) return [a, b];
  const n = Math.ceil(d / stepKm);
  const out: LngLat[] = [a];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    out.push({
      lon: a.lon + (b.lon - a.lon) * t,
      lat: a.lat + (b.lat - a.lat) * t,
    });
  }
  out.push(b);
  return out;
}

/** Split long A→B into mid-corridor segments for ingest (no global graph). */
export function segmentCorridorForIngest(
  a: LngLat,
  b: LngLat,
  maxSpanKm = WG_INGEST_MAX_SPAN_KM,
): Array<{ a: LngLat; b: LngLat }> {
  const span = haversineKm(a, b);
  if (span <= maxSpanKm) return [{ a, b }];
  const samples = densifyChord(a, b, maxSpanKm * 0.85);
  const segs: Array<{ a: LngLat; b: LngLat }> = [];
  for (let i = 0; i < samples.length - 1; i++) {
    segs.push({ a: samples[i]!, b: samples[i + 1]! });
  }
  return segs;
}

function bboxQuery(south: number, west: number, north: number, east: number): string {
  return `
[out:json][timeout:14];
(
  way["waterway"~"^(river|canal|fairway|ship_canal|link|tidal_channel)$"](${south},${west},${north},${east});
  way["waterway"="stream"]["name"](${south},${west},${north},${east});
);
out geom;
`;
}

async function fetchOneOverpass(
  endpoint: string,
  body: string,
  ms: number,
): Promise<OverpassElementLike[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': 'AquaRoute/1.5 (water-graph-ingest; https://advharvest-arch.github.io)',
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const data = JSON.parse(text) as { elements?: OverpassElementLike[] };
    return data.elements ?? [];
  } finally {
    clearTimeout(timer);
  }
}

async function overpassQuery(query: string): Promise<OverpassElementLike[]> {
  const body = `data=${encodeURIComponent(query)}`;
  return await new Promise<OverpassElementLike[]>((resolve) => {
    let pending = OVERPASS_ENDPOINTS.length;
    let empty: OverpassElementLike[] | null = null;
    let done = false;

    for (const endpoint of OVERPASS_ENDPOINTS) {
      fetchOneOverpass(endpoint, body, 16000)
        .then((els) => {
          if (done) return;
          if (els.length > 0) {
            done = true;
            resolve(els);
            return;
          }
          empty = els;
          pending -= 1;
          if (pending === 0) resolve(empty ?? []);
        })
        .catch(() => {
          if (done) return;
          pending -= 1;
          if (pending === 0) resolve(empty ?? []);
        });
    }
  });
}

/**
 * Fetch OSM waterway centerlines for a corridor bbox (capped cell fan-out).
 */
export async function fetchOverpassCenterlinesForBbox(
  bbox: [number, number, number, number],
  maxCells = WG_INGEST_MAX_CELLS,
): Promise<OverpassElementLike[]> {
  const [west, south, east, north] = bbox;
  const spanLon = east - west;
  const spanLat = north - south;
  // Small corridor: single bbox query.
  if (spanLon <= WG_INGEST_CELL_DEG * 2.5 && spanLat <= WG_INGEST_CELL_DEG * 2.5) {
    return overpassQuery(bboxQuery(south, west, north, east));
  }

  const cx0 = Math.floor(west / WG_INGEST_CELL_DEG);
  const cx1 = Math.floor(east / WG_INGEST_CELL_DEG);
  const cy0 = Math.floor(south / WG_INGEST_CELL_DEG);
  const cy1 = Math.floor(north / WG_INGEST_CELL_DEG);
  const cells: Array<{ cx: number; cy: number }> = [];
  for (let cx = cx0; cx <= cx1; cx++) {
    for (let cy = cy0; cy <= cy1; cy++) {
      cells.push({ cx, cy });
    }
  }
  const toLoad = cells.slice(0, maxCells);
  const all: OverpassElementLike[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < toLoad.length; i += 6) {
    const batch = toLoad.slice(i, i + 6);
    const parts = await Promise.all(
      batch.map(({ cx, cy }) => {
        const pad = 0.015;
        const w = cx * WG_INGEST_CELL_DEG - pad;
        const s = cy * WG_INGEST_CELL_DEG - pad;
        const e = (cx + 1) * WG_INGEST_CELL_DEG + pad;
        const n = (cy + 1) * WG_INGEST_CELL_DEG + pad;
        return overpassQuery(bboxQuery(s, w, n, e));
      }),
    );
    for (const els of parts) {
      for (const el of els) {
        if (seen.has(el.id)) continue;
        seen.add(el.id);
        all.push(el);
      }
    }
  }
  return all;
}

export type IngestCorridorOptions = {
  padDeg?: number;
  maxSpanKm?: number;
  maxCells?: number;
  /** Prefer fixture/features over live Overpass (tests). */
  features?: OsmCenterlineFeature[];
  geojson?: Parameters<typeof geojsonToCenterlineFeatures>[0];
  sourceLabel?: string;
  /** Skip live Overpass even if no features (offline). */
  skipOverpass?: boolean;
  /** When span is segmented, fetch every segment (default: mid only). */
  fetchAllSegments?: boolean;
};

/**
 * Universal corridor centerline ingest → CenterlineSource[] + provenance stats.
 */
export async function ingestCorridorCenterlines(
  a: LngLat,
  b: LngLat,
  options: IngestCorridorOptions = {},
): Promise<CenterlineIngestResult> {
  const t0 = performance.now();
  const pad = options.padDeg ?? WG_INGEST_CORRIDOR_PAD_DEG;
  const segsAll = segmentCorridorForIngest(
    a,
    b,
    options.maxSpanKm ?? WG_INGEST_MAX_SPAN_KM,
  );
  // Long-span: ingest mid segment by default (stitching later in E2.x).
  // Avoid building a multi-hundred-km graph in one shadow pass.
  const segs =
    segsAll.length > 1 && options.fetchAllSegments !== true
      ? [segsAll[Math.floor(segsAll.length / 2)]!]
      : segsAll;
  const fullBbox = corridorBbox(a, b, pad);
  const stats = emptyStats(fullBbox);
  stats.longSpanSegmented = segsAll.length > 1;
  stats.segmentCount = segs.length;

  const allFeatures: OsmCenterlineFeature[] = [];
  let sourceKind: CenterlineIngestStats['centerlineSource'] = 'empty';
  const rejectedAccum: CenterlineRejection[] = [];

  if (options.geojson) {
    allFeatures.push(...geojsonToCenterlineFeatures(options.geojson));
    sourceKind = 'fixture';
  }
  if (options.features?.length) {
    allFeatures.push(...options.features);
    sourceKind = sourceKind === 'empty' ? 'fixture' : 'mixed';
  }

  if (allFeatures.length === 0 && !options.skipOverpass) {
    const seen = new Set<number | string>();
    for (const seg of segs) {
      const bb = corridorBbox(seg.a, seg.b, pad);
      try {
        const els = await fetchOverpassCenterlinesForBbox(
          bb,
          options.maxCells ?? WG_INGEST_MAX_CELLS,
        );
        const { features, rejected } = overpassElementsToFeatures(els);
        rejectedAccum.push(...rejected);
        for (const f of features) {
          if (seen.has(f.osmId)) continue;
          seen.add(f.osmId);
          allFeatures.push(f);
        }
      } catch {
        // Overpass unavailable — leave features empty for this segment.
      }
    }
    if (allFeatures.length > 0) sourceKind = 'overpass';
  }

  stats.osmFeatureCount = allFeatures.length + rejectedAccum.length;
  const converted = featuresToCenterlineSources(allFeatures, fullBbox, {
    sourceLabel: options.sourceLabel ?? (sourceKind === 'fixture' ? 'fixture' : 'overpass'),
  });

  // Merge rejection reasons from parse + convert.
  for (const r of rejectedAccum) {
    converted.rejectionReasons[r.reason] =
      (converted.rejectionReasons[r.reason] ?? 0) + 1;
  }

  stats.acceptedFeatureCount = converted.accepted;
  stats.rejectedFeatureCount =
    Object.values(converted.rejectionReasons).reduce((s, n) => s + n, 0);
  stats.rejectionReasons = converted.rejectionReasons;
  stats.sourceFeatureCount = converted.centerlines.length;
  stats.sourceWaterwayIds = [
    ...new Set(
      converted.centerlines
        .map((c) => c.sourceId)
        .filter((x): x is string => !!x),
    ),
  ].slice(0, 64);
  stats.centerlineSource = converted.centerlines.length
    ? sourceKind === 'empty'
      ? 'overpass'
      : sourceKind
    : 'empty';
  stats.ingestMs = performance.now() - t0;
  stats.dataTimestampMs = Date.now();

  let failureCode: CenterlineIngestResult['failureCode'] = 'none';
  if (allFeatures.length === 0 && converted.centerlines.length === 0) {
    failureCode = 'centerline_missing';
  } else if (converted.centerlines.length === 0) {
    failureCode = 'centerline_empty_after_filter';
  }

  return {
    centerlines: converted.centerlines,
    stats,
    failureCode,
  };
}

/**
 * Sync helper for tests/fixtures (no Overpass).
 */
export function ingestCenterlineFeaturesSync(
  a: LngLat,
  b: LngLat,
  features: OsmCenterlineFeature[],
  opts?: { padDeg?: number; sourceLabel?: string },
): CenterlineIngestResult {
  const t0 = performance.now();
  const bbox = corridorBbox(a, b, opts?.padDeg ?? WG_INGEST_CORRIDOR_PAD_DEG);
  const stats = emptyStats(bbox);
  stats.osmFeatureCount = features.length;
  const converted = featuresToCenterlineSources(features, bbox, {
    sourceLabel: opts?.sourceLabel ?? 'fixture',
  });
  stats.acceptedFeatureCount = converted.accepted;
  stats.rejectedFeatureCount = converted.rejected.length;
  stats.rejectionReasons = converted.rejectionReasons;
  stats.sourceFeatureCount = converted.centerlines.length;
  stats.sourceWaterwayIds = [
    ...new Set(
      converted.centerlines
        .map((c) => c.sourceId)
        .filter((x): x is string => !!x),
    ),
  ].slice(0, 64);
  stats.centerlineSource = converted.centerlines.length ? 'fixture' : 'empty';
  stats.ingestMs = performance.now() - t0;

  let failureCode: CenterlineIngestResult['failureCode'] = 'none';
  if (features.length === 0) failureCode = 'centerline_missing';
  else if (converted.centerlines.length === 0) failureCode = 'centerline_empty_after_filter';

  return { centerlines: converted.centerlines, stats, failureCode };
}
