/**
 * E2.2.2 — Overpass fallback preflight diagnostics (observability only).
 *
 * Inspects signals known BEFORE fetchWaterNetwork runs.
 * Does NOT change routing, timeouts, or Overpass execution.
 */

import { closestOnSegment, haversineKm, type LngLat } from './geo';

export type OverpassPreflightScope =
  | 'none'
  | 'not_reached'
  | 'skipped_span_gt_120'
  | 'cache_route_attempt'
  | 'around_query'
  | 'cell_batch';

export type OverpassPreflight = {
  /** True only when fetchWaterNetwork (network Overpass) is about to run / ran. */
  triggered: boolean;
  /** Why triggered or why skipped / not reached. */
  reason: string;
  /** Code-path condition that gates Overpass fallback. */
  triggerCondition: string;
  endpointDistanceKm: number;
  nearestKnownWaterDistanceKm: number | null;
  nearestKnownWaterKind: 'waterway' | 'lake' | null;
  nearestKnownWaterName: string | null;
  localWaterwayPresent: boolean;
  localLakePresent: boolean;
  sharedLakePresent: boolean;
  sharedLakeName: string | null;
  phaseCRejectReason: string | null;
  phaseCCandidateCountA: number;
  phaseCCandidateCountB: number;
  brouterHadGeometry: boolean | null;
  cachedCorridorLineCount: number;
  cachedCorridorWaterwayCount: number;
  cachedCorridorLakeCount: number;
  estimatedCellCount: number;
  estimatedMissingCellCount: number;
  estimatedFallbackScope: OverpassPreflightScope;
  existingCoverageSignals: string[];
};

export type WaterLineLike = {
  id: string;
  name: string | null;
  kind: 'waterway' | 'lake';
  coords: LngLat[];
};

export type PreflightCellProbe = {
  cells: Array<{ cx: number; cy: number }>;
  linesInCorridor: WaterLineLike[];
  missingCellCount: number;
};

const CELL_DEG = 0.2;
/** Same cap as fetchWaterNetwork Overpass fan-out. */
export const OVERPASS_PREFLIGHT_MAX_CELLS = 24;

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function pointCell(p: LngLat): { cx: number; cy: number } {
  return { cx: Math.floor(p.lon / CELL_DEG), cy: Math.floor(p.lat / CELL_DEG) };
}

/** Densify for cell enumeration (mirrors waterways densifyPoints stepKm=10). */
function densifyForCells(points: LngLat[], stepKm: number): LngLat[] {
  if (points.length < 2) return points.slice();
  const out: LngLat[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = haversineKm(a, b);
    if (d <= stepKm) {
      out.push(b);
      continue;
    }
    const n = Math.ceil(d / stepKm);
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      out.push({
        lon: a.lon + (b.lon - a.lon) * t,
        lat: a.lat + (b.lat - a.lat) * t,
      });
    }
  }
  return out;
}

export function estimateCellsAlong(
  points: LngLat[],
): Array<{ cx: number; cy: number }> {
  const seen = new Set<string>();
  const out: Array<{ cx: number; cy: number }> = [];
  for (const p of densifyForCells(points, 10)) {
    const { cx, cy } = pointCell(p);
    const k = cellKey(cx, cy);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ cx, cy });
  }
  return out;
}

/**
 * Cache-only nearest water (no Overpass prefetch side effects).
 * Reads provided cell map only.
 */
export function nearestWaterFromCellMap(
  click: LngLat,
  getLines: (cx: number, cy: number) => WaterLineLike[] | undefined,
  maxKm = 12,
): {
  distKm: number;
  kind: 'waterway' | 'lake';
  name: string | null;
} | null {
  const { cx, cy } = pointCell(click);
  let best: { distKm: number; kind: 'waterway' | 'lake'; name: string | null } | null =
    null;
  const seen = new Set<string>();
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (const line of getLines(cx + dx, cy + dy) ?? []) {
        if (seen.has(line.id) || line.coords.length < 2) continue;
        seen.add(line.id);
        const stride = Math.max(1, Math.floor(line.coords.length / 80));
        for (let j = stride; j < line.coords.length; j += stride) {
          const c = closestOnSegment(click, line.coords[j - stride]!, line.coords[j]!);
          if (c.distKm > maxKm) continue;
          if (!best || c.distKm < best.distKm) {
            best = {
              distKm: c.distKm,
              kind: line.kind,
              name: line.name,
            };
          }
        }
      }
    }
  }
  return best;
}

export function probeCorridorCache(input: {
  points: LngLat[];
  getLines: (cx: number, cy: number) => WaterLineLike[] | undefined;
  isCellMissing: (cx: number, cy: number) => boolean;
}): PreflightCellProbe {
  const cells = estimateCellsAlong(input.points);
  const linesInCorridor: WaterLineLike[] = [];
  const seen = new Set<string>();
  let missingCellCount = 0;
  for (const c of cells) {
    if (input.isCellMissing(c.cx, c.cy)) missingCellCount += 1;
    for (const line of input.getLines(c.cx, c.cy) ?? []) {
      if (seen.has(line.id)) continue;
      seen.add(line.id);
      linesInCorridor.push(line);
    }
  }
  return { cells, linesInCorridor, missingCellCount };
}

