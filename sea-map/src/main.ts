import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { addOfflineBasemap } from './basemap';
import { PORTS, formatCoords, nearestPortName } from './ports';
import './style.css';

type Point = { lon: number; lat: number; label: string };

const mapEl = document.getElementById('map');
if (!mapEl) {
  throw new Error('Map container #map not found');
}

const map = L.map(mapEl, {
  worldCopyJump: true,
  minZoom: 2,
  maxZoom: 10,
  zoomControl: false,
  attributionControl: true,
}).setView([20, 10], 3);

L.control.zoom({ position: 'bottomright' }).addTo(map);
addOfflineBasemap(map);

const refreshSize = () => map.invalidateSize({ animate: false });
requestAnimationFrame(refreshSize);
setTimeout(refreshSize, 100);
setTimeout(refreshSize, 500);
window.addEventListener('resize', refreshSize);
window.addEventListener('orientationchange', refreshSize);

const routeLayer = L.layerGroup().addTo(map);

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
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const avoidSuez = document.querySelector<HTMLInputElement>('#avoid-suez')!;
const avoidPanama = document.querySelector<HTMLInputElement>('#avoid-panama')!;
const allowArctic = document.querySelector<HTMLInputElement>('#allow-arctic')!;
const presetsEl = document.querySelector<HTMLElement>('#presets')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const panelToggle = document.querySelector<HTMLButtonElement>('#panel-toggle')!;

let origin: Point | null = null;
let destination: Point | null = null;
let pickTarget: 'origin' | 'destination' = 'origin';
let activePreset: 'origin' | 'destination' | null = null;

function pointLabel(lon: number, lat: number): string {
  return nearestPortName(lon, lat) ?? formatCoords(lon, lat);
}

