/**
 * Viewport OSM water inspection overlay (?russiaWaterTopologyDebug=1).
 * Catalog bboxes on overview; live Overpass on closer frames.
 * Does not write WRG, edges, or inferred connections.
 */
import L from 'leaflet';
import waterBodies from './water-bodies.json';
import {
  INSPECT_LEGEND as C,
  LOCAL_EXTRACT_COVERAGE,
  OSM_WATER_INSPECT_MIN_ZOOM,
  buildInspectOverpassQuery,
  catalogFeaturesFromBodies,
  buildInspectViewportStats,
  formatInspectPopup,
  formatInspectStatsHtml,
  inspectDetailLevel,
  parseOverpassToInspectFeatures,
  russiaWaterTopologyDebugEnabledFromSearchParams,
  simplifyInspectFeatureForDisplay,
  type InspectDetail,
  type InspectFeature,
  type InspectLayer,
  type InspectProps,
  type OverpassInspectElement,
} from './osm-water-inspect';

export { russiaWaterTopologyDebugEnabledFromSearchParams };

const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const EUROPE_VIEW: L.LatLngBoundsExpression = [
  [48.2, 27.0],
  [66.8, 55.0],
];

type NamedWater = { n: string; k: string; b: [number, number, number, number] };

const JUMPS: NamedWater[] = (waterBodies as NamedWater[]).filter((w) => {
  const [west, south, east] = w.b;
  return west >= 26 && east <= 56 && south >= 44;
});

function pathStyle(layer: InspectLayer): L.PathOptions {
  if (layer === 'polygon-lake') {
    return { color: C.LAKE, weight: 1, fillColor: C.POLYGON, fillOpacity: 0.28, opacity: 0.85 };
  }
  if (layer === 'polygon-reservoir') {
    return { color: C.RESERVOIR, weight: 1, fillColor: C.RESERVOIR, fillOpacity: 0.22, opacity: 0.9 };
  }
  if (layer === 'polygon-river-area' || layer === 'polygon-other') {
    return { color: C.RIVER_AREA, weight: 1, fillColor: C.RIVER_AREA, fillOpacity: 0.2, opacity: 0.85 };
  }
  if (layer === 'centerline-river') {
    return { color: C.CENTERLINE_RIVER, weight: 3, opacity: 0.95, fill: false };
  }
  if (layer === 'centerline-canal') {
    return { color: C.CENTERLINE_CANAL, weight: 3, opacity: 0.95, fill: false };
  }
  if (layer === 'centerline-stream' || layer === 'centerline-other') {
    return { color: C.CENTERLINE_STREAM, weight: 2, opacity: 0.85, fill: false };
  }
  if (layer === 'mp-outer') {
    return { color: C.OUTER, weight: 3, opacity: 0.95, fill: false, dashArray: '6 4' };
  }
  if (layer === 'mp-inner') {
    return {
      color: C.INNER,
      weight: 2,
      fillColor: '#fda4af',
      fillOpacity: 0.15,
      opacity: 1,
      dashArray: '4 3',
    };
  }
  if (layer === 'catalog-water') {
    return {
      color: C.EXTRACT,
      weight: 1,
      fillColor: C.CATALOG,
      fillOpacity: 0.22,
      dashArray: '3 2',
      opacity: 0.85,
    };
  }
  return { color: C.EXTRACT, weight: 2, dashArray: '6 4', fill: false, opacity: 0.8 };
}

async function fetchOverpass(
  query: string,
  timeoutMs = 28000,
): Promise<OverpassInspectElement[]> {
  const body = `data=${encodeURIComponent(query)}`;
  let lastErr: unknown;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const data = JSON.parse(text) as { elements?: OverpassInspectElement[] };
      return data.elements ?? [];
    } catch (err) {
      lastErr = err;
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('Overpass failed');
}

function switchToSatellite(): void {
  const sel = document.querySelector<HTMLSelectElement>('#basemap-select');
  if (!sel || sel.value === 'satellite') return;
  sel.value = 'satellite';
  sel.dispatchEvent(new Event('change'));
}

