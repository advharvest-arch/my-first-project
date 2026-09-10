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
  OUTER: '#c026d3',
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
  | 'mp-outer'
  | 'mp-inner'
  | 'catalog-water'
  | 'extract-coverage';

export type InspectGeomKind = 'line' | 'polygon' | 'inner' | 'outer';

export type InspectMemberInfo = {
  role: string;
  osm_type: string;
  osm_id: number;
  tags: Record<string, string>;
  geometry_type: string;
  vertex_count: number;
  closed: boolean;
};

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
  relation_tags?: Record<string, string>;
  member_tags?: Record<string, string>;
  members_detail?: InspectMemberInfo[];
  closed?: boolean;
  waterway?: string;
  water?: string;
  natural?: string;
  vertex_count?: number;
  vertex_count_drawn?: number;
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

/** Display-only: keep OSM shape/holes, drop vertices so Leaflet can draw Ladoga-scale geom. */
export const INSPECT_DISPLAY_MAX_RING_VERTICES = 500;

export function decimateLine(coords: number[][], maxVertices = INSPECT_DISPLAY_MAX_RING_VERTICES): number[][] {
  if (coords.length <= maxVertices) return coords;
  const step = Math.max(1, Math.ceil((coords.length - 1) / (maxVertices - 1)));
  const out: number[][] = [];
  for (let i = 0; i < coords.length - 1; i += step) out.push(coords[i]);
  const last = coords[coords.length - 1];
  const prev = out[out.length - 1];
  if (!prev || prev[0] !== last[0] || prev[1] !== last[1]) out.push(last);
  return out;
}

export function decimateRing(ring: number[][], maxVertices = INSPECT_DISPLAY_MAX_RING_VERTICES): number[][] {
  if (ring.length <= maxVertices) return ring;
  const closed =
    ring.length > 1 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const open = closed ? ring.slice(0, -1) : ring;
  const sampled = decimateLine(open, Math.max(4, maxVertices - 1));
  const first = sampled[0];
  const last = sampled[sampled.length - 1];
  if (!first) return ring;
  if (!last || last[0] !== first[0] || last[1] !== first[1]) sampled.push(first);
  return sampled;
}

function countGeometryVertices(geometry: GeoJSON.Geometry): number {
  if (geometry.type === 'LineString') return geometry.coordinates.length;
  if (geometry.type === 'Polygon') return geometry.coordinates.reduce((n, ring) => n + ring.length, 0);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce(
      (n, poly) => n + poly.reduce((m, ring) => m + ring.length, 0),
      0,
    );
  }
  return 0;
}

