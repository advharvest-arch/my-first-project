import L from 'leaflet';
import { feature as topoFeature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landTopology from './land-110m.json';

/**
 * Offline-first basemap: bundled Natural Earth land polygons.
 * No external tile CDN required — works behind blocked networks.
 */
export function addOfflineBasemap(map: L.Map): void {
  map.createPane('landPane');
  const pane = map.getPane('landPane');
  if (pane) {
    pane.style.zIndex = '200';
    pane.style.pointerEvents = 'none';
  }

  const topology = landTopology as unknown as Topology<{ land: GeometryCollection }>;
  const land = topoFeature(topology, topology.objects.land);

  L.geoJSON(land as GeoJSON.GeoJsonObject, {
    pane: 'landPane',
    style: {
      color: '#5f7f86',
      weight: 0.7,
      fillColor: '#d8e6df',
      fillOpacity: 1,
    },
    interactive: false,
  }).addTo(map);

  // Optional raster tiles — only if the network allows them
  const tiles = L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 19,
      opacity: 0,
      className: 'basemap-tiles',
    },
  );

  let loaded = 0;
  tiles.on('tileload', () => {
    loaded += 1;
    if (loaded >= 2) {
      tiles.setOpacity(0.88);
    }
  });
  tiles.on('tileerror', () => {
    // Keep offline land basemap; ignore CDN failures
  });
  tiles.addTo(map);
}
