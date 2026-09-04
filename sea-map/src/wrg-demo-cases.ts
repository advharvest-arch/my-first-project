/**
 * WRG-004 validation coordinates for the Demo UI.
 * Same points as water-data/ingest/wrg_route.py VALIDATION_CASES.
 */

import type { WrgDemoCase } from './wrg-demo-types';

/** Camera for Free Route so the user can click water without a case button. */
export const WRG_FREE_ROUTE_VIEW = {
  lon: 37.44,
  lat: 60.29,
  zoom: 9,
} as const;

export const WRG_FREE_ROUTE_UI = {
  title: 'Free Route',
  hint: 'Первый клик = Start (A), второй = Finish (B). «Промежуточные точки» — C1, C2… затем Finish. Clear — новый тест.',
  examplesLabel: 'Tests / Examples',
  examplesOpenByDefault: false,
  viaToggleLabel: 'Промежуточные точки',
  finishLabel: 'Finish',
} as const;

export const WRG_DEMO_CASES: WrgDemoCase[] = [
  {
    id: 'beloye_kovzha_belozersky',
    name: 'Белое: Ковжа → Белозерский',
    a: { lon: 37.15860787, lat: 60.33563016 },
    b: { lon: 37.2263761, lat: 60.2570485 },
    expect: 'ROUTE_FOUND',
    zoom: 10,
  },
  {
    id: 'beloye_same_part',
    name: 'Белое: одна part',
    a: { lon: 37.5591499, lat: 60.3253729 },
    b: { lon: 37.3270442, lat: 60.2490477 },
    expect: 'ROUTE_FOUND',
    zoom: 10,
  },
  {
    id: 'vygozero_same_part',
    name: 'Выгозеро: одна part',
    a: { lon: 34.3220777, lat: 63.8827376 },
    b: { lon: 34.245828, lat: 63.8472787 },
    expect: 'ROUTE_FOUND',
    zoom: 10,
  },
  {
    id: 'strelka_land_separation',
    name: 'Стрелка: через сушу',
    a: { lon: 30.2091961, lat: 59.9667554 },
    b: { lon: 30.2773486, lat: 59.9815368 },
    expect: 'NO_WATER_CONNECTION',
    zoom: 12,
  },
  {
    id: 'land_off_network',
    name: 'Суша: вне сети',
    a: { lon: 30.2348444, lat: 59.94200785 },
    b: { lon: 30.2773486, lat: 59.9815368 },
    expect: 'ENDPOINT_NOT_ON_WATER',
    zoom: 12,
  },
];
