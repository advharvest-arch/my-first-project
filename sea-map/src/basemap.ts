import L from 'leaflet';
import { feature as topoFeature } from 'topojson-client';
import type { GeometryCollection, Topology } from 'topojson-specification';
import landTopology from './land-110m.json';

export type BasemapId = 'osm' | 'topo' | 'satellite' | 'offline';

type BasemapDef = {
  id: BasemapId;
  label: string;
  layer: L.TileLayer | L.LayerGroup;
};

function offlineLandLayer(pane?: string): L.GeoJSON {
  const topology = landTopology as unknown as Topology<{ land: GeometryCollection }>;
  const land = topoFeature(topology, topology.objects.land);
  return L.geoJSON(land as GeoJSON.GeoJsonObject, {
    pane,
    style: {
      color: '#5f7f86',
      weight: 0.7,
      fillColor: '#d8e6df',
      fillOpacity: 1,
    },
    interactive: false,
  });
}

/** Raster tiles with a secondary URL if the primary host fails (403/timeout). */
function rasterLayer(
  primaryUrl: string,
  options: L.TileLayerOptions,
  fallbackUrl?: string,
): L.TileLayer {
  const layer = L.tileLayer(primaryUrl, {
    updateWhenIdle: true,
    keepBuffer: 2,
    ...options,
  });

  if (!fallbackUrl) return layer;

  layer.on('tileerror', (e) => {
    const tile = (e as L.TileErrorEvent).tile as HTMLImageElement | undefined;
    const coords = (e as L.TileErrorEvent).coords;
    if (!tile || !coords || tile.dataset.fallbackTried === '1') return;
    tile.dataset.fallbackTried = '1';
    const { z, x, y } = coords;
    tile.src = L.Util.template(fallbackUrl, {
      s: ['a', 'b', 'c', 'd'][Math.abs(x + y) % 4],
      r: '',
      z,
      x,
      y,
    });
  });

  return layer;
}

export function createBasemaps(): Record<BasemapId, BasemapDef> {
  // Standard OSM for clear water/land contrast; Carto as fallback if OSM rate-limits.
  const osm = rasterLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
      className: 'basemap-tiles',
    },
    'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
  );

  const topo = rasterLayer(
    'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    {
      attribution:
        '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> | &copy; OpenStreetMap',
      subdomains: 'abc',
      maxZoom: 17,
      className: 'basemap-tiles',
    },
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  );

  const satellite = rasterLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19,
      className: 'basemap-tiles',
    },
  );

  const offline = L.layerGroup([offlineLandLayer()]);

  return {
    osm: { id: 'osm', label: 'OSM (реки и озёра)', layer: osm },
    topo: { id: 'topo', label: 'Топокарта', layer: topo },
    satellite: { id: 'satellite', label: 'Спутник', layer: satellite },
    offline: { id: 'offline', label: 'Офлайн-контур', layer: offline },
  };
}

export function attachBasemapControl(
  map: L.Map,
  basemaps: Record<BasemapId, BasemapDef>,
  initial: BasemapId = 'osm',
): { setBasemap: (id: BasemapId) => void; getBasemap: () => BasemapId } {
  let current = initial;

  // Land contour only for offline mode — never under raster tiles
  // (opaque fill washed out OSM/Carto and looked like a broken map).
  map.createPane('underlayPane');
  const underlayPane = map.getPane('underlayPane');
  if (underlayPane) {
    underlayPane.style.zIndex = '200';
    underlayPane.style.pointerEvents = 'none';
  }
  const offlineUnderlay = offlineLandLayer('underlayPane');

  const syncUnderlay = (id: BasemapId) => {
    if (id === 'offline') {
      if (!map.hasLayer(offlineUnderlay)) offlineUnderlay.addTo(map);
    } else if (map.hasLayer(offlineUnderlay)) {
      map.removeLayer(offlineUnderlay);
    }
  };

  basemaps[current].layer.addTo(map);
  syncUnderlay(current);
  map.getContainer().dataset.basemap = current;

  const setBasemap = (id: BasemapId) => {
    if (id === current) return;
    map.removeLayer(basemaps[current].layer);
    current = id;
    basemaps[current].layer.addTo(map);
    syncUnderlay(id);
    map.getContainer().dataset.basemap = id;
  };

  return {
    setBasemap,
    getBasemap: () => current,
  };
}