export function buildOverpassPreflight(input: {
  a: LngLat;
  b: LngLat;
  triggered: boolean;
  reason: string;
  triggerCondition: string;
  estimatedFallbackScope: OverpassPreflightScope;
  sharedLakeName?: string | null;
  phaseCRejectReason?: string | null;
  phaseCCandidateCountA?: number;
  phaseCCandidateCountB?: number;
  brouterHadGeometry?: boolean | null;
  getLines: (cx: number, cy: number) => WaterLineLike[] | undefined;
  isCellMissing: (cx: number, cy: number) => boolean;
}): OverpassPreflight {
  const points = [input.a, input.b];
  const endpointDistanceKm = haversineKm(input.a, input.b);
  const probe = probeCorridorCache({
    points,
    getLines: input.getLines,
    isCellMissing: input.isCellMissing,
  });
  const nearA = nearestWaterFromCellMap(input.a, input.getLines);
  const nearB = nearestWaterFromCellMap(input.b, input.getLines);
  let nearest = nearA;
  if (nearB && (!nearest || nearB.distKm < nearest.distKm)) nearest = nearB;

  const waterwayCount = probe.linesInCorridor.filter((l) => l.kind === 'waterway').length;
  const lakeCount = probe.linesInCorridor.filter((l) => l.kind === 'lake').length;
  const estimatedCellCount = Math.min(OVERPASS_PREFLIGHT_MAX_CELLS, probe.cells.length);
  const estimatedMissingCellCount = Math.min(
    OVERPASS_PREFLIGHT_MAX_CELLS,
    probe.missingCellCount,
  );

  const signals: string[] = [];
  if (input.sharedLakeName) signals.push(`shared_lake:${input.sharedLakeName}`);
  else signals.push('no_shared_lake');
  if (waterwayCount > 0) signals.push(`cached_waterway_lines:${waterwayCount}`);
  else signals.push('cached_waterway_absent');
  if (lakeCount > 0) signals.push(`cached_lake_lines:${lakeCount}`);
  else signals.push('cached_lake_absent');
  if (nearest) signals.push(`nearest_cache_water_${nearest.kind}_km:${nearest.distKm.toFixed(2)}`);
  else signals.push('nearest_cache_water_absent');
  if ((input.phaseCCandidateCountA ?? 0) + (input.phaseCCandidateCountB ?? 0) === 0) {
    signals.push('phase_c_candidates_empty');
  }
  if (input.phaseCRejectReason) signals.push(`phase_c:${input.phaseCRejectReason}`);
  if (input.brouterHadGeometry === true) signals.push('brouter_had_geometry');
  if (input.brouterHadGeometry === false) signals.push('brouter_no_geometry');
  if (endpointDistanceKm > 120) signals.push('span_gt_120');
  else if (endpointDistanceKm > 100) signals.push('span_100_120');
  else if (endpointDistanceKm <= 100) signals.push('span_le_100');
  if (estimatedMissingCellCount >= estimatedCellCount && estimatedCellCount > 0) {
    signals.push('all_corridor_cells_missing_or_empty');
  }
  if (probe.linesInCorridor.length === 0) signals.push('corridor_cache_empty');

  return {
    triggered: input.triggered,
    reason: input.reason,
    triggerCondition: input.triggerCondition,
    endpointDistanceKm: Math.round(endpointDistanceKm * 1000) / 1000,
    nearestKnownWaterDistanceKm: nearest ? Math.round(nearest.distKm * 1000) / 1000 : null,
    nearestKnownWaterKind: nearest?.kind ?? null,
    nearestKnownWaterName: nearest?.name ?? null,
    localWaterwayPresent: waterwayCount > 0,
    localLakePresent: lakeCount > 0,
    sharedLakePresent: Boolean(input.sharedLakeName),
    sharedLakeName: input.sharedLakeName ?? null,
    phaseCRejectReason: input.phaseCRejectReason ?? null,
    phaseCCandidateCountA: input.phaseCCandidateCountA ?? 0,
    phaseCCandidateCountB: input.phaseCCandidateCountB ?? 0,
    brouterHadGeometry: input.brouterHadGeometry ?? null,
    cachedCorridorLineCount: probe.linesInCorridor.length,
    cachedCorridorWaterwayCount: waterwayCount,
    cachedCorridorLakeCount: lakeCount,
    estimatedCellCount,
    estimatedMissingCellCount,
    estimatedFallbackScope: input.estimatedFallbackScope,
    existingCoverageSignals: signals,
  };
}
