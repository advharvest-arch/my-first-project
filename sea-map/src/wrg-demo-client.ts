/**
 * Demo adapter: browser → `/wrg-demo/route` → wrg_route.py (Vite middleware).
 *
 * TODO (if this fetch 404/503): run `npm run dev` in sea-map so the Vite
 * plugin can spawn `python3 ingest/wrg_route.py --stdio-json` against PostGIS.
 * Do not invent a production HTTP API here.
 */

import type {
  WrgDemoChainResult,
  WrgDemoPoint,
  WrgDemoRouteResult,
  WrgDemoSegment,
} from './wrg-demo-types';

const ROUTE_PATH = '/wrg-demo/route';

function demoOrigin(): string {
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin;
  }
  return 'http://127.0.0.1';
}

export async function requestWrgDemoRoute(
  a: WrgDemoPoint,
  b: WrgDemoPoint,
  fetchImpl: typeof fetch = fetch,
): Promise<WrgDemoRouteResult> {
  const url = new URL(ROUTE_PATH, demoOrigin());
  url.searchParams.set('a_lon', String(a.lon));
  url.searchParams.set('a_lat', String(a.lat));
  url.searchParams.set('b_lon', String(b.lon));
  url.searchParams.set('b_lat', String(b.lat));
  let res: Response;
  try {
    res = await fetchImpl(url.toString(), { method: 'GET' });
  } catch {
    return {
      status: 'RUNTIME_UNAVAILABLE',
      detail:
        'TODO: WaterGraph runtime is Python/PostGIS. Start sea-map with Vite so /wrg-demo/route can call wrg_route.py. No production backend was added.',
    };
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string; status?: string };
      if (body.detail) detail = `${detail}: ${body.detail}`;
    } catch {
      /* ignore */
    }
    return { status: 'RUNTIME_UNAVAILABLE', detail };
  }
  let body: WrgDemoRouteResult;
  try {
    body = (await res.json()) as WrgDemoRouteResult;
  } catch {
    return { status: 'RUNTIME_UNAVAILABLE', detail: `HTTP ${res.status}: invalid JSON` };
  }
  return body;
}

function overallChainStatus(segments: WrgDemoSegment[]): WrgDemoRouteResult['status'] {
  for (const seg of segments) {
    if (seg.result.status !== 'ROUTE_FOUND') return seg.result.status;
  }
  return 'ROUTE_FOUND';
}

/**
 * Sequential A→C1→…→B using the existing `/wrg-demo/route` A→B call.
 * Not a new backend. Failed legs keep their WRG status and have no drawable line.
 */
export async function requestWrgDemoChain(
  points: WrgDemoPoint[],
  fetchImpl: typeof fetch = fetch,
): Promise<WrgDemoChainResult> {
  if (points.length < 2) {
    return { status: 'BAD_REQUEST', distance_m: null, segments: [] };
  }
  const segments: WrgDemoSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i]!;
    const to = points[i + 1]!;
    const result = await requestWrgDemoRoute(from, to, fetchImpl);
    segments.push({ from, to, result });
  }
  const status = overallChainStatus(segments);
  let foundSum = 0;
  let anyFound = false;
  for (const seg of segments) {
    if (seg.result.status === 'ROUTE_FOUND' && seg.result.distance_m != null) {
      foundSum += seg.result.distance_m;
      anyFound = true;
    }
  }
  const distance_m = status === 'ROUTE_FOUND' ? foundSum : anyFound ? foundSum : null;
  return { status, distance_m, segments };
}
