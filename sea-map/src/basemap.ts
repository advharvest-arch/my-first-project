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

type TileSource = {
  url: string;
  options?: L.TileLayerOptions;
};

/** If a tile hasn't loaded by then, try the next URL (hangs never fire tileerror). */
const TILE_FAIL_MS = 3500;

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

function tileUrl(template: string, coords: L.Coords, subdomains = 'abcd'): string {
  const { z, x, y } = coords;
  const s = subdomains[Math.abs(x + y) % subdomains.length] ?? 'a';
  return L.Util.template(template, { s, r: L.Browser.retina ? '@2x' : '', z, x, y });
}

/**
 * Raster tiles with ordered failover.
 * OSM.org often rate-limits apps; Carto/Esri CDNs are faster and more reliable.
 * Also recovers from hung requests (no tileerror) via a per-tile timeout.
 */
function rasterLayer(sources: TileSource[], shared: L.TileLayerOptions = {}): L.TileLayer {
  if (!sources.length) throw new Error('rasterLayer: no sources');
  const primary = sources[0]!;
  const layer = L.tileLayer(primary.url, {
    updateWhenIdle: false,
    updateWhenZooming: true,
    keepBuffer: 4,
    crossOrigin: true,
    ...shared,
    ...primary.options,
    className: `basemap-tiles ${shared.className ?? ''}`.trim(),
  });

  if (sources.length < 2) return layer;

  const armFailover = (tile: HTMLImageElement, coords: L.Coords) => {
    if (tile.dataset.failoverArmed === '1') return;
    tile.dataset.failoverArmed = '1';
    let idx = 0;

    const tryNext = () => {
      idx += 1;
      if (idx >= sources.length) return;
      const src = sources[idx]!;
      const subs =
        (src.options?.subdomains as string | undefined) ??
        (shared.subdomains as string | undefined) ??
        'abcd';
      tile.dataset.fallbackTried = String(idx);
      tile.src = tileUrl(src.url, coords, typeof subs === 'string' ? subs : 'abcd');
      watch();
    };

    const onError = () => tryNext();

    let timer = 0;
    const clear = () => {
      if (timer) window.clearTimeout(timer);
      timer = 0;
      tile.removeEventListener('error', onError);
      tile.removeEventListener('load', clear);
    };

    const watch = () => {
      clear();
      // Already failed before listeners attached (cached error / instant 403).
      if (tile.complete && tile.naturalWidth === 0) {
        tryNext();
        return;
      }
      if (tile.complete && tile.naturalWidth > 0) return;
      tile.addEventListener('error', onError);
      tile.addEventListener('load', clear);
      timer = window.setTimeout(() => {
        // Still blank / broken after timeout → next CDN.
        if (!tile.complete || tile.naturalWidth === 0) tryNext();
      }, TILE_FAIL_MS);
    };

    watch();
  };

  layer.on('tileloadstart', (e) => {
    const tile = (e as L.TileEvent).tile as HTMLImageElement | undefined;
    const coords = (e as L.TileEvent).coords;
    if (!tile || !coords) return;
    armFailover(tile, coords);
  });

  layer.on('tileerror', (e) => {
    const tile = (e as L.TileErrorEvent).tile as HTMLImageElement | undefined;
    const coords = (e as L.TileErrorEvent).coords;
    if (!tile || !coords) return;
    // Ensure failover is armed even if loadstart was missed.
    armFailover(tile, coords);
    // Force immediate advance when the browser already reported error.
    if (tile.dataset.fallbackTried == null || tile.dataset.fallbackTried === '0') {
      tile.dispatchEvent(new Event('error'));
    }
  });

  return layer;
}

export function createBasemaps(): Record<BasemapId, BasemapDef> {
  // OSM standard first: local `name` tags → Cyrillic labels across Russia.
  // OsmAnd HD also renders Russian place names well; Carto/Esri as last resort.
  const osm = rasterLayer(
    [
      {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { maxZoom: 19 },
      },
      {
        url: 'https://tile.osmand.net/hd/{z}/{x}/{y}.png',
        options: { maxZoom: 19 },
      },
      {
        url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
        options: { subdomains: 'abcd', maxZoom: 20 },
      },
    ],
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    },
  );

  // Esri topo is far more reliable than OpenTopoMap (often overloaded).
  const topo = rasterLayer(
    [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
        options: { maxZoom: 19 },
      },
      {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { maxZoom: 19 },
      },
      {
        url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
        options: { subdomains: 'abc', maxZoom: 17 },
      },
    ],
    {
      attribution:
        'Tiles &copy; Esri | &copy; OpenStreetMap | OpenTopoMap',
      maxZoom: 19,
    },
  );

  const satellite = rasterLayer(
    [
      {
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        options: { maxZoom: 19 },
      },
      {
        url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
        options: { maxZoom: 19 },
      },
    ],
    {
      attribution: 'Tiles &copy; Esri | &copy; OpenStreetMap',
      maxZoom: 19,
    },
  );

  const offline = L.layerGroup([offlineLandLayer()]);

  return {
    osm: { id: 'osm', label: 'Карта (русские названия)', layer: osm },
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
