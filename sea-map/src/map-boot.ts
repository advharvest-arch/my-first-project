/**
 * Minimal first paint: Leaflet + basemap tiles only.
 * Heavy routing / GVR / water-core load in a second module.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { attachBasemapControl, createBasemaps } from './basemap';
import { setMapContext } from './map-context';
import './style.css';

const mapEl = document.getElementById('map');
if (!mapEl) throw new Error('Map container #map not found');

const map = L.map(mapEl, {
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
}).setView([55.75, 37.62], 5);

map.getContainer().style.cursor = 'default';
map.doubleClickZoom.disable();
L.control.zoom({ position: 'bottomright' }).addTo(map);

const basemaps = createBasemaps();
const basemapControl = attachBasemapControl(map, basemaps, 'osm');
setMapContext(map, basemapControl);

const refreshSize = () => map.invalidateSize({ animate: false });
requestAnimationFrame(refreshSize);
setTimeout(refreshSize, 80);
setTimeout(refreshSize, 300);

const appRoot = document.getElementById('app');
if (appRoot) {
  appRoot.removeAttribute('data-booting');
  appRoot.style.display = '';
}
const bootFallback = document.getElementById('boot-fallback');
if (bootFallback) bootFallback.removeAttribute('data-show');

// Defer routing, GVR index, water-core, searoute — map tiles already painting.
void import('./main');
