/**
 * Leaflet overlay for WaterGraph Demo. Separate layer group from production drawLayer.
 * Uses exact GeoJSON coordinates. smoothFactor=0 so Leaflet does not simplify onto land.
 */

import L from 'leaflet';
import type { WrgDemoPoint } from './wrg-demo-types';

const ROUTE_STYLE: L.PolylineOptions = {
  color: '#22d3ee',
  weight: 5,
  opacity: 0.95,
  interactive: false,
  smoothFactor: 0,
};

function markerIcon(label: string, fill: string): L.DivIcon {
  return L.divIcon({
    className: 'wrg-demo-marker',
    html: `<span class="wrg-demo-marker__dot" style="background:${fill}">${label}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

export class WrgDemoLayers {
  private readonly group: L.LayerGroup;
  private readonly map: L.Map;

  constructor(map: L.Map) {
    this.map = map;
    this.group = L.layerGroup().addTo(map);
  }

  clear(): void {
    this.group.clearLayers();
  }

  remove(): void {
    this.clear();
    this.map.removeLayer(this.group);
  }

  render(opts: {
    a: WrgDemoPoint | null;
    b: WrgDemoPoint | null;
    vias?: WrgDemoPoint[];
    routeLatLngs: Array<[number, number]> | null;
    routeSegments?: Array<Array<[number, number]>>;
  }): void {
    this.clear();
    if (opts.a) {
      L.marker([opts.a.lat, opts.a.lon], {
        icon: markerIcon('A', '#22d3ee'),
        interactive: false,
        keyboard: false,
      }).addTo(this.group);
    }
    (opts.vias ?? []).forEach((via, i) => {
      L.marker([via.lat, via.lon], {
        icon: markerIcon(String(i + 1), '#67e8f9'),
        interactive: false,
        keyboard: false,
      }).addTo(this.group);
    });
    if (opts.b) {
      L.marker([opts.b.lat, opts.b.lon], {
        icon: markerIcon('B', '#0284c7'),
        interactive: false,
        keyboard: false,
      }).addTo(this.group);
    }
    const segs = (opts.routeSegments ?? []).filter((line) => line.length >= 2);
    if (segs.length > 0) {
      for (const line of segs) {
        L.polyline(line, ROUTE_STYLE).addTo(this.group);
      }
      return;
    }
    if (opts.routeLatLngs && opts.routeLatLngs.length >= 2) {
      L.polyline(opts.routeLatLngs, ROUTE_STYLE).addTo(this.group);
    }
  }
}
