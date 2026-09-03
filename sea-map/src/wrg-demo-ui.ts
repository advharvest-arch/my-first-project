/**
 * WaterGraph Demo / Shadow UI on the existing Leaflet map.
 * Does not call measureWaterChain, BRouter, or production drawLayer.
 */

import type { Map as LeafletMap } from 'leaflet';
import { WRG_DEMO_CASES } from './wrg-demo-cases';
import { requestWrgDemoRoute } from './wrg-demo-client';
import {
  WrgDemoController,
  formatWrgDemoPanel,
  isWrgDemoHttpErrorStatus,
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
  root.setAttribute('aria-label', 'WaterGraph Demo');

  const toggle = el('button', 'wrg-demo__toggle', 'WaterGraph Demo') as HTMLButtonElement;
  toggle.type = 'button';

  const body = el('div', 'wrg-demo__body');
  const hint = el(
    'p',
    'wrg-demo__hint',
    'Shadow mode. Клик A → клик B → WRG-маршрут. Clear сбрасывает пару. Production не меняется.',
  );
  const resultEl = el('pre', 'wrg-demo__result', '');
  const clearBtn = el('button', 'wrg-demo__btn', 'Clear A/B · Reset') as HTMLButtonElement;
  clearBtn.type = 'button';

  const casesWrap = el('div', 'wrg-demo__cases');
  for (const c of WRG_DEMO_CASES) {
    const btn = el('button', 'wrg-demo__btn wrg-demo__btn--case', c.name) as HTMLButtonElement;
    btn.type = 'button';
    btn.dataset.caseId = c.id;
    casesWrap.append(btn);
  }

  body.append(hint, casesWrap, clearBtn, resultEl);
  root.append(toggle, body);
  document.body.append(root);

  const sync = (state: WrgDemoState) => {
    root.classList.toggle('is-on', state.enabled);
    document.body.classList.toggle('wrg-demo-on', state.enabled);
    toggle.classList.toggle('is-active', state.enabled);
    toggle.setAttribute('aria-pressed', state.enabled ? 'true' : 'false');
    resultEl.textContent = formatWrgDemoPanel(state);
    layers.render(wrgDemoMapView(state));
    setSuppressMapClick(state.enabled);
  };

  const runRoute = async (a: WrgDemoPoint, b: WrgDemoPoint) => {
    resultEl.textContent = 'WaterGraph считает маршрут…';
    const res: WrgDemoRouteResult = await requestWrgDemoRoute(a, b);
    if (isWrgDemoHttpErrorStatus(res.status)) {
      sync(controller.applyError(String(res.detail ?? res.status)));
      layers.render(wrgDemoMapView(controller.getState()));
      return;
    }
    sync(controller.applyResult(res));
    const view = wrgDemoMapView(controller.getState());
    if (view.routeLatLngs && view.routeLatLngs.length >= 2) {
      map.fitBounds(view.routeLatLngs, { padding: [48, 48], maxZoom: 13 });
    } else if (a && b) {
      map.fitBounds(
        [
          [a.lat, a.lon],
          [b.lat, b.lon],
        ],
        { padding: [48, 48], maxZoom: 13 },
      );
    }
  };

  toggle.addEventListener('click', () => {
    if (controller.isEnabled()) sync(controller.disable());
    else sync(controller.enable());
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
    }
  });

  const params = new URLSearchParams(window.location.search);
  if (params.get('wrgDemo') === '1' || params.get('wrg-demo') === '1') {
    sync(controller.enable());
  } else {
    sync(controller.getState());
  }

  return controller;
}
