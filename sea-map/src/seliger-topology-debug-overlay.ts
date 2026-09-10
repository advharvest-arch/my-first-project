/**
 * Visual overlay of the PR #86 Seliger topology graph.
 * Diagnostic only: no WRG, routing, DB, or discovery.
 */
import L from 'leaflet';
import {
  TOPOLOGY_LEGEND,
  formatTopologyConnectionPopup,
  formatTopologyWaterPopup,
  isConnectionLayer,
  type TopologyDebugCollection,
  type TopologyDebugProps,
} from './seliger-topology-debug';

export const SELIGER_TOPOLOGY_DEBUG_GEOJSON_URL = `${import.meta.env.BASE_URL}seliger-topology-debug.geojson`;

export {
  seligerTopologyDebugEnabledFromSearchParams,
  formatTopologyConnectionPopup,
  formatTopologyWaterPopup,
} from './seliger-topology-debug';

const C = TOPOLOGY_LEGEND;

function attachPopup(layer: L.Layer, props: TopologyDebugProps): void {
  const html = isConnectionLayer(props.layer)
    ? formatTopologyConnectionPopup(props)
    : formatTopologyWaterPopup(props);
  layer.bindPopup(html, { maxWidth: 380, className: 'seliger-topo-popup-wrap' });
}

function pathStyle(props: TopologyDebugProps): L.PathOptions {
  const layer = props.layer;
  if (layer === 'seed-outer') {
    return {
      color: C.SEED,
      weight: 1,
      opacity: 0.85,
      fillColor: C.SEED,
      fillOpacity: 0.28,
    };
  }
  if (layer === 'confirmed-feature') {
    return {
      color: C.CONFIRMED_WATER,
      weight: 1,
      opacity: 0.9,
      fillColor: C.CONFIRMED_WATER,
      fillOpacity: 0.22,
    };
  }
  if (layer === 'confirmed-waterway' || layer === 'waterway') {
    return { color: C.CONFIRMED_WATER, weight: 2, opacity: 0.7, fill: false };
  }
  if (layer === 'waterway-connector') {
    return { color: C.WATERWAY_CONNECTOR, weight: 5, opacity: 0.95, fill: false };
  }
  if (layer === 'nearby-candidate') {
    return {
      color: C.NEARBY_CANDIDATE,
      weight: 2,
      opacity: 1,
      dashArray: '6 4',
      fillColor: C.NEARBY_CANDIDATE,
      fillOpacity: 0.18,
    };
  }
  if (layer === 'island-water') {
    return {
      color: C.ISLAND_WATER,
      weight: 2,
      opacity: 1,
      fillColor: C.ISLAND_WATER,
      fillOpacity: 0.35,
    };
  }
  if (layer === 'portage-candidate') {
    return {
      color: C.PORTAGE_CANDIDATE,
      weight: 3,
      opacity: 0.95,
      dashArray: '4 4',
      fill: false,
    };
  }
  if (layer === 'uncertain-connection') {
    return {
      color: C.UNCERTAIN,
      weight: 3,
      opacity: 0.9,
      dashArray: '2 6',
      fill: false,
    };
  }
  if (layer === 'osm-contour-inner') {
    return {
      color: C.OSM_CONTOUR,
      weight: 1.5,
      opacity: 0.95,
      fillColor: '#fde68a',
      fillOpacity: 0.12,
    };
  }
  if (layer === 'osm-contour-outer') {
    return { color: C.SEED, weight: 3, opacity: 0.95, fill: false };
  }
  return { color: '#94a3b8', weight: 1, opacity: 0.7, fill: false };
}

