import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { Passage } from 'searoute-ts';
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
import { measureHybridChain, type RoutePrefer } from './hybrid';
import { PORTS, nearestPortName } from './ports';
import { getPresetRoute, type PresetRouteId } from './presets';
import {
  describeWaterItinerary,
  formatItinerary,
  prefetchWaterBbox,
  prefetchWaterNear,
} from './waterways';
import './style.css';

type AppMode = 'water' | 'ruler';
type Waypoint = { id: string; lon: number; lat: number; name: string };

const KM_PER_KNOT = 1.852;

/** Hidden demo presets (URL ?demo=…) — not shown in the panel. */
const INLAND_PRESETS: Array<{
  id: PresetRouteId;
  label: string;
  a: LngLat;
  b: LngLat;
  zoom: number;
}> = [
  {
    id: 'moscow',
    label: 'Москва-река',
    a: { lon: 37.505, lat: 55.742 },
    b: { lon: 37.645, lat: 55.749 },
    zoom: 12,
  },
  {
    id: 'volga-nn',
    label: 'Волга (Н.Новгород)',
    a: { lon: 43.95, lat: 56.33 },
    b: { lon: 44.15, lat: 56.29 },
    zoom: 11,
  },
  {
    id: 'kuybyshev',
    label: 'Куйбышевское вдхр.',
    a: { lon: 48.42, lat: 54.36 },
    b: { lon: 48.55, lat: 54.4 },
    zoom: 10,
  },
  {
    id: 'seliger-vokhma',
    label: 'Селигер → Вохма',
    a: { lon: 33.080173, lat: 57.438374 },
    b: { lon: 46.731219, lat: 59.404186 },
    zoom: 5,
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
map.doubleClickZoom.disable();
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

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const statsEl = document.querySelector<HTMLElement>('#stats')!;
const distanceEl = document.querySelector<HTMLElement>('#stat-distance')!;
const etaEl = document.querySelector<HTMLElement>('#stat-eta')!;
const routeBtn = document.querySelector<HTMLButtonElement>('#route-btn')!;
const clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo-btn')!;
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const routePreferSelect = document.querySelector<HTMLSelectElement>('#route-prefer')!;
const panel = document.querySelector<HTMLElement>('#panel')!;
const panelToggle = document.querySelector<HTMLButtonElement>('#panel-toggle')!;
const collapseBtn = document.querySelector<HTMLButtonElement>('#collapse-btn')!;
const basemapSelect = document.querySelector<HTMLSelectElement>('#basemap-select')!;
const seaControls = document.querySelector<HTMLElement>('#sea-controls')!;
const waypointCountEl = document.querySelector<HTMLElement>('#waypoint-count')!;
const waypointListEl = document.querySelector<HTMLElement>('#waypoint-list')!;
const lineColorInput = document.querySelector<HTMLInputElement>('#line-color')!;
const lineWeightInput = document.querySelector<HTMLInputElement>('#line-weight')!;
const showKmLabelsInput = document.querySelector<HTMLInputElement>('#show-km-labels')!;
const showReturnInput = document.querySelector<HTMLInputElement>('#show-return')!;
const showArrowsInput = document.querySelector<HTMLInputElement>('#show-arrows')!;
const routeDescEl = document.querySelector<HTMLElement>('#route-desc')!;
const routeDescBody = document.querySelector<HTMLTextAreaElement>('#route-desc-body')!;
const routeDescCopy = document.querySelector<HTMLButtonElement>('#route-desc-copy')!;

let mode: AppMode = 'water';
let waypoints: Waypoint[] = [];
let busy = false;
let pendingRebuild = false;
let suppressMapClick = false;
/** Last computed route distance — used for live ETA when speed changes */
let lastDistanceKm: number | null = null;
let lastRoutePath: LngLat[] | null = null;
let lastCumKm: number[] = [];
let dragRebuildTimer: number | null = null;
let nextWaypointId = 1;

/**
 * Multi-leg parallel lanes: prefer a constant on-screen gap, but never let the
 * lane fan exceed a typical aquatory width — when that would require going
 * ashore, shrink the gap (lanes may partially overlap).
 */
const PARALLEL_GAP_PX = 16;
/** Max total width (m) of all parallel lanes combined (outermost to outermost). */
const AQUATORY_MAX_SPAN_M = 80;

let markerClickGuardUntil = 0;
let lastMarkerTap: { id: string; at: number } | null = null;

function metersForPixels(px: number): number {
  try {
    const a = map.containerPointToLatLng(L.point(0, 0));
    const b = map.containerPointToLatLng(L.point(px, 0));
    return Math.max(0.05, map.distance(a, b));
  } catch {
    return px * 2;
  }
}

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

function refreshEtaFromSpeed(): void {
  if (lastDistanceKm == null || statsEl.hidden) return;
  distanceEl.textContent = formatKm(lastDistanceKm);
  etaEl.textContent = formatDuration(etaHours(lastDistanceKm, speedKmh()));
}

function defaultWaypointName(index: number): string {
  if (index === 0) return 'Старт';
  if (index === waypoints.length - 1 && waypoints.length > 1) return 'Финиш';
  return `Точка ${index + 1}`;
}

function isAutoWaypointName(name: string): boolean {
  return (
    name === 'Старт' ||
    name === 'Финиш' ||
    /^Точка\s+\d+$/.test(name)
  );
}

/** Keep auto names unique after delete/reorder; preserve custom names. */
function renormalizeWaypointNames(): void {
  waypoints.forEach((wp, index) => {
    if (!wp.name || isAutoWaypointName(wp.name)) {
      wp.name = defaultWaypointName(index);
    }
  });
}

function makeWaypoint(lon: number, lat: number, name?: string): Waypoint {
  const id = `wp-${nextWaypointId++}`;
  return { id, lon, lat, name: name ?? defaultWaypointName(waypoints.length) };
}

/** Inland/ruler waypoint: larger hit area (dot + label) for reliable double-click delete. */
function waypointMarkerIcon(
  kind: 'origin' | 'dest' | 'way',
  index: number,
  labelHtml: string,
): L.DivIcon {
  return L.divIcon({
    className: 'route-marker-wrap wp-marker-wrap',
    html: `<div class="wp-hit" title="Двойной щелчок — удалить">
      <div class="route-marker ${kind}"><span class="wp-num">${index + 1}</span></div>
      <div class="route-marker-label">${labelHtml}</div>
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
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
  lastDistanceKm = null;
  lastRoutePath = null;
  lastCumKm = [];
  hideRouteDesc();
}

function showStats(distanceKm: number): void {
  lastDistanceKm = distanceKm;
  statsEl.hidden = false;
  refreshEtaFromSpeed();
}

function hideRouteDesc(): void {
  routeDescEl.hidden = true;
  routeDescBody.value = '';
  routeDescCopy.textContent = 'Копировать';
}

function showRouteDesc(text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    hideRouteDesc();
    return;
  }
  routeDescBody.value = trimmed;
  routeDescEl.hidden = false;
  routeDescCopy.textContent = 'Копировать';
}

async function copyRouteDesc(): Promise<void> {
  const text = routeDescBody.value.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    routeDescCopy.textContent = 'Скопировано';
    window.setTimeout(() => {
      if (routeDescCopy.textContent === 'Скопировано') routeDescCopy.textContent = 'Копировать';
    }, 1600);
  } catch {
    routeDescBody.focus();
    routeDescBody.select();
    routeDescCopy.textContent = 'Ctrl+C';
  }
}

async function updateRouteItinerary(
  path: LngLat[],
  totalKm: number,
  fallback: string | null,
  opts: { allowDescribe?: boolean } = {},
): Promise<void> {
  // Straight A→B (air) must not get a fake «Волга — Угличское…» from bbox hits.
  if (opts.allowDescribe === false) {
    hideRouteDesc();
    return;
  }
  try {
    const segments = await describeWaterItinerary(path, { totalKm });
    if (segments.length) {
      showRouteDesc(formatItinerary(segments));
      return;
    }
    showRouteDesc(fallback?.trim() ? fallback : 'Определяем водоёмы по маршруту…');
  } catch (err) {
    console.warn(err);
    showRouteDesc(fallback?.trim() ? fallback : 'Определяем водоёмы по маршруту…');
  }
}

function syncControls(): void {
  routeBtn.disabled = waypoints.length < 2 || busy;
  undoBtn.hidden = false;
  waypointCountEl.textContent = `Точек: ${waypoints.length}`;
  renderWaypointList();
}

function renderWaypointList(): void {
  if (waypoints.length === 0) {
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
      <button type="button" class="waypoint-del" data-id="${wp.id}" title="Удалить точку" aria-label="Удалить точку">×</button>
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
    row.querySelector<HTMLButtonElement>('.waypoint-del')!.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      deleteWaypointById(wp.id);
    });
    waypointListEl.appendChild(row);
  });
}

function redrawCurrent(): void {
  redrawWaypoints(lastRoutePath ?? undefined);
}

function deleteWaypointById(id: string): void {
  const idx = waypoints.findIndex((w) => w.id === id);
  if (idx < 0) return;
  waypoints.splice(idx, 1);
  renormalizeWaypointNames();
  lastRoutePath = null;
  lastCumKm = [];
  lastMarkerTap = null;
  markerClickGuardUntil = Date.now() + 600;
  suppressMapClick = true;
  window.setTimeout(() => {
    suppressMapClick = false;
  }, 350);

  redrawWaypoints();
  syncControls();

  if (waypoints.length >= 2) {
    if (mode === 'water') void computeWaterRoute({ fit: false });
    else computeRuler({ fit: false });
  } else {
    clearStats();
    setStatus(
      waypoints.length === 1
        ? 'Точка удалена. Добавьте ещё одну или кликните по карте.'
        : 'Все точки удалены.',
    );
  }
}

/**
 * Adjacent-lane spacing (m). Uses full screen gap when it fits in the aquatory;
 * otherwise shrinks so the fan stays on water (may overlap when zoomed out).
 */
function parallelGapMeters(laneCount: number): number {
  if (laneCount <= 1) return 0;
  const weight = Math.max(2, Math.min(14, Number(lineWeightInput.value) || 5));
  const gapPx = Math.max(PARALLEL_GAP_PX, weight + 8);
  const desired = metersForPixels(gapPx);
  const maxSep = AQUATORY_MAX_SPAN_M / (laneCount - 1);
  return Math.min(desired, Math.max(0, maxSep));
}

function bearingDeg(a: LngLat, b: LngLat): number {
  const toR = (d: number) => (d * Math.PI) / 180;
  const dLon = toR(b.lon - a.lon);
  const lat1 = toR(a.lat);
  const lat2 = toR(b.lat);
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function legChordBearing(leg: LngLat[]): number {
  return bearingDeg(leg[0]!, leg[leg.length - 1]!);
}

/** True if leg travels roughly the same way as the reference leg. */
function sameTravelDirection(leg: LngLat[], ref: LngLat[]): boolean {
  let d = Math.abs(legChordBearing(leg) - legChordBearing(ref)) % 360;
  if (d > 180) d = 360 - d;
  return d <= 90;
}

/** Nearest path vertex for each waypoint, searching only forward along the route. */
function waypointPathIndices(path: LngLat[], wps: Waypoint[]): number[] {
  const indices: number[] = [];
  let from = 0;
  for (let w = 0; w < wps.length; w++) {
    const wp = wps[w]!;
    let bestI = from;
    let bestD = Infinity;
    for (let i = from; i < path.length; i++) {
      const d = haversineKm(wp, path[i]!);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    indices.push(bestI);
    from = bestI;
  }
  return indices;
}

function splitPathLegs(path: LngLat[], indices: number[]): LngLat[][] {
  const legs: LngLat[][] = [];
  for (let i = 1; i < indices.length; i++) {
    const a = indices[i - 1]!;
    let b = indices[i]!;
    if (b <= a) b = Math.min(path.length - 1, a + 1);
    const leg = path.slice(a, b + 1);
    if (leg.length >= 2) legs.push(leg);
  }
  return legs;
}

/**
 * Offset a leg with taper to 0 at both ends — legs meet at waypoints while
 * the middle sits on its assigned parallel lane.
 */
function offsetPathTapered(points: LngLat[], meters: number): LngLat[] {
  if (points.length < 2 || meters === 0) return points.map((p) => ({ ...p }));
  const full = offsetPathMeters(points, meters);
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1]! + haversineKm(points[i - 1]!, points[i]!) * 1000);
  }
  const total = cum[cum.length - 1] || 1;
  const taperM = Math.min(Math.max(total * 0.1, 16), total * 0.22, 70);

  return points.map((p, i) => {
    const d = cum[i]!;
    let t = 1;
    if (d < taperM) t = d / taperM;
    if (total - d < taperM) t = Math.min(t, (total - d) / taperM);
    t = t * t * (3 - 2 * t);
    const o = full[i]!;
    return {
      lon: p.lon + (o.lon - p.lon) * t,
      lat: p.lat + (o.lat - p.lat) * t,
    };
  });
}

/**
 * Fan every route leg onto its own parallel lane (2, 3, … N).
 * Shared geographic frame; spacing shrinks to stay inside the aquatory.
 */
function buildParallelLegs(path: LngLat[]): LngLat[][] | null {
  if (!showReturnInput.checked || waypoints.length < 3) return null;
  const indices = waypointPathIndices(path, waypoints);
  const legs = splitPathLegs(path, indices);
  if (legs.length < 2) return null;

  const n = legs.length;
  const sep = parallelGapMeters(n);
  const ref = legs[0]!;
  return legs.map((leg, i) => {
    const lane = i - (n - 1) / 2;
    const geoOffset = lane * sep; // + = left of reference travel
    const dirSign = sameTravelDirection(leg, ref) ? 1 : -1;
    return offsetPathTapered(leg, geoOffset * dirSign);
  });
}

/** Constant on-screen arrow layout (CSS pixels) — same at every zoom. */
const ARROW_STEP_PX = 160;
const ARROW_SIZE_PX = 16;
/** Hard cap — long routes at high zoom used to create 2000+ DOM markers and freeze the tab. */
const MAX_ROUTE_ARROWS = 48;

function arrowLayoutForScale(pathLengthM: number): { stepM: number; sizePx: number } {
  const screenStep = Math.max(1, metersForPixels(ARROW_STEP_PX));
  const capped =
    pathLengthM > 0 ? Math.max(screenStep, pathLengthM / MAX_ROUTE_ARROWS) : screenStep;
  return {
    stepM: capped,
    sizePx: ARROW_SIZE_PX,
  };
}

function drawDirectionArrows(path: LngLat[], color: string): void {
  if (!showArrowsInput.checked) return;
  if (path.length < 2) return;
  let totalM = 0;
  for (let i = 1; i < path.length; i++) totalM += haversineKm(path[i - 1]!, path[i]!) * 1000;
  const { stepM, sizePx } = arrowLayoutForScale(totalM);
  const safeColor = escapeHtml(color);
  const half = sizePx / 2;
  let acc = 0;
  let nextAt = stepM * 0.5;
  let drawn = 0;
  for (let i = 1; i < path.length; i++) {
    if (drawn >= MAX_ROUTE_ARROWS) break;
    const a = path[i - 1]!;
    const b = path[i]!;
    const segM = haversineKm(a, b) * 1000;
    if (segM < 0.5) {
      acc += segM;
      continue;
    }
    const segStart = acc;
    acc += segM;
    while (nextAt <= acc && drawn < MAX_ROUTE_ARROWS) {
      const t = (nextAt - segStart) / segM;
      const lon = a.lon + (b.lon - a.lon) * t;
      const lat = a.lat + (b.lat - a.lat) * t;
      const brg = bearingDeg(a, b);
      L.marker([lat, lon], {
        interactive: false,
        keyboard: false,
        zIndexOffset: 200,
        icon: L.divIcon({
          className: 'route-arrow-wrap',
          html: `<div class="route-arrow" style="--brg:${brg.toFixed(1)}deg;--arrow-size:${sizePx}px">
            <svg viewBox="0 0 24 24" width="${sizePx}" height="${sizePx}" aria-hidden="true">
              <path d="M12 2.5 L21 20.5 L12 16.2 L3 20.5 Z"
                fill="${safeColor}" stroke="#ffffff" stroke-width="2.2" stroke-linejoin="round"/>
            </svg>
          </div>`,
          iconSize: [sizePx, sizePx],
          iconAnchor: [half, half],
        }),
      }).addTo(drawLayer);
      drawn += 1;
      nextAt += stepM;
    }
  }
}

/**
 * Same-color route; opposing legs drawn as separate parallel polylines
 * with a constant on-screen gap at every zoom.
 */
function drawRouteGeometry(path: LngLat[]): void {
  const style = lineStyle();
  const color = String(style.color ?? '#2ec4b6');
  const parallelLegs = buildParallelLegs(path);
  if (parallelLegs) {
    for (const leg of parallelLegs) {
      if (leg.length < 2) continue;
      L.polyline(
        leg.map((p) => [p.lat, p.lon] as L.LatLngTuple),
        { ...style, interactive: false },
      ).addTo(drawLayer);
      drawDirectionArrows(leg, color);
    }
    return;
  }
  L.polyline(
    path.map((p) => [p.lat, p.lon] as L.LatLngTuple),
    { ...style, interactive: false },
  ).addTo(drawLayer);
  drawDirectionArrows(path, color);
}

function attachWaypointMarker(wp: Waypoint, index: number): void {
  const kind = index === 0 ? 'origin' : index === waypoints.length - 1 ? 'dest' : 'way';
  const marker = L.marker([wp.lat, wp.lon], {
    icon: waypointMarkerIcon(kind, index, waypointLabelHtml(wp, index)),
    draggable: true,
    autoPan: true,
  });

  const removeThis = () => {
    lastMarkerTap = null;
    markerClickGuardUntil = Date.now() + 600;
    deleteWaypointById(wp.id);
  };

  marker.on('add', () => {
    const el = marker.getElement();
    if (!el) return;
    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);
    // Native dblclick is more reliable than Leaflet's when marker is draggable.
    L.DomEvent.on(el, 'dblclick', (ev: Event) => {
      L.DomEvent.stop(ev);
      removeThis();
    });
  });

  marker
    .on('mousedown', () => {
      markerClickGuardUntil = Date.now() + 600;
    })
    .on('dragstart', () => {
      suppressMapClick = true;
      markerClickGuardUntil = Date.now() + 1000;
      lastMarkerTap = null;
    })
    .on('drag', (e: L.LeafletEvent) => {
      const ll = (e.target as L.Marker).getLatLng();
      wp.lon = ll.lng;
      wp.lat = ll.lat;
    })
    .on('dragend', () => {
      window.setTimeout(() => {
        suppressMapClick = false;
      }, 250);
      markerClickGuardUntil = Date.now() + 450;
      scheduleRebuildAfterDrag();
    })
    .on('click', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      markerClickGuardUntil = Date.now() + 600;
      const now = Date.now();
      if (lastMarkerTap && lastMarkerTap.id === wp.id && now - lastMarkerTap.at < 450) {
        // Briefly disable drag so the second tap of a double-click isn't eaten.
        marker.dragging?.disable();
        removeThis();
        return;
      }
      lastMarkerTap = { id: wp.id, at: now };
      // Pause drag briefly to allow a clean double-click / second tap.
      marker.dragging?.disable();
      window.setTimeout(() => {
        if (waypoints.some((w) => w.id === wp.id)) marker.dragging?.enable();
      }, 450);
    })
    .on('dblclick', (e: L.LeafletMouseEvent) => {
      L.DomEvent.stop(e);
      removeThis();
    })
    .bindTooltip('Двойной клик — удалить', { direction: 'bottom', opacity: 0.85 })
    .addTo(drawLayer);
}

function redrawWaypoints(path?: LngLat[]): void {
  drawLayer.clearLayers();
  waypoints.forEach((wp, i) => attachWaypointMarker(wp, i));

  const forward = path && path.length >= 2 ? path : null;
  if (forward) {
    drawRouteGeometry(forward);
  } else if (waypoints.length >= 2) {
    L.polyline(
      waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple),
      { ...lineStyle(), opacity: 0.55, interactive: false },
    ).addTo(drawLayer);
  }
}

function scheduleRebuildAfterDrag(): void {
  if (dragRebuildTimer != null) window.clearTimeout(dragRebuildTimer);
  dragRebuildTimer = window.setTimeout(() => {
    dragRebuildTimer = null;
    if (mode === 'water' && waypoints.length >= 2) void computeWaterRoute({ fit: false });
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

function seaRestrictions(): Passage[] {
  return [];
}

function routePrefer(): RoutePrefer {
  const v = routePreferSelect.value;
  if (v === 'shortest' || v === 'sea') return v;
  return 'river';
}

async function computeWaterRoute(opts: { fit?: boolean } = {}): Promise<void> {
  const fit = opts.fit ?? false;
  if (waypoints.length < 2) return;
  if (busy) {
    pendingRebuild = true;
    return;
  }
  busy = true;
  pendingRebuild = false;
  routeBtn.disabled = true;
  const prefer = routePrefer();
  setStatus('Построение маршрута...');

  try {
    const path = await measureHybridChain(waypoints, {
      restrictions: seaRestrictions(),
      allowArctic: false,
      speedKnots: speedKmh() / KM_PER_KNOT,
      prefer,
    });
    lastRoutePath = path.points;
    lastCumKm = path.waypointCumKm ?? [];

    redrawWaypoints(path.points);
    renderWaypointList();

    const netParts = [...new Set(path.networks.filter((n) => n !== 'direct'))];
    const netLabel =
      netParts.length === 0
        ? 'прямо'
        : netParts
            .map((n) => (n === 'sea' ? 'море' : 'река/канал'))
            .join(' + ');
    const waterLabel = [
      path.waterName,
      path.passages.length ? `проходы: ${uniquePassageLabel(path.passages)}` : null,
    ]
      .filter(Boolean)
      .join(' · ') || netLabel;

    showStats(path.lengthKm);
    const geo = haversineKm(waypoints[0]!, waypoints[waypoints.length - 1]!);
    const isAir =
      path.method === 'direct' ||
      path.points.length <= 3 ||
      (path.lengthKm > 0 && geo > 250 && path.lengthKm <= geo * 1.2);
    void updateRouteItinerary(
      path.points,
      path.lengthKm,
      path.method === 'direct' ? null : waterLabel,
      { allowDescribe: !isAir },
    );
    const parallelNote =
      showReturnInput.checked && waypoints.length >= 3
        ? ` Участки разведены в ${waypoints.length - 1} паралл. полос.`
        : '';

    if (path.seaUnavailable && prefer === 'sea') {
      setStatus(
        `Точки далеко от моря — оставлен речной маршрут (${netLabel}). Для моря кликните порт или берег.`,
        true,
      );
    } else {
      setStatus(
        path.method === 'direct' && !netParts.length
          ? 'Не удалось найти водный путь. Кликните ближе к фарватеру или берегу.'
          : `Готово: ${waypoints.length} точ.${parallelNote}`,
        path.method === 'direct' && !netParts.length,
      );
    }
    if (fit && path.points.length >= 2) {
      fitRouteBounds(path.points);
    }
  } catch (err) {
    console.error(err);
    // Keep the previous successful route visible instead of wiping it.
    if (lastRoutePath && lastRoutePath.length >= 2) {
      redrawWaypoints(lastRoutePath);
      setStatus('Не удалось пересчитать маршрут — показан предыдущий. Попробуйте снова.', true);
    } else {
      lastRoutePath = null;
      lastCumKm = [];
      redrawWaypoints();
      const km = pathLengthKm(waypoints);
      showStats(km);
      hideRouteDesc();
      setStatus('Ошибка запроса маршрута. Подождите и нажмите «Проложить» ещё раз.', true);
    }
  } finally {
    busy = false;
    syncControls();
    if (pendingRebuild && waypoints.length >= 2) {
      pendingRebuild = false;
      void computeWaterRoute({ fit: false });
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
  redrawWaypoints(lastRoutePath);
  renderWaypointList();
  showStats(sum);
  hideRouteDesc();
  setStatus(
    showReturnInput.checked && waypoints.length >= 3
      ? `Линейка: ${waypoints.length - 1} паралл. полос.`
      : 'Линейка: сумма отрезков.',
  );
  if (fit) {
    map.fitBounds(L.latLngBounds(waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple)).pad(0.2));
  }
}

function fitRouteBounds(points: LngLat[]): void {
  if (points.length < 2) return;
  const mobile = window.matchMedia('(max-width: 720px)').matches;
  map.fitBounds(L.latLngBounds(points.map((p) => [p.lat, p.lon] as L.LatLngTuple)), {
    paddingTopLeft: [24, 24],
    paddingBottomRight: mobile ? [24, Math.round(window.innerHeight * 0.42)] : [24, 24],
    maxZoom: 8,
    animate: true,
  });
}

/** Apply a bundled offline track (URL ?demo=…) — no brouter.de. */
function applyOfflinePreset(preset: (typeof INLAND_PRESETS)[number]): boolean {
  const canned = getPresetRoute(preset.id);
  if (!canned || canned.points.length < 2) return false;

  busy = false;
  pendingRebuild = false;
  waypoints = [
    makeWaypoint(canned.a.lon, canned.a.lat, 'Старт'),
    makeWaypoint(canned.b.lon, canned.b.lat, 'Финиш'),
  ];
  lastRoutePath = canned.points;
  lastCumKm = [0, canned.lengthKm];
  redrawWaypoints(canned.points);
  renderWaypointList();
  showStats(canned.lengthKm);
  setStatus('Готово.');
  syncControls();
  map.setView(
    [(canned.a.lat + canned.b.lat) / 2, (canned.a.lon + canned.b.lon) / 2],
    preset.zoom,
    { animate: false },
  );
  fitRouteBounds(canned.points);
  void updateRouteItinerary(canned.points, canned.lengthKm, 'река/канал');
  return true;
}

function setMode(next: AppMode): void {
  mode = next;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === next);
  });
  const water = next === 'water';
  seaControls.hidden = !water;
  routeBtn.textContent = next === 'ruler' ? 'Измерить' : 'Проложить';

  waypoints = [];
  lastRoutePath = null;
  lastCumKm = [];
  drawLayer.clearLayers();
  clearStats();
  syncControls();
  setStatus(water ? 'Кликните точки маршрута на воде.' : 'Кликните точки для измерения.');
  if (water) warmWaterCache();
}

function warmWaterCache(): void {
  const b = map.getBounds();
  prefetchWaterBbox(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
}

let waterPrefetchTimer: number | null = null;
map.on('moveend', () => {
  if (mode !== 'water') return;
  if (waterPrefetchTimer != null) window.clearTimeout(waterPrefetchTimer);
  waterPrefetchTimer = window.setTimeout(() => warmWaterCache(), 350);
});

let parallelRedrawTimer: number | null = null;
function scheduleScaleDependentRedraw(): void {
  if (!lastRoutePath || lastRoutePath.length < 2) return;
  if (parallelRedrawTimer != null) window.clearTimeout(parallelRedrawTimer);
  parallelRedrawTimer = window.setTimeout(() => {
    parallelRedrawTimer = null;
    if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
  }, 40);
}

map.on('zoom', () => scheduleScaleDependentRedraw());
map.on('zoomend', () => scheduleScaleDependentRedraw());

map.on('click', (e: L.LeafletMouseEvent) => {
  if (suppressMapClick) return;
  if (Date.now() < markerClickGuardUntil) return;
  const { lat, lng } = e.latlng;

  const label = nearestPortName(lng, lat) ?? undefined;
  const wp = makeWaypoint(lng, lat, label);
  waypoints.push(wp);
  redrawWaypoints(lastRoutePath ?? undefined);
  syncControls();
  if (mode === 'water') prefetchWaterNear({ lon: lng, lat });

  if (mode === 'water') {
    if (waypoints.length === 1) {
      setStatus('Старт отмечен. Кликните следующую точку на реке или море.');
    } else {
      void computeWaterRoute({ fit: waypoints.length === 2 });
    }
  } else {
    if (waypoints.length >= 2) computeRuler({ fit: waypoints.length === 2 });
    else setStatus(`Точка ${waypoints.length}. Продолжайте кликать.`);
  }
});

routeBtn.addEventListener('click', () => {
  if (mode === 'water') void computeWaterRoute({ fit: true });
  else computeRuler({ fit: true });
});

undoBtn.addEventListener('click', () => {
  waypoints.pop();
  lastRoutePath = null;
  lastCumKm = [];
  if (waypoints.length >= 2) {
    if (mode === 'water') void computeWaterRoute({ fit: false });
    else computeRuler({ fit: false });
  } else {
    clearStats();
    redrawWaypoints();
    syncControls();
  }
});

clearBtn.addEventListener('click', () => {
  waypoints = [];
  lastRoutePath = null;
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
  if (lastRoutePath && lastRoutePath.length >= 2) {
    redrawWaypoints(lastRoutePath);
    return;
  }
  redrawWaypoints();
}

lineColorInput.addEventListener('input', () => restyleRouteLine());
lineWeightInput.addEventListener('input', () => restyleRouteLine());
showKmLabelsInput.addEventListener('change', () => {
  redrawCurrent();
  renderWaypointList();
});
showReturnInput.addEventListener('change', () => {
  if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
  else restyleRouteLine();
});
showArrowsInput.addEventListener('change', () => {
  if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
  else restyleRouteLine();
});

routePreferSelect.addEventListener('change', () => {
  if (mode === 'water' && waypoints.length >= 2) void computeWaterRoute({ fit: false });
});

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
routeDescCopy.addEventListener('click', () => {
  void copyRouteDesc();
});
function bootFromQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const qMode = params.get('mode');
  if (qMode === 'ruler') setMode('ruler');
  else if (qMode === 'water' || qMode === 'sea' || qMode === 'inland') setMode('water');

  const demo = params.get('demo');
  if (demo && mode === 'water') {
    const preset = INLAND_PRESETS.find((p) => {
      const q = demo.toLowerCase();
      return p.id === q || p.id.includes(q) || p.label.toLowerCase().includes(q);
    });
    if (preset) {
      if (!applyOfflinePreset(preset)) {
        waypoints = [
          makeWaypoint(preset.a.lon, preset.a.lat, 'Старт'),
          makeWaypoint(preset.b.lon, preset.b.lat, 'Финиш'),
        ];
        map.setView([(preset.a.lat + preset.b.lat) / 2, (preset.a.lon + preset.b.lon) / 2], preset.zoom);
        redrawWaypoints();
        syncControls();
        void computeWaterRoute({ fit: true });
      }
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
  setMode('water');
  waypoints = [
    makeWaypoint(from.coords[0], from.coords[1], from.city),
    makeWaypoint(to.coords[0], to.coords[1], to.city),
  ];
  redrawWaypoints();
  syncControls();
  void computeWaterRoute({ fit: true });
}

syncControls();
setStatus('Кликните точки маршрута на воде.');
warmWaterCache();
bootFromQuery();
