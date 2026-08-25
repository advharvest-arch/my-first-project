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
  itinerarySourceNote,
  polishWaterPath,
  prefetchWaterBbox,
  prefetchWaterNear,
  snapClickToWater,
  type ItinerarySegment,
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
  // Prefer DOM tiles (crisper labels); canvas is only for vectors if needed.
  preferCanvas: false,
  fadeAnimation: false,
  zoomAnimation: true,
  markerZoomAnimation: false,
  // Load tiles while the user is still panning (feels much snappier).
  // Basemap layers also set updateWhenIdle: false.
  tapTolerance: 20,
  bounceAtZoomLimits: false,
}).setView([55.75, 37.62], 5);

map.getContainer().style.cursor = 'default';
map.doubleClickZoom.disable();
L.control.zoom({ position: 'bottomright' }).addTo(map);

const basemaps = createBasemaps();
const basemapControl = attachBasemapControl(map, basemaps, 'osm');

const refreshSize = () => map.invalidateSize({ animate: false });
const scheduleRefresh = () => {
  requestAnimationFrame(refreshSize);
  setTimeout(refreshSize, 100);
  setTimeout(refreshSize, 400);
  setTimeout(refreshSize, 1000);
};
scheduleRefresh();
window.addEventListener('resize', refreshSize);
window.addEventListener('orientationchange', scheduleRefresh);
// bfcache / tab restore on iOS Safari
window.addEventListener('pageshow', scheduleRefresh);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleRefresh();
});
// Mobile browser chrome show/hide changes the visual viewport without a window resize.
const vv = window.visualViewport;
if (vv) {
  vv.addEventListener('resize', refreshSize);
  vv.addEventListener('scroll', refreshSize);
}
// Mark boot complete for the inline loader UI.
const appRoot = document.getElementById('app');
if (appRoot) {
  appRoot.removeAttribute('data-booting');
  appRoot.style.display = '';
}
const bootFallback = document.getElementById('boot-fallback');
if (bootFallback) bootFallback.removeAttribute('data-show');

const drawLayer = L.layerGroup().addTo(map);

const statusEl = document.querySelector<HTMLParagraphElement>('#status')!;
const statsEl = document.querySelector<HTMLElement>('#stats')!;
const distanceEl = document.querySelector<HTMLElement>('#stat-distance')!;
const etaEl = document.querySelector<HTMLElement>('#stat-eta')!;
const routeBtn = document.querySelector<HTMLButtonElement>('#route-btn')!;
const clearBtn = document.querySelector<HTMLButtonElement>('#clear-btn')!;
const undoBtn = document.querySelector<HTMLButtonElement>('#undo-btn')!;
const reverseBtn = document.querySelector<HTMLButtonElement>('#reverse-btn')!;
const speedInput = document.querySelector<HTMLInputElement>('#speed')!;
const speedPresets = document.querySelector<HTMLElement>('#speed-presets');
const panel = document.querySelector<HTMLElement>('#panel')!;
const panelToggle = document.querySelector<HTMLButtonElement>('#panel-toggle')!;
const collapseBtn = document.querySelector<HTMLButtonElement>('#collapse-btn')!;
const basemapSelect = document.querySelector<HTMLSelectElement>('#basemap-select')!;
const waypointCountEl = document.querySelector<HTMLElement>('#waypoint-count')!;
const waypointListEl = document.querySelector<HTMLElement>('#waypoint-list')!;
const lineColorInput = document.querySelector<HTMLInputElement>('#line-color')!;
const lineWeightInput = document.querySelector<HTMLInputElement>('#line-weight')!;
const showKmLabelsInput = document.querySelector<HTMLInputElement>('#show-km-labels')!;
const showDistanceMarksInput = document.querySelector<HTMLInputElement>('#show-distance-marks')!;
const showElevationInput = document.querySelector<HTMLInputElement>('#show-elevation')!;
const showSegmentLabelsInput = document.querySelector<HTMLInputElement>('#show-segment-labels')!;
const showReturnInput = document.querySelector<HTMLInputElement>('#show-return')!;
const showArrowsInput = document.querySelector<HTMLInputElement>('#show-arrows')!;
const routeDescEl = document.querySelector<HTMLElement>('#route-desc')!;
const routeDescBody = document.querySelector<HTMLTextAreaElement>('#route-desc-body')!;
const routeDescList = document.querySelector<HTMLOListElement>('#route-desc-list')!;
const routeDescSource = document.querySelector<HTMLParagraphElement>('#route-desc-source')!;
const routeDescCopy = document.querySelector<HTMLButtonElement>('#route-desc-copy')!;
const shareRouteBtn = document.querySelector<HTMLButtonElement>('#share-route-btn')!;
const gpxExportBtn = document.querySelector<HTMLButtonElement>('#gpx-export-btn')!;
const elevPanel = document.querySelector<HTMLElement>('#elev-panel')!;
const elevRangeEl = document.querySelector<HTMLElement>('#elev-range')!;
const elevCanvas = document.querySelector<HTMLCanvasElement>('#elev-canvas')!;

