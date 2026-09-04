/**
 * WaterGraph Demo / Shadow UI on the existing Leaflet map.
 * Free Route is the primary mode. Vias use sequential /wrg-demo/route legs.
 * Five validation cases live under Tests / Examples.
 * Does not call measureWaterChain, BRouter, or production drawLayer.
 */

import type { Map as LeafletMap } from 'leaflet';
import { WRG_DEMO_CASES, WRG_FREE_ROUTE_UI, WRG_FREE_ROUTE_VIEW } from './wrg-demo-cases';
import { requestWrgDemoChain, requestWrgDemoRoute } from './wrg-demo-client';
import {
  WrgDemoController,
  formatWrgDemoPanel,
  isWrgDemoHttpErrorStatus,
  shouldAutoEnableWrgFreeRoute,
  wrgDemoMapView,
} from './wrg-demo-controller';
import { WrgDemoLayers } from './wrg-demo-layers';
import type { WrgDemoPoint, WrgDemoRouteResult, WrgDemoState } from './wrg-demo-types';

export type WrgDemoHooks = {
  map: LeafletMap;
  /** Keep production map-click → waypoint from firing while demo is on. */
  setSuppressMapClick: (next: boolean) => void;
};

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

export function mountWrgDemo(hooks: WrgDemoHooks): WrgDemoController {
  const { map, setSuppressMapClick } = hooks;
  const controller = new WrgDemoController();
  const layers = new WrgDemoLayers(map);

  const root = el('aside', 'wrg-demo');
  root.setAttribute('aria-label', WRG_FREE_ROUTE_UI.title);
  root.dataset.mode = 'free-route';

  const toggle = el('button', 'wrg-demo__toggle', WRG_FREE_ROUTE_UI.title) as HTMLButtonElement;
  toggle.type = 'button';

  const body = el('div', 'wrg-demo__body');
  const title = el('h2', 'wrg-demo__title', WRG_FREE_ROUTE_UI.title);
  const hint = el('p', 'wrg-demo__hint', WRG_FREE_ROUTE_UI.hint);
  const resultEl = el('pre', 'wrg-demo__result', '');

  const viaRow = el('label', 'wrg-demo__via-toggle');
  const viaCheck = el('input') as HTMLInputElement;
  viaCheck.type = 'checkbox';
  viaCheck.checked = false;
  viaRow.append(viaCheck, document.createTextNode(` ${WRG_FREE_ROUTE_UI.viaToggleLabel}`));

  const actions = el('div', 'wrg-demo__actions');
  const finishBtn = el(
    'button',
    'wrg-demo__btn wrg-demo__btn--finish',
    WRG_FREE_ROUTE_UI.finishLabel,
  ) as HTMLButtonElement;
  finishBtn.type = 'button';
  const clearBtn = el('button', 'wrg-demo__btn wrg-demo__btn--clear', 'Clear') as HTMLButtonElement;
  clearBtn.type = 'button';
  actions.append(finishBtn, clearBtn);

  const examples = el('details', 'wrg-demo__examples');
  examples.open = WRG_FREE_ROUTE_UI.examplesOpenByDefault;
  const summary = el('summary', 'wrg-demo__examples-summary', WRG_FREE_ROUTE_UI.examplesLabel);
  const casesWrap = el('div', 'wrg-demo__cases');
  for (const c of WRG_DEMO_CASES) {
    const btn = el('button', 'wrg-demo__btn wrg-demo__btn--case', c.name) as HTMLButtonElement;
    btn.type = 'button';
    btn.dataset.caseId = c.id;
    casesWrap.append(btn);
  }
  examples.append(summary, casesWrap);

  body.append(title, hint, resultEl, viaRow, actions, examples);
  root.append(toggle, body);
  document.body.append(root);

  const fitRoute = (state: WrgDemoState, a: WrgDemoPoint, b: WrgDemoPoint) => {
    const view = wrgDemoMapView(state);
    const all = view.routeSegments.flat();
    if (all.length >= 2) {
      map.fitBounds(all, { padding: [48, 48], maxZoom: 13 });
    } else if (view.routeLatLngs && view.routeLatLngs.length >= 2) {
      map.fitBounds(view.routeLatLngs, { padding: [48, 48], maxZoom: 13 });
    } else {
      map.fitBounds(
        [
          [a.lat, a.lon],
          [b.lat, b.lon],
        ],
        { padding: [48, 48], maxZoom: 13 },
      );
    }
  };

  const sync = (state: WrgDemoState) => {
    root.classList.toggle('is-on', state.enabled);
    document.body.classList.toggle('wrg-demo-on', state.enabled);
    toggle.classList.toggle('is-active', state.enabled);
    toggle.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    viaCheck.checked = state.viaMode;
    const canArmFinish =
      state.enabled &&
      state.viaMode &&
      !!state.a &&
      !state.b &&
      state.phase !== 'routing' &&
      state.phase !== 'result';
    finishBtn.disabled = !canArmFinish;
    finishBtn.classList.toggle('is-armed', state.phase === 'pick-finish');
    resultEl.textContent = formatWrgDemoPanel(state);
    layers.render(wrgDemoMapView(state));
    setSuppressMapClick(state.enabled);
  };

  const runRoute = async (a: WrgDemoPoint, b: WrgDemoPoint) => {
    resultEl.textContent = formatWrgDemoPanel(controller.getState());
    const res: WrgDemoRouteResult = await requestWrgDemoRoute(a, b);
    if (isWrgDemoHttpErrorStatus(res.status)) {
      sync(controller.applyError(String(res.detail ?? res.status)));
      return;
    }
    const state = controller.applyResult(res);
    sync(state);
    fitRoute(state, a, b);
  };

  const runChain = async (points: WrgDemoPoint[]) => {
    resultEl.textContent = formatWrgDemoPanel(controller.getState());
    const chain = await requestWrgDemoChain(points);
    const state = controller.applyChain(chain);
    sync(state);
    const first = points[0]!;
    const last = points[points.length - 1]!;
    fitRoute(state, first, last);
  };

  toggle.addEventListener('click', () => {
    if (controller.isEnabled()) sync(controller.disable());
    else sync(controller.enable());
  });

  viaCheck.addEventListener('change', () => {
    sync(controller.setViaMode(viaCheck.checked));
  });

  finishBtn.addEventListener('click', () => {
    sync(controller.armFinish());
  });

  clearBtn.addEventListener('click', () => {
    sync(controller.clear());
  });

  casesWrap.addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-case-id]');
    if (!btn?.dataset.caseId) return;
    const c = WRG_DEMO_CASES.find((x) => x.id === btn.dataset.caseId);
    if (!c) return;
    if (!controller.isEnabled()) controller.enable();
    map.setView([(c.a.lat + c.b.lat) / 2, (c.a.lon + c.b.lon) / 2], c.zoom);
    sync(controller.setPoints(c.a, c.b));
    void runRoute(c.a, c.b);
  });

  map.on('click', (e) => {
    if (!controller.isEnabled()) return;
    const effect = controller.click(e.latlng.lng, e.latlng.lat);
    if (effect.kind === 'ignored') return;
    sync(controller.getState());
    if (effect.kind === 'set-b-and-route') {
      void runRoute(effect.a, effect.b);
    } else if (effect.kind === 'set-finish-and-route') {
      void runChain(effect.points);
    }
  });

  if (shouldAutoEnableWrgFreeRoute(window.location.search)) {
    sync(controller.enable());
    map.setView([WRG_FREE_ROUTE_VIEW.lat, WRG_FREE_ROUTE_VIEW.lon], WRG_FREE_ROUTE_VIEW.zoom, {
      animate: false,
    });
  } else {
    sync(controller.getState());
  }

  return controller;
}
