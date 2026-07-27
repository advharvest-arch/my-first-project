import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { attachBasemapControl, createBasemaps, type BasemapId } from './basemap';
import {
  etaHours,
  formatDuration,
  formatKm,
  haversineKm,
  pathLengthKm,
  type LngLat,
} from './geo';
import { PORTS, formatCoords, nearestPortName } from './ports';
import { measureWaterChain, prefetchWaterBbox, prefetchWaterNear } from './waterways';
import './style.css';

type AppMode = 'sea' | 'inland' | 'ruler';
type Point = { lon: number; lat: number; label: string };

const KM_PER_KNOT = 1.852;

const INLAND_PRESETS: Array<{ label: string; a: LngLat; b: LngLat; zoom: number }> = [
  {
    label: 'Москва-река',
    a: { lon: 37.505, lat: 55.742 },
    b: { lon: 37.645, lat: 55.749 },
    zoom: 12,
  },
  {
    label: 'Волга (Н.Новгород)',
    a: { lon: 43.95, lat: 56.33 },
    b: { lon: 44.15, lat: 56.29 },
    zoom: 11,
  },
  {
    label: 'Куйбышевское вдхр.',
    a: { lon: 48.42, lat: 54.36 },
    b: { lon: 48.55, lat: 54.4 },
    zoom: 10,
  },
];

const mapEl = document.getElementById('map');
if (!mapEl) throw new Error('Map container #map not found');

const map = L.map(mapEl, {
  worldCopyJump: true,
  minZoom: 2,
  maxZoom: 19,
  zoomControl: false,
  attributionControl: true,
}).setView([55.75, 37.62], 5);

map.getContainer().style.cursor = 'default';
L.control.zoom({ position: 'bottomright' }).addTo(map);

const basemaps = createBasemaps();
const basemapControl = attachBasemapControl(map, basemaps, 'osm');

const refreshSize = () => map.invalidateSize({ animate: false });
requestAnimationFrame(refreshSize);
setTimeout(refreshSize, 100);
setTimeout(refreshSize, 500);
window.addEventListener('resize', refreshSize);
window.addEventListener('orientationchange', refreshSize);

const drawLayer = L.layerGroup().addTo(map);

const originInput = document.querySelector<HTMLInputElement>('#origin-input')!;
const destInput = document.querySelector<HTMLInputElement>('#dest-input')!;
const hintEl = document.querySelector<HTMLParagraphElement>('#hint')!;
const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const statsEl = document.querySelector<HTMLElement>('#stats')!;
const distanceEl = document.querySelector<HTMLElement>('#stat-distance')!;
const etaEl = document.querySelector<HTMLElement>('#stat-eta')!;
const passagesEl = document.querySelector<HTMLElement>('#stat-passages')!;
const routeBtn = document.querySelector<HTMLButtonElement>('#route-btn')!;
const clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo-btn')!;
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const avoidSuez = document.querySelector<HTMLInputElement>('#avoid-suez')!;
const avoidPanama = document.querySelector<HTMLInputElement>('#avoid-panama')!;
const allowArctic = document.querySelector<HTMLInputElement>('#allow-arctic')!;
const presetsEl = document.querySelector<HTMLElement>('#presets')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const panelToggle = document.querySelector<HTMLButtonElement>('#panel-toggle')!;
const collapseBtn = document.querySelector<HTMLButtonElement>('#collapse-btn')!;
const basemapSelect = document.querySelector<HTMLSelectElement>('#basemap-select')!;
const seaFields = document.querySelector<HTMLElement>('#sea-fields')!;
const seaControls = document.querySelector<HTMLElement>('#sea-controls')!;
const inlandHelp = document.querySelector<HTMLElement>('#inland-help')!;
const waypointCountEl = document.querySelector<HTMLElement>('#waypoint-count')!;

let mode: AppMode = 'sea';
let origin: Point | null = null;
let destination: Point | null = null;
let pickTarget: 'origin' | 'destination' = 'origin';
let activePreset: 'origin' | 'destination' | null = null;
let waypoints: LngLat[] = [];
let busy = false;
/** Last computed route distance — used for live ETA when speed changes */
let lastDistanceKm: number | null = null;
let lastWaterLabel = '—';