let mode: AppMode = 'water';
let waypoints: Waypoint[] = [];
let busy = false;
let pendingRebuild = false;
let suppressMapClick = false;
/** Last computed route distance — used for live ETA when speed changes */
let lastDistanceKm: number | null = null;
let lastRoutePath: LngLat[] | null = null;
let lastCumKm: number[] = [];
/** Named stretches for map ticks (start/end + km). */
let lastItinerary: ItinerarySegment[] = [];
/**
 * Water route kept on the map when switching to the ruler so measurement
 * does not wipe the built track.
 */
let pinnedWaterRoute: {
  path: LngLat[];
  itinerary: ItinerarySegment[];
  cumKm: number[];
  distanceKm: number | null;
} | null = null;
let dragRebuildTimer: number | null = null;
let nextWaypointId = 1;
/** Bumps on each successful water route so background polish can cancel. */
let routeGeneration = 0;

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
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;')
    .split('"')
    .join('&quot;');
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
  lastItinerary = [];
  hideRouteDesc();
  hideElevation();
}

function showStats(distanceKm: number): void {
  lastDistanceKm = distanceKm;
  statsEl.hidden = false;
  refreshEtaFromSpeed();
}

function hideRouteDesc(): void {
  routeDescEl.hidden = true;
  routeDescBody.value = '';
  routeDescList.innerHTML = '';
  routeDescList.hidden = true;
  routeDescSource.textContent = '';
  routeDescSource.hidden = true;
  routeDescCopy.textContent = 'Копировать';
}

function hideElevation(): void {
  elevPanel.hidden = true;
  elevRangeEl.textContent = '—';
  const ctx = elevCanvas.getContext('2d');
  if (ctx) ctx.clearRect(0, 0, elevCanvas.width, elevCanvas.height);
}