function addLayerFromFilter(
  map: L.Map,
  fc: TopologyDebugCollection,
  pane: string,
  pred: (layer: string | undefined) => boolean,
  pointToLayer?: (feature: GeoJSON.Feature, latlng: L.LatLng) => L.Layer,
): L.GeoJSON {
  return L.geoJSON(fc as GeoJSON.GeoJsonObject, {
    pane,
    filter: (feature) => pred(feature.properties?.layer),
    style: (feature) => pathStyle((feature?.properties ?? {}) as TopologyDebugProps),
    pointToLayer,
    onEachFeature: (feature, layer) => {
      attachPopup(layer, (feature.properties ?? {}) as TopologyDebugProps);
    },
  }).addTo(map);
}

function switchToSatellite(): void {
  const sel = document.querySelector<HTMLSelectElement>('#basemap-select');
  if (!sel) return;
  if (sel.value === 'satellite') return;
  sel.value = 'satellite';
  sel.dispatchEvent(new Event('change'));
}

function addPanel(
  map: L.Map,
  groups: Record<string, L.Layer>,
  focusLayer: L.GeoJSON,
): void {
  if (document.querySelector('.seliger-topo-legend')) return;
  const el = document.createElement('aside');
  el.className = 'seliger-topo-legend';
  el.innerHTML = `<strong>Селигер · topology debug</strong>
<div class="seliger-topo-muted">PR #86 graph · без новых связей</div>
<label><input type="checkbox" data-layer="connections" checked> confirmed connections</label>
<label><input type="checkbox" data-layer="candidates" checked> candidates / nearby</label>
<label><input type="checkbox" data-layer="island" checked> island water</label>
<label><input type="checkbox" data-layer="contours" checked> OSM contours</label>
<label><input type="checkbox" data-layer="labels" checked> focus labels</label>
<div class="seliger-topo-swatches">
  <div><i style="background:${C.DIRECT_OSM}"></i> DIRECT_OSM</div>
  <div><i style="background:${C.WATERWAY_CONNECTOR}"></i> WATERWAY_CONNECTOR</div>
  <div><i style="background:${C.NEARBY_CANDIDATE}"></i> NEARBY CANDIDATE</div>
  <div><i style="background:${C.PORTAGE_CANDIDATE}"></i> PORTAGE CANDIDATE</div>
  <div><i style="background:${C.UNCERTAIN}"></i> UNCERTAIN</div>
  <div><i style="background:${C.ISLAND_WATER}"></i> ISLAND WATER</div>
</div>
<div class="seliger-topo-muted">подложка: «Спутник» в панели слева</div>
<div class="seliger-topo-focus"></div>`;
  document.body.appendChild(el);

  const toggle = (name: string, on: boolean) => {
    const layer = groups[name];
    if (!layer) return;
    if (on && !map.hasLayer(layer)) layer.addTo(map);
    if (!on && map.hasLayer(layer)) map.removeLayer(layer);
  };

  el.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((input) => {
    input.addEventListener('change', () => {
      const key = input.dataset.layer;
      if (key === 'connections') {
        toggle('connectors', input.checked);
        toggle('direct', input.checked);
      } else if (key === 'candidates') {
        toggle('nearby', input.checked);
        toggle('portage', input.checked);
        toggle('uncertain', input.checked);
      } else if (key === 'island') {
        toggle('island', input.checked);
      } else if (key === 'contours') {
        toggle('contours', input.checked);
      } else if (key === 'labels') {
        toggle('labels', input.checked);
      }
    });
  });

  const box = el.querySelector('.seliger-topo-focus');
  if (box) {
    focusLayer.eachLayer((layer) => {
      const feature = (layer as L.Layer & { feature?: GeoJSON.Feature }).feature;
      const props = (feature?.properties ?? {}) as TopologyDebugProps;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `seliger-topo-jump seliger-topo-jump--${props.status || 'other'}`;
      btn.textContent = props.name || osmFallback(props);
      btn.addEventListener('click', () => {
        const ll = (layer as L.Marker).getLatLng?.();
        if (ll) map.setView(ll, Math.max(map.getZoom(), 14), { animate: false });
        (layer as L.Layer).openPopup?.();
      });
      box.appendChild(btn);
    });
  }
}