function markerIcon(kind: 'origin' | 'dest'): L.DivIcon {
  return L.divIcon({
    className: '',
    html: `<div class="route-marker ${kind}"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });
}

function setStatus(message: string, isError = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function updateHint(): void {
  if (!origin) {
    hintEl.textContent = 'Кликните по карте: сначала точка отправления, затем прибытия.';
  } else if (!destination) {
    hintEl.textContent = 'Теперь выберите точку прибытия на воде или у порта.';
  } else {
    hintEl.textContent = 'Маршрут готов к расчёту. Можно сменить точки кликом или портами ниже.';
  }
}

function syncInputs(): void {
  originInput.value = origin ? origin.label : '';
  destInput.value = destination ? destination.label : '';
  routeBtn.disabled = !(origin && destination);
  updateHint();
}

function redrawMarkers(): void {
  routeLayer.clearLayers();
  if (origin) {
    L.marker([origin.lat, origin.lon], { icon: markerIcon('origin') })
      .bindTooltip(origin.label, { direction: 'top' })
      .addTo(routeLayer);
  }
  if (destination) {
    L.marker([destination.lat, destination.lon], { icon: markerIcon('dest') })
      .bindTooltip(destination.label, { direction: 'top' })
      .addTo(routeLayer);
  }
}

function clearRouteStats(): void {
  statsEl.hidden = true;
  distanceEl.textContent = '—';
  etaEl.textContent = '—';
  passagesEl.textContent = '—';
}

function formatDuration(hours: number): string {
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  if (d <= 0) return `${h} ч`;
  return `${d} д ${h} ч`;
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

function drawRoute(feature: SeaRouteFeature | SeaRouteMultiFeature): void {
  redrawMarkers();

  const segments = routeSegments(feature);
  const style = {
    color: '#2ec4b6',
    weight: 4,
    opacity: 0.95,
    className: 'route-line',
  };

  const layer = L.layerGroup(segments.map((segment) => L.polyline(segment, style))).addTo(
    routeLayer,
  );

  const bounds = L.latLngBounds([]);
  layer.eachLayer((l) => {
    if (l instanceof L.Polyline) bounds.extend(l.getBounds());
  });
  if (bounds.isValid()) {
    map.fitBounds(bounds.pad(0.18), { animate: true, duration: 0.8 });
  }

  const { length, durationHours, passages } = feature.properties;
  distanceEl.textContent = `${Math.round(length).toLocaleString('ru-RU')} м.миль`;
  etaEl.textContent = durationHours != null ? formatDuration(durationHours) : '—';
  passagesEl.textContent =
    passages && passages.length > 0 ? passages.map(passageLabel).join(', ') : 'нет';
  statsEl.hidden = false;
}

async function computeRoute(): Promise<void> {
  if (!origin || !destination) return;

  const restrictions: Passage[] = [];
  if (avoidSuez.checked) restrictions.push('suez', 'babelmandeb');
  if (avoidPanama.checked) restrictions.push('panama');

  const speed = Number(speedInput.value) || 14;
  setStatus('Считаем морской маршрут…');
  routeBtn.disabled = true;

  try {
    const { seaRoute } = await import('searoute-ts');
    const feature = seaRoute([origin.lon, origin.lat], [destination.lon, destination.lat], {
      units: 'nauticalmiles',
      speedKnots: speed,
      restrictions,
      allowArctic: allowArctic.checked,
      returnPassages: true,
      appendOriginDestination: true,
      antimeridian: 'split',
      maxSnapDistanceKm: 250,
    });

    drawRoute(feature);
    setStatus('Маршрут построен по судоходной сети Eurostat.');
  } catch (err) {
    redrawMarkers();
    clearRouteStats();
    const name = err instanceof Error ? err.name : '';
    if (name === 'SnapFailedError') {
      setStatus('Точка слишком далеко от моря. Выберите берег или порт.', true);
    } else if (name === 'NoRouteError') {
      setStatus('Маршрут не найден. Снимите ограничения или смените точки.', true);
    } else {
      console.error(err);
      setStatus('Не удалось построить маршрут.', true);
    }
  } finally {
    routeBtn.disabled = !(origin && destination);
  }
}

function setPoint(kind: 'origin' | 'destination', lon: number, lat: number, label?: string): void {
  const point: Point = { lon, lat, label: label ?? pointLabel(lon, lat) };
  if (kind === 'origin') origin = point;
  else destination = point;
  redrawMarkers();
  clearRouteStats();
  syncInputs();
  setStatus('');
  if (origin && destination) computeRoute();
}

map.on('click', (e: L.LeafletMouseEvent) => {
  const { lat, lng } = e.latlng;
  if (pickTarget === 'origin' || !origin) {
    setPoint('origin', lng, lat);
    pickTarget = 'destination';
  } else if (pickTarget === 'destination' || !destination) {
    setPoint('destination', lng, lat);
    pickTarget = 'origin';
  } else {
    setPoint('origin', lng, lat);
    destination = null;
    pickTarget = 'destination';
    redrawMarkers();
    clearRouteStats();
    syncInputs();
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

routeBtn.addEventListener('click', computeRoute);

clearBtn.addEventListener('click', () => {
  origin = null;
  destination = null;
  pickTarget = 'origin';
  activePreset = null;
  routeLayer.clearLayers();
  clearRouteStats();
  syncInputs();
  setStatus('');
  map.setView([20, 10], 3, { animate: true });
});

for (const input of [speedInput, avoidSuez, avoidPanama, allowArctic]) {
  input.addEventListener('change', () => {
    if (origin && destination) computeRoute();
  });
}

for (const port of PORTS) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'chip';
  chip.textContent = port.city;
  chip.title = port.name;
  chip.addEventListener('click', () => {
    const target = activePreset ?? (!origin ? 'origin' : 'destination');
    setPoint(target, port.coords[0], port.coords[1], port.city);
    activePreset = target === 'origin' ? 'destination' : null;
    pickTarget = activePreset ?? 'origin';
    document.querySelectorAll('.chip.active').forEach((el) => el.classList.remove('active'));
    chip.classList.add('active');
  });
  presetsEl.appendChild(chip);
}

panelToggle.addEventListener('click', () => {
  panel.classList.remove('collapsed');
});

let lastScroll = 0;
panel.addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('input,button,label,fieldset')) return;
  panel.classList.add('collapsed');
});

// Mobile: swipe-like toggle via long press on brand
document.querySelector('.brand')?.addEventListener('click', () => {
  if (window.innerWidth <= 720) {
    const now = Date.now();
    if (now - lastScroll < 350) panel.classList.add('collapsed');
    lastScroll = now;
  }
});

// Add a discrete collapse control inside panel
const collapseBtn = document.createElement('button');
collapseBtn.type = 'button';
collapseBtn.className = 'btn ghost';
collapseBtn.style.marginTop = '0.75rem';
collapseBtn.style.width = '100%';
collapseBtn.textContent = 'Свернуть панель';
collapseBtn.addEventListener('click', () => panel.classList.add('collapsed'));
panel.appendChild(collapseBtn);

function bootFromQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const fromKey = params.get('from')?.toLowerCase();
  const toKey = params.get('to')?.toLowerCase();
  if (!fromKey || !toKey) return;

  const from = PORTS.find(
    (p) => p.name.toLowerCase() === fromKey || p.city.toLowerCase() === fromKey,
  );
  const to = PORTS.find(
    (p) => p.name.toLowerCase() === toKey || p.city.toLowerCase() === toKey,
  );
  if (!from || !to) return;

  origin = { lon: from.coords[0], lat: from.coords[1], label: from.city };
  destination = { lon: to.coords[0], lat: to.coords[1], label: to.city };
  pickTarget = 'origin';
  redrawMarkers();
  syncInputs();
  void computeRoute();
}

syncInputs();
setStatus('Кликните по океану или выберите порт.');
bootFromQuery();