function speedKmh(): number {
  return Math.max(1, Number(speedInput.value) || 20);
}

function refreshEtaFromSpeed(): void {
  if (lastDistanceKm == null || statsEl.hidden) return;
  distanceEl.textContent = formatKm(lastDistanceKm);
  etaEl.textContent = formatDuration(etaHours(lastDistanceKm, speedKmh()));
  passagesEl.textContent = lastWaterLabel;
}

function pointLabel(lon: number, lat: number): string {
  return nearestPortName(lon, lat) ?? formatCoords(lon, lat);
}

function markerIcon(kind: 'origin' | 'dest' | 'way'): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="route-marker ${kind}"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function clearStats(): void {
  statsEl.hidden = true;
  distanceEl.textContent = '—';
  etaEl.textContent = '—';
  passagesEl.textContent = '—';
  lastDistanceKm = null;
  lastWaterLabel = '—';
}

function showStats(distanceKm: number, water: string): void {
  lastDistanceKm = distanceKm;
  lastWaterLabel = water;
  distanceEl.textContent = formatKm(distanceKm);
  etaEl.textContent = formatDuration(etaHours(distanceKm, speedKmh()));
  passagesEl.textContent = water;
  statsEl.hidden = false;
}

function updateHint(): void {
  if (mode === 'sea') {
    if (!origin) hintEl.textContent = 'Море: кликните точку отправления, затем прибытия.';
    else if (!destination) hintEl.textContent = 'Море: выберите точку прибытия у порта или на воде.';
    else hintEl.textContent = 'Море: маршрут готов. Можно сменить точки или ограничения.';
  } else if (mode === 'inland') {
    hintEl.textContent =
      'Реки/озёра: два клика по воде — маршрут построится сам. Или выберите пример ниже.';
  } else {
    hintEl.textContent = 'Линейка: кликайте точки подряд. Длина — сумма отрезков в километрах.';
  }
}

function syncControls(): void {
  originInput.value = origin ? origin.label : '';
  destInput.value = destination ? destination.label : '';
  routeBtn.disabled = mode === 'sea' ? !(origin && destination) || busy : waypoints.length < 2 || busy;
  undoBtn.hidden = mode === 'sea';
  waypointCountEl.textContent = `Точек: ${waypoints.length}`;
  updateHint();
}

function redrawSeaMarkers(): void {
  drawLayer.clearLayers();
  if (origin) {
    L.marker([origin.lat, origin.lon], { icon: markerIcon('origin') })
      .bindTooltip(origin.label, { direction: 'top' })
      .addTo(drawLayer);
  }
  if (destination) {
    L.marker([destination.lat, destination.lon], { icon: markerIcon('dest') })
      .bindTooltip(destination.label, { direction: 'top' })
      .addTo(drawLayer);
  }
}

function redrawWaypoints(path?: LngLat[]): void {
  drawLayer.clearLayers();
  waypoints.forEach((p, i) => {
    L.marker([p.lat, p.lon], { icon: markerIcon(i === 0 ? 'origin' : 'way') })
      .bindTooltip(`#${i + 1}`, { direction: 'top' })
      .addTo(drawLayer);
  });
  if (path && path.length >= 2) {
    L.polyline(
      path.map((p) => [p.lat, p.lon] as L.LatLngTuple),
      { color: '#2ec4b6', weight: 5, opacity: 0.95, className: 'route-line' },
    ).addTo(drawLayer);
  } else if (waypoints.length >= 2) {
    L.polyline(
      waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple),
      { color: '#d9c3a0', weight: 2, dashArray: '4 6', opacity: 0.85 },
    ).addTo(drawLayer);
  }
}

function passageLabel(p: Passage): string {
  const mapNames: Partial<Record<Passage, string>> = {
    suez: 'Суэц',
    panama: 'Панама',
    malacca: 'Малакка',
    gibraltar: 'Гибралтар',
    dover: 'Дувр',
    babelmandeb: 'Баб-эль-Мандеб',
    babalmandab: 'Баб-эль-Мандеб',
    ormuz: 'Ормуз',
    bosporus: 'Босфор',
    kiel: 'Киль',
    corinth: 'Коринф',
    sunda: 'Зондский',
    bering: 'Берингов',
    magellan: 'Магелланов',
    cape_horn: 'Мыс Горн',
    northwest: 'СЗ проход',
    northeast: 'СВ проход',
  };
  return mapNames[p] ?? p;
}

