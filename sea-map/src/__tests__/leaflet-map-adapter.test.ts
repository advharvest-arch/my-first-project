import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { LngLat } from '../geo';

/**
 * Mock Leaflet enough to exercise LeafletMapAdapter without a DOM/map runtime.
 * AquaRoute UI is not imported.
 */
const markerAddTo = vi.fn(function (this: unknown) {
  return this;
});
const polyAddTo = vi.fn(function (this: unknown) {
  return this;
});
const layerGroupAddTo = vi.fn(function (this: unknown) {
  return this;
});
const tileAddTo = vi.fn(function (this: unknown) {
  return this;
});
const controlAddTo = vi.fn(function (this: unknown) {
  return this;
});

const mapApi = {
  setView: vi.fn(function (this: unknown) {
    return this;
  }),
  getContainer: vi.fn(() => ({ style: { cursor: '' } })),
  doubleClickZoom: { disable: vi.fn() },
  fitBounds: vi.fn(),
  getZoom: vi.fn(() => 5),
  on: vi.fn(),
  off: vi.fn(),
  remove: vi.fn(),
};

vi.mock('leaflet', () => {
  const L = {
    map: vi.fn(() => mapApi),
    tileLayer: vi.fn(() => ({ addTo: tileAddTo })),
    layerGroup: vi.fn(() => ({
      addTo: layerGroupAddTo,
      removeLayer: vi.fn(),
    })),
    control: {
      zoom: vi.fn(() => ({ addTo: controlAddTo })),
    },
    marker: vi.fn(() => ({ addTo: markerAddTo })),
    polyline: vi.fn(() => ({ addTo: polyAddTo })),
    divIcon: vi.fn((opts: unknown) => opts),
    latLngBounds: vi.fn((pts: unknown) => ({
      pad: vi.fn(function (this: unknown) {
        return this;
      }),
      _pts: pts,
    })),
  };
  return { default: L };
});

describe('LeafletMapAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('implements MapAdapter ops on a mounted Leaflet map', async () => {
    const L = (await import('leaflet')).default;
    const { createLeafletMapAdapter } = await import('../leaflet-map-adapter');

    const adapter = createLeafletMapAdapter();
    const el = { tagName: 'DIV' } as unknown as HTMLElement;
    const center: LngLat = { lon: 34.84, lat: 62.85 };

    adapter.mount(el, { center, zoom: 10 });
    expect(L.map).toHaveBeenCalledWith(el, expect.any(Object));
    expect(mapApi.setView).toHaveBeenCalledWith([center.lat, center.lon], 10);

    adapter.setMarkers([{ id: 'a', at: center, label: 'A' }]);
    expect(L.marker).toHaveBeenCalled();

    const line: LngLat[] = [center, { lon: 34.85, lat: 62.86 }];
    adapter.setRoute('r1', line, { color: '#0284c7', weight: 4 });
    expect(L.polyline).toHaveBeenCalled();
    expect(polyAddTo).toHaveBeenCalled();

    adapter.clearRoute('r1');
    adapter.clearRoute();

    const handler = vi.fn();
    const off = adapter.onClick(handler);
    expect(mapApi.on).toHaveBeenCalledWith('click', expect.any(Function));
    const clickFn = mapApi.on.mock.calls.find((c) => c[0] === 'click')?.[1] as (
      e: { latlng: { lng: number; lat: number } },
    ) => void;
    clickFn({ latlng: { lng: 1.5, lat: 2.5 } });
    expect(handler).toHaveBeenCalledWith({ lon: 1.5, lat: 2.5 });
    off();
    expect(mapApi.off).toHaveBeenCalled();

    adapter.fitBounds(line, 0.2);
    expect(mapApi.fitBounds).toHaveBeenCalled();

    adapter.setView(center, 8);
    expect(mapApi.setView).toHaveBeenCalledWith([center.lat, center.lon], 8);

    adapter.destroy();
    expect(mapApi.remove).toHaveBeenCalled();
  });

  it('is not imported by AquaRoute entry modules', async () => {
    // Guard: adapter stays unused by runtime UI until a later wiring task.
    const mainSrc = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../main.ts', import.meta.url), 'utf8'),
    );
    const bootSrc = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../map-boot.ts', import.meta.url), 'utf8'),
    );
    expect(mainSrc).not.toMatch(/leaflet-map-adapter/);
    expect(bootSrc).not.toMatch(/leaflet-map-adapter/);
  });
});
