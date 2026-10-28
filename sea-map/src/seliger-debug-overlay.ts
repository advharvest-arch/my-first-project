/**
 * Diagnostic overlay of reconstructed OSM relation 399081 (Селигер).
 * Rings were chained by identical endpoint node ids only.
 * Does not touch WRG, BRouter, Area-Bridge, or routing topology.
 */
import L from 'leaflet';
import {
  countSeligerDebugContours,
  formatSeligerDebugPopup,
  formatWaterRouterPopup,
  type SeligerDebugCollection,
  type SeligerDebugProps,
  type WaterRouterCollection,
  type WaterRouterFeatureProps,
} from './seliger-debug';

export const SELIGER_DEBUG_GEOJSON_URL = `${import.meta.env.BASE_URL}seliger-399081-debug.geojson`;
export const WATER_ROUTER_GEOJSON_URL = `${import.meta.env.BASE_URL}seliger-water-router.geojson`;

export {
  countSeligerDebugContours,
  formatSeligerDebugPopup,
  formatWaterRouterPopup,
  seligerDebugEnabledFromSearchParams,
  waterRouterEnabledFromSearchParams,
} from './seliger-debug';
export type {
  SeligerDebugCollection,
  SeligerDebugProps,
  SeligerDebugWay,
  WaterRouterCollection,
  WaterRouterFeatureProps,
} from './seliger-debug';

function contourStyle(props: SeligerDebugProps): L.PathOptions {
  if (props.role === 'outer') {
    return {
      color: props.part === 'south' ? '#0b4f6c' : '#145f4a',
      weight: 3,
      opacity: 0.95,
      fill: false,
    };
  }
  return {
    color: '#e3a008',
    weight: 2,
    opacity: 0.95,
    fill: false,
  };
}

function waterStyle(props: SeligerDebugProps): L.PathOptions {
  return {
    color: props.part === 'south' ? '#1a6f9a' : '#1a8a72',
    weight: 1,
    opacity: 0.7,
    fillColor: props.part === 'south' ? '#2a9fd6' : '#2bb3a0',
    fillOpacity: 0.32,
  };
}

function attachPopup(layer: L.Layer, props: SeligerDebugProps): void {
  layer.bindPopup(formatSeligerDebugPopup(props), {
    maxWidth: 360,
    className: 'seliger-debug-popup-wrap',
  });
}

function addLegend(): void {
  if (document.querySelector('.seliger-debug-legend')) return;
  const el = document.createElement('aside');
  el.className = 'seliger-debug-legend';
  el.innerHTML = `<strong>Селигер OSM 399081</strong>
<div>диагностика геометрии · Полоновка не включена</div>
<div>SOUTH-OUTER + 93 inner · NORTH-OUTER + 44 inner</div>
<div>вода — заливка · острова — жёлтый контур</div>
<div>клик по контуру — way ID и теги</div>
<div>включите подложку «Спутник» для сверки</div>`;
  document.body.appendChild(el);
}

export async function mountSeligerDebugOverlay(map: L.Map): Promise<{
  outerContours: number;
  innerContours: number;
  waterAreas: number;
}> {
  const res = await fetch(SELIGER_DEBUG_GEOJSON_URL);
  if (!res.ok) {
    throw new Error(`seliger debug geojson HTTP ${res.status}`);
  }
  const fc = (await res.json()) as SeligerDebugCollection;
  const counts = countSeligerDebugContours(fc);

  map.createPane('seligerDebugPane');
  const pane = map.getPane('seligerDebugPane');
  if (pane) pane.style.zIndex = '450';

  const waterLayer = L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'seligerDebugPane',
    filter: (feature) => feature.properties?.kind === 'water-area',
    style: (feature) => waterStyle(feature?.properties as SeligerDebugProps),
    onEachFeature: (feature, layer) => {
      attachPopup(layer, feature.properties as SeligerDebugProps);
    },
  }).addTo(map);

  const contourLayer = L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'seligerDebugPane',
    filter: (feature) => feature.properties?.kind === 'contour',
    style: (feature) => contourStyle(feature?.properties as SeligerDebugProps),
    onEachFeature: (feature, layer) => {
      attachPopup(layer, feature.properties as SeligerDebugProps);
    },
  }).addTo(map);

  for (const feature of fc.features) {
    const props = feature.properties;
    if (props.kind !== 'contour' || !props.labelLonLat) continue;
    const [lon, lat] = props.labelLonLat;
    const cls =
      props.role === 'outer'
        ? 'seliger-debug-label seliger-debug-label--outer'
        : 'seliger-debug-label seliger-debug-label--inner';
    L.marker([lat, lon], {
      pane: 'seligerDebugPane',
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: cls,
        html: `<span>${props.label}</span>`,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      }),
    }).addTo(map);
  }

  const bounds = waterLayer.getBounds().extend(contourLayer.getBounds());
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.08), { maxZoom: 11, animate: false });
  }
  addLegend();
  return counts;
}

export async function mountWaterRouterOverlay(map: L.Map): Promise<{
  routeCount: number;
}> {
  await mountSeligerDebugOverlay(map);
  const res = await fetch(WATER_ROUTER_GEOJSON_URL);
  if (!res.ok) {
    throw new Error(`water router geojson HTTP ${res.status}`);
  }
  const fc = (await res.json()) as WaterRouterCollection;

  map.createPane('waterRouterPane');
  const pane = map.getPane('waterRouterPane');
  if (pane) pane.style.zIndex = '470';

  const routeLayer = L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'waterRouterPane',
    filter: (feature) => feature.properties?.kind === 'water-route',
    style: (feature) => {
      const p = feature?.properties as WaterRouterFeatureProps | undefined;
      return {
        color: p?.color ?? '#ef4444',
        weight: 4,
        opacity: 0.95,
      };
    },
    onEachFeature: (feature, layer) => {
      layer.bindPopup(
        formatWaterRouterPopup(feature.properties as WaterRouterFeatureProps),
        { maxWidth: 380, className: 'seliger-debug-popup-wrap' },
      );
    },
  }).addTo(map);

  L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'waterRouterPane',
    filter: (feature) => feature.properties?.kind === 'water-route-endpoint',
    pointToLayer: (feature, latlng) => {
      const p = feature.properties as WaterRouterFeatureProps;
      return L.circleMarker(latlng, {
        pane: 'waterRouterPane',
        radius: p.endpointRole === 'start' ? 6 : 5,
        color: '#ffffff',
        weight: 2,
        fillColor: p.color ?? '#ef4444',
        fillOpacity: 1,
      });
    },
    onEachFeature: (feature, layer) => {
      const p = feature.properties as WaterRouterFeatureProps;
      layer.bindTooltip(p.label, { direction: 'top' });
    },
  }).addTo(map);

  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.08), { maxZoom: 11, animate: false });
  }
  return { routeCount: fc.properties?.routeCount ?? 0 };
}
