/**
 * Pure helpers for OSM water inspection (?russiaWaterTopologyDebug=1).
 * No Leaflet / WRG / routing / topology inference.
 */

/** Below this, live Overpass is not used; catalog bboxes still show. */
export const OSM_WATER_INSPECT_MIN_ZOOM = 5;
/** Viewport wider than this uses named majors, not every pond. */
export const OSM_WATER_INSPECT_FULL_SPAN_DEG = 3;
/** Viewport wider than this stays on catalog bboxes (no Overpass). */
export const OSM_WATER_INSPECT_MAJOR_SPAN_DEG = 10;
/** @deprecated alias: former hard reject; full OSM still uses a tight span. */
export const OSM_WATER_INSPECT_MAX_SPAN_DEG = OSM_WATER_INSPECT_FULL_SPAN_DEG;

export type InspectDetail = 'catalog' | 'major' | 'full' | 'streams';

export function inspectViewportSpanDeg(
  south: number,
  west: number,
  north: number,
  east: number,
): number {
  return Math.max(north - south, east - west);
}

/** Choose how much OSM to fetch. Wide overview stays catalog-only. */
export function inspectDetailLevel(
  zoom: number,
  south: number,
  west: number,
  north: number,
  east: number,
): InspectDetail {
  const span = inspectViewportSpanDeg(south, west, north, east);
  if (zoom >= 11 && span <= 2.5) return 'streams';
  if (zoom >= 7 && span <= OSM_WATER_INSPECT_FULL_SPAN_DEG) return 'full';
  if (zoom >= OSM_WATER_INSPECT_MIN_ZOOM && span <= OSM_WATER_INSPECT_MAJOR_SPAN_DEG) {
    return 'major';
  }
  return 'catalog';
}

export const INSPECT_LEGEND = {
  POLYGON: '#2563eb',
  LAKE: '#1d4ed8',
  RESERVOIR: '#7c3aed',
  RIVER_AREA: '#0ea5e9',
  CENTERLINE_RIVER: '#f97316',
  CENTERLINE_CANAL: '#16a34a',
  CENTERLINE_STREAM: '#eab308',
  INNER: '#fb7185',
  EXTRACT: '#64748b',
  CATALOG: '#94a3b8',
} as const;

/** Documented local water.objects extract footprints (NW Russia only). */
export const LOCAL_EXTRACT_COVERAGE: Array<{
  id: string;
  name: string;
  west: number;
  south: number;
  east: number;
  north: number;
}> = [
  { id: 'karelia', name: 'extract: Карелия', west: 29.3, south: 60.73, east: 37.97, north: 66.75 },
  { id: 'leningrad', name: 'extract: Ленинградская обл.', west: 26.98, south: 58.39, east: 35.96, north: 61.34 },
  { id: 'vologda', name: 'extract: Вологодская обл.', west: 34.5, south: 58.48, east: 47.2, north: 61.62 },
];

export type InspectLayer =
  | 'centerline-river'
  | 'centerline-canal'
  | 'centerline-stream'
  | 'centerline-other'
  | 'polygon-lake'
  | 'polygon-reservoir'
  | 'polygon-river-area'
  | 'polygon-other'
  | 'mp-inner'
  | 'catalog-water'
  | 'extract-coverage';

export type InspectProps = {
  layer: InspectLayer;
  name?: string;
  osm_type: string;
  osm_id: number;
  tags: Record<string, string>;
  geometry_type: string;
  part_count: number;
  hole_count: number;
  member_count?: number;
  member_roles?: string[];
  relation_id?: number;
  relation_role?: string;
  waterway?: string;
  water?: string;
  natural?: string;
};

export type InspectFeature = {
  type: 'Feature';
  properties: InspectProps;
  geometry: GeoJSON.Geometry;
};

export function russiaWaterTopologyDebugEnabledFromSearchParams(
  search: string | URLSearchParams,
): boolean {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('russiaWaterTopologyDebug') === '1';
}

export function spanTooWide(south: number, west: number, north: number, east: number): boolean {
  return inspectViewportSpanDeg(south, west, north, east) > OSM_WATER_INSPECT_MAX_SPAN_DEG;
}

export function catalogFeaturesFromBodies(
  bodies: Array<{ n: string; k?: string; b: [number, number, number, number] }>,
): InspectFeature[] {
  return bodies.map((w) => {
    const [west, south, east, north] = w.b;
    return {
      type: 'Feature' as const,
      properties: {
        layer: 'catalog-water' as const,
        name: w.n,
        osm_type: 'catalog',
        osm_id: 0,
        tags: { source: 'water-bodies.json', kind: w.k || '' },
        geometry_type: 'Polygon',
        part_count: 1,
        hole_count: 0,
      },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [west, south],
            [east, south],
            [east, north],
            [west, north],
            [west, south],
          ],
        ],
      },
    };
  }).filter((f) => {
    const ring = (f.geometry as GeoJSON.Polygon).coordinates[0];
    const west = ring[0][0];
    const east = ring[1][0];
    return west >= 26 && east <= 60;
  });
}

