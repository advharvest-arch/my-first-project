/**
 * USER_TEST_READY — manual test presets for AquaRoute.
 * expectedCurrentStatus is documentation for human testers only —
 * never read by routing / validators / knowledge matching.
 */

import type { LngLat } from './geo';

export type UserTestGroup = 'safe' | 'target' | 'safety' | 'rivers';

export type UserTestExpectedStatus =
  | 'ok_expected'
  | 'fail_expected'
  | 'flaky_or_unknown'
  | 'advisory_interesting';

export type UserTestPreset = {
  id: string;
  name: string;
  group: UserTestGroup;
  a: LngLat;
  b: LngLat;
  zoom: number;
  expectedCurrentStatus: UserTestExpectedStatus;
  purpose: string;
};

/**
 * Coordinates taken from existing regression / E1 fixtures and live corridor notes.
 * Status labels are hints for manual testing — not assertions for CI routing.
 */
export const USER_TEST_PRESETS: UserTestPreset[] = [
  // —— SAFE / CONTROL ——
  {
    id: 'L01',
    name: 'L01 Rybinsk mid-pool',
    group: 'safe',
    a: { lon: 38.1, lat: 58.4 },
    b: { lon: 38.6, lat: 58.35 },
    zoom: 10,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'Control open-lake short hop on Rybinsk mid-pool',
  },
  {
    id: 'L05',
    name: 'L05 Cheboksary pool span',
    group: 'safe',
    a: { lon: 45.45, lat: 56.35 },
    b: { lon: 47.25, lat: 56.14 },
    zoom: 9,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'Control shared-lake / fairway corridor (Cheboksary pool)',
  },
  {
    id: 'L07',
    name: 'L07 Kuibyshev → Tolyatti long',
    group: 'safe',
    a: { lon: 49.0, lat: 55.75 },
    b: { lon: 49.4, lat: 53.55 },
    zoom: 7,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'Long shared-lake control (Phase C residual / fairway)',
  },
  {
    id: 'L14',
    name: 'L14 Rybinsk approach → lock',
    group: 'safe',
    a: { lon: 38.4, lat: 58.3 },
    b: { lon: 38.72, lat: 58.05 },
    zoom: 10,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'Control approach through Rybinsk lock corridor',
  },
  {
    id: 'R01',
    name: 'R01 Myshkin → Rybinsk',
    group: 'safe',
    a: { lon: 38.4516, lat: 57.7847 },
    b: { lon: 38.8559, lat: 58.049 },
    zoom: 9,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'River/reservoir control corridor (Myshkin→Rybinsk)',
  },
  {
    id: 'R03',
    name: 'R03 Ilmen short lake',
    group: 'safe',
    a: { lon: 31.15, lat: 58.3 },
    b: { lon: 31.55, lat: 58.28 },
    zoom: 10,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'Short verified open-lake control outside Volga',
  },

  // —— TARGET ——
  {
    id: 'L2',
    name: 'L2 Kuibyshev mid-pool',
    group: 'target',
    a: { lon: 49.1, lat: 55.4 },
    b: { lon: 49.2, lat: 55.1 },
    zoom: 9,
    expectedCurrentStatus: 'ok_expected',
    purpose: 'E1 target: complete Kuibyshev mask Phase A mid-pool',
  },
  {
    id: 'N06',
    name: 'N06 Kuibyshev S mid',
    group: 'target',
    a: { lon: 48.9, lat: 54.7 },
    b: { lon: 49.1, lat: 54.35 },
    zoom: 9,
    expectedCurrentStatus: 'flaky_or_unknown',
    purpose: 'Target: southern Kuibyshev mid — watch snap/mask binding',
  },
  {
    id: 'N08',
    name: 'N08 Kuibyshev north',
    group: 'target',
    a: { lon: 49.05, lat: 55.75 },
    b: { lon: 48.45, lat: 55.82 },
    zoom: 9,
    expectedCurrentStatus: 'flaky_or_unknown',
    purpose: 'Target: northern Kuibyshev / Kazan approach',
  },
  {
    id: 'N11',
    name: 'N11 Uglich-ish',
    group: 'target',
    a: { lon: 38.33, lat: 57.53 },
    b: { lon: 38.55, lat: 57.75 },
    zoom: 10,
    expectedCurrentStatus: 'flaky_or_unknown',
    purpose: 'Target: Uglich reservoir corridor / lock neighborhood',
  },
  {
    id: 'X3',
    name: 'X3 Cheboksary → Vetluga stem',
    group: 'target',
    a: { lon: 47.25, lat: 56.15 },
    b: { lon: 45.9, lat: 56.85 },
    zoom: 8,
    expectedCurrentStatus: 'fail_expected',
    purpose: 'Target: incomplete Cheboksary / Vetluga stem weakness',
  },

  // —— SAFETY ——
  {
    id: 'STEM',
    name: 'STEM wrong-arm tributary',
    group: 'safety',
    a: { lon: 45.5, lat: 56.2 },
    b: { lon: 45.05, lat: 56.35 },
    zoom: 10,
    expectedCurrentStatus: 'fail_expected',
    purpose: 'Safety: excessive_detour / wrong-arm stem must not silently accept',
  },
  {
    id: 'VETL',
    name: 'VETL Volga → Vetluga miss',
    group: 'safety',
    a: { lon: 44.0, lat: 56.33 },
    b: { lon: 45.05, lat: 56.15 },
    zoom: 9,
    expectedCurrentStatus: 'fail_expected',
    purpose: 'Safety: stem residual / endpoints_far regression',
  },
  {
    id: 'X2',
    name: 'X2 / DAM Rybinsk dam chord',
    group: 'safety',
    a: { lon: 38.8559, lat: 58.049 },
    b: { lon: 38.4, lat: 58.55 },
    zoom: 10,
    expectedCurrentStatus: 'fail_expected',
    purpose: 'Safety: dam crest chord must stay rejected (illegal_barrier / hydro)',
  },

  // —— RIVERS ——
  {
    id: 'BELOMOR',
    name: 'BELOMOR White Sea–Baltic Canal',
    group: 'rivers',
    a: { lon: 34.82, lat: 62.86 },
    b: { lon: 34.77, lat: 64.52 },
    zoom: 7,
    expectedCurrentStatus: 'ok_expected',
    purpose:
      'E9 pilot: enable ?wg=1 — PostGIS NAVIGABLE WaterGraph (~217 km); flag off = legacy BRouter',
  },
  {
    id: 'R02',
    name: 'R02 Oka Kaluga → Serpukhov',
    group: 'rivers',
    a: { lon: 36.275, lat: 54.514 },
    b: { lon: 37.415, lat: 54.916 },
    zoom: 9,
    expectedCurrentStatus: 'flaky_or_unknown',
    purpose: 'River: Oka corridor + possible Kim open-data depth context',
  },
  {
    id: 'R04',
    name: 'R04 Don lower sample',
    group: 'rivers',
    a: { lon: 39.7, lat: 47.25 },
    b: { lon: 40.15, lat: 47.55 },
    zoom: 9,
    expectedCurrentStatus: 'flaky_or_unknown',
    purpose: 'River: Don sample (open-RU knowledge currently sparse)',
  },
];

export function getUserTestPreset(id: string): UserTestPreset | undefined {
  return USER_TEST_PRESETS.find((p) => p.id === id);
}

export function listUserTestPresetsByGroup(): Record<UserTestGroup, UserTestPreset[]> {
  const out: Record<UserTestGroup, UserTestPreset[]> = {
    safe: [],
    target: [],
    safety: [],
    rivers: [],
  };
  for (const p of USER_TEST_PRESETS) out[p.group].push(p);
  return out;
}
