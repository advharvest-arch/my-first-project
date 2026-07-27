import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Passage, SeaRouteFeature, SeaRouteMultiFeature } from 'searoute-ts';
import { attachBasemapControl, createBasemaps, type BasemapId } from './basemap';
import {
  etaHours,
  formatDuration,
  formatKm,
  haversineKm,
  offsetPathMeters,
  pathLengthKm,
  type LngLat,
} from './geo';
import { PORTS, formatCoords, nearestPortName } from './ports';
import { measureWaterChain, prefetchWaterBbox, prefetchWaterNear } from './waterways';
import './style.css';

type AppMode = 'sea' | 'inland' | 'ruler';
type Point = { lon: number; lat: number; label: string };
type Waypoint = { id: string; lon: number; lat: number; name: string };

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
const waypointListEl = document.querySelector<HTMLElement>('#waypoint-list')!;
const lineColorInput = document.querySelector<HTMLInputElement>('#line-color')!;
const lineWeightInput = document.querySelector<HTMLInputElement>('#line-weight')!;
const showKmLabelsInput = document.querySelector<HTMLInputElement>('#show-km-labels')!;
const showReturnInput = document.querySelector<HTMLInputElement>('#show-return')!;
const returnColorInput = document.querySelector<HTMLInputElement>('#return-color')!;
const returnColorField = document.querySelector<HTMLElement>('#return-color-field')!;

let mode: AppMode = 'sea';
let origin: Point | null = null;
let destination: Point | null = null;
let pickTarget: 'origin' | 'destination' = 'origin';
let activePreset: 'origin' | 'destination' | null = null;
let waypoints: Waypoint[] = [];
let busy = false;
let pendingRebuild = false;
let suppressMapClick = false;
/** Last computed route distance — used for live ETA when speed changes */
let lastDistanceKm: number | null = null;
let lastReturnKm: number | null = null;
let lastWaterLabel = '—';
let lastRoutePath: LngLat[] | null = null;
let lastReturnPath: LngLat[] | null = null;
let lastCumKm: number[] = [];
let dragRebuildTimer: number | null = null;
let nextWaypointId = 1;

/** Parallel offset between туда/обратно lines, metres */
const RETURN_OFFSET_M = 28;

function speedKmh(): number {
  return Math.max(1, Number(speedInput.value) || 20);
}

function lineStyle(): L.PolylineOptions {
  return {
    color: lineColorInput.value || '#2ec4b6',
    weight: Math.max(2, Number(lineWeightInput.value) || 5),
    opacity: 0.95,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'route-line',
  };
}

function returnLineStyle(): L.PolylineOptions {
  return {
    color: returnColorInput.value || '#d9c3a0',
    weight: Math.max(2, Number(lineWeightInput.value) || 5),
    opacity: 0.92,
    lineCap: 'round',
    lineJoin: 'round',
    className: 'route-line return',
  };
}

function refreshEtaFromSpeed(): void {
  if (lastDistanceKm == null || statsEl.hidden) return;
  const total =
    showReturnInput.checked && lastReturnKm != null
      ? lastDistanceKm + lastReturnKm
      : lastDistanceKm;
  if (showReturnInput.checked && lastReturnKm != null) {
    distanceEl.textContent = `${formatKm(lastDistanceKm)} + ${formatKm(lastReturnKm)}`;
  } else {
    distanceEl.textContent = formatKm(lastDistanceKm);
  }
  etaEl.textContent = formatDuration(etaHours(total, speedKmh()));
  passagesEl.textContent = lastWaterLabel;
}

function pointLabel(lon: number, lat: number): string {
  return nearestPortName(lon, lat) ?? formatCoords(lon, lat);
}

function defaultWaypointName(index: number): string {
  if (index === 0) return 'Старт';
  return `Точка ${index + 1}`;
}

function makeWaypoint(lon: number, lat: number, name?: string): Waypoint {
  const id = `wp-${nextWaypointId++}`;
  return { id, lon, lat, name: name ?? defaultWaypointName(waypoints.length) };
}

