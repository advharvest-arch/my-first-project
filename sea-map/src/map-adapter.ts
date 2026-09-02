/**
 * MapAdapter — map-engine contract for AquaRoute UI.
 *
 * Implementations (Leaflet / Yandex / Mobile) come later.
 * Routing, WaterGraph, and PostGIS stay on LngLat[] and do not depend on this.
 */

import type { LngLat } from './geo';

export type MapAdapterMarker = {
  id: string;
  at: LngLat;
  label?: string;
};

export type MapAdapterRouteStyle = {
  color?: string;
  weight?: number;
};

export type MapAdapterMountOptions = {
  center: LngLat;
  zoom: number;
};

/** Unsubscribe previously registered click handler. */
export type MapAdapterUnsubscribe = () => void;

/**
 * Minimal cartographic surface shared by future map engines.
 * Coordinates are always {@link LngLat} (`{ lon, lat }`).
 */
export type MapAdapter = {
  mount(el: HTMLElement, opts?: MapAdapterMountOptions): void;
  setMarkers(points: MapAdapterMarker[]): void;
  setRoute(id: string, line: LngLat[], style?: MapAdapterRouteStyle): void;
  clearRoute(id?: string): void;
  onClick(handler: (p: LngLat) => void): MapAdapterUnsubscribe;
  fitBounds(points: LngLat[], pad?: number): void;
  setView(center: LngLat, zoom: number): void;
  destroy(): void;
};
