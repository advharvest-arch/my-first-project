/**
 * Leaflet 1.9 implementation of {@link MapAdapter}.
 *
 * Standalone cartographic adapter — not wired into AquaRoute UI yet.
 * Does not touch WaterGraph, PostGIS, or routing.
 */

import L from 'leaflet';
import type { LngLat } from './geo';
import type {
  MapAdapter,
  MapAdapterMarker,
  MapAdapterMountOptions,
  MapAdapterRouteStyle,
  MapAdapterUnsubscribe,
} from './map-adapter';

const DEFAULT_CENTER: LngLat = { lon: 37.62, lat: 55.75 };
const DEFAULT_ZOOM = 5;

const DEFAULT_ROUTE_STYLE: Required<MapAdapterRouteStyle> = {
  color: '#2ec4b6',
  weight: 5,
};

function toLatLng(p: LngLat): L.LatLngExpression {
  return [p.lat, p.lon];
}

function toLatLngs(line: LngLat[]): L.LatLngExpression[] {
  return line.map(toLatLng);
}

/**
 * Create a MapAdapter backed by Leaflet 1.9.
 * Call {@link MapAdapter.mount} before other drawing methods.
 */
export function createLeafletMapAdapter(): MapAdapter {
  return new LeafletMapAdapter();
}

class LeafletMapAdapter implements MapAdapter {
  private map: L.Map | null = null;
  private overlay: L.LayerGroup | null = null;
  private markers = new Map<string, L.Marker>();
  private routes = new Map<string, L.Polyline>();
  private clickUnsubs = new Set<MapAdapterUnsubscribe>();

  mount(el: HTMLElement, opts?: MapAdapterMountOptions): void {
    if (this.map) {
      this.destroy();
    }

    const center = opts?.center ?? DEFAULT_CENTER;
    const zoom = opts?.zoom ?? DEFAULT_ZOOM;

    // Same core Leaflet map options as map-boot.ts (basemap stays simple OSM).
    const map = L.map(el, {
      worldCopyJump: true,
      minZoom: 2,
      maxZoom: 19,
      zoomControl: false,
      attributionControl: true,
      preferCanvas: false,
      fadeAnimation: false,
      zoomAnimation: true,
      markerZoomAnimation: false,
      tapTolerance: 20,
      bounceAtZoomLimits: false,
    }).setView(toLatLng(center), zoom);

    map.getContainer().style.cursor = 'default';
    map.doubleClickZoom.disable();
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    this.map = map;
    this.overlay = L.layerGroup().addTo(map);
  }

  setMarkers(points: MapAdapterMarker[]): void {
    const overlay = this.requireOverlay();
    for (const marker of this.markers.values()) {
      overlay.removeLayer(marker);
    }
    this.markers.clear();

    for (const point of points) {
      const label = point.label ?? point.id;
      const icon = L.divIcon({
        className: 'map-adapter-marker',
        html: `<div class="map-adapter-marker__label">${escapeHtml(label)}</div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });
      const marker = L.marker(toLatLng(point.at), {
        icon,
        interactive: false,
        keyboard: false,
      }).addTo(overlay);
      this.markers.set(point.id, marker);
    }
  }

  setRoute(id: string, line: LngLat[], style?: MapAdapterRouteStyle): void {
    const overlay = this.requireOverlay();
    const prev = this.routes.get(id);
    if (prev) {
      overlay.removeLayer(prev);
      this.routes.delete(id);
    }
    if (line.length < 2) return;

    const merged = { ...DEFAULT_ROUTE_STYLE, ...style };
    const poly = L.polyline(toLatLngs(line), {
      color: merged.color,
      weight: merged.weight,
      opacity: 0.95,
      interactive: false,
      smoothFactor: 0,
    }).addTo(overlay);
    this.routes.set(id, poly);
  }

  clearRoute(id?: string): void {
    const overlay = this.overlay;
    if (!overlay) {
      this.routes.clear();
      return;
    }
    if (id == null) {
      for (const poly of this.routes.values()) {
        overlay.removeLayer(poly);
      }
      this.routes.clear();
      return;
    }
    const poly = this.routes.get(id);
    if (poly) {
      overlay.removeLayer(poly);
      this.routes.delete(id);
    }
  }

  onClick(handler: (p: LngLat) => void): MapAdapterUnsubscribe {
    const map = this.requireMap();
    const listener = (e: L.LeafletMouseEvent) => {
      handler({ lon: e.latlng.lng, lat: e.latlng.lat });
    };
    map.on('click', listener);
    const unsub: MapAdapterUnsubscribe = () => {
      map.off('click', listener);
      this.clickUnsubs.delete(unsub);
    };
    this.clickUnsubs.add(unsub);
    return unsub;
  }

  fitBounds(points: LngLat[], pad?: number): void {
    const map = this.requireMap();
    if (points.length === 0) return;
    if (points.length === 1) {
      map.setView(toLatLng(points[0]!), map.getZoom());
      return;
    }
    const bounds = L.latLngBounds(toLatLngs(points));
    // pad mirrors main.ts waypoint fit (0.2) when provided; otherwise Leaflet default.
    if (pad != null && Number.isFinite(pad)) {
      map.fitBounds(bounds.pad(pad));
    } else {
      map.fitBounds(bounds);
    }
  }

  setView(center: LngLat, zoom: number): void {
    this.requireMap().setView(toLatLng(center), zoom);
  }

  destroy(): void {
    for (const unsub of [...this.clickUnsubs]) {
      unsub();
    }
    this.clickUnsubs.clear();
    this.markers.clear();
    this.routes.clear();
    this.overlay = null;
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  private requireMap(): L.Map {
    if (!this.map) {
      throw new Error('LeafletMapAdapter: mount() before use');
    }
    return this.map;
  }

  private requireOverlay(): L.LayerGroup {
    if (!this.overlay) {
      throw new Error('LeafletMapAdapter: mount() before use');
    }
    return this.overlay;
  }
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
