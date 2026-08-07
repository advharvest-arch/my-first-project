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

export function createBasemaps(): Record<BasemapId, BasemapDef> {
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
    className: 'basemap-tiles',
  });

  const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution:
      '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> | &copy; OpenStreetMap',
    subdomains: 'abc',
    maxZoom: 17,
    className: 'basemap-tiles',
  });

  const satellite = L.tileLayer(
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
  map.createPane('underlayPane');
  const underlayPane = map.getPane('underlayPane');
  if (underlayPane) {
    underlayPane.style.zIndex = '150';
    underlayPane.style.pointerEvents = 'none';
  }
  offlineLandLayer('underlayPane').addTo(map);

  basemaps[current].layer.addTo(map);

  const setBasemap = (id: BasemapId) => {
    if (id === current) return;
    map.removeLayer(basemaps[current].layer);
    current = id;
    basemaps[current].layer.addTo(map);
    map.getContainer().dataset.basemap = id;
  };

  return {
    setBasemap,
    getBasemap: () => current,
  };
}