export function simplifyInspectFeatureForDisplay(feature: InspectFeature): InspectFeature {
  const geom = feature.geometry;
  const vertex_count = countGeometryVertices(geom);
  let next: GeoJSON.Geometry = geom;
  if (geom.type === 'LineString') {
    next = { type: 'LineString', coordinates: decimateLine(geom.coordinates) };
  } else if (geom.type === 'Polygon') {
    next = { type: 'Polygon', coordinates: geom.coordinates.map((ring) => decimateRing(ring)) };
  } else if (geom.type === 'MultiPolygon') {
    next = {
      type: 'MultiPolygon',
      coordinates: geom.coordinates.map((poly) => poly.map((ring) => decimateRing(ring))),
    };
  }
  return {
    ...feature,
    properties: {
      ...feature.properties,
      vertex_count,
      vertex_count_drawn: countGeometryVertices(next),
    },
    geometry: next,
  };
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
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: Array<{ lat: number; lon: number }>;
  members?: Array<{
    type: string;
    ref?: number;
    id?: number;
    role?: string;
    tags?: Record<string, string>;
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

function sameCoord(a: number[], b: number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function toLine(coords: Array<{ lat: number; lon: number }>): number[][] {
  return coords.map((p) => [p.lon, p.lat]);
}

function memberRef(m: { ref?: number; id?: number }): number {
  return m.ref ?? m.id ?? 0;
}

/** Join unclosed MP member ways that share endpoints into closed rings. Not topology between water objects. */
export function assembleClosedRings(lines: number[][][]): number[][][] {
  const rings: number[][][] = [];
  const unused = lines
    .filter((line) => line.length >= 2)
    .map((line) => line.map((c) => [c[0], c[1]]));
  const open: number[][][] = [];
  for (const line of unused) {
    if (line.length >= 4 && sameCoord(line[0], line[line.length - 1])) rings.push(line);
    else open.push(line);
  }
  while (open.length) {
    let chain = open.pop()!;
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < open.length; i += 1) {
        const cand = open[i];
        const head = chain[0];
        const tail = chain[chain.length - 1];
        const c0 = cand[0];
        const c1 = cand[cand.length - 1];
        if (sameCoord(tail, c0)) {
          chain = chain.concat(cand.slice(1));
          open.splice(i, 1);
          progressed = true;
          break;
        }
        if (sameCoord(tail, c1)) {
          chain = chain.concat(cand.slice(0, -1).reverse());
          open.splice(i, 1);
          progressed = true;
          break;
        }
        if (sameCoord(head, c1)) {
          chain = cand.slice(0, -1).concat(chain);
          open.splice(i, 1);
          progressed = true;
          break;
        }
        if (sameCoord(head, c0)) {
          chain = cand.slice().reverse().slice(0, -1).concat(chain);
          open.splice(i, 1);
          progressed = true;
          break;
        }
      }
    }
    if (chain.length >= 4 && sameCoord(chain[0], chain[chain.length - 1])) rings.push(chain);
  }
  return rings;
}

export function classifyInspectLayer(
  tags: Record<string, string>,
  kind: InspectGeomKind,
): InspectLayer {
  if (kind === 'inner') return 'mp-inner';
  if (kind === 'outer') return 'mp-outer';
  if (kind === 'line') {
    if (tags.type === 'multipolygon' && isAreaTags(tags)) return 'mp-outer';
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

function isMultipolygonArea(tags: Record<string, string>): boolean {
  if (tags.type === 'waterway') return false;
  return tags.type === 'multipolygon' || tags.type === 'water' || isAreaTags(tags);
}

export function parseOverpassToInspectFeatures(
  elements: OverpassInspectElement[],
): InspectFeature[] {
  const wayTags = new Map<number, Record<string, string>>();
  for (const el of elements) {
    if (el.type === 'way') wayTags.set(el.id, el.tags ?? {});
  }

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

    if (el.bounds && !el.geometry && !(el.members && el.members.some((m) => m.geometry && m.geometry.length >= 2))) {
      const b = el.bounds;
      const kind: InspectGeomKind = tags.waterway && !isAreaTags(tags) ? 'line' : 'polygon';
      const bboxRing = [
        [b.minlon, b.minlat],
        [b.maxlon, b.minlat],
        [b.maxlon, b.maxlat],
        [b.minlon, b.maxlat],
        [b.minlon, b.minlat],
      ];
      out.push({
        type: 'Feature',
        properties: {
          ...base,
          layer: classifyInspectLayer(tags, kind),
          geometry_type: 'Overpass-bbox',
          part_count: 1,
          hole_count: 0,
        },
        geometry: { type: 'Polygon', coordinates: [bboxRing] },
      });
      continue;
    }

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
            vertex_count: el.geometry.length,
            closed: true,
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
            vertex_count: el.geometry.length,
            closed: closed(el.geometry),
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
    if (!members.length) continue;
    const roles = members.map((m) => m.role || '');
    const details: InspectMemberInfo[] = members.map((m) => {
      const geom = m.geometry!;
      const isClosed = closed(geom);
      const mTags = wayTags.get(memberRef(m)) ?? m.tags ?? {};
      return {
        role: m.role || (isClosed ? 'outer' : ''),
        osm_type: m.type || 'way',
        osm_id: memberRef(m),
        tags: mTags,
        geometry_type: isClosed ? 'Polygon' : 'LineString',
        vertex_count: geom.length,
        closed: isClosed,
      };
    });
    const outerMembers = members.filter((m) => (m.role || 'outer') === 'outer' || m.role === '');
    const innerMembers = members.filter((m) => m.role === 'inner');

    if (isMultipolygonArea(tags)) {
      for (const m of outerMembers) {
        const geom = m.geometry!;
        const mTags = wayTags.get(memberRef(m)) ?? m.tags ?? {};
        out.push({
          type: 'Feature',
          properties: {
            name,
            osm_type: m.type || 'way',
            osm_id: memberRef(m),
            tags: mTags,
            member_tags: mTags,
            waterway: mTags.waterway,
            water: tags.water,
            natural: tags.natural,
            layer: 'mp-outer',
            geometry_type: 'LineString',
            part_count: outerMembers.length,
            hole_count: innerMembers.length,
            member_count: members.length,
            member_roles: roles,
            relation_id: el.id,
            relation_role: m.role || 'outer',
            relation_tags: tags,
            members_detail: details,
            vertex_count: geom.length,
            closed: closed(geom),
          },
          geometry: {
            type: 'LineString',
            coordinates: geom.map((p) => [p.lon, p.lat]),
          },
        });
      }
      for (const m of innerMembers) {
        const geom = m.geometry!;
        const mTags = wayTags.get(memberRef(m)) ?? m.tags ?? {};
        const isClosed = closed(geom);
        out.push({
          type: 'Feature',
          properties: {
            name,
            osm_type: m.type || 'way',
            osm_id: memberRef(m),
            tags: mTags,
            member_tags: mTags,
            waterway: mTags.waterway,
            water: tags.water,
            natural: tags.natural,
            layer: 'mp-inner',
            geometry_type: isClosed ? 'Polygon-inner' : 'LineString',
            part_count: outerMembers.length,
            hole_count: innerMembers.length,
            member_count: members.length,
            member_roles: roles,
            relation_id: el.id,
            relation_role: 'inner',
            relation_tags: tags,
            members_detail: details,
            vertex_count: geom.length,
            closed: isClosed,
          },
          geometry: isClosed
            ? { type: 'Polygon', coordinates: [ring(geom)] }
            : { type: 'LineString', coordinates: geom.map((p) => [p.lon, p.lat]) },
        });
      }
      const assembled = assembleClosedRings(outerMembers.map((m) => toLine(m.geometry!)));
      const holes = innerMembers.filter((m) => closed(m.geometry!)).map((m) => ring(m.geometry!));
      for (let i = 0; i < assembled.length; i += 1) {
        const outerRing = assembled[i];
        const holeRings = assembled.length === 1 ? holes : [];
        out.push({
          type: 'Feature',
          properties: {
            ...base,
            layer: classifyInspectLayer(tags, 'polygon'),
            geometry_type: assembled.length > 1 ? 'MultiPolygon-part' : 'Polygon',
            part_count: assembled.length,
            hole_count: holeRings.length,
            member_count: members.length,
            member_roles: roles,
            members_detail: details,
            relation_role: 'area',
            vertex_count: outerRing.length + holeRings.reduce((n, h) => n + h.length, 0),
            closed: true,
          },
          geometry: { type: 'Polygon', coordinates: [outerRing, ...holeRings] },
        });
      }
      continue;
    }

    for (const m of members) {
      const geom = m.geometry!;
      const mTags = wayTags.get(memberRef(m)) ?? m.tags ?? {};
      const lineTags = mTags.waterway ? mTags : tags;
      out.push({
        type: 'Feature',
        properties: {
          name: mTags['name:ru'] || mTags.name || name,
          osm_type: m.type || 'way',
          osm_id: memberRef(m),
          tags: Object.keys(mTags).length ? mTags : tags,
          member_tags: mTags,
          waterway: lineTags.waterway,
          water: lineTags.water,
          natural: lineTags.natural,
          layer: classifyInspectLayer(lineTags, 'line'),
          geometry_type: 'LineString',
          part_count: members.length,
          hole_count: 0,
          member_count: members.length,
          member_roles: roles,
          relation_id: el.id,
          relation_role: m.role || '',
          relation_tags: tags,
          members_detail: details,
          vertex_count: geom.length,
          closed: closed(geom),
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

function formatMemberList(members: InspectMemberInfo[]): string {
  if (!members.length) return '';
  const outer = members.filter((m) => m.role === 'outer' || m.role === '').length;
  const inner = members.filter((m) => m.role === 'inner').length;
  const other = members.length - outer - inner;
  const items = members
    .map((m) => {
      const tagStr = Object.keys(m.tags).length
        ? Object.entries(m.tags)
            .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
            .join(', ')
        : 'нет';
      return `<li><strong>role: ${escapeHtml(m.role || 'outer')}</strong><br>
${escapeHtml(m.osm_type)}/${m.osm_id}<br>
tags: ${tagStr}<br>
geometry: ${escapeHtml(m.geometry_type)} · vertices: ${m.vertex_count} · closed: ${m.closed ? 'yes' : 'no'}</li>`;
    })
    .join('');
  return `<p>Members: outer ${outer} · inner ${inner}${other ? ` · other ${other}` : ''}</p>
<ul class="osm-inspect-members">${items}</ul>`;
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
  const isBoundary = props.layer === 'mp-outer' || props.layer === 'mp-inner';
  const relRef = props.relation_id ? `relation/${props.relation_id}` : '';
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
  const boundaryNote = isBoundary
    ? `<p><strong>это boundary way multipolygon, не waterway=river centerline</strong></p>
<p>member of ${escapeHtml(relRef || 'relation')} · role: <code>${escapeHtml(props.relation_role || '')}</code></p>`
    : '';
  const tagSource = props.osm_type === 'relation' || props.relation_role === 'area' ? props.tags : props.member_tags || props.tags;
  return `<div class="osm-inspect-popup">
<p><strong>${title}</strong></p>
<p>OSM: ${escapeHtml(ref)}${relRef && props.osm_type !== 'relation' ? ` · ${escapeHtml(relRef)}` : ''}</p>
<p>internal/area id: нет (это live OSM inspect, не строка water.objects)</p>
<p>layer: <code>${escapeHtml(props.layer)}</code></p>
<p>geometry: <code>${escapeHtml(props.geometry_type)}</code></p>
${
  props.geometry_type === 'Overpass-bbox'
    ? '<p>это bbox объекта OSM из Overpass, не полное кольцо (на широком кадре). Приблизьте для geom.</p>'
    : ''
}
${boundaryNote}
<p>parts: ${props.part_count} · holes/inners: ${props.hole_count}</p>
<p>OSM members: ${escapeHtml(members)}</p>
${formatMemberList(props.members_detail || [])}
${
  typeof props.vertex_count === 'number'
    ? `<p>vertices: OSM ${props.vertex_count}${
        typeof props.vertex_count_drawn === 'number' && props.vertex_count_drawn !== props.vertex_count
          ? `, на карте ${props.vertex_count_drawn} (inspect simplify, не topology)`
          : ''
      }</p>`
    : ''
}
<p>centerline «связи»: не вычисляются (нет topology)</p>
<p>теги ${props.osm_type === 'relation' || props.relation_role === 'area' ? 'relation' : 'этого way'}:</p>
${formatTags(tagSource)}
${
  relRef && isBoundary
    ? `<p>теги relation:</p>${formatTags(props.relation_tags || {})}`
    : ''
}
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
  relation["natural"="water"]["name"]["water"~"^(lake|reservoir)$"](${bb});
  relation["landuse"="reservoir"]["name"](${bb});
  way["natural"="water"]["name"]["water"~"^(lake|reservoir)$"](${bb});
);
out tags bb;`;
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
)->.q;
.q out geom;
way(r.q); out tags;`;
}