function markerIcon(kind: 'origin' | 'dest' | 'way', labelHtml: string): L.DivIcon {
  return L.divIcon({
    className: 'route-marker-wrap',
    html: `<div class="route-marker ${kind}"></div><div class="route-marker-label">${labelHtml}</div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function waypointLabelHtml(wp: Waypoint, index: number): string {
  const name = escapeHtml(wp.name || defaultWaypointName(index));
  if (!showKmLabelsInput.checked || lastCumKm[index] == null) return name;
  const km = formatKm(lastCumKm[index]!);
  return `${name}<span class="km">${escapeHtml(km)}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
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
  lastReturnKm = null;
  lastWaterLabel = '—';
  lastRoutePath = null;
  lastReturnPath = null;
  lastCumKm = [];
}

function showStats(distanceKm: number, water: string, returnKm: number | null = null): void {
  lastDistanceKm = distanceKm;
  lastReturnKm = returnKm;
  lastWaterLabel = water;
  refreshEtaFromSpeed();
  statsEl.hidden = false;
}

function updateHint(): void {
  if (mode === 'sea') {
    if (!origin) hintEl.textContent = 'Море: кликните точку отправления, затем прибытия.';
    else if (!destination) hintEl.textContent = 'Море: выберите точку прибытия у порта или на воде.';
    else hintEl.textContent = 'Море: маршрут готов. Можно сменить точки или ограничения.';
  } else if (mode === 'inland') {
    hintEl.textContent =
      'Реки: клик — точка, перетаскивание — сдвиг, двойной клик — удаление. Можно включить обратный маршрут.';
  } else {
    hintEl.textContent =
      'Линейка: кликайте точки. Двойной клик по точке — удалить. Опционально — обратный путь параллельно.';
  }
}

function syncControls(): void {
  originInput.value = origin ? origin.label : '';
  destInput.value = destination ? destination.label : '';
  routeBtn.disabled = mode === 'sea' ? !(origin && destination) || busy : waypoints.length < 2 || busy;
  undoBtn.hidden = mode === 'sea';
  waypointCountEl.textContent = `Точек: ${waypoints.length}`;
  updateHint();
  renderWaypointList();
}

function renderWaypointList(): void {
  if (mode === 'sea' || waypoints.length === 0) {
    waypointListEl.hidden = true;
    waypointListEl.innerHTML = '';
    return;
  }
  waypointListEl.hidden = false;
  waypointListEl.innerHTML = '';
  waypoints.forEach((wp, index) => {
    const row = document.createElement('div');
    row.className = 'waypoint-row';
    const kmText =
      showKmLabelsInput.checked && lastCumKm[index] != null ? formatKm(lastCumKm[index]!) : '';
    row.innerHTML = `
      <span class="waypoint-idx">${index + 1}</span>
      <input type="text" class="waypoint-name" data-id="${wp.id}" value="${escapeHtml(wp.name)}" maxlength="48" />
      <span class="waypoint-km">${kmText}</span>
    `;
    const input = row.querySelector<HTMLInputElement>('input')!;
    input.addEventListener('input', () => {
      wp.name = input.value.trim() || defaultWaypointName(index);
      redrawCurrent();
    });
    input.addEventListener('focus', () => {
      suppressMapClick = true;
    });
    input.addEventListener('blur', () => {
      window.setTimeout(() => {
        suppressMapClick = false;
      }, 200);
    });
    waypointListEl.appendChild(row);
  });
}

function redrawCurrent(): void {
  if (mode === 'sea') {
    if (lastRoutePath) {
      // keep sea polylines via recompute is heavier; just markers + reuse path if stored as sea
      redrawSeaMarkers();
    } else {
      redrawSeaMarkers();
    }
    return;
  }
  redrawWaypoints(lastRoutePath ?? undefined);
}

function redrawSeaMarkers(): void {
  drawLayer.clearLayers();
  if (origin) {
    L.marker([origin.lat, origin.lon], {
      icon: markerIcon('origin', escapeHtml(origin.label)),
      draggable: true,
    })
      .on('dragstart', () => {
        suppressMapClick = true;
      })
      .on('dragend', (e: L.LeafletEvent) => {
        const m = e.target as L.Marker;
        const ll = m.getLatLng();
        origin = { lon: ll.lng, lat: ll.lat, label: pointLabel(ll.lng, ll.lat) };
        window.setTimeout(() => {
          suppressMapClick = false;
        }, 200);
        void computeSeaRoute();
      })
      .addTo(drawLayer);
  }
  if (destination) {
    L.marker([destination.lat, destination.lon], {
      icon: markerIcon('dest', escapeHtml(destination.label)),
      draggable: true,
    })
      .on('dragstart', () => {
        suppressMapClick = true;
      })
      .on('dragend', (e: L.LeafletEvent) => {
        const m = e.target as L.Marker;
        const ll = m.getLatLng();
        destination = { lon: ll.lng, lat: ll.lat, label: pointLabel(ll.lng, ll.lat) };
        window.setTimeout(() => {
          suppressMapClick = false;
        }, 200);
        void computeSeaRoute();
      })
      .addTo(drawLayer);
  }
}

function deleteWaypointById(id: string): void {
  const idx = waypoints.findIndex((w) => w.id === id);
  if (idx < 0) return;
  waypoints.splice(idx, 1);
  lastRoutePath = null;
  lastReturnPath = null;
  lastCumKm = [];
  if (waypoints.length >= 2) {
    if (mode === 'inland') void computeInlandRoute({ fit: false });
    else if (mode === 'ruler') computeRuler({ fit: false });
    else {
      redrawWaypoints();
      syncControls();
    }
  } else {
    clearStats();
    redrawWaypoints();
    syncControls();
    setStatus(
      waypoints.length === 1
        ? 'Точка удалена. Добавьте ещё одну или кликните по карте.'
        : 'Все точки удалены.',
    );
  }
}

function syncReturnUi(): void {
  returnColorField.hidden = !showReturnInput.checked;
}

function redrawWaypoints(path?: LngLat[]): void {
  drawLayer.clearLayers();
  waypoints.forEach((wp, i) => {
    const kind = i === 0 ? 'origin' : i === waypoints.length - 1 ? 'dest' : 'way';
    const marker = L.marker([wp.lat, wp.lon], {
      icon: markerIcon(kind, waypointLabelHtml(wp, i)),
      draggable: true,
      autoPan: true,
    });
    marker
      .on('dragstart', () => {
        suppressMapClick = true;
      })
      .on('drag', (e: L.LeafletEvent) => {
        const ll = (e.target as L.Marker).getLatLng();
        wp.lon = ll.lng;
        wp.lat = ll.lat;
      })
      .on('dragend', () => {
        window.setTimeout(() => {
          suppressMapClick = false;
        }, 200);
        scheduleRebuildAfterDrag();
      })
      .on('dblclick', (e: L.LeafletMouseEvent) => {
        L.DomEvent.stop(e);
        suppressMapClick = true;
        window.setTimeout(() => {
          suppressMapClick = false;
        }, 300);
        deleteWaypointById(wp.id);
      })
      .bindTooltip('Двойной клик — удалить', { direction: 'bottom', opacity: 0.85 })
      .addTo(drawLayer);
  });

  const style = lineStyle();
  const forward = path && path.length >= 2 ? path : null;
  if (forward) {
    if (showReturnInput.checked) {
      const half = RETURN_OFFSET_M / 2;
      const outPath = offsetPathMeters(forward, -half);
      const backSource = lastReturnPath ?? [...forward].reverse();
      const backPath = offsetPathMeters(backSource, half);
      L.polyline(
        outPath.map((p) => [p.lat, p.lon] as L.LatLngTuple),
        style,
      ).addTo(drawLayer);
      L.polyline(
        backPath.map((p) => [p.lat, p.lon] as L.LatLngTuple),
        returnLineStyle(),
      ).addTo(drawLayer);
    } else {
      L.polyline(
        forward.map((p) => [p.lat, p.lon] as L.LatLngTuple),
        style,
      ).addTo(drawLayer);
    }
  } else if (waypoints.length >= 2) {
    L.polyline(
      waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple),
      { ...style, opacity: 0.55 },
    ).addTo(drawLayer);
  }
}

function scheduleRebuildAfterDrag(): void {
  if (dragRebuildTimer != null) window.clearTimeout(dragRebuildTimer);
  dragRebuildTimer = window.setTimeout(() => {
    dragRebuildTimer = null;
    if (mode === 'inland' && waypoints.length >= 2) void computeInlandRoute({ fit: false });
    else if (mode === 'ruler' && waypoints.length >= 2) computeRuler({ fit: false });
    else redrawWaypoints();
  }, 180);
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

function uniquePassageLabel(passages: Passage[] | undefined): string {
  if (!passages?.length) return 'нет';
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of passages) {
    const label = passageLabel(p);
    const key = label.toLocaleLowerCase('ru');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
  }
  return out.join(', ');
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
  const style = lineStyle();
  const layer = L.layerGroup(segments.map((segment) => L.polyline(segment, style))).addTo(
    drawLayer,
  );
  const bounds = L.latLngBounds([]);
  layer.eachLayer((l) => {
    if (l instanceof L.Polyline) bounds.extend(l.getBounds());
  });
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.15), { animate: true });

  const lengthKm = feature.properties.length;
  showStats(lengthKm, uniquePassageLabel(feature.properties.passages));
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

