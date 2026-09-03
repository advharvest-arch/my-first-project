/**
 * WaterGraph Demo / Shadow — frontend tests only.
 * Does not exercise production measureWaterChain / BRouter.
 */
import { describe, expect, it, vi } from 'vitest';
import { WRG_DEMO_CASES, WRG_FREE_ROUTE_UI, WRG_FREE_ROUTE_VIEW } from '../wrg-demo-cases';
import { requestWrgDemoRoute } from '../wrg-demo-client';
import {
  WrgDemoController,
  formatWrgDemoPanel,
  geoJsonLineToLatLngs,
  isWrgDemoHttpErrorStatus,
  shouldAutoEnableWrgFreeRoute,
  shouldBlockProductionWaypointClick,
  shouldDrawWrgRoute,
  wrgDemoMapView,
} from '../wrg-demo-controller';
import type { WrgDemoRouteResult } from '../wrg-demo-types';

const line: WrgDemoRouteResult = {
  status: 'ROUTE_FOUND',
  distance_m: 1000,
  path_node_count: 4,
  path_edge_count: 3,
  e1_mesh_transitions: 2,
  component_a: 151,
  component_b: 151,
  geometry: {
    type: 'LineString',
    coordinates: [
      [37.16, 60.33],
      [37.20, 60.30],
      [37.22, 60.25],
    ],
  },
};

describe('WaterGraph Demo A/B selection', () => {
  it('first click is A, second click is B and requests a route', () => {
    const c = new WrgDemoController();
    expect(c.click(1, 2).kind).toBe('ignored');
    c.enable();
    const a = c.click(37.1, 60.3);
    expect(a).toEqual({ kind: 'set-a', a: { lon: 37.1, lat: 60.3 } });
    expect(c.getState().phase).toBe('pick-b');
    expect(c.getState().a).toEqual({ lon: 37.1, lat: 60.3 });
    const b = c.click(37.2, 60.2);
    expect(b.kind).toBe('set-b-and-route');
    expect(c.getState().phase).toBe('routing');
    expect(c.getState().b).toEqual({ lon: 37.2, lat: 60.2 });
  });

  it('arbitrary Beloye pair click A then B requests a route', () => {
    const c = new WrgDemoController();
    c.enable();
    const a = { lon: 37.42, lat: 60.29 };
    const b = { lon: 37.48, lat: 60.31 };
    expect(c.click(a.lon, a.lat)).toEqual({ kind: 'set-a', a });
    const effect = c.click(b.lon, b.lat);
    expect(effect).toEqual({ kind: 'set-b-and-route', a, b });
    expect(c.getState().a).toEqual(a);
    expect(c.getState().b).toEqual(b);
    expect(c.getState().phase).toBe('routing');
    expect(JSON.stringify(c.getState())).not.toMatch(/waypoint/i);
  });

  it('after a result, next click starts a new A instead of keeping old A', () => {
    const c = new WrgDemoController();
    c.enable();
    c.click(37.42, 60.29);
    c.click(37.48, 60.31);
    c.applyResult(line);
    expect(c.getState().phase).toBe('result');
    const next = c.click(37.40, 60.28);
    expect(next.kind).toBe('set-a');
    expect(c.getState().b).toBeNull();
    expect(c.getState().result).toBeNull();
    expect(wrgDemoMapView(c.getState()).routeLatLngs).toBeNull();
  });
});

describe('WaterGraph Demo route rendering', () => {
  it('ROUTE_FOUND uses exact GeoJSON coordinates (not a straight A→B)', () => {
    const c = new WrgDemoController();
    c.setPoints({ lon: 0, lat: 0 }, { lon: 1, lat: 1 });
    c.applyResult(line);
    const view = wrgDemoMapView(c.getState());
    expect(view.routeLatLngs).toEqual([
      [60.33, 37.16],
      [60.3, 37.2],
      [60.25, 37.22],
    ]);
    expect(view.routeLatLngs).not.toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(shouldDrawWrgRoute(line)).toBe(true);
  });
});

describe('WaterGraph Demo error statuses do not render a route', () => {
  it('NO_WATER_CONNECTION does not render a line', () => {
    const fakeGeom: WrgDemoRouteResult = {
      status: 'NO_WATER_CONNECTION',
      geometry: {
        type: 'LineString',
        coordinates: [
          [30.2, 59.96],
          [30.27, 59.98],
        ],
      },
    };
    expect(shouldDrawWrgRoute(fakeGeom)).toBe(false);
    const c = new WrgDemoController();
    c.enable();
    c.click(30.2, 59.96);
    c.click(30.27, 59.98);
    c.applyResult(fakeGeom);
    expect(wrgDemoMapView(c.getState()).routeLatLngs).toBeNull();
    expect(wrgDemoMapView(c.getState()).a).not.toBeNull();
    expect(wrgDemoMapView(c.getState()).b).not.toBeNull();
  });

  it('ENDPOINT_NOT_ON_WATER does not render a line', () => {
    const fakeGeom: WrgDemoRouteResult = {
      status: 'ENDPOINT_NOT_ON_WATER',
      geometry: {
        type: 'LineString',
        coordinates: [
          [30.23, 59.94],
          [30.27, 59.98],
        ],
      },
    };
    expect(shouldDrawWrgRoute(fakeGeom)).toBe(false);
    const c = new WrgDemoController();
    c.setPoints({ lon: 30.23, lat: 59.94 }, { lon: 30.27, lat: 59.98 });
    c.applyResult(fakeGeom);
    expect(wrgDemoMapView(c.getState()).routeLatLngs).toBeNull();
  });
});

