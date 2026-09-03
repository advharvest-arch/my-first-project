/**
 * WaterGraph Demo / Shadow — frontend tests only.
 * Does not exercise production measureWaterChain / BRouter.
 */
import { describe, expect, it, vi } from 'vitest';
import { WRG_DEMO_CASES } from '../wrg-demo-cases';
import { requestWrgDemoRoute } from '../wrg-demo-client';
import {
  WrgDemoController,
  geoJsonLineToLatLngs,
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
});
