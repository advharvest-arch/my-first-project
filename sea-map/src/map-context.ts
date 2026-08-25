import type { Map as LeafletMap } from 'leaflet';
import type { BasemapId } from './basemap';

export type BasemapApi = {
  setBasemap: (id: BasemapId) => void;
  getBasemap: () => BasemapId;
};

let map: LeafletMap | null = null;
let basemapControl: BasemapApi | null = null;

export function setMapContext(nextMap: LeafletMap, nextBasemap: BasemapApi): void {
  map = nextMap;
  basemapControl = nextBasemap;
}

export function requireMap(): LeafletMap {
  if (!map) throw new Error('Map not ready');
  return map;
}

export function requireBasemapControl(): BasemapApi {
  if (!basemapControl) throw new Error('Basemap control not ready');
  return basemapControl;
}