function routeSegments(
  feature: SeaRouteFeature | SeaRouteMultiFeature,
): L.LatLngExpression[][] {
  const geom = feature.geometry;
  if (geom.type === 'MultiLineString') {
    return geom.coordinates.map((line) => line.map(([lon, lat]) => [lat, lon] as L.LatLngTuple));
  }
  return [geom.coordinates.map(([lon, lat]) => [lat, lon] as L.LatLngTuple)];
}

function drawSeaRoute(feature: SeaRouteFeature | SeaRouteMultiFeature): void {
  redrawSeaMarkers();
  const segments = routeSegments(feature);
  const style = { color: '#2ec4b6', weight: 4, opacity: 0.95, className: 'route-line' };
  const layer = L.layerGroup(segments.map((segment) => L.polyline(segment, style))).addTo(
    drawLayer,
  );
  const bounds = L.latLngBounds([]);
  layer.eachLayer((l) => {
    if (l instanceof L.Polyline) bounds.extend(l.getBounds());
  });
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { animate: true });

  const lengthKm = feature.properties.length; // kilometers
  const water = feature.properties.passages?.length
    ? feature.properties.passages.map(passageLabel).join(', ')
    : 'нет';
  showStats(lengthKm, water);
}

async function computeSeaRoute(): Promise<void> {
  if (!origin || !destination) return;
  const restrictions: Passage[] = [];
  if (avoidSuez.checked) restrictions.push('suez', 'babelmandeb');
  if (avoidPanama.checked) restrictions.push('panama');
  const kmh = speedKmh();

  busy = true;
  routeBtn.disabled = true;
  setStatus('Считаем морской маршрут…');

  try {
    const { seaRoute } = await import('searoute-ts');
    const feature = seaRoute([origin.lon, origin.lat], [destination.lon, destination.lat], {
      units: 'kilometers',
      speedKnots: kmh / KM_PER_KNOT,
      restrictions,
      allowArctic: allowArctic.checked,
      returnPassages: true,
      appendOriginDestination: true,
      antimeridian: 'split',
      maxSnapDistanceKm: 250,
    });
    drawSeaRoute(feature);
    setStatus('Морской маршрут по сети Eurostat.');
  } catch (err) {
    redrawSeaMarkers();
    clearStats();
    const name = err instanceof Error ? err.name : '';
    if (name === 'SnapFailedError') {
      setStatus('Точка слишком далеко от моря. Выберите берег или порт.', true);
    } else if (name === 'NoRouteError') {
      setStatus('Маршрут не найден. Снимите ограничения или смените точки.', true);
    } else {
      console.error(err);
      setStatus('Не удалось построить морской маршрут.', true);
    }
  } finally {
    busy = false;
    syncControls();
  }
}

async function computeInlandRoute(): Promise<void> {
  if (waypoints.length < 2 || busy) return;
  busy = true;
  routeBtn.disabled = true;
  setStatus('Строим маршрут…');

  try {
    const path = await measureWaterChain(waypoints);
    redrawWaypoints(path.points);
    const methodLabel =
      path.method === 'waterway'
        ? 'по руслу/каналу'
        : path.method === 'lake'
          ? 'по водоёму'
          : 'вода не связана';
    showStats(path.lengthKm, path.waterName ?? methodLabel);
    setStatus(
      path.method === 'direct'
        ? 'Не удалось связать водные пути. Приблизьте карту и кликните точнее по синей воде, или выберите пример ниже.'
        : `Готово: ${methodLabel}${path.waterName ? ` (${path.waterName})` : ''}.`,
      path.method === 'direct',
    );
    if (path.points.length >= 2) {
      map.fitBounds(
        L.latLngBounds(path.points.map((p) => [p.lat, p.lon] as L.LatLngTuple)).pad(0.2),
      );
    }
  } catch (err) {
    console.error(err);
    redrawWaypoints();
    const km = pathLengthKm(waypoints);
    showStats(km, 'ошибка сети');
    setStatus('Ошибка запроса OSM. Подождите пару секунд и нажмите «Проложить» ещё раз.', true);
  } finally {
    busy = false;
    syncControls();
  }
}