export type OverpassInspectElement = {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{
    type: string;
    role?: string;
    geometry?: Array<{ lat: number; lon: number }>;
  }>;
};

function ring(coords: Array<{ lat: number; lon: number }>): number[][] {
  const line = coords.map((p) => [p.lon, p.lat]);
  if (line.length && (line[0][0] !== line[line.length - 1][0] || line[0][1] !== line[line.length - 1][1])) {
    line.push([...line[0]]);
  }
  return line;
}

function closed(coords: Array<{ lat: number; lon: number }>): boolean {
  if (coords.length < 4) return false;
  const a = coords[0];
  const b = coords[coords.length - 1];
  return a.lat === b.lat && a.lon === b.lon;
}

function isAreaTags(tags: Record<string, string>): boolean {
  if (tags.natural === 'water') return true;
  if (tags.landuse === 'reservoir' || tags.landuse === 'basin') return true;
  if (tags.waterway === 'riverbank') return true;
  if (tags.water === 'lake' || tags.water === 'reservoir' || tags.water === 'pond' || tags.water === 'river') {
    return !tags.waterway || tags.waterway === 'riverbank';
  }
  return false;
}

export function classifyInspectLayer(
  tags: Record<string, string>,
  kind: 'line' | 'polygon' | 'inner',
): InspectLayer {
  if (kind === 'inner') return 'mp-inner';
  if (kind === 'line') {
    const w = tags.waterway || '';
    if (w === 'canal' || w === 'ship_canal') return 'centerline-canal';
    if (w === 'river' || w === 'fairway') return 'centerline-river';
    if (w === 'stream' || w === 'ditch' || w === 'drain') return 'centerline-stream';
    return 'centerline-other';
  }
  if (tags.water === 'reservoir' || tags.landuse === 'reservoir') return 'polygon-reservoir';
  if (tags.water === 'river' || tags.waterway === 'riverbank') return 'polygon-river-area';
  if (tags.water === 'lake' || tags.natural === 'water') return 'polygon-lake';
  return 'polygon-other';
}

export function parseOverpassToInspectFeatures(
  elements: OverpassInspectElement[],
): InspectFeature[] {
  const out: InspectFeature[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags['name:ru'] || tags.name || '';
    const base = {
      name,
      osm_type: el.type,
      osm_id: el.id,
      tags,
      waterway: tags.waterway,
      water: tags.water,
      natural: tags.natural,
    };

    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      const area = isAreaTags(tags) && closed(el.geometry);
      if (area) {
        const coords = ring(el.geometry);
        out.push({
          type: 'Feature',
          properties: {
            ...base,
            layer: classifyInspectLayer(tags, 'polygon'),
            geometry_type: 'Polygon',
            part_count: 1,
            hole_count: 0,
          },
          geometry: { type: 'Polygon', coordinates: [coords] },
        });
      } else {
        out.push({
          type: 'Feature',
          properties: {
            ...base,
            layer: classifyInspectLayer(tags, 'line'),
            geometry_type: 'LineString',
            part_count: 1,
            hole_count: 0,
          },
          geometry: {
            type: 'LineString',
            coordinates: el.geometry.map((p) => [p.lon, p.lat]),
          },
        });
      }
      continue;
    }

    if (el.type !== 'relation' || !el.members) continue;
    const members = el.members.filter((m) => m.geometry && m.geometry.length >= 2);
    const roles = members.map((m) => m.role || '');
    const outers = members.filter((m) => (m.role || 'outer') === 'outer' || m.role === '');
    const inners = members.filter((m) => m.role === 'inner');
    const isMp =
      tags.type === 'multipolygon' || isAreaTags(tags) || tags.type === 'water';

    if (isMp && (outers.length > 0 || inners.length > 0 || members.some((m) => closed(m.geometry!)))) {
      const outerParts = (outers.length ? outers : members.filter((m) => closed(m.geometry!))).filter(
        (m) => m.geometry && m.geometry.length >= 2,
      );
      for (let i = 0; i < outerParts.length; i += 1) {
        const geom = outerParts[i].geometry!;
        const coords = closed(geom) ? ring(geom) : geom.map((p) => [p.lon, p.lat]);
        if (coords.length < 4) {
          out.push({
            type: 'Feature',
            properties: {
              ...base,
              layer: classifyInspectLayer(tags, 'line'),
              geometry_type: 'LineString',
              part_count: outerParts.length,
              hole_count: inners.length,
              member_count: members.length,
              member_roles: roles,
              relation_role: outerParts[i].role || 'outer',
            },
            geometry: { type: 'LineString', coordinates: geom.map((p) => [p.lon, p.lat]) },
          });
          continue;
        }
        out.push({
          type: 'Feature',
          properties: {
            ...base,
            layer: classifyInspectLayer(tags, 'polygon'),
            geometry_type: outerParts.length > 1 ? 'MultiPolygon-part' : 'Polygon',
            part_count: outerParts.length,
            hole_count: inners.length,
            member_count: members.length,
            member_roles: roles,
            relation_role: outerParts[i].role || 'outer',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [closed(geom) ? ring(geom) : [...coords, coords[0]]],
          },
        });
      }
      for (const inner of inners) {
        const geom = inner.geometry!;
        out.push({
          type: 'Feature',
          properties: {
            ...base,
            layer: 'mp-inner',
            geometry_type: 'Polygon-inner',
            part_count: outerParts.length,
            hole_count: inners.length,
            member_count: members.length,
            member_roles: roles,
            relation_role: 'inner',
          },
          geometry: {
            type: 'Polygon',
            coordinates: [ring(geom)],
          },
        });
      }
      continue;
    }

    // waterway relation: keep member lines separate, no merge
    for (const m of members) {
      const geom = m.geometry!;
      out.push({
        type: 'Feature',
        properties: {
          ...base,
          layer: classifyInspectLayer(tags, 'line'),
          geometry_type: 'LineString',
          part_count: members.length,
          hole_count: 0,
          member_count: members.length,
          member_roles: roles,
          relation_role: m.role || '',
        },
        geometry: {
          type: 'LineString',
          coordinates: geom.map((p) => [p.lon, p.lat]),
        },
      });
    }
  }
  return out;
}

