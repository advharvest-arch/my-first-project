/**
 * WaterGraph Demo state machine (no Leaflet, no production router).
 * Map click → request → GeoJSON. Errors never yield a drawable line.
 */

import type {
  WrgDemoChainResult,
  WrgDemoPhase,
  WrgDemoPoint,
  WrgDemoRouteResult,
  WrgDemoSegment,
  WrgDemoState,
} from './wrg-demo-types';

const INITIAL: WrgDemoState = {
  enabled: false,
  phase: 'off',
  viaMode: false,
  a: null,
  vias: [],
  b: null,
  result: null,
  segments: [],
  error: null,
};

export function createInitialWrgDemoState(): WrgDemoState {
  return { ...INITIAL };
}

export function isWrgDemoLineString(
  geom: WrgDemoRouteResult['geometry'],
): geom is { type: 'LineString'; coordinates: number[][] } {
  return (
    !!geom &&
    geom.type === 'LineString' &&
    'coordinates' in geom &&
    Array.isArray(geom.coordinates) &&
    geom.coordinates.length >= 2
  );
}

/** Leaflet [lat, lon] from WaterGraph GeoJSON. Null if the line must not be drawn. */
export function geoJsonLineToLatLngs(
  geom: WrgDemoRouteResult['geometry'],
): Array<[number, number]> | null {
  if (!isWrgDemoLineString(geom)) return null;
  const out: Array<[number, number]> = [];
  for (const pair of geom.coordinates) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const lon = Number(pair[0]);
    const lat = Number(pair[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    out.push([lat, lon]);
  }
  return out.length >= 2 ? out : null;
}

/**
 * Draw only a proven ROUTE_FOUND LineString.
 * NO_WATER_CONNECTION / ENDPOINT_NOT_ON_WATER never render a route,
 * even if a geometry blob is present.
 */
export function shouldDrawWrgRoute(result: WrgDemoRouteResult | null): boolean {
  if (!result || result.status !== 'ROUTE_FOUND') return false;
  return geoJsonLineToLatLngs(result.geometry) !== null;
}

export function wrgDemoMapView(state: WrgDemoState): {
  a: WrgDemoPoint | null;
  b: WrgDemoPoint | null;
  vias: WrgDemoPoint[];
  routeLatLngs: Array<[number, number]> | null;
  routeSegments: Array<Array<[number, number]>>;
} {
  const routeSegments: Array<Array<[number, number]>> = [];
  for (const seg of state.segments) {
    if (!shouldDrawWrgRoute(seg.result)) continue;
    const line = geoJsonLineToLatLngs(seg.result.geometry);
    if (line) routeSegments.push(line);
  }
  const fromOverall = shouldDrawWrgRoute(state.result)
    ? geoJsonLineToLatLngs(state.result?.geometry ?? null)
    : null;
  const allLegsOk =
    state.segments.length > 0 && state.segments.every((s) => shouldDrawWrgRoute(s.result));
  return {
    a: state.a,
    b: state.b,
    vias: [...state.vias],
    routeLatLngs: allLegsOk ? stitchRouteLatLngs(routeSegments) : fromOverall,
    routeSegments: routeSegments.length > 0 ? routeSegments : fromOverall ? [fromOverall] : [],
  };
}

/** Join successful leg lines. Never used across a missing/failed leg. */
export function stitchRouteLatLngs(
  lines: Array<Array<[number, number]>>,
): Array<[number, number]> | null {
  if (lines.length === 0) return null;
  const out: Array<[number, number]> = [];
  for (const line of lines) {
    if (line.length < 2) return null;
    if (out.length === 0) {
      out.push(...line);
      continue;
    }
    const prev = out[out.length - 1]!;
    const next = line[0]!;
    const same = prev[0] === next[0] && prev[1] === next[1];
    out.push(...(same ? line.slice(1) : line));
  }
  return out.length >= 2 ? out : null;
}

export function isWrgDemoHttpErrorStatus(status: string | undefined): boolean {
  return status === 'RUNTIME_UNAVAILABLE' || status === 'BAD_REQUEST';
}

function fmtPt(p: WrgDemoPoint | null): string {
  if (!p) return '—';
  return `${p.lon.toFixed(6)}, ${p.lat.toFixed(6)}`;
}

/** `?wrgDemo=1` opens Free Route immediately (no case-button required). */
export function shouldAutoEnableWrgFreeRoute(search: string): boolean {
  const q = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(q);
  return params.get('wrgDemo') === '1' || params.get('wrg-demo') === '1';
}

function formatDistanceM(distanceM: number | null | undefined): string {
  if (distanceM == null) return '—';
  return `${Math.round(distanceM).toLocaleString('ru-RU')} м`;
}

function pendingStatus(phase: WrgDemoPhase): string {
  if (phase === 'pick-a') return 'кликните A';
  if (phase === 'pick-b') return 'кликните B';
  if (phase === 'pick-via') return 'кликните C или Finish';
  if (phase === 'pick-finish') return 'кликните Finish';
  if (phase === 'routing') return 'считаем маршрут';
  return 'ожидание';
}

function formatSegmentLine(i: number, seg: WrgDemoSegment): string {
  const dist =
    seg.result.status === 'ROUTE_FOUND' ? formatDistanceM(seg.result.distance_m) : '—';
  return `seg ${i + 1}: ${seg.result.status}  ${dist}`;
}

/** Free Route panel: A/B (and vias), status, distance. */
export function formatWrgDemoPanel(state: WrgDemoState): string {
  const lines = [`A: ${fmtPt(state.a)}`];
  state.vias.forEach((via, i) => {
    lines.push(`C${i + 1}: ${fmtPt(via)}`);
  });
  lines.push(`B: ${fmtPt(state.b)}`);
  const r = state.result;
  if (state.error || isWrgDemoHttpErrorStatus(r?.status)) {
    const detail = state.error || String(r?.detail ?? r?.status ?? 'backend error');
    lines.push(`http_error: ${r?.status ?? 'RUNTIME_UNAVAILABLE'}`, `distance: —`, detail);
    for (let i = 0; i < state.segments.length; i++) {
      lines.push(formatSegmentLine(i, state.segments[i]!));
    }
    return lines.join('\n');
  }
  if (!r) {
    lines.push(`status: ${pendingStatus(state.phase)}`, 'distance: —');
    return lines.join('\n');
  }
  lines.push(`status: ${r.status}`, `distance: ${formatDistanceM(r.distance_m)}`);
  if (state.segments.length > 1) {
    for (let i = 0; i < state.segments.length; i++) {
      lines.push(formatSegmentLine(i, state.segments[i]!));
    }
  }
  return lines.join('\n');
}

export function shouldBlockProductionWaypointClick(
  wrgDemoOn: boolean,
  suppressMapClick: boolean,
): boolean {
  return suppressMapClick || wrgDemoOn;
}

export type WrgDemoClickEffect =
  | { kind: 'ignored' }
  | { kind: 'set-a'; a: WrgDemoPoint }
  | { kind: 'add-via'; via: WrgDemoPoint }
  | { kind: 'set-b-and-route'; a: WrgDemoPoint; b: WrgDemoPoint }
  | { kind: 'set-finish-and-route'; points: WrgDemoPoint[] };

export class WrgDemoController {
  private state: WrgDemoState = createInitialWrgDemoState();

  getState(): WrgDemoState {
    return {
      ...this.state,
      vias: [...this.state.vias],
      segments: [...this.state.segments],
    };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  isViaMode(): boolean {
    return this.state.viaMode;
  }

  enable(): WrgDemoState {
    this.state = {
      enabled: true,
      phase: 'pick-a',
      viaMode: this.state.viaMode,
      a: null,
      vias: [],
      b: null,
      result: null,
      segments: [],
      error: null,
    };
    return this.getState();
  }

  disable(): WrgDemoState {
    const viaMode = this.state.viaMode;
    this.state = { ...createInitialWrgDemoState(), viaMode };
    return this.getState();
  }

  /** Clear points/route/status but stay in demo mode (pick A again). */
  clear(): WrgDemoState {
    if (!this.state.enabled) return this.getState();
    return this.enable();
  }

  setViaMode(on: boolean): WrgDemoState {
    this.state = { ...this.state, viaMode: on };
    if (!this.state.enabled || this.state.phase === 'routing' || this.state.phase === 'result') {
      return this.getState();
    }
    if (on && this.state.phase === 'pick-b' && this.state.a && !this.state.b) {
      this.state = { ...this.state, phase: 'pick-via' };
    } else if (!on && (this.state.phase === 'pick-via' || this.state.phase === 'pick-finish') && this.state.a && !this.state.b) {
      this.state = { ...this.state, phase: 'pick-b', vias: [] };
    }
    return this.getState();
  }

  /** Next map click is Finish (via mode only). */
  armFinish(): WrgDemoState {
    if (!this.state.enabled || !this.state.viaMode || !this.state.a) return this.getState();
    if (this.state.phase === 'routing' || this.state.phase === 'result') return this.getState();
    this.state = { ...this.state, phase: 'pick-finish', b: null, result: null, error: null, segments: [] };
    return this.getState();
  }

  setPoints(a: WrgDemoPoint, b: WrgDemoPoint): WrgDemoState {
    this.state = {
      enabled: true,
      phase: 'routing',
      viaMode: this.state.viaMode,
      a: { ...a },
      vias: [],
      b: { ...b },
      result: null,
      segments: [],
      error: null,
    };
    return this.getState();
  }

  click(lon: number, lat: number): WrgDemoClickEffect {
    if (!this.state.enabled) return { kind: 'ignored' };
    if (this.state.phase === 'routing') return { kind: 'ignored' };
    const pt: WrgDemoPoint = { lon, lat };
    if (
      this.state.phase === 'pick-a' ||
      this.state.phase === 'result' ||
      this.state.a === null
    ) {
      this.state = {
        enabled: true,
        viaMode: this.state.viaMode,
        a: pt,
        vias: [],
        b: null,
        result: null,
        error: null,
        segments: [],
        phase: this.state.viaMode ? 'pick-via' : 'pick-b',
      };
      return { kind: 'set-a', a: pt };
    }
    if (this.state.viaMode && this.state.phase === 'pick-via') {
      this.state = {
        ...this.state,
        vias: [...this.state.vias, pt],
        result: null,
        error: null,
        segments: [],
      };
      return { kind: 'add-via', via: pt };
    }
    const points: WrgDemoPoint[] = [this.state.a, ...this.state.vias, pt];
    this.state = {
      ...this.state,
      b: pt,
      result: null,
      error: null,
      segments: [],
      phase: 'routing',
    };
    if (this.state.vias.length > 0) {
      return { kind: 'set-finish-and-route', points };
    }
    return { kind: 'set-b-and-route', a: this.state.a!, b: pt };
  }

  applyResult(result: WrgDemoRouteResult): WrgDemoState {
    this.state = {
      ...this.state,
      result,
      error: null,
      phase: 'result',
      segments:
        this.state.a && this.state.b
          ? [{ from: this.state.a, to: this.state.b, result }]
          : [],
    };
    return this.getState();
  }

  applyChain(chain: WrgDemoChainResult): WrgDemoState {
    const overall: WrgDemoRouteResult = {
      status: chain.status,
      distance_m: chain.distance_m,
      geometry: null,
      detail: chain.segments.find((s) => s.result.status !== 'ROUTE_FOUND')?.result.detail ?? null,
    };
    this.state = {
      ...this.state,
      result: overall,
      segments: chain.segments,
      error: isWrgDemoHttpErrorStatus(chain.status)
        ? String(chain.segments.find((s) => isWrgDemoHttpErrorStatus(s.result.status))?.result.detail ?? chain.status)
        : null,
      phase: 'result',
    };
    return this.getState();
  }

  applyError(message: string): WrgDemoState {
    this.state = {
      ...this.state,
      result: null,
      error: message,
      phase: 'result',
    };
    return this.getState();
  }

  phase(): WrgDemoPhase {
    return this.state.phase;
  }

  routePoints(): WrgDemoPoint[] {
    const pts: WrgDemoPoint[] = [];
    if (this.state.a) pts.push(this.state.a);
    pts.push(...this.state.vias);
    if (this.state.b) pts.push(this.state.b);
    return pts;
  }
}