function computeRuler(): void {
  if (waypoints.length < 2) return;
  redrawWaypoints(waypoints);
  const km = pathLengthKm(waypoints);
  let maxLeg = 0;
  for (let i = 1; i < waypoints.length; i++) {
    maxLeg = Math.max(maxLeg, haversineKm(waypoints[i - 1]!, waypoints[i]!));
  }
  showStats(km, `${waypoints.length - 1} отр., макс. ${formatKm(maxLeg)}`);
  setStatus('Линейка: сумма отрезков между кликами.');
  map.fitBounds(L.latLngBounds(waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple)).pad(0.2));
}

function setSeaPoint(kind: 'origin' | 'destination', lon: number, lat: number, label?: string): void {
  const point: Point = { lon, lat, label: label ?? pointLabel(lon, lat) };
  if (kind === 'origin') origin = point;
  else destination = point;
  redrawSeaMarkers();
  clearStats();
  syncControls();
  setStatus('');
  if (origin && destination) void computeSeaRoute();
}

function renderPresets(): void {
  presetsEl.innerHTML = '';
  if (mode === 'sea') {
    for (const port of PORTS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = port.city;
      chip.title = port.name;
      chip.addEventListener('click', () => {
        const target = activePreset ?? (!origin ? 'origin' : 'destination');
        setSeaPoint(target, port.coords[0], port.coords[1], port.city);
        activePreset = target === 'origin' ? 'destination' : null;
        pickTarget = activePreset ?? 'origin';
        document.querySelectorAll('.chip.active').forEach((el) => el.classList.remove('active'));
        chip.classList.add('active');
      });
      presetsEl.appendChild(chip);
    }
  } else if (mode === 'inland') {
    for (const preset of INLAND_PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = preset.label;
      chip.addEventListener('click', () => {
        waypoints = [preset.a, preset.b];
        map.setView([(preset.a.lat + preset.b.lat) / 2, (preset.a.lon + preset.b.lon) / 2], preset.zoom);
        redrawWaypoints();
        syncControls();
        prefetchWaterNear(preset.a);
        prefetchWaterNear(preset.b);
        void computeInlandRoute();
      });
      presetsEl.appendChild(chip);
    }
  }
}

function setMode(next: AppMode): void {
  mode = next;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === next);
  });
  const sea = next === 'sea';
  seaFields.hidden = !sea;
  seaControls.hidden = !sea;
  inlandHelp.hidden = sea;
  undoBtn.hidden = sea;
  routeBtn.textContent = next === 'ruler' ? 'Измерить' : 'Проложить';
  speedInput.value = sea ? '25' : '20';

  origin = null;
  destination = null;
  waypoints = [];
  drawLayer.clearLayers();
  clearStats();
  renderPresets();
  syncControls();
  setStatus(
    next === 'sea'
      ? 'Кликните по карте или выберите порт.'
      : next === 'inland'
        ? 'Кликните две точки на воде или выберите пример (Москва-река / Волга / водохранилище).'
        : 'Кликайте точки для измерения в километрах.',
  );
  if (next === 'inland') warmInlandCache();
}

function warmInlandCache(): void {
  const b = map.getBounds();
  prefetchWaterBbox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
}

let inlandPrefetchTimer: number | null = null;
map.on('moveend', () => {
  if (mode !== 'inland') return;
  if (inlandPrefetchTimer != null) window.clearTimeout(inlandPrefetchTimer);
  inlandPrefetchTimer = window.setTimeout(() => warmInlandCache(), 350);
});