export function countInspectLayers(features: InspectFeature[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) {
    const k = f.properties.layer;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTags(tags: Record<string, string>): string {
  const keys = Object.keys(tags);
  if (!keys.length) return '<em>нет</em>';
  return keys
    .map((k) => `<code>${escapeHtml(k)}=${escapeHtml(String(tags[k]))}</code>`)
    .join('<br>');
}

export function formatInspectPopup(props: InspectProps): string {
  if (props.osm_type === 'catalog' || props.layer === 'catalog-water') {
    const title = escapeHtml((props.name || '').trim() || 'каталог');
    return `<div class="osm-inspect-popup">
<p><strong>${title}</strong></p>
<p>это справочный bbox из water-bodies.json, <strong>не OSM-геометрия</strong></p>
<p>OSM id / relation members: нет (каталог, не Overpass)</p>
<p>internal/area id: нет</p>
<p>layer: <code>catalog-water</code></p>
<p>centerline «связи»: не вычисляются (нет topology)</p>
</div>`;
  }
  const ref =
    props.osm_type === 'relation'
      ? `relation/${props.osm_id}`
      : props.osm_type === 'way'
        ? `way/${props.osm_id}`
        : `osm:${props.osm_id}`;
  const title = (props.name || '').trim() ? `${escapeHtml(props.name!)} · ${ref}` : ref;
  const members =
    typeof props.member_count === 'number'
      ? `${props.member_count} (роли: ${(props.member_roles || []).join(', ') || '—'})`
      : '— (не relation / не из membership)';
  return `<div class="osm-inspect-popup">
<p><strong>${title}</strong></p>
<p>OSM: ${escapeHtml(ref)}</p>
<p>internal/area id: нет (это live OSM inspect, не строка water.objects)</p>
<p>layer: <code>${escapeHtml(props.layer)}</code></p>
<p>geometry: <code>${escapeHtml(props.geometry_type)}</code></p>
<p>parts: ${props.part_count} · holes/inners: ${props.hole_count}</p>
<p>OSM members: ${escapeHtml(members)}</p>
<p>centerline «связи»: не вычисляются (нет topology)</p>
<p>теги:</p>
${formatTags(props.tags)}
</div>`;
}

export function buildInspectOverpassQuery(
  south: number,
  west: number,
  north: number,
  east: number,
  detail: Exclude<InspectDetail, 'catalog'>,
): string {
  const bb = `${south},${west},${north},${east}`;
  if (detail === 'major') {
    return `[out:json][timeout:40];
(
  relation["natural"="water"]["name"](${bb});
  relation["landuse"="reservoir"](${bb});
  relation["waterway"~"^(river|canal)$"](${bb});
  way["waterway"~"^(river|canal)$"]["name"](${bb});
  way["natural"="water"]["name"](${bb});
);
out geom;`;
  }
  const wayWaterway =
    detail === 'streams'
      ? `way["waterway"](${bb});`
      : `way["waterway"~"^(river|canal|fairway|ship_canal|link)$"](${bb});`;
  return `[out:json][timeout:25];
(
  ${wayWaterway}
  way["natural"="water"](${bb});
  way["landuse"="reservoir"](${bb});
  way["waterway"="riverbank"](${bb});
  relation["natural"="water"](${bb});
  relation["landuse"="reservoir"](${bb});
  relation["waterway"~"^(river|canal)$"](${bb});
  relation["type"="multipolygon"]["natural"="water"](${bb});
);
out geom;`;
}
