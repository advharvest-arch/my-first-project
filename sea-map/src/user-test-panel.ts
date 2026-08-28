/**
 * USER_TEST_READY — compact DEV-only test panel.
 * Never mounted in production builds (import.meta.env.DEV).
 */

import type { Map as LeafletMap } from 'leaflet';
import type { LngLat } from './geo';
import { getLastRouteTrace, setRouteTraceSink, type RouteTrace } from './route-trace';
import {
  USER_TEST_PRESETS,
  getUserTestPreset,
  type UserTestPreset,
} from './user-test-presets';
import {
  formatUserTestSessionSummary,
  getLastUserTestTrace,
  getUserTestSessionSummary,
  recordUserTestTrace,
  resetUserTestSession,
} from './user-test-session';
import {
  getRouteFeatureFlags,
  setRouteFeatureFlagsForTests,
} from './route-feature-flags';
import {
  userRouterSourceFromHybrid,
  userRouterSourceLabelEn,
} from './hybrid-router-ui';

export type UserTestPanelHooks = {
  map: LeafletMap;
  /** Replace A/B waypoints and run the normal water router. */
  runRoute: (a: LngLat, b: LngLat, meta?: { presetId?: string }) => Promise<void>;
  /** Optional: clear map route/waypoints. */
  clearRoute?: () => void;
  /** Suppress normal map click → waypoint while picking A/B. */
  setSuppressMapClick?: (next: boolean) => void;
  /** E2.16 — notify app when Hybrid WaterGraph toggle changes. */
  onHybridToggle?: (enabled: boolean) => void;
};

type PickTarget = 'A' | 'B' | null;

