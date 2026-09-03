/**
 * WaterGraph Demo state machine (no Leaflet, no production router).
 * Map click → request → GeoJSON. Errors never yield a drawable line.
 */

import type {
  WrgDemoPhase,
  WrgDemoPoint,
  WrgDemoRouteResult,
  WrgDemoState,
} from './wrg-demo-types';

const INITIAL: WrgDemoState = {
  enabled: false,
  phase: 'off',
  a: null,
  b: null,
  result: null,
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
  routeLatLngs: Array<[number, number]> | null;
} {
  return {
    a: state.a,
    b: state.b,
    routeLatLngs: shouldDrawWrgRoute(state.result)
      ? geoJsonLineToLatLngs(state.result?.geometry ?? null)
      : null,
  };
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
  if (phase === 'routing') return 'считаем маршрут';
  return 'ожидание';
}

/** Free Route panel: A, B, status, distance. */
export function formatWrgDemoPanel(state: WrgDemoState): string {
  const head = [`A: ${fmtPt(state.a)}`, `B: ${fmtPt(state.b)}`];
  const r = state.result;
  if (state.error || isWrgDemoHttpErrorStatus(r?.status)) {
    const detail = state.error || String(r?.detail ?? r?.status ?? 'backend error');
    return [
      ...head,
      `http_error: ${r?.status ?? 'RUNTIME_UNAVAILABLE'}`,
      `distance: —`,
      detail,
    ].join('\n');
  }
  if (!r) {
    return [...head, `status: ${pendingStatus(state.phase)}`, 'distance: —'].join('\n');
  }
  return [...head, `status: ${r.status}`, `distance: ${formatDistanceM(r.distance_m)}`].join(
    '\n',
  );
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
  | { kind: 'set-b-and-route'; a: WrgDemoPoint; b: WrgDemoPoint };

export class WrgDemoController {
  private state: WrgDemoState = createInitialWrgDemoState();

  getState(): WrgDemoState {
    return { ...this.state };
  }

  isEnabled(): boolean {
    return this.state.enabled;
  }

  enable(): WrgDemoState {
    this.state = {
      enabled: true,
      phase: 'pick-a',
      a: null,
      b: null,
      result: null,
      error: null,
    };
    return this.getState();
  }

  disable(): WrgDemoState {
    this.state = createInitialWrgDemoState();
    return this.getState();
  }

  /** Clear A/B/result but stay in demo mode (pick A again). */
  clear(): WrgDemoState {
    if (!this.state.enabled) return this.getState();
    return this.enable();
  }

  setPoints(a: WrgDemoPoint, b: WrgDemoPoint): WrgDemoState {
    this.state = {
      enabled: true,
      phase: 'routing',
      a: { ...a },
      b: { ...b },
      result: null,
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
        a: pt,
        b: null,
        result: null,
        error: null,
        phase: 'pick-b',
      };
      return { kind: 'set-a', a: pt };
    }
    this.state = {
      ...this.state,
      b: pt,
      result: null,
      error: null,
      phase: 'routing',
    };
    return { kind: 'set-b-and-route', a: this.state.a!, b: pt };
  }

  applyResult(result: WrgDemoRouteResult): WrgDemoState {
    this.state = {
      ...this.state,
      result,
      error: null,
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
}
