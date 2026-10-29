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

export async function mountSeligerDebugOverlay(
  map: L.Map,
  opts?: { interactive?: boolean },
): Promise<{
  outerContours: number;
  innerContours: number;
  waterAreas: number;
}> {
  const interactive = opts?.interactive !== false;
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
    interactive,
    filter: (feature) => feature.properties?.kind === 'water-area',
    style: (feature) => waterStyle(feature?.properties as SeligerDebugProps),
    onEachFeature: (feature, layer) => {
      if (interactive) attachPopup(layer, feature.properties as SeligerDebugProps);
    },
  }).addTo(map);

  const contourLayer = L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'seligerDebugPane',
    interactive,
    filter: (feature) => feature.properties?.kind === 'contour',
    style: (feature) => contourStyle(feature?.properties as SeligerDebugProps),
    onEachFeature: (feature, layer) => {
      if (interactive) attachPopup(layer, feature.properties as SeligerDebugProps);
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

const WATER_ROUTER_API_URL = '/api/route';

function addWaterRouterControls(onClear: () => void): void {
  if (document.querySelector('.water-router-controls')) return;
  const el = document.createElement('aside');
  el.className = 'seliger-debug-legend water-router-controls';
  el.innerHTML = `<strong>Water Router A → B</strong>
<div>клик 1 — точка A · клик 2 — точка B</div>
<div>ПКМ — сброс точек</div>
<button type="button" class="water-router-clear">Clear</button>`;
  el.querySelector('button')!.addEventListener('click', onClear);
  document.body.appendChild(el);
}

function showWaterRouterMessage(map: L.Map, latlng: L.LatLng, html: string): void {
  L.popup({ maxWidth: 380, className: 'seliger-debug-popup-wrap' })
    .setLatLng(latlng)
    .setContent(`<div class="seliger-debug-popup">${html}</div>`)
    .openOn(map);
}

function drawWaterRouterGeoJSON(map: L.Map, layer: L.LayerGroup, fc: WaterRouterCollection): void {
  L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'waterRouterPane',
    filter: (feature) => feature.properties?.kind === 'water-route',
    style: (feature) => {
      const p = feature?.properties as WaterRouterFeatureProps | undefined;
      return {
        color: p?.color ?? 'cyan',
        weight: 4,
        opacity: 0.95,
      };
    },
    onEachFeature: (feature, routeLayer) => {
      const raw = (feature.properties ?? {}) as Partial<WaterRouterFeatureProps>;
      const props: WaterRouterFeatureProps = {
        kind: 'water-route',
        routeId: raw.routeId ?? 'click-ab',
        label: raw.label ?? 'A → B',
        status: raw.status,
        lengthM: raw.lengthM,
        visitedFeatures: raw.visitedFeatures,
        visitedCorridors: raw.visitedCorridors,
        pointCount: raw.pointCount,
        color: raw.color,
      };
      routeLayer.bindPopup(formatWaterRouterPopup(props), {
        maxWidth: 380,
        className: 'seliger-debug-popup-wrap',
      });
    },
  }).addTo(layer);

  L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane: 'waterRouterPane',
    filter: (feature) => feature.properties?.kind === 'water-route-endpoint',
    pointToLayer: (feature, latlng) => {
      const p = feature.properties as Partial<WaterRouterFeatureProps>;
      return L.circleMarker(latlng, {
        pane: 'waterRouterPane',
        radius: p.endpointRole === 'start' ? 6 : 5,
        color: '#ffffff',
        weight: 2,
        fillColor: p.color ?? '#ef4444',
        fillOpacity: 1,
      });
    },
    onEachFeature: (feature, endpointLayer) => {
      const p = feature.properties as Partial<WaterRouterFeatureProps>;
      endpointLayer.bindTooltip(p.endpointRole === 'start' ? 'A' : 'B', { direction: 'top' });
    },
  }).addTo(layer);
}

export async function mountWaterRouterOverlay(map: L.Map): Promise<{
  routeCount: number;
}> {
  await mountSeligerDebugOverlay(map, { interactive: false });

  map.createPane('waterRouterPane');
  const pane = map.getPane('waterRouterPane');
  if (pane) pane.style.zIndex = '470';

  const layer = L.layerGroup().addTo(map);
  let start: L.LatLng | null = null;
  let pending = false;

  const clear = () => {
    layer.clearLayers();
    start = null;
    pending = false;
    map.closePopup();
  };

  const addClickMarker = (latlng: L.LatLng, label: 'A' | 'B') =>
    L.circleMarker(latlng, {
      pane: 'waterRouterPane',
      radius: label === 'A' ? 6 : 5,
      color: '#ffffff',
      weight: 2,
      fillColor: label === 'A' ? '#16a34a' : '#ef4444',
      fillOpacity: 1,
    })
      .bindTooltip(label, { direction: 'top', permanent: true })
      .addTo(layer);

  map.on('click', async (e: L.LeafletMouseEvent) => {
    if (pending) return;
    const latlng = e.latlng;
    if (!start) {
      clear();
      start = latlng;
      addClickMarker(latlng, 'A');
      return;
    }

    const a = start;
    start = null;
    addClickMarker(latlng, 'B');
    pending = true;
    try {
      const res = await fetch(WATER_ROUTER_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          start: [a.lng, a.lat],
          end: [latlng.lng, latlng.lat],
        }),
      });
      if (!res.ok) {
        const text = await res.text();
        showWaterRouterMessage(
          map,
          latlng,
          `<p><strong>Ошибка сервера</strong></p><p><code>${res.status}</code> ${text}</p>`,
        );
        return;
      }
      const fc = (await res.json()) as WaterRouterCollection & {
        properties?: { status?: string };
      };
      const status = fc.properties?.status;
      if (status && status !== 'OK') {
        showWaterRouterMessage(
          map,
          latlng,
          `<p><strong>${status}</strong></p><p>маршрут не построен</p>`,
        );
      }
      drawWaterRouterGeoJSON(map, layer, fc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showWaterRouterMessage(
        map,
        latlng,
        `<p><strong>Ошибка</strong></p><p>${msg}</p><p>Проверьте API <code>/api/route</code></p>`,
      );
    } finally {
      pending = false;
    }
  });

  map.on('contextmenu', (e: L.LeafletMouseEvent) => {
    L.DomEvent.preventDefault(e.originalEvent);
    L.DomEvent.stop(e);
    clear();
  });

  addWaterRouterControls(clear);
  return { routeCount: 0 };
}