export async function mountOsmWaterInspectOverlay(map: L.Map): Promise<void> {
  switchToSatellite();
  map.createPane('osmInspectFill');
  map.createPane('osmInspectLine');
  const fillPane = map.getPane('osmInspectFill');
  const linePane = map.getPane('osmInspectLine');
  if (fillPane) fillPane.style.zIndex = '430';
  if (linePane) linePane.style.zIndex = '450';

  const coverage = L.layerGroup();
  for (const box of LOCAL_EXTRACT_COVERAGE) {
    L.rectangle(
      [
        [box.south, box.west],
        [box.north, box.east],
      ],
      {
        pane: 'osmInspectLine',
        color: C.EXTRACT,
        weight: 2,
        dashArray: '8 6',
        fill: false,
        opacity: 0.75,
      },
    )
      .bindPopup(`<div class="osm-inspect-popup"><p><strong>${box.name}</strong></p><p>локальный water.objects extract. Не live OSM.</p></div>`)
      .addTo(coverage);
  }
  coverage.addTo(map);

  const dataGroup = L.layerGroup().addTo(map);
  let fetchGen = 0;
  let timer: number | null = null;

  const panel = document.createElement('aside');
  panel.className = 'osm-inspect-legend';
  panel.innerHTML = `<strong>OSM water inspect</strong>
<div class="osm-inspect-muted">Европейская Россия · исходные OSM объекты · без topology / WRG. Обзор = catalog bbox; live OSM с z≥${OSM_WATER_INSPECT_MIN_ZOOM}.</div>
<p id="osm-inspect-status" class="osm-inspect-muted">широкий кадр — справочные bbox; live OSM с z≥${OSM_WATER_INSPECT_MIN_ZOOM}</p>
<div id="osm-inspect-stats"></div>
<div class="osm-inspect-swatches">
  <div><i style="background:${C.POLYGON}"></i> A. water polygon / lake</div>
  <div><i style="background:${C.RESERVOIR}"></i> reservoir polygon</div>
  <div><i style="background:${C.RIVER_AREA}"></i> river-area polygon</div>
  <div><i style="background:${C.CENTERLINE_RIVER}"></i> B. river centerline (waterway=river)</div>
  <div><i style="background:${C.CENTERLINE_CANAL}"></i> canal centerline</div>
  <div><i style="background:${C.CENTERLINE_STREAM}"></i> stream centerline</div>
  <div><i style="background:${C.OUTER};outline:1px dashed ${C.OUTER}"></i> C. MP outer boundary (не centerline)</div>
  <div><i style="background:${C.INNER}"></i> C. MP inner / hole</div>
  <div><i style="background:${C.CATALOG}"></i> catalog bbox (не OSM)</div>
  <div><i style="background:${C.EXTRACT}"></i> local extract coverage</div>
</div>
<label><input type="checkbox" data-k="poly" checked> polygons / river-area</label>
<label><input type="checkbox" data-k="line" checked> centerlines</label>
<label><input type="checkbox" data-k="boundary" checked> MP outer/inner boundary</label>
<label><input type="checkbox" data-k="inner" checked> holes fill</label>
<label><input type="checkbox" data-k="cov" checked> extract coverage</label>
<div class="osm-inspect-jumps"></div>`;
  document.body.appendChild(panel);

  const statusEl = panel.querySelector('#osm-inspect-status')!;
  const statsEl = panel.querySelector('#osm-inspect-stats')!;
  const jumps = panel.querySelector('.osm-inspect-jumps')!;
  const wanted = [
    'Селигер',
    'Ладожское озеро',
    'Онежское озеро',
    'Белое озеро',
    'Рыбинское водохранилище',
    'Горьковское водохранилище',
    'Нева',
    'Волхов',
    'Свирь',
    'Волга',
    'Чудское озеро',
  ];
  for (const name of wanted) {
    const row = JUMPS.find((w) => w.n === name);
    if (!row) continue;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'osm-inspect-jump';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      const [west, south, east, north] = row.b;
      map.fitBounds(
        [
          [south, west],
          [north, east],
        ],
        { maxZoom: 11, animate: false, padding: [24, 24] },
      );
    });
    jumps.appendChild(btn);
  }
  const gulf = document.createElement('button');
  gulf.type = 'button';
  gulf.className = 'osm-inspect-jump';
  gulf.textContent = 'Финский залив';
  gulf.addEventListener('click', () => {
    map.fitBounds(
      [
        [59.7, 27.6],
        [60.35, 30.4],
      ],
      { maxZoom: 10, animate: false },
    );
  });
  jumps.appendChild(gulf);
  const vb = document.createElement('button');
  vb.type = 'button';
  vb.className = 'osm-inspect-jump';
  vb.textContent = 'Волго-Балт';
  vb.addEventListener('click', () => {
    map.fitBounds(
      [
        [59.77, 30.36],
        [61.27, 35.84],
      ],
      { maxZoom: 9, animate: false },
    );
  });
  jumps.appendChild(vb);

  const inspectJumps: Array<{ label: string; south: number; west: number; north: number; east: number; maxZoom: number }> = [
    { label: 'r399081 Селигер', south: 56.85, west: 32.9, north: 57.2, east: 33.55, maxZoom: 11 },
    { label: 'r2406778 river-area', south: 56.8127, west: 33.4526, north: 56.8542, east: 33.5469, maxZoom: 16 },
    { label: 'r2580469 river-area', south: 56.9043, west: 33.2741, north: 57.0312, east: 33.4375, maxZoom: 13 },
    { label: 'r379295 Селижаровка', south: 56.8524, west: 33.2755, north: 57.0309, east: 33.4584, maxZoom: 13 },
  ];
  for (const j of inspectJumps) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'osm-inspect-jump';
    btn.textContent = j.label;
    btn.addEventListener('click', () => {
      map.fitBounds(
        [
          [j.south, j.west],
          [j.north, j.east],
        ],
        { maxZoom: j.maxZoom, animate: false, padding: [28, 28] },
      );
    });
    jumps.appendChild(btn);
  }

  const layerOn = { poly: true, line: true, inner: true, boundary: true, cov: true };
  panel.querySelectorAll<HTMLInputElement>('input[data-k]').forEach((input) => {
    input.addEventListener('change', () => {
      const k = input.dataset.k as keyof typeof layerOn;
      layerOn[k] = input.checked;
      if (k === 'cov') {
        if (input.checked) coverage.addTo(map);
        else map.removeLayer(coverage);
        return;
      }
      dataGroup.eachLayer((ly) => {
        const feat = (ly as L.Layer & { feature?: GeoJSON.Feature }).feature;
        const layer = feat?.properties?.layer as InspectLayer | undefined;
        if (!layer) return;
        const isInnerFill = layer === 'mp-inner';
        const isBoundary = layer === 'mp-outer' || layer === 'mp-inner';
        const isLine = layer.startsWith('centerline');
        const isPoly = layer.startsWith('polygon') || layer === 'catalog-water';
        const show =
          (isInnerFill && layerOn.inner) ||
          (isBoundary && layerOn.boundary) ||
          (isLine && layerOn.line) ||
          (isPoly && layerOn.poly);
        (ly as L.Path).setStyle({ opacity: show ? 0.95 : 0, fillOpacity: show && !isLine ? 0.22 : 0 });
      });
    });
  });

  const render = (features: InspectFeature[]) => {
    dataGroup.clearLayers();
    const fc: GeoJSON.FeatureCollection = {
      type: 'FeatureCollection',
      features: features.map(simplifyInspectFeatureForDisplay),
    };
    L.geoJSON(fc, {
      pane: 'osmInspectFill',
      filter: (f) => {
        const layer = f.properties?.layer as InspectLayer;
        if (layer.startsWith('polygon') || layer === 'catalog-water') return true;
        return layer === 'mp-inner' && f.geometry?.type === 'Polygon';
      },
      style: (f) => pathStyle((f?.properties?.layer as InspectLayer) || 'polygon-other'),
      onEachFeature: (f, ly) => {
        ly.bindPopup(formatInspectPopup(f.properties as InspectProps), {
          maxWidth: 500,
          maxHeight: 460,
          className: 'osm-inspect-popup-wrap',
        });
      },
    }).addTo(dataGroup);
    L.geoJSON(fc, {
      pane: 'osmInspectLine',
      filter: (f) => {
        const layer = String(f.properties?.layer || '');
        if (layer.startsWith('centerline') || layer === 'mp-outer') return true;
        return layer === 'mp-inner' && f.geometry?.type === 'LineString';
      },
      style: (f) => pathStyle((f?.properties?.layer as InspectLayer) || 'centerline-other'),
      onEachFeature: (f, ly) => {
        ly.bindPopup(formatInspectPopup(f.properties as InspectProps), {
          maxWidth: 500,
          maxHeight: 460,
          className: 'osm-inspect-popup-wrap',
        });
      },
    }).addTo(dataGroup);
  };

  const refresh = () => {
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void loadViewport();
    }, 450);
  };

  async function loadViewport(): Promise<void> {
    const z = map.getZoom();
    const b = map.getBounds();
    const south = b.getSouth();
    const west = b.getWest();
    const north = b.getNorth();
    const east = b.getEast();
    const detail: InspectDetail = inspectDetailLevel(z, south, west, north, east);

    if (detail === 'catalog') {
      fetchGen += 1;
      const catalog = catalogFeaturesFromBodies(waterBodies as NamedWater[]);
      render(catalog);
      const stats = buildInspectViewportStats(catalog, 'catalog');
      statsEl.innerHTML = formatInspectStatsHtml(stats);
      statusEl.textContent =
        z < OSM_WATER_INSPECT_MIN_ZOOM
          ? `каталог ${catalog.length} bbox (не OSM). z≥${OSM_WATER_INSPECT_MIN_ZOOM} — live OSM named majors.`
          : `каталог ${catalog.length} bbox (не OSM). Кадр шире Overpass; приблизьте район (Ладога, Селигер, Волга…).`;
      return;
    }

    const gen = ++fetchGen;
    statusEl.textContent = `загрузка OSM Overpass (${detail}) для текущего viewport…`;
    try {
      const timeoutMs = detail === 'major' ? 45000 : 28000;
      const els = await fetchOverpass(
        buildInspectOverpassQuery(south, west, north, east, detail),
        timeoutMs,
      );
      if (gen !== fetchGen) return;
      const features = parseOverpassToInspectFeatures(els);
      render(features);
      const stats = buildInspectViewportStats(features, 'overpass');
      statsEl.innerHTML = formatInspectStatsHtml(stats);
      const extra =
        detail === 'streams'
          ? ''
          : detail === 'full'
            ? ' · stream скрыты до z11'
            : ' · named majors как OSM bbox (не полное кольцо)';
      statusEl.textContent = `OSM ${detail} · zoom ${z.toFixed(1)}${extra}. Совпадения на глаз, связи не вычисляются.`;
    } catch (err) {
      if (gen !== fetchGen) return;
      const msg = err instanceof Error ? err.message : String(err);
      statusEl.textContent = `Overpass не ответил: ${msg}. Показан каталог. Повторите приближение.`;
      const catalog = catalogFeaturesFromBodies(waterBodies as NamedWater[]);
      render(catalog);
      statsEl.innerHTML = formatInspectStatsHtml(buildInspectViewportStats(catalog, 'catalog'));
    }
  }

  map.fitBounds(EUROPE_VIEW, { animate: false, maxZoom: 6 });
  map.on('moveend', refresh);
  void loadViewport();
}