async function computeInlandRoute(opts: { fit?: boolean } = {}): Promise<void> {
  const fit = opts.fit ?? false;
  if (waypoints.length < 2) return;
  if (busy) {
    pendingRebuild = true;
    return;
  }
  busy = true;
  pendingRebuild = false;
  routeBtn.disabled = true;
  setStatus(
    showReturnInput.checked ? 'Строим маршрут туда и обратно…' : 'Строим маршрут…',
  );

  try {
    const path = await measureWaterChain(waypoints);
    lastRoutePath = path.points;
    lastCumKm = path.waypointCumKm ?? [];

    let returnKm: number | null = null;
    lastReturnPath = null;
    if (showReturnInput.checked) {
      const back = await measureWaterChain([...waypoints].reverse());
      if (back.method !== 'direct' && back.points.length >= 2) {
        lastReturnPath = back.points;
        returnKm = back.lengthKm;
      } else if (path.points.length >= 2) {
        // Fallback: reverse of forward geometry
        lastReturnPath = [...path.points].reverse();
        returnKm = path.lengthKm;
      }
    }

    redrawWaypoints(path.points);
    renderWaypointList();
    const methodLabel =
      path.method === 'waterway'
        ? 'по руслу/каналу'
        : path.method === 'lake'
          ? 'по водоёму'
          : 'вода не связана';
    const waterLabel = path.waterName ?? methodLabel;
    showStats(path.lengthKm, waterLabel, returnKm);
    setStatus(
      path.method === 'direct'
        ? 'Не удалось найти связанный водный путь между точками. Кликните ближе к фарватеру (середине реки/канала) или выберите пример ниже.'
        : showReturnInput.checked && returnKm != null
          ? `Готово: туда ${formatKm(path.lengthKm)}, обратно ${formatKm(returnKm)}${path.waterName ? ` (${path.waterName})` : ''}. Двойной клик по точке — удалить.`
          : `Готово: ${waypoints.length} точ., ${methodLabel}${path.waterName ? ` (${path.waterName})` : ''}. Двойной клик по точке — удалить.`,
      path.method === 'direct',
    );
    if (fit && path.points.length >= 2) {
      map.fitBounds(
        L.latLngBounds(path.points.map((p) => [p.lat, p.lon] as L.LatLngTuple)).pad(0.2),
      );
    }
  } catch (err) {
    console.error(err);
    lastRoutePath = null;
    lastReturnPath = null;
    lastCumKm = [];
    redrawWaypoints();
    const km = pathLengthKm(waypoints);
    showStats(km, 'ошибка сети');
    setStatus('Ошибка запроса маршрута. Подождите пару секунд и нажмите «Проложить» ещё раз.', true);
  } finally {
    busy = false;
    syncControls();
    if (pendingRebuild && waypoints.length >= 2) {
      pendingRebuild = false;
      void computeInlandRoute({ fit: false });
    }
  }
}