describe('WaterGraph Demo clear/reset', () => {
  it('clear drops A/B/result and drawable geometry', () => {
    const c = new WrgDemoController();
    c.setPoints({ lon: 1, lat: 2 }, { lon: 3, lat: 4 });
    c.applyResult(line);
    expect(wrgDemoMapView(c.getState()).routeLatLngs).not.toBeNull();
    c.clear();
    const s = c.getState();
    expect(s.enabled).toBe(true);
    expect(s.a).toBeNull();
    expect(s.b).toBeNull();
    expect(s.result).toBeNull();
    expect(s.phase).toBe('pick-a');
    expect(wrgDemoMapView(s).routeLatLngs).toBeNull();
  });

  it('after clear, a new A→B pair can be set immediately', () => {
    const c = new WrgDemoController();
    c.setPoints({ lon: 1, lat: 2 }, { lon: 3, lat: 4 });
    c.applyResult(line);
    c.clear();
    expect(c.click(37.42, 60.29).kind).toBe('set-a');
    expect(c.click(37.48, 60.31).kind).toBe('set-b-and-route');
    expect(c.getState().a).toEqual({ lon: 37.42, lat: 60.29 });
    expect(c.getState().b).toEqual({ lon: 37.48, lat: 60.31 });
    expect(c.getState().result).toBeNull();
  });

  it('disable leaves demo off with empty view', () => {
    const c = new WrgDemoController();
    c.enable();
    c.click(1, 2);
    c.disable();
    expect(c.isEnabled()).toBe(false);
    expect(wrgDemoMapView(c.getState())).toEqual({
      a: null,
      b: null,
      routeLatLngs: null,
    });
  });
});

describe('WaterGraph Demo GeoJSON helper', () => {
  it('rejects non-LineString and short lines', () => {
    expect(geoJsonLineToLatLngs(null)).toBeNull();
    expect(geoJsonLineToLatLngs({ type: 'LineString', n_coords: 3 })).toBeNull();
    expect(
      geoJsonLineToLatLngs({ type: 'LineString', coordinates: [[1, 2]] }),
    ).toBeNull();
  });
});

describe('Free Route query and chrome', () => {
  it('?wrgDemo=1 auto-opens Free Route without a case id', () => {
    expect(shouldAutoEnableWrgFreeRoute('?wrgDemo=1')).toBe(true);
    expect(shouldAutoEnableWrgFreeRoute('wrg-demo=1')).toBe(true);
    expect(shouldAutoEnableWrgFreeRoute('?wrgDemo=1&from=x')).toBe(true);
    expect(shouldAutoEnableWrgFreeRoute('')).toBe(false);
    expect(shouldAutoEnableWrgFreeRoute('?demo=moscow')).toBe(false);
  });

  it('keeps Tests / Examples collapsed and secondary', () => {
    expect(WRG_FREE_ROUTE_UI.title).toBe('Free Route');
    expect(WRG_FREE_ROUTE_UI.examplesLabel).toBe('Tests / Examples');
    expect(WRG_FREE_ROUTE_UI.examplesOpenByDefault).toBe(false);
    expect(WRG_FREE_ROUTE_VIEW.zoom).toBeGreaterThanOrEqual(8);
  });
});

describe('WaterGraph Demo cases catalog', () => {
  it('includes the five required WRG validation cases', () => {
    expect(WRG_DEMO_CASES.map((c) => c.id)).toEqual([
      'beloye_kovzha_belozersky',
      'beloye_same_part',
      'vygozero_same_part',
      'strelka_land_separation',
      'land_off_network',
    ]);
    expect(WRG_DEMO_CASES[0]?.expect).toBe('ROUTE_FOUND');
    expect(WRG_DEMO_CASES[3]?.expect).toBe('NO_WATER_CONNECTION');
    expect(WRG_DEMO_CASES[4]?.expect).toBe('ENDPOINT_NOT_ON_WATER');
  });
});

