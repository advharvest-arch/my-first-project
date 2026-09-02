import { describe, expect, it } from 'vitest';
import type {
  MapAdapter,
  MapAdapterMarker,
  MapAdapterMountOptions,
  MapAdapterRouteStyle,
} from '../map-adapter';
import type { LngLat } from '../geo';

/**
 * Compile-time / shape check only — no engine is wired.
 * Ensures the MapAdapter contract stays importable and LngLat-aligned.
 */
describe('MapAdapter contract', () => {
  it('exports LngLat-based operation shapes', () => {
    const center: LngLat = { lon: 34.84, lat: 62.85 };
    const opts: MapAdapterMountOptions = { center, zoom: 12 };
    const markers: MapAdapterMarker[] = [{ id: 'a', at: center, label: 'A' }];
    const style: MapAdapterRouteStyle = { color: '#0284c7', weight: 5 };
    const line: LngLat[] = [center, { lon: 34.85, lat: 62.86 }];

    // Structural stand-in: proves the type is constructible without a real map.
    const stub: MapAdapter = {
      mount(_el, _opts) {},
      setMarkers(_points) {},
      setRoute(_id, _line, _style) {},
      clearRoute(_id) {},
      onClick(_handler) {
        return () => {};
      },
      fitBounds(_points, _pad) {},
      setView(_center, _zoom) {},
      destroy() {},
    };

    // Node vitest has no DOM; mount only needs an HTMLElement-shaped handle.
    const el = { tagName: 'DIV' } as unknown as HTMLElement;
    stub.mount(el, opts);
    stub.setMarkers(markers);
    stub.setRoute('demo', line, style);
    stub.clearRoute('demo');
    const off = stub.onClick(() => {});
    off();
    stub.fitBounds(line, 0.1);
    stub.setView(center, 11);
    stub.destroy();

    expect(opts.zoom).toBe(12);
    expect(markers[0]!.at.lon).toBe(center.lon);
    expect(line).toHaveLength(2);
  });
});