function computeRuler(opts: { fit?: boolean } = {}): void {
  const fit = opts.fit ?? true;
  if (waypoints.length < 2) return;
  lastRoutePath = waypoints.map((w) => ({ lon: w.lon, lat: w.lat }));
  const cum = [0];
  let sum = 0;
  for (let i = 1; i < waypoints.length; i++) {
    sum += haversineKm(waypoints[i - 1]!, waypoints[i]!);
    cum.push(sum);
  }
  lastCumKm = cum;
  lastReturnPath = showReturnInput.checked ? [...lastRoutePath].reverse() : null;
  const returnKm = showReturnInput.checked ? sum : null;
  redrawWaypoints(lastRoutePath);
  renderWaypointList();
  let maxLeg = 0;
  for (let i = 1; i < waypoints.length; i++) {
    maxLeg = Math.max(maxLeg, haversineKm(waypoints[i - 1]!, waypoints[i]!));
  }
  showStats(sum, `${waypoints.length - 1} отр., макс. ${formatKm(maxLeg)}`, returnKm);
  setStatus(
    showReturnInput.checked
      ? 'Линейка туда и обратно. Двойной клик по точке — удалить.'
      : 'Линейка: сумма отрезков. Двойной клик по точке — удалить.',
  );
  if (fit) {
    map.fitBounds(L.latLngBounds(waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple)).pad(0.2));
  }
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
        waypoints = [
          makeWaypoint(preset.a.lon, preset.a.lat, 'Старт'),
          makeWaypoint(preset.b.lon, preset.b.lat, 'Финиш'),
        ];
        map.setView([(preset.a.lat + preset.b.lat) / 2, (preset.a.lon + preset.b.lon) / 2], preset.zoom);
        lastRoutePath = null;
        lastCumKm = [];
        redrawWaypoints();
        syncControls();
        prefetchWaterNear(preset.a);
        prefetchWaterNear(preset.b);
        void computeInlandRoute({ fit: true });
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
  lastRoutePath = null;
  lastReturnPath = null;
  lastCumKm = [];
  drawLayer.clearLayers();
  clearStats();
  renderPresets();
  syncControls();
  syncReturnUi();
  setStatus(
    next === 'sea'
      ? 'Кликните по карте или выберите порт.'
      : next === 'inland'
        ? 'Кликайте точки на воде. Двойной клик по точке — удалить. Можно включить обратный маршрут.'
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
  if (suppressMapClick) return;
  const { lat, lng } = e.latlng;

  if (mode === 'sea') {
    if (busy) return;
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

  const wp = makeWaypoint(lng, lat);
  waypoints.push(wp);
  redrawWaypoints(lastRoutePath ?? undefined);
  syncControls();
  if (mode === 'inland') prefetchWaterNear({ lon: lng, lat });

  if (mode === 'inland') {
    if (waypoints.length === 1) {
      setStatus('Старт отмечен. Кликните следующую точку на воде.');
    } else {
      void computeInlandRoute({ fit: waypoints.length === 2 });
    }
  } else {
    if (waypoints.length >= 2) computeRuler({ fit: waypoints.length === 2 });
    else setStatus(`Точка ${waypoints.length}. Продолжайте кликать.`);
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
  else if (mode === 'inland') void computeInlandRoute({ fit: true });
  else computeRuler({ fit: true });
});

undoBtn.addEventListener('click', () => {
  waypoints.pop();
  lastRoutePath = null;
  lastReturnPath = null;
  lastCumKm = [];
  if (waypoints.length >= 2) {
    if (mode === 'inland') void computeInlandRoute({ fit: false });
    else computeRuler({ fit: false });
  } else {
    clearStats();
    redrawWaypoints();
    syncControls();
  }
});

clearBtn.addEventListener('click', () => {
  origin = null;
  destination = null;
  waypoints = [];
  pickTarget = 'origin';
  activePreset = null;
  lastRoutePath = null;
  lastReturnPath = null;
  lastCumKm = [];
  drawLayer.clearLayers();
  clearStats();
  syncControls();
  setStatus('');
});

speedInput.addEventListener('input', () => {
  refreshEtaFromSpeed();
});

function restyleRouteLine(): void {
  if (mode === 'sea' && origin && destination) {
    void computeSeaRoute();
    return;
  }
  if (lastRoutePath && lastRoutePath.length >= 2) {
    redrawWaypoints(lastRoutePath);
    return;
  }
  redrawWaypoints();
}

lineColorInput.addEventListener('input', () => restyleRouteLine());
lineWeightInput.addEventListener('input', () => restyleRouteLine());
returnColorInput.addEventListener('input', () => restyleRouteLine());
showKmLabelsInput.addEventListener('change', () => {
  redrawCurrent();
  renderWaypointList();
});
showReturnInput.addEventListener('change', () => {
  syncReturnUi();
  if (mode === 'inland' && waypoints.length >= 2) void computeInlandRoute({ fit: false });
  else if (mode === 'ruler' && waypoints.length >= 2) computeRuler({ fit: false });
  else restyleRouteLine();
});
syncReturnUi();

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
      waypoints = [
        makeWaypoint(preset.a.lon, preset.a.lat, 'Старт'),
        makeWaypoint(preset.b.lon, preset.b.lat, 'Финиш'),
      ];
      map.setView([(preset.a.lat + preset.b.lat) / 2, (preset.a.lon + preset.b.lon) / 2], preset.zoom);
      redrawWaypoints();
      syncControls();
      void computeInlandRoute({ fit: true });
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