describe('WaterGraph Demo client adapter', () => {
  it('maps fetch failure to RUNTIME_UNAVAILABLE without inventing geometry', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'));
    const res = await requestWrgDemoRoute(
      { lon: 1, lat: 2 },
      { lon: 3, lat: 4 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe('RUNTIME_UNAVAILABLE');
    expect(res.geometry).toBeUndefined();
    expect(shouldDrawWrgRoute(res)).toBe(false);
  });

  it('maps HTTP 500 to RUNTIME_UNAVAILABLE, not a routing status', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ detail: 'boom' }),
    });
    const res = await requestWrgDemoRoute(
      { lon: 1, lat: 2 },
      { lon: 3, lat: 4 },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe('RUNTIME_UNAVAILABLE');
    expect(res.detail).toContain('HTTP 500');
    expect(isWrgDemoHttpErrorStatus(res.status)).toBe(true);
    expect(shouldDrawWrgRoute(res)).toBe(false);
  });

  it('Kovzha → Belozersky 200 ROUTE_FOUND draws funnel coords, not a straight A→B', async () => {
    const a = WRG_DEMO_CASES[0]!.a;
    const b = WRG_DEMO_CASES[0]!.b;
    const funnel = {
      status: 'ROUTE_FOUND' as const,
      distance_m: 31631,
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [a.lon, a.lat],
          [37.20, 60.30],
          [b.lon, b.lat],
        ],
      },
    };
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => funnel,
    });
    const res = await requestWrgDemoRoute(a, b, fetchImpl as unknown as typeof fetch);
    expect(res.status).toBe('ROUTE_FOUND');
    const c = new WrgDemoController();
    c.setPoints(a, b);
    c.applyResult(res);
    const view = wrgDemoMapView(c.getState());
    expect(view.routeLatLngs).toEqual([
      [a.lat, a.lon],
      [60.3, 37.2],
      [b.lat, b.lon],
    ]);
    expect(view.routeLatLngs).not.toEqual([
      [a.lat, a.lon],
      [b.lat, b.lon],
    ]);
  });
});

describe('WaterGraph Demo panel vs production', () => {
  it('shows A/B, status and distance after a click-built route (no case button)', () => {
    const c = new WrgDemoController();
    c.enable();
    expect(formatWrgDemoPanel(c.getState())).toContain('status: кликните A');
    c.click(37.42, 60.29);
    expect(formatWrgDemoPanel(c.getState())).toContain('status: кликните B');
    c.click(37.48, 60.31);
    expect(formatWrgDemoPanel(c.getState())).toContain('status: считаем маршрут');
    c.applyResult({ status: 'ROUTE_FOUND', distance_m: 1200, geometry: line.geometry });
    const text = formatWrgDemoPanel(c.getState());
    expect(text).toContain('A: 37.420000, 60.290000');
    expect(text).toContain('B: 37.480000, 60.310000');
    expect(text).toContain('status: ROUTE_FOUND');
    expect(text).toMatch(/distance: .*(1.200|1200) м/);
    expect(text.split('\n').filter((line) => line.startsWith('A:') || line.startsWith('B:') || line.startsWith('status:') || line.startsWith('distance:'))).toHaveLength(4);
    expect(text).not.toContain('http_error');
    expect(text).not.toMatch(/Белое|Выгозеро|Стрелка|Ковжа/);
  });

  it('shows A/B lon lat and routing status, not http_error, for WRG statuses', () => {
    const c = new WrgDemoController();
    c.setPoints({ lon: 37.42, lat: 60.29 }, { lon: 37.48, lat: 60.31 });
    c.applyResult({ status: 'ROUTE_FOUND', distance_m: 1200, geometry: line.geometry });
    const text = formatWrgDemoPanel(c.getState());
    expect(text).toContain('A: 37.420000, 60.290000');
    expect(text).toContain('B: 37.480000, 60.310000');
    expect(text).toContain('status: ROUTE_FOUND');
    expect(text).toContain('distance:');
    expect(text).not.toContain('http_error');
  });

  it('builds a second Free Route pair after Clear without reloading', () => {
    const c = new WrgDemoController();
    c.enable();
    c.click(37.42, 60.29);
    c.click(37.48, 60.31);
    c.applyResult(line);
    c.clear();
    expect(c.click(37.40, 60.28).kind).toBe('set-a');
    expect(c.click(37.50, 60.32).kind).toBe('set-b-and-route');
    c.applyResult({ ...line, distance_m: 2400 });
    const text = formatWrgDemoPanel(c.getState());
    expect(text).toContain('A: 37.400000, 60.280000');
    expect(text).toContain('B: 37.500000, 60.320000');
    expect(text).toContain('status: ROUTE_FOUND');
    expect(text).toContain('distance:');
  });

  it('shows http_error separately from routing status', () => {
    const c = new WrgDemoController();
    c.enable();
    c.click(1, 2);
    c.click(3, 4);
    c.applyError('HTTP 503: down');
    const text = formatWrgDemoPanel(c.getState());
    expect(text).toContain('http_error:');
    expect(text).not.toContain('status: ROUTE_FOUND');
    expect(text).not.toContain('status: NO_WATER_CONNECTION');
  });

  it('blocks production waypoint clicks while demo is on', () => {
    expect(shouldBlockProductionWaypointClick(true, false)).toBe(true);
    expect(shouldBlockProductionWaypointClick(false, true)).toBe(true);
    expect(shouldBlockProductionWaypointClick(false, false)).toBe(false);
  });
});