function renderItineraryList(segments: ItinerarySegment[]): void {
  const named = segments.filter((s) => s.name);
  routeDescList.innerHTML = '';
  if (!named.length) {
    routeDescList.hidden = true;
    return;
  }
  routeDescList.hidden = false;
  for (const s of named) {
    const li = document.createElement('li');
    const km = Math.max(0.1, Math.round(s.km * 10) / 10);
    const kmText = km.toLocaleString('ru-RU', {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
    const gvr =
      s.fromGvr && s.gvrCode
        ? `<span class="itin-gvr" title="Код Государственного водного реестра">ГВР ${escapeHtml(s.gvrCode)}</span>`
        : '';
    li.innerHTML = `<span class="itin-name">${escapeHtml(s.name)}${gvr}</span><span class="itin-km">${escapeHtml(kmText)} км</span>`;
    routeDescList.appendChild(li);
  }
}

function showRouteDesc(text: string, segments?: ItinerarySegment[]): void {
  const trimmed = text.trim();
  if (!trimmed) {
    hideRouteDesc();
    return;
  }
  routeDescBody.value = trimmed;
  const segs = segments ?? lastItinerary;
  renderItineraryList(segs);
  const note = itinerarySourceNote(segs);
  routeDescSource.textContent = note;
  routeDescSource.hidden = !note;
  routeDescEl.hidden = false;
  routeDescCopy.textContent = 'Копировать';
}

function copyTextFallback(text: string): boolean {
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '0';
    area.style.width = '1px';
    area.style.height = '1px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

async function copyRouteDesc(): Promise<void> {
  const text = routeDescBody.value.trim();
  if (!text) return;
  let ok = false;
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) ok = copyTextFallback(text);
  if (ok) {
    routeDescCopy.textContent = 'Скопировано';
    window.setTimeout(() => {
      if (routeDescCopy.textContent === 'Скопировано') routeDescCopy.textContent = 'Копировать';
    }, 1600);
    return;
  }
  routeDescBody.focus();
  routeDescBody.select();
  routeDescCopy.textContent = 'Ctrl+C / ⌘C';
}

async function updateRouteItinerary(
  path: LngLat[],
  totalKm: number,
  fallback: string | null,
  opts: { allowDescribe?: boolean; itinerary?: ItinerarySegment[] } = {},
): Promise<void> {
  // Straight A→B (air) must not get a fake «Волга — Угличское…» from bbox hits.
  if (opts.allowDescribe === false) {
    lastItinerary = [];
    hideRouteDesc();
    if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
    return;
  }
  try {
    const segments =
      opts.itinerary && opts.itinerary.length
        ? opts.itinerary
        : await describeWaterItinerary(path, {
            totalKm,
            origin: waypoints[0],
            destination: waypoints[waypoints.length - 1],
          });
    if (segments.length) {
      lastItinerary = segments;
      showRouteDesc(formatItinerary(segments), segments);
      if (lastRoutePath && lastRoutePath.length >= 2) {
        redrawWaypoints(lastRoutePath);
      }
      return;
    }
    lastItinerary = [];
    // Empty segments after filters = bad geometry; don't show a stale water label.
    if (fallback?.trim() && !fallback.includes('прямо')) {
      hideRouteDesc();
      return;
    }
    hideRouteDesc();
  } catch (err) {
    console.warn(err);
    lastItinerary = [];
    hideRouteDesc();
  }
}

function syncControls(): void {
  routeBtn.disabled = waypoints.length < 2 || busy;
  undoBtn.hidden = false;
  reverseBtn.hidden = waypoints.length < 2;
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
  lastItinerary = [];
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

function pointAlongPath(
  path: LngLat[],
  targetKm: number,
): { point: LngLat; bearing: number } {
  if (path.length < 2) {
    return { point: path[0] ?? { lon: 0, lat: 0 }, bearing: 0 };
  }
  const total = pathLengthKm(path);
  const goal = Math.max(0, Math.min(targetKm, total));
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!;
    const b = path[i]!;
    const d = haversineKm(a, b);
    if (acc + d >= goal - 1e-9) {
      const t = d > 1e-9 ? (goal - acc) / d : 0;
      return {
        point: {
          lon: a.lon + (b.lon - a.lon) * t,
          lat: a.lat + (b.lat - a.lat) * t,
        },
        bearing: bearingDeg(a, b),
      };
    }
    acc += d;
  }
  const a = path[path.length - 2]!;
  const b = path[path.length - 1]!;
  return { point: { ...b }, bearing: bearingDeg(a, b) };
}

function shortSegmentName(name: string): string {
  // Keep «водохранилище» on map labels; only shorten «озеро».
  return name.replace(/\s+озеро$/i, '').trim();
}

function formatSegmentKm(km: number): string {
  const v = Math.max(0.1, Math.round(km * 10) / 10);
  return `${v.toLocaleString('ru-RU', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} км`;
}

/** Destination ~`meters` from `p` along geographic bearing (degrees). */
function destinationMeters(p: LngLat, bearing: number, meters: number): LngLat {
  const R = 6371000;
  const δ = meters / R;
  const θ = (bearing * Math.PI) / 180;
  const φ1 = (p.lat * Math.PI) / 180;
  const λ1 = (p.lon * Math.PI) / 180;
  const sinφ2 =
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return {
    lat: (φ2 * 180) / Math.PI,
    lon: ((((λ2 * 180) / Math.PI + 540) % 360) - 180),
  };
}

/** Half-length of a boundary tick so it stays ~10–12 px on screen. */
function segmentTickHalfMeters(at: LngLat): number {
  const z = map.getZoom();
  const mPerPx =
    (156543.03392 * Math.cos((at.lat * Math.PI) / 180)) / 2 ** z;
  return Math.max(18, Math.min(350, mPerPx * 11));
}

/**
 * Perpendicular hash marks at stretch boundaries; name + km above each stretch midpoint.
 * Ticks are short geographic polylines across the route (bearing ± 90°).
 * Near-duplicate boundaries (e.g. flicker at a mouth) collapse to one tick.
 */
function drawSegmentTicks(path: LngLat[], segments: ItinerarySegment[]): void {
  if (!showSegmentLabelsInput.checked) return;
  if (path.length < 2 || segments.length === 0) return;
  const pathKm = pathLengthKm(path);
  const segSum = segments.reduce((s, x) => s + x.km, 0);
  if (!(pathKm > 0) || !(segSum > 0)) return;
  const scale = pathKm / segSum;

  let cum = 0;
  const boundsKm: number[] = [];
  // Internal stretch boundaries only (skip route start/end — they clutter mouths).
  for (let i = 0; i < segments.length - 1; i++) {
    cum += segments[i]!.km;
    boundsKm.push(cum);
  }

  const ticks: { point: LngLat; bearing: number }[] = [];
  for (const km of boundsKm) {
    const { point, bearing } = pointAlongPath(path, km * scale);
    // Wide merge: Чебоксарское↔Ветлуга flicker left marks several km apart at the mouth.
    if (ticks.some((t) => haversineKm(t.point, point) < 8)) continue;
    ticks.push({ point, bearing });
  }

  for (const { point, bearing } of ticks) {
    const half = segmentTickHalfMeters(point);
    // Across the line: left/right of travel, not along it.
    const a = destinationMeters(point, bearing - 90, half);
    const b = destinationMeters(point, bearing + 90, half);
    L.polyline(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      {
        color: '#ffffff',
        weight: 5,
        opacity: 0.95,
        lineCap: 'butt',
        interactive: false,
      },
    ).addTo(drawLayer);
    L.polyline(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      {
        color: '#071821',
        weight: 2.5,
        opacity: 1,
        lineCap: 'butt',
        interactive: false,
      },
    ).addTo(drawLayer);
  }

  cum = 0;
  for (const seg of segments) {
    const midKm = (cum + seg.km / 2) * scale;
    cum += seg.km;
    const { point } = pointAlongPath(path, midKm);
    const name = escapeHtml(shortSegmentName(seg.name));
    const kmText = escapeHtml(formatSegmentKm(seg.km));
    L.marker([point.lat, point.lon], {
      interactive: false,
      keyboard: false,
      zIndexOffset: 460,
      icon: L.divIcon({
        className: 'seg-mid-wrap',
        html: `<div class="seg-mid">
          <div class="seg-mid-label">${name}<span>${kmText}</span></div>
        </div>`,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      }),
    }).addTo(drawLayer);
  }
}

/** Kilometre marks along the track (MapMagic-style distance markers, free). */
function drawDistanceMarks(path: LngLat[]): void {
  if (!showDistanceMarksInput.checked) return;
  if (path.length < 2) return;
  const total = pathLengthKm(path);
  if (!(total > 1)) return;
  const step = total > 120 ? 10 : total > 40 ? 5 : 2;
  for (let km = step; km < total - 0.4; km += step) {
    const { point } = pointAlongPath(path, km);
    L.marker([point.lat, point.lon], {
      interactive: false,
      keyboard: false,
      zIndexOffset: 420,
      icon: L.divIcon({
        className: 'dist-mark-wrap',
        html: `<div class="dist-mark">${Math.round(km)} км</div>`,
        iconSize: [1, 1],
        iconAnchor: [0, 0],
      }),
    }).addTo(drawLayer);
  }
}

function samplePathForElevation(path: LngLat[], maxSamples = 80): LngLat[] {
  if (path.length <= maxSamples) return path;
  const out: LngLat[] = [];
  const step = (path.length - 1) / (maxSamples - 1);
  for (let i = 0; i < maxSamples; i++) out.push(path[Math.round(i * step)]!);
  return out;
}

async function fetchElevations(points: LngLat[]): Promise<number[] | null> {
  if (points.length < 2) return null;
  const lats = points.map((p) => p.lat.toFixed(5)).join(',');
  const lons = points.map((p) => p.lon.toFixed(5)).join(',');
  const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { elevation?: number[] };
    if (!data.elevation || data.elevation.length !== points.length) return null;
    return data.elevation;
  } catch {
    return null;
  }
}

function paintElevationProfile(elevations: number[]): void {
  const ctx = elevCanvas.getContext('2d');
  if (!ctx || elevations.length < 2) {
    hideElevation();
    return;
  }
  const w = elevCanvas.width;
  const h = elevCanvas.height;
  ctx.clearRect(0, 0, w, h);
  let min = Infinity;
  let max = -Infinity;
  for (const z of elevations) {
    if (z < min) min = z;
    if (z > max) max = z;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    hideElevation();
    return;
  }
  const span = Math.max(8, max - min);
  elevRangeEl.textContent = `${Math.round(min)}…${Math.round(max)} м`;
  elevPanel.hidden = false;

  ctx.fillStyle = 'rgba(46, 196, 182, 0.18)';
  ctx.strokeStyle = 'rgba(46, 196, 182, 0.95)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let i = 0; i < elevations.length; i++) {
    const x = (i / (elevations.length - 1)) * (w - 4) + 2;
    const y = h - 4 - ((elevations[i]! - min) / span) * (h - 10);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.lineTo(w - 2, h - 2);
  ctx.lineTo(2, h - 2);
  ctx.closePath();
  ctx.fill();
}

let elevRequestId = 0;
async function updateElevationProfile(path: LngLat[]): Promise<void> {
  if (!showElevationInput.checked || path.length < 2) {
    hideElevation();
    return;
  }
  const id = ++elevRequestId;
  const samples = samplePathForElevation(path, 72);
  const elev = await fetchElevations(samples);
  if (id !== elevRequestId) return;
  if (!elev) {
    hideElevation();
    return;
  }
  paintElevationProfile(elev);
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildGpx(path: LngLat[], wps: Waypoint[], itinerary: ItinerarySegment[]): string {
  const name = itinerary.length
    ? itinerary.map((s) => s.name).join(' — ')
    : 'AquaRoute';
  const desc = itinerary.length
    ? formatItinerary(itinerary)
    : `Маршрут AquaRoute, ${formatKm(pathLengthKm(path))}`;
  const wptXml = wps
    .map(
      (wp, i) => `  <wpt lat="${wp.lat.toFixed(6)}" lon="${wp.lon.toFixed(6)}">
    <name>${xmlEscape(wp.name || `Точка ${i + 1}`)}</name>
  </wpt>`,
    )
    .join('\n');
  // Keep GPX responsive: densify not needed; thin only if huge.
  const track =
    path.length > 5000
      ? path.filter((_, i) => i === 0 || i === path.length - 1 || i % 2 === 0)
      : path;
  const trkpts = track
    .map((p) => `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="AquaRoute" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${xmlEscape(name)}</name>
    <desc>${xmlEscape(desc)}</desc>
  </metadata>
${wptXml}
  <trk>
    <name>${xmlEscape(name)}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

function downloadGpx(): void {
  if (!lastRoutePath || lastRoutePath.length < 2) {
    setStatus('Сначала постройте маршрут.', true);
    return;
  }
  const gpx = buildGpx(lastRoutePath, waypoints, lastItinerary);
  const blob = new Blob([gpx], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `aquaroute-${Date.now()}.gpx`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus('GPX сохранён — без подписки.');
}

function encodeRouteQuery(wps: Waypoint[]): string {
  return wps.map((w) => `${w.lon.toFixed(5)},${w.lat.toFixed(5)}`).join('|');
}

function parseRouteQuery(raw: string): LngLat[] {
  const out: LngLat[] = [];
  for (const part of raw.split('|')) {
    const [lonS, latS] = part.split(',');
    const lon = Number(lonS);
    const lat = Number(latS);
    if (Number.isFinite(lon) && Number.isFinite(lat)) out.push({ lon, lat });
  }
  return out;
}

function buildShareUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  if (waypoints.length >= 2) url.searchParams.set('route', encodeRouteQuery(waypoints));
  else url.searchParams.delete('route');
  url.searchParams.delete('demo');
  url.searchParams.delete('from');
  url.searchParams.delete('to');
  return url.toString();
}

async function shareRouteLink(): Promise<void> {
  if (waypoints.length < 2) {
    setStatus('Нужны минимум две точки.', true);
    return;
  }
  const link = buildShareUrl();
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
    else if (!copyTextFallback(link)) throw new Error('clipboard');
    // Keep URL bar in sync without reload.
    window.history.replaceState({}, '', link);
    setStatus('Ссылка на маршрут скопирована.');
  } catch {
    setStatus('Не удалось скопировать ссылку.', true);
  }
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
function drawRouteGeometry(
  path: LngLat[],
  opts: { itinerary?: ItinerarySegment[]; muted?: boolean } = {},
): void {
  const base = lineStyle();
  const style = opts.muted
    ? {
        ...base,
        opacity: Math.min(0.55, Number(base.opacity ?? 1) * 0.65),
        weight: Math.max(2, Number(base.weight ?? 4) - 1),
      }
    : base;
  const color = String(style.color ?? '#2ec4b6');
  const itinerary = opts.itinerary ?? (opts.muted ? [] : lastItinerary);
  const parallelLegs = opts.muted ? null : buildParallelLegs(path);
  if (parallelLegs) {
    for (const leg of parallelLegs) {
      if (leg.length < 2) continue;
      L.polyline(
        leg.map((p) => [p.lat, p.lon] as L.LatLngTuple),
        { ...style, interactive: false, smoothFactor: 0 },
      ).addTo(drawLayer);
      drawDirectionArrows(leg, color);
    }
    // Segment ticks on the geographic route (not offset lanes).
    if (itinerary.length) drawSegmentTicks(path, itinerary);
    drawDistanceMarks(path);
    if (!opts.muted) void updateElevationProfile(path);
    return;
  }
  L.polyline(
    path.map((p) => [p.lat, p.lon] as L.LatLngTuple),
    { ...style, interactive: false, smoothFactor: 0 },
  ).addTo(drawLayer);
  if (!opts.muted) drawDirectionArrows(path, color);
  if (itinerary.length) drawSegmentTicks(path, itinerary);
  drawDistanceMarks(path);
  if (!opts.muted) void updateElevationProfile(path);
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
      if (mode === 'water') {
        const snapped = snapClickToWater({ lon: wp.lon, lat: wp.lat });
        // Only pull when clearly off the centerline but still near water.
        if (snapped && snapped.distKm >= 0.04 && snapped.distKm <= 1.25) {
          wp.lon = snapped.point.lon;
          wp.lat = snapped.point.lat;
          if (snapped.name && isAutoWaypointName(wp.name)) {
            wp.name = snapped.name;
          }
          redrawWaypoints(lastRoutePath ?? undefined);
          renderWaypointList();
          const meters = Math.round(snapped.distKm * 1000);
          setStatus(
            snapped.name
              ? `Притянули к «${snapped.name}» (${meters} м).`
              : `Притянули к воде (${meters} м).`,
          );
        }
      }
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

  // Keep the built water track under ruler measurements.
  if (
    mode === 'ruler' &&
    pinnedWaterRoute &&
    pinnedWaterRoute.path.length >= 2
  ) {
    drawRouteGeometry(pinnedWaterRoute.path, {
      itinerary: pinnedWaterRoute.itinerary,
      muted: true,
    });
  }

  waypoints.forEach((wp, i) => attachWaypointMarker(wp, i));

  const forward = path && path.length >= 2 ? path : null;
  if (forward) {
    drawRouteGeometry(forward);
  } else if (waypoints.length >= 2) {
    L.polyline(
      waypoints.map((p) => [p.lat, p.lon] as L.LatLngTuple),
      { ...lineStyle(), opacity: 0.55, interactive: false, smoothFactor: 0 },
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
  // Panel control removed — inland rivers/canals are the default network.
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
    lastItinerary = path.itinerary ?? [];

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
    const ratio =
      path.lengthKm > 0 ? path.lengthKm / Math.max(geo, 0.001) : Infinity;
    // Near-geodesic = air/land cut. Do NOT treat normal cascade winding
    // (often 1.15–1.4× on geo>250) as air — that hid itineraries (Городец→Талица).
    const isAir =
      path.method === 'direct' ||
      path.points.length <= 3 ||
      (geo >= 12 && ratio < 0.85) ||
      (geo >= 15 && ratio <= 1.04) ||
      (geo >= 40 && ratio <= 1.08 && path.points.length < Math.max(5, geo / 25));
    void updateRouteItinerary(
      path.points,
      path.lengthKm,
      path.method === 'direct' ? null : waterLabel,
      { allowDescribe: !isAir, itinerary: path.itinerary },
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

    // Polish lakes / meanders / names in the background — do not block first paint.
    if (!isAir && path.method !== 'direct') {
      const gen = ++routeGeneration;
      const wps = waypoints.map((w) => ({ lon: w.lon, lat: w.lat }));
      void polishWaterPath(path, wps).then((polished) => {
        if (!polished || gen !== routeGeneration) return;
        if (busy) return;
        lastRoutePath = polished.points;
        lastCumKm = polished.waypointCumKm ?? lastCumKm;
        lastItinerary = polished.itinerary ?? lastItinerary;
        lastDistanceKm = polished.lengthKm;
        showStats(polished.lengthKm);
        if (lastItinerary.length) {
          showRouteDesc(formatItinerary(lastItinerary), lastItinerary);
        }
        redrawWaypoints(polished.points);
        renderWaypointList();
        void updateElevationProfile(polished.points);
      });
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
  const prev = mode;
  // Pin the water track before leaving inland mode so the ruler can keep it.
  if (
    prev === 'water' &&
    next === 'ruler' &&
    lastRoutePath &&
    lastRoutePath.length >= 2
  ) {
    pinnedWaterRoute = {
      path: lastRoutePath.slice(),
      itinerary: lastItinerary.map((s) => ({ ...s })),
      cumKm: lastCumKm.slice(),
      distanceKm: lastDistanceKm,
    };
  }

  mode = next;
  document.querySelectorAll('.mode-btn').forEach((btn) => {
    btn.classList.toggle('active', (btn as HTMLElement).dataset.mode === next);
  });
  const water = next === 'water';
  routeBtn.textContent = next === 'ruler' ? 'Измерить' : 'Проложить';

  waypoints = [];
  lastRoutePath = null;
  lastCumKm = [];
  lastItinerary = [];
  drawLayer.clearLayers();

  if (next === 'ruler' && pinnedWaterRoute) {
    // Keep water stats/description; ruler will overlay its own distance when set.
    if (pinnedWaterRoute.distanceKm != null) {
      lastDistanceKm = pinnedWaterRoute.distanceKm;
      showStats(pinnedWaterRoute.distanceKm);
    }
    if (pinnedWaterRoute.itinerary.length) {
      showRouteDesc(formatItinerary(pinnedWaterRoute.itinerary), pinnedWaterRoute.itinerary);
    }
    redrawWaypoints();
    syncControls();
    setStatus('Кликните точки для измерения. Построенный маршрут остаётся на карте.');
    return;
  }

  if (next === 'water' && pinnedWaterRoute) {
    // Restore the pinned inland route when returning from the ruler.
    lastRoutePath = pinnedWaterRoute.path;
    lastItinerary = pinnedWaterRoute.itinerary;
    lastCumKm = pinnedWaterRoute.cumKm;
    lastDistanceKm = pinnedWaterRoute.distanceKm;
    if (lastDistanceKm != null) showStats(lastDistanceKm);
    if (lastItinerary.length) {
      showRouteDesc(formatItinerary(lastItinerary), lastItinerary);
    }
    redrawWaypoints(lastRoutePath);
    syncControls();
    setStatus('Кликните точки маршрута на воде.');
    warmWaterCache();
    return;
  }

  pinnedWaterRoute = null;
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

  let lon = lng;
  let pointLat = lat;
  let label = nearestPortName(lng, lat) ?? undefined;
  let snapNote = '';

  if (mode === 'water') {
    prefetchWaterNear({ lon: lng, lat });
    const snapped = snapClickToWater({ lon: lng, lat });
    if (snapped && snapped.distKm <= 1.25) {
      // Already on water (<40 m) — keep the click; otherwise pull to centerline.
      if (snapped.distKm >= 0.04) {
        lon = snapped.point.lon;
        pointLat = snapped.point.lat;
        const meters = Math.round(snapped.distKm * 1000);
        snapNote = snapped.name
          ? ` Притянули к «${snapped.name}» (${meters} м).`
          : ` Притянули к воде (${meters} м).`;
      }
      if (!label && snapped.name) label = snapped.name;
    }
  }

  const wp = makeWaypoint(lon, pointLat, label);
  waypoints.push(wp);
  redrawWaypoints(lastRoutePath ?? undefined);
  syncControls();
  if (mode === 'water') prefetchWaterNear({ lon, lat: pointLat });

  if (mode === 'water') {
    if (waypoints.length === 1) {
      setStatus(`Старт отмечен.${snapNote} Кликните следующую точку на реке или море.`);
    } else {
      if (snapNote) setStatus(snapNote.trim());
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
  lastItinerary = [];
  if (waypoints.length >= 2) {
    if (mode === 'water') void computeWaterRoute({ fit: false });
    else computeRuler({ fit: false });
  } else {
    clearStats();
    redrawWaypoints();
    syncControls();
  }
});

reverseBtn.addEventListener('click', () => {
  if (waypoints.length < 2) return;
  waypoints.reverse();
  renormalizeWaypointNames();
  lastRoutePath = lastRoutePath ? [...lastRoutePath].reverse() : null;
  lastCumKm = [];
  lastItinerary = [];
  redrawWaypoints(lastRoutePath ?? undefined);
  syncControls();
  if (mode === 'water') void computeWaterRoute({ fit: false });
  else computeRuler({ fit: false });
  setStatus('Маршрут развёрнут.');
});

clearBtn.addEventListener('click', () => {
  waypoints = [];
  lastRoutePath = null;
  lastCumKm = [];
  lastItinerary = [];
  pinnedWaterRoute = null;
  drawLayer.clearLayers();
  clearStats();
  syncControls();
  setStatus('');
});

speedInput.addEventListener('input', () => {
  refreshEtaFromSpeed();
  syncSpeedPresetChips();
});

function syncSpeedPresetChips(): void {
  if (!speedPresets) return;
  const v = Math.round(Number(speedInput.value) || 0);
  speedPresets.querySelectorAll<HTMLButtonElement>('.chip[data-speed]').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.speed) === v);
  });
}

speedPresets?.addEventListener('click', (ev) => {
  const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('.chip[data-speed]');
  if (!btn) return;
  const speed = Number(btn.dataset.speed);
  if (!Number.isFinite(speed)) return;
  speedInput.value = String(speed);
  refreshEtaFromSpeed();
  syncSpeedPresetChips();
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
showDistanceMarksInput.addEventListener('change', () => {
  if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
});
showElevationInput.addEventListener('change', () => {
  if (showElevationInput.checked && lastRoutePath && lastRoutePath.length >= 2) {
    void updateElevationProfile(lastRoutePath);
  } else {
    hideElevation();
  }
});
showReturnInput.addEventListener('change', () => {
  if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
  else restyleRouteLine();
});
showArrowsInput.addEventListener('change', () => {
  if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
  else restyleRouteLine();
});
showSegmentLabelsInput.addEventListener('change', () => {
  if (lastRoutePath && lastRoutePath.length >= 2) redrawWaypoints(lastRoutePath);
  else if (pinnedWaterRoute && pinnedWaterRoute.path.length >= 2) redrawWaypoints();
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
shareRouteBtn.addEventListener('click', () => {
  void shareRouteLink();
});
gpxExportBtn.addEventListener('click', () => {
  downloadGpx();
});
function bootFromQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const qMode = params.get('mode');
  if (qMode === 'ruler') setMode('ruler');
  else if (qMode === 'water' || qMode === 'sea' || qMode === 'inland') setMode('water');

  const routeRaw = params.get('route');
  if (routeRaw) {
    const pts = parseRouteQuery(routeRaw);
    if (pts.length >= 2) {
      setMode('water');
      waypoints = pts.map((p, i) =>
        makeWaypoint(
          p.lon,
          p.lat,
          i === 0 ? 'Старт' : i === pts.length - 1 ? 'Финиш' : `Точка ${i + 1}`,
        ),
      );
      const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
      const midLon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
      map.setView([midLat, midLon], 9);
      redrawWaypoints();
      syncControls();
      void computeWaterRoute({ fit: true });
      return;
    }
  }

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
syncSpeedPresetChips();
setStatus('Кликните точки маршрута на воде.');
warmWaterCache();
bootFromQuery();