let pickTarget: PickTarget = null;
let activePresetId: string | null = null;
let panelEl: HTMLElement | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function parseCoord(raw: string): number | null {
  const n = Number(String(raw).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fmtCoord(n: number): string {
  return n.toFixed(5);
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function isUserTestModeEnabled(): boolean {
  return import.meta.env.DEV === true;
}

export function mountUserTestPanel(hooks: UserTestPanelHooks): void {
  if (!isUserTestModeEnabled()) return;
  if (panelEl) return;

  const root = el('aside', 'user-test-panel');
  root.setAttribute('aria-label', 'AquaRoute manual test panel');

  const title = el('div', 'user-test-panel__title', 'TEST ROUTE');
  const hint = el(
    'p',
    'user-test-panel__hint',
    'Dev trial · Hybrid: checkbox or ?wg=1 · off = normal BRouter',
  );

  const aLon = el('input', 'user-test-panel__input') as HTMLInputElement;
  const aLat = el('input', 'user-test-panel__input') as HTMLInputElement;
  const bLon = el('input', 'user-test-panel__input') as HTMLInputElement;
  const bLat = el('input', 'user-test-panel__input') as HTMLInputElement;
  aLon.placeholder = 'lon';
  aLat.placeholder = 'lat';
  bLon.placeholder = 'lon';
  bLat.placeholder = 'lat';
  aLon.type = aLat.type = bLon.type = bLat.type = 'text';
  aLon.inputMode = aLat.inputMode = bLon.inputMode = bLat.inputMode = 'decimal';

  const pickA = el('button', 'user-test-panel__btn user-test-panel__btn--ghost', 'Pick A') as HTMLButtonElement;
  const pickB = el('button', 'user-test-panel__btn user-test-panel__btn--ghost', 'Pick B') as HTMLButtonElement;
  pickA.type = pickB.type = 'button';

  const buildBtn = el('button', 'user-test-panel__btn user-test-panel__btn--primary', 'BUILD ROUTE') as HTMLButtonElement;
  buildBtn.type = 'button';

  const presetSelect = el('select', 'user-test-panel__select') as HTMLSelectElement;
  const groups = [
    ['safe', 'SAFE / CONTROL'],
    ['target', 'TARGET'],
    ['safety', 'SAFETY'],
    ['rivers', 'RIVERS'],
  ] as const;
  for (const [g, label] of groups) {
    const og = document.createElement('optgroup');
    og.label = label;
    for (const p of USER_TEST_PRESETS.filter((x) => x.group === g)) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.id} — ${p.name}`;
      og.appendChild(opt);
    }
    presetSelect.appendChild(og);
  }

  const runPresetBtn = el('button', 'user-test-panel__btn', 'RUN PRESET') as HTMLButtonElement;
  runPresetBtn.type = 'button';
  const expectedEl = el('pre', 'user-test-panel__expected', '');

  const resultEl = el('pre', 'user-test-panel__result', 'Result: —');
  const sessionEl = el('pre', 'user-test-panel__session', formatUserTestSessionSummary());

  const showTraceBtn = el('button', 'user-test-panel__btn', 'SHOW TRACE') as HTMLButtonElement;
  const copyTraceBtn = el('button', 'user-test-panel__btn', 'COPY TRACE') as HTMLButtonElement;
  const downloadTraceBtn = el('button', 'user-test-panel__btn', 'DOWNLOAD TRACE') as HTMLButtonElement;
  const resetSessionBtn = el('button', 'user-test-panel__btn user-test-panel__btn--ghost', 'RESET SESSION') as HTMLButtonElement;
  const collapseBtn = el('button', 'user-test-panel__collapse', '▾') as HTMLButtonElement;
  showTraceBtn.type = copyTraceBtn.type = downloadTraceBtn.type = resetSessionBtn.type = collapseBtn.type = 'button';

  const traceEl = el('pre', 'user-test-panel__trace');
  traceEl.hidden = true;

  function setPick(next: PickTarget): void {
    pickTarget = next;
    pickA.classList.toggle('is-active', next === 'A');
    pickB.classList.toggle('is-active', next === 'B');
    hooks.map.getContainer().style.cursor = next ? 'crosshair' : '';
    hooks.setSuppressMapClick?.(Boolean(next));
  }

  function fillFromPreset(p: UserTestPreset): void {
    aLon.value = fmtCoord(p.a.lon);
    aLat.value = fmtCoord(p.a.lat);
    bLon.value = fmtCoord(p.b.lon);
    bLat.value = fmtCoord(p.b.lat);
    expectedEl.textContent = `expected: ${p.expectedCurrentStatus}\npurpose: ${p.purpose}`;
  }

  function readAB(): { a: LngLat; b: LngLat } | null {
    const alo = parseCoord(aLon.value);
    const ala = parseCoord(aLat.value);
    const blo = parseCoord(bLon.value);
    const bla = parseCoord(bLat.value);
    if (alo == null || ala == null || blo == null || bla == null) return null;
    return { a: { lon: alo, lat: ala }, b: { lon: blo, lat: bla } };
  }

  function renderFromTrace(trace: RouteTrace | null): void {
    sessionEl.textContent = formatUserTestSessionSummary();
    if (!trace) {
      resultEl.textContent = 'Result: —';
      return;
    }
    const ok = trace.final.ok;
    const source = userRouterSourceFromHybrid(trace.hybridRouter, ok);
    const routerLine = userRouterSourceLabelEn(source);
    resultEl.textContent = [
      `Result: ${ok ? 'OK' : 'ROUTE NOT FOUND'}`,
      `Router: ${routerLine}`,
      `Length: ${trace.final.lengthKm.toFixed(1)} km`,
      `Water: ${trace.final.waterName ?? '—'}`,
      `Preset: ${activePresetId ?? '—'}`,
    ].join('\n');
  }

  function syncWgQuery(enabled: boolean): void {
    const url = new URL(window.location.href);
    if (enabled) url.searchParams.set('wg', '1');
    else url.searchParams.delete('wg');
    url.searchParams.delete('useWaterGraph');
    window.history.replaceState({}, '', url.toString());
  }

  async function build(meta?: { presetId?: string }): Promise<void> {
    const ab = readAB();
    if (!ab) {
      resultEl.textContent = 'Result: invalid A/B coordinates';
      return;
    }
    activePresetId = meta?.presetId ?? null;
    buildBtn.disabled = true;
    runPresetBtn.disabled = true;
    resultEl.textContent = 'Result: building…';
    try {
      await hooks.runRoute(ab.a, ab.b, { presetId: activePresetId ?? undefined });
      // Trace sink records asynchronously at end of measureWaterChain;
      // read buffer after a tick in case hybrid finishes inland last.
      window.setTimeout(() => {
        const trace = getLastUserTestTrace() ?? getLastRouteTrace();
        renderFromTrace(trace);
        buildBtn.disabled = false;
        runPresetBtn.disabled = false;
      }, 50);
    } catch (err) {
      resultEl.textContent = `Result: error ${err instanceof Error ? err.message : String(err)}`;
      buildBtn.disabled = false;
      runPresetBtn.disabled = false;
    }
  }

  // Layout
  const head = el('div', 'user-test-panel__head');
  head.append(title, collapseBtn);
  root.append(head, hint);

  const wgLabel = el('label', 'user-test-panel__row') as HTMLLabelElement;
  const wgCheck = document.createElement('input');
  wgCheck.type = 'checkbox';
  wgCheck.checked = getRouteFeatureFlags().USE_WATER_GRAPH;
  const wgText = document.createElement('span');
  wgText.className = 'user-test-panel__label';
  wgText.textContent = 'Hybrid WaterGraph (пилот)';
  wgLabel.append(wgCheck, wgText);
  wgCheck.addEventListener('change', () => {
    const on = wgCheck.checked;
    setRouteFeatureFlagsForTests(on ? { USE_WATER_GRAPH: true } : null);
    syncWgQuery(on);
    hooks.onHybridToggle?.(on);
  });

  const aRow = el('div', 'user-test-panel__row');
  aRow.append(el('span', 'user-test-panel__label', 'A'), aLon, aLat, pickA);
  const bRow = el('div', 'user-test-panel__row');
  bRow.append(el('span', 'user-test-panel__label', 'B'), bLon, bLat, pickB);
  root.append(aRow, bRow, wgLabel, buildBtn);

  const presetBlock = el('div', 'user-test-panel__block');
  presetBlock.append(el('div', 'user-test-panel__label', 'Preset'), presetSelect, runPresetBtn, expectedEl);
  root.append(presetBlock);

  root.append(resultEl);
  const tools = el('div', 'user-test-panel__tools');
  tools.append(showTraceBtn, copyTraceBtn, downloadTraceBtn, resetSessionBtn);
  root.append(tools, traceEl, el('div', 'user-test-panel__label', 'Session'), sessionEl);

  document.body.appendChild(root);
  panelEl = root;
  document.body.classList.add('has-user-test-panel');

  // Default preset selection
  fillFromPreset(USER_TEST_PRESETS[0]!);

  setRouteTraceSink((trace) => {
    recordUserTestTrace(trace, activePresetId);
    renderFromTrace(trace);
  });

  pickA.addEventListener('click', () => setPick(pickTarget === 'A' ? null : 'A'));
  pickB.addEventListener('click', () => setPick(pickTarget === 'B' ? null : 'B'));

  hooks.map.on('click', (e) => {
    if (!pickTarget) return;
    const { lat, lng } = e.latlng;
    if (pickTarget === 'A') {
      aLon.value = fmtCoord(lng);
      aLat.value = fmtCoord(lat);
    } else {
      bLon.value = fmtCoord(lng);
      bLat.value = fmtCoord(lat);
    }
    setPick(null);
  });

  buildBtn.addEventListener('click', () => {
    void build();
  });

  presetSelect.addEventListener('change', () => {
    const p = getUserTestPreset(presetSelect.value);
    if (p) fillFromPreset(p);
  });

  runPresetBtn.addEventListener('click', () => {
    const p = getUserTestPreset(presetSelect.value);
    if (!p) return;
    fillFromPreset(p);
    hooks.map.setView([(p.a.lat + p.b.lat) / 2, (p.a.lon + p.b.lon) / 2], p.zoom);
    void build({ presetId: p.id });
  });

  showTraceBtn.addEventListener('click', () => {
    const trace = getLastUserTestTrace() ?? getLastRouteTrace();
    if (!trace) {
      traceEl.hidden = false;
      traceEl.textContent = 'No RouteTrace yet. Build a route first.';
      return;
    }
    traceEl.hidden = !traceEl.hidden;
    if (!traceEl.hidden) traceEl.textContent = JSON.stringify(trace, null, 2);
  });

  copyTraceBtn.addEventListener('click', () => {
    const trace = getLastUserTestTrace() ?? getLastRouteTrace();
    if (!trace) return;
    void copyText(JSON.stringify(trace, null, 2)).then((ok) => {
      copyTraceBtn.textContent = ok ? 'COPIED' : 'COPY FAILED';
      window.setTimeout(() => {
        copyTraceBtn.textContent = 'COPY TRACE';
      }, 1200);
    });
  });

  downloadTraceBtn.addEventListener('click', () => {
    const trace = getLastUserTestTrace() ?? getLastRouteTrace();
    if (!trace) return;
    downloadJson(`aquaroute-trace-${trace.requestId}.json`, trace);
  });

  resetSessionBtn.addEventListener('click', () => {
    resetUserTestSession();
    renderFromTrace(null);
    traceEl.hidden = true;
    hooks.clearRoute?.();
  });

  collapseBtn.addEventListener('click', () => {
    root.classList.toggle('is-collapsed');
    collapseBtn.textContent = root.classList.contains('is-collapsed') ? '▸' : '▾';
  });
}

export function getUserTestPanelDebugSnapshot(): {
  session: ReturnType<typeof getUserTestSessionSummary>;
  lastTrace: RouteTrace | null;
} {
  return {
    session: getUserTestSessionSummary(),
    lastTrace: getLastUserTestTrace(),
  };
}