map.on('click', (e: L.LeafletMouseEvent) => {
  if (busy) return;
  const { lat, lng } = e.latlng;

  if (mode === 'sea') {
    if (pickTarget === 'origin' || !origin) {
      setSeaPoint('origin', lng, lat);
      pickTarget = 'destination';
    } else if (pickTarget === 'destination' || !destination) {
      setSeaPoint('destination', lng, lat);
      pickTarget = 'origin';
    } else {
      setSeaPoint('origin', lng, lat);
      destination = null;
      pickTarget = 'destination';
      redrawSeaMarkers();
      clearStats();
      syncControls();
    }
    return;
  }

  waypoints.push({ lon: lng, lat });
  clearStats();
  redrawWaypoints();
  syncControls();
  if (mode === 'inland') prefetchWaterNear({ lon: lng, lat });

  if (mode === 'inland') {
    if (waypoints.length === 1) {
      setStatus('Старт отмечен. Кликните вторую точку на той же реке/озере/водохранилище.');
    } else if (waypoints.length === 2) {
      void computeInlandRoute();
    } else {
      setStatus(`Точек: ${waypoints.length}. Нажмите «Проложить» или добавьте ещё точку.`);
    }
  } else {
    setStatus(`Точка ${waypoints.length}. Нажмите «Измерить» или продолжайте кликать.`);
  }
});

originInput.addEventListener('click', () => {
  pickTarget = 'origin';
  activePreset = 'origin';
  setStatus('Выберите отправление на карте или порт ниже.');
});

destInput.addEventListener('click', () => {
  pickTarget = 'destination';
  activePreset = 'destination';
  setStatus('Выберите прибытие на карте или порт ниже.');
});

routeBtn.addEventListener('click', () => {
  if (mode === 'sea') void computeSeaRoute();
  else if (mode === 'inland') void computeInlandRoute();
  else computeRuler();
});

undoBtn.addEventListener('click', () => {
  waypoints.pop();
  clearStats();
  redrawWaypoints();
  syncControls();
});

clearBtn.addEventListener('click', () => {
  origin = null;
  destination = null;
  waypoints = [];
  pickTarget = 'origin';
  activePreset = null;
  drawLayer.clearLayers();
  clearStats();
  syncControls();
  setStatus('');
});

speedInput.addEventListener('input', () => {
  refreshEtaFromSpeed();
});

for (const input of [avoidSuez, avoidPanama, allowArctic]) {
  input.addEventListener('change', () => {
    if (mode === 'sea' && origin && destination) void computeSeaRoute();
  });
}

basemapSelect.addEventListener('change', () => {
  basemapControl.setBasemap(basemapSelect.value as BasemapId);
  map.getContainer().style.background = basemapSelect.value === 'offline' ? '#0b3a4a' : '#cdd7d5';
});

document.querySelectorAll('.mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    setMode((btn as HTMLElement).dataset.mode as AppMode);
  });
});

panelToggle.addEventListener('click', () => panel.classList.remove('collapsed'));
collapseBtn.addEventListener('click', () => panel.classList.add('collapsed'));

function bootFromQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const qMode = params.get('mode') as AppMode | null;
  if (qMode === 'inland' || qMode === 'ruler' || qMode === 'sea') setMode(qMode);

  const demo = params.get('demo');
  if (demo && mode === 'inland') {
    const preset = INLAND_PRESETS.find((p) => p.label.toLowerCase().includes(demo.toLowerCase()));
    if (preset) {
      waypoints = [preset.a, preset.b];
      map.setView([(preset.a.lat + preset.b.lat) / 2, (preset.a.lon + preset.b.lon) / 2], preset.zoom);
      redrawWaypoints();
      syncControls();
      void computeInlandRoute();
      return;
    }
  }

  const fromKey = params.get('from')?.toLowerCase();
  const toKey = params.get('to')?.toLowerCase();
  if (!fromKey || !toKey) return;
  const from = PORTS.find(
    (p) => p.name.toLowerCase() === fromKey || p.city.toLowerCase() === fromKey,
  );
  const to = PORTS.find((p) => p.name.toLowerCase() === toKey || p.city.toLowerCase() === toKey);
  if (!from || !to) return;
  setMode('sea');
  origin = { lon: from.coords[0], lat: from.coords[1], label: from.city };
  destination = { lon: to.coords[0], lat: to.coords[1], label: to.city };
  redrawSeaMarkers();
  syncControls();
  void computeSeaRoute();
}

renderPresets();
syncControls();
setStatus('Выберите режим. Дистанция в км, скорость в км/ч.');
bootFromQuery();