function osmFallback(props: TopologyDebugProps): string {
  if (props.osm_type === 'relation') return `r${props.osm_id}`;
  if (props.osm_type === 'way') return `w${props.osm_id}`;
  return `osm:${props.osm_id}`;
}

export async function mountSeligerTopologyDebugOverlay(map: L.Map): Promise<{
  seedOuters: number;
  innerPolygons: number;
}> {
  switchToSatellite();
  const res = await fetch(SELIGER_TOPOLOGY_DEBUG_GEOJSON_URL);
  if (!res.ok) {
    throw new Error(`seliger topology debug geojson HTTP ${res.status}`);
  }
  const fc = (await res.json()) as TopologyDebugCollection;

  map.createPane('seligerTopoFill');
  map.createPane('seligerTopoLine');
  map.createPane('seligerTopoPoint');
  const fillPane = map.getPane('seligerTopoFill');
  const linePane = map.getPane('seligerTopoLine');
  const pointPane = map.getPane('seligerTopoPoint');
  if (fillPane) fillPane.style.zIndex = '430';
  if (linePane) linePane.style.zIndex = '450';
  if (pointPane) pointPane.style.zIndex = '470';

  const seed = addLayerFromFilter(
    map,
    fc,
    'seligerTopoFill',
    (layer) => layer === 'seed-outer',
  );
  const confirmed = addLayerFromFilter(
    map,
    fc,
    'seligerTopoFill',
    (layer) => layer === 'confirmed-feature' || layer === 'confirmed-waterway' || layer === 'waterway',
  );
  const island = addLayerFromFilter(
    map,
    fc,
    'seligerTopoFill',
    (layer) => layer === 'island-water',
  );
  const nearby = addLayerFromFilter(
    map,
    fc,
    'seligerTopoFill',
    (layer) => layer === 'nearby-candidate',
  );
  const contours = addLayerFromFilter(
    map,
    fc,
    'seligerTopoLine',
    (layer) => layer === 'osm-contour-inner' || layer === 'osm-contour-outer',
  );
  const connectors = addLayerFromFilter(
    map,
    fc,
    'seligerTopoLine',
    (layer) => layer === 'waterway-connector',
  );
  const portage = addLayerFromFilter(
    map,
    fc,
    'seligerTopoLine',
    (layer) => layer === 'portage-candidate',
  );
  const uncertain = addLayerFromFilter(
    map,
    fc,
    'seligerTopoLine',
    (layer) => layer === 'uncertain-connection',
  );
  const direct = addLayerFromFilter(
    map,
    fc,
    'seligerTopoPoint',
    (layer) => layer === 'direct-osm-node',
    (_feature, latlng) =>
      L.circleMarker(latlng, {
        pane: 'seligerTopoPoint',
        radius: 5,
        color: '#854d0e',
        weight: 1,
        fillColor: C.DIRECT_OSM,
        fillOpacity: 0.95,
      }),
  );
  const labels = addLayerFromFilter(
    map,
    fc,
    'seligerTopoPoint',
    (layer) => layer === 'focus-label',
    (feature, latlng) => {
      const props = (feature.properties ?? {}) as TopologyDebugProps;
      const status = props.status || 'other';
      return L.marker(latlng, {
        pane: 'seligerTopoPoint',
        icon: L.divIcon({
          className: `seliger-topo-label seliger-topo-label--${status}`,
          html: `<span>${(props.name || osmFallback(props))
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')}</span>`,
          iconSize: [1, 1],
          iconAnchor: [0, 0],
        }),
      });
    },
  );

  const bounds = seed.getBounds();
  if (confirmed.getBounds().isValid()) bounds.extend(confirmed.getBounds());
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.06), { maxZoom: 11, animate: false });
  }

  addPanel(map, { connectors, direct, nearby, portage, uncertain, island, contours, labels }, labels);
  return {
    seedOuters: fc.properties?.seed_outers ?? 0,
    innerPolygons: fc.properties?.inner_polygons ?? 0,
  };
}
