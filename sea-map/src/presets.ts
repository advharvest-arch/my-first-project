import type { LngLat } from './geo';
import presetRoutes from './preset-routes.json';

export type PresetRouteId = 'moscow' | 'volga-nn' | 'kuybyshev' | 'seliger-vokhma';

type PresetRouteRow = {
  a: [number, number];
  b: [number, number];
  lengthKm: number;
  coords: Array<[number, number]>;
};

const ROUTES = presetRoutes as Record<PresetRouteId, PresetRouteRow>;

/** Built-in offline tracks — work even when brouter.de is blocked. */
export function getPresetRoute(id: PresetRouteId): {
  points: LngLat[];
  lengthKm: number;
  a: LngLat;
  b: LngLat;
} | null {
  const row = ROUTES[id];
  if (!row?.coords?.length) return null;
  return {
    a: { lon: row.a[0], lat: row.a[1] },
    b: { lon: row.b[0], lat: row.b[1] },
    lengthKm: row.lengthKm,
    points: row.coords.map(([lon, lat]) => ({ lon, lat })),
  };
}
