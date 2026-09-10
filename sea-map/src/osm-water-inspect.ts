/**
 * Pure helpers for OSM water inspection (?russiaWaterTopologyDebug=1).
 * No Leaflet / WRG / routing / topology inference.
 */

declare global {
  interface Window {
    __AQUAROUTE_OSM_INSPECT__?: boolean;
  }
}

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
  start?: [number, number];
  end?: [number, number];
  in_relation: boolean;
};

/** OSM relation membership from Overpass members[], never inferred by distance. */
export type InspectMembership = {
  relation_id: number;
  relation_type: string;
  role: string;
  relation_tags: Record<string, string>;
};

export type InspectRoleCounts = {
  outer: number;
  inner: number;
  main_stream: number;
  side_stream: number;
  other: number;
  other_roles: string[];
};

/** UI grouping of one OSM relation and its declared members. Not a computed water body. */
export type OsmObjectFamily = {
  relation_id: number;
  relation_tags: Record<string, string>;
  member_count: number;
  role_counts: InspectRoleCounts;
  is_water_polygon: boolean;
  is_waterway_relation: boolean;
  centerline_member_count: number;
  waterway_tagged_members: number;
};

export type InspectViewportStats = {
  source: 'overpass' | 'catalog';
  loaded_features: number;
  lake_polygons: number;
  reservoir_polygons: number;
  river_area_polygons: number;
  other_polygons: number;
  river_centerlines: number;
  canal_centerlines: number;
  stream_centerlines: number;
  other_centerlines: number;
  multipolygon_relations: number;
  waterway_relations: number;
  outer_members: number;
  inner_members: number;
  catalog_bboxes: number;
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
  osm_memberships?: InspectMembership[];
  family?: OsmObjectFamily;
  start?: [number, number];
  end?: [number, number];
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

/** Hosted htmlpreview has no usable query string; open.html sets a window flag. */
export function russiaWaterTopologyDebugEnabledFromHost(opts: {
  inspectFlag?: boolean;
  search?: string;
  hash?: string;
}): boolean {
  if (opts.inspectFlag === true) return true;
  if (opts.search && russiaWaterTopologyDebugEnabledFromSearchParams(opts.search)) {
    return true;
  }
  const raw = opts.hash?.startsWith('#') ? opts.hash.slice(1) : (opts.hash ?? '');
  return raw ? russiaWaterTopologyDebugEnabledFromSearchParams(raw) : false;
}

export function russiaWaterTopologyDebugEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.location === 'undefined') {
    return false;
  }
  return russiaWaterTopologyDebugEnabledFromHost({
    inspectFlag: window.__AQUAROUTE_OSM_INSPECT__,
    search: window.location.search,
    hash: window.location.hash,
  });
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

function isWaterwayRelation(tags: Record<string, string>): boolean {
  if (tags.type === 'multipolygon') return false;
  return tags.type === 'waterway' || tags.waterway === 'river' || tags.waterway === 'canal';
}

function lineEndpoints(
  coords: Array<{ lat: number; lon: number }>,
): { start?: [number, number]; end?: [number, number] } {
  if (!coords.length) return {};
  const a = coords[0];
  const b = coords[coords.length - 1];
  return { start: [a.lon, a.lat], end: [b.lon, b.lat] };
}

function normalizeMemberRole(role: string | undefined, relationTags: Record<string, string>): string {
  const r = role || '';
  if (r) return r;
  if (isMultipolygonArea(relationTags)) return 'outer';
  return '';
}

export function inspectMemberFromOverpass(
  m: NonNullable<OverpassInspectElement['members']>[number],
  wayTags: Map<number, Record<string, string>>,
  relationTags: Record<string, string>,
): InspectMemberInfo {
  const geom = m.geometry;
  const isClosed = geom ? closed(geom) : false;
  const mTags = wayTags.get(memberRef(m)) ?? m.tags ?? {};
  const ends = geom && geom.length ? lineEndpoints(geom) : {};
  return {
    role: normalizeMemberRole(m.role, relationTags),
    osm_type: m.type || 'way',
    osm_id: memberRef(m),
    tags: mTags,
    geometry_type: !geom || geom.length < 2 ? 'unknown' : isClosed ? 'Polygon' : 'LineString',
    vertex_count: geom?.length ?? 0,
    closed: isClosed,
    start: ends.start,
    end: ends.end,
    in_relation: true,
  };
}

export function countMemberRoles(members: InspectMemberInfo[]): InspectRoleCounts {
  const other_roles: string[] = [];
  const counts: InspectRoleCounts = {
    outer: 0,
    inner: 0,
    main_stream: 0,
    side_stream: 0,
    other: 0,
    other_roles,
  };
  for (const m of members) {
    const r = m.role || '';
    if (r === 'outer') counts.outer += 1;
    else if (r === 'inner') counts.inner += 1;
    else if (r === 'main_stream') counts.main_stream += 1;
    else if (r === 'side_stream') counts.side_stream += 1;
    else {
      counts.other += 1;
      if (r && !other_roles.includes(r)) other_roles.push(r);
    }
  }
  return counts;
}

export function groupMembersByRole(
  members: InspectMemberInfo[],
): Array<{ role: string; members: InspectMemberInfo[] }> {
  const order = ['outer', 'inner', 'main_stream', 'side_stream'];
  const map = new Map<string, InspectMemberInfo[]>();
  for (const m of members) {
    const role = m.role || '(empty)';
    const list = map.get(role) ?? [];
    list.push(m);
    map.set(role, list);
  }
  const keys = [...map.keys()].sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    if (a === '(empty)') return 1;
    if (b === '(empty)') return -1;
    return a.localeCompare(b);
  });
  return keys.map((role) => ({ role, members: map.get(role)! }));
}

export function buildOsmObjectFamily(
  relationId: number,
  relationTags: Record<string, string>,
  members: InspectMemberInfo[],
): OsmObjectFamily {
  const role_counts = countMemberRoles(members);
  const waterway_rel = isWaterwayRelation(relationTags);
  return {
    relation_id: relationId,
    relation_tags: relationTags,
    member_count: members.length,
    role_counts,
    is_water_polygon: isMultipolygonArea(relationTags),
    is_waterway_relation: waterway_rel,
    centerline_member_count: waterway_rel ? members.length : 0,
    waterway_tagged_members: members.filter((m) => Boolean(m.tags.waterway)).length,
  };
}

function membershipKey(osmType: string, osmId: number): string {
  return `${osmType}/${osmId}`;
}

export function collectOsmMemberships(
  elements: OverpassInspectElement[],
): Map<string, InspectMembership[]> {
  const map = new Map<string, InspectMembership[]>();
  for (const el of elements) {
    if (el.type !== 'relation' || !el.members) continue;
    const relationTags = el.tags ?? {};
    for (const m of el.members) {
      const key = membershipKey(m.type || 'way', memberRef(m));
      const list = map.get(key) ?? [];
      list.push({
        relation_id: el.id,
        relation_type: relationTags.type || '',
        role: normalizeMemberRole(m.role, relationTags),
        relation_tags: relationTags,
      });
      map.set(key, list);
    }
  }
  return map;
}

function uniqueOsmCount(
  features: InspectFeature[],
  pred: (f: InspectFeature) => boolean,
): number {
  const ids = new Set<string>();
  for (const f of features) {
    if (!pred(f)) continue;
    ids.add(membershipKey(f.properties.osm_type, f.properties.osm_id));
  }
  return ids.size;
}

function uniqueRelationIds(
  features: InspectFeature[],
  wantType: 'multipolygon' | 'waterway',
): number {
  const ids = new Set<number>();
  for (const f of features) {
    const own = f.properties.osm_type === 'relation' ? f.properties.tags : undefined;
    const parent = f.properties.relation_tags;
    const tags = own?.type === wantType ? own : parent?.type === wantType ? parent : undefined;
    if (!tags) continue;
    const id = own?.type === wantType ? f.properties.osm_id : f.properties.relation_id;
    if (id) ids.add(id);
  }
  return ids.size;
}

export function buildInspectViewportStats(
  features: InspectFeature[],
  source: 'overpass' | 'catalog',
): InspectViewportStats {
  return {
    source,
    loaded_features: features.length,
    lake_polygons: uniqueOsmCount(features, (f) => f.properties.layer === 'polygon-lake'),
    reservoir_polygons: uniqueOsmCount(features, (f) => f.properties.layer === 'polygon-reservoir'),
    river_area_polygons: uniqueOsmCount(features, (f) => f.properties.layer === 'polygon-river-area'),
    other_polygons: uniqueOsmCount(features, (f) => f.properties.layer === 'polygon-other'),
    river_centerlines: uniqueOsmCount(features, (f) => f.properties.layer === 'centerline-river'),
    canal_centerlines: uniqueOsmCount(features, (f) => f.properties.layer === 'centerline-canal'),
    stream_centerlines: uniqueOsmCount(features, (f) => f.properties.layer === 'centerline-stream'),
    other_centerlines: uniqueOsmCount(features, (f) => f.properties.layer === 'centerline-other'),
    multipolygon_relations: uniqueRelationIds(features, 'multipolygon'),
    waterway_relations: uniqueRelationIds(features, 'waterway'),
    outer_members: uniqueOsmCount(features, (f) => f.properties.layer === 'mp-outer'),
    inner_members: uniqueOsmCount(features, (f) => f.properties.layer === 'mp-inner'),
    catalog_bboxes: uniqueOsmCount(features, (f) => f.properties.layer === 'catalog-water'),
  };
}

/** Prefer the copy that carries OSM membership when the same centerline way is both standalone and a relation member. */
export function dedupeInspectFeatures(features: InspectFeature[]): InspectFeature[] {
  const best = new Map<string, InspectFeature>();
  const rest: InspectFeature[] = [];
  const score = (f: InspectFeature) =>
    (f.properties.relation_id ? 2 : 0) +
    (f.properties.members_detail?.length ? 1 : 0) +
    (f.properties.osm_memberships?.length ? 1 : 0);
  for (const f of features) {
    const p = f.properties;
    if (!p.layer.startsWith('centerline')) {
      rest.push(f);
      continue;
    }
    const key = `${p.osm_type}/${p.osm_id}`;
    const prev = best.get(key);
    if (!prev || score(f) > score(prev)) best.set(key, f);
  }
  return [...rest, ...best.values()];
}

export function parseOverpassToInspectFeatures(
  elements: OverpassInspectElement[],
): InspectFeature[] {
  const wayTags = new Map<number, Record<string, string>>();
  for (const el of elements) {
    if (el.type === 'way') wayTags.set(el.id, el.tags ?? {});
  }
  const memberships = collectOsmMemberships(elements);

  const out: InspectFeature[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    const name = tags['name:ru'] || tags.name || '';
    const ownMemberships = memberships.get(membershipKey(el.type, el.id)) ?? [];
    const base = {
      name,
      osm_type: el.type,
      osm_id: el.id,
      tags,
      waterway: tags.waterway,
      water: tags.water,
      natural: tags.natural,
      osm_memberships: ownMemberships,
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
      const details = (el.members ?? []).map((m) => inspectMemberFromOverpass(m, wayTags, tags));
      const family = el.type === 'relation' ? buildOsmObjectFamily(el.id, tags, details) : undefined;
      out.push({
        type: 'Feature',
        properties: {
          ...base,
          layer: classifyInspectLayer(tags, kind),
          geometry_type: 'Overpass-bbox',
          part_count: 1,
          hole_count: 0,
          member_count: details.length || undefined,
          member_roles: details.map((m) => m.role),
          members_detail: details.length ? details : undefined,
          family,
        },
        geometry: { type: 'Polygon', coordinates: [bboxRing] },
      });
      continue;
    }

    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      const area = isAreaTags(tags) && closed(el.geometry);
      const ends = lineEndpoints(el.geometry);
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
            start: ends.start,
            end: ends.end,
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
            start: ends.start,
            end: ends.end,
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
    const details = el.members.map((m) => inspectMemberFromOverpass(m, wayTags, tags));
    const family = buildOsmObjectFamily(el.id, tags, details);
    const members = el.members.filter((m) => m.geometry && m.geometry.length >= 2);
    if (!members.length) continue;
    const roles = details.map((m) => m.role);
    const outerMembers = members.filter((m) => normalizeMemberRole(m.role, tags) === 'outer');
    const innerMembers = members.filter((m) => normalizeMemberRole(m.role, tags) === 'inner');

    if (isMultipolygonArea(tags)) {
      for (const m of outerMembers) {
        const geom = m.geometry!;
        const mTags = wayTags.get(memberRef(m)) ?? m.tags ?? {};
        const ends = lineEndpoints(geom);
        const ref = memberRef(m);
        out.push({
          type: 'Feature',
          properties: {
            name,
            osm_type: m.type || 'way',
            osm_id: ref,
            tags: mTags,
            member_tags: mTags,
            waterway: mTags.waterway,
            water: tags.water,
            natural: tags.natural,
            layer: 'mp-outer',
            geometry_type: 'LineString',
            part_count: outerMembers.length,
            hole_count: innerMembers.length,
            member_count: details.length,
            member_roles: roles,
            relation_id: el.id,
            relation_role: normalizeMemberRole(m.role, tags),
            relation_tags: tags,
            members_detail: details,
            family,
            osm_memberships: memberships.get(membershipKey(m.type || 'way', ref)) ?? [],
            vertex_count: geom.length,
            closed: closed(geom),
            start: ends.start,
            end: ends.end,
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
        const ends = lineEndpoints(geom);
        const ref = memberRef(m);
        out.push({
          type: 'Feature',
          properties: {
            name,
            osm_type: m.type || 'way',
            osm_id: ref,
            tags: mTags,
            member_tags: mTags,
            waterway: mTags.waterway,
            water: tags.water,
            natural: tags.natural,
            layer: 'mp-inner',
            geometry_type: isClosed ? 'Polygon-inner' : 'LineString',
            part_count: outerMembers.length,
            hole_count: innerMembers.length,
            member_count: details.length,
            member_roles: roles,
            relation_id: el.id,
            relation_role: 'inner',
            relation_tags: tags,
            members_detail: details,
            family,
            osm_memberships: memberships.get(membershipKey(m.type || 'way', ref)) ?? [],
            vertex_count: geom.length,
            closed: isClosed,
            start: ends.start,
            end: ends.end,
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
            member_count: details.length,
            member_roles: roles,
            members_detail: details,
            family,
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
      const ends = lineEndpoints(geom);
      const ref = memberRef(m);
      out.push({
        type: 'Feature',
        properties: {
          name: mTags['name:ru'] || mTags.name || name,
          osm_type: m.type || 'way',
          osm_id: ref,
          tags: Object.keys(mTags).length ? mTags : tags,
          member_tags: mTags,
          waterway: lineTags.waterway,
          water: lineTags.water,
          natural: lineTags.natural,
          layer: classifyInspectLayer(lineTags, 'line'),
          geometry_type: 'LineString',
          part_count: members.length,
          hole_count: 0,
          member_count: details.length,
          member_roles: roles,
          relation_id: el.id,
          relation_role: normalizeMemberRole(m.role, tags),
          relation_tags: tags,
          members_detail: details,
          family,
          osm_memberships: memberships.get(membershipKey(m.type || 'way', ref)) ?? [],
          vertex_count: geom.length,
          closed: closed(geom),
          start: ends.start,
          end: ends.end,
        },
        geometry: {
          type: 'LineString',
          coordinates: geom.map((p) => [p.lon, p.lat]),
        },
      });
    }
  }
  return dedupeInspectFeatures(out);
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
  if (!keys.length) return '<em>none</em>';
  return keys
    .map((k) => `<code>${escapeHtml(k)}=${escapeHtml(String(tags[k]))}</code>`)
    .join('<br>');
}

function formatCoord(pt?: [number, number]): string {
  if (!pt) return '—';
  return `${pt[0].toFixed(5)}, ${pt[1].toFixed(5)}`;
}

function formatKeyTags(tags: Record<string, string>, keys: string[]): string {
  return keys
    .filter((k) => tags[k])
    .map((k) => `<code>${escapeHtml(k)}=${escapeHtml(tags[k])}</code>`)
    .join('<br>');
}

export function formatOsmAnatomy(props: InspectProps): string {
  const relId = props.osm_type === 'relation' ? props.osm_id : props.relation_id;
  const relTags =
    props.osm_type === 'relation' || props.relation_role === 'area'
      ? props.tags
      : props.relation_tags;
  const members = props.members_detail || [];
  if (!relId || !relTags || !members.length) return '';
  const groups = groupMembersByRole(members);
  const head = formatKeyTags(relTags, ['type', 'natural', 'water', 'waterway', 'name', 'name:ru']);
  const roles = countMemberRoles(members);
  const blocks = groups
    .map((g) => {
      const label = g.role === '(empty)' ? 'OTHER / empty role' : g.role.toUpperCase();
      const items = g.members
        .map((m) => {
          const tagStr = Object.keys(m.tags).length
            ? Object.entries(m.tags)
                .map(([k, v]) => `${escapeHtml(k)}=${escapeHtml(String(v))}`)
                .join(', ')
            : 'none';
          const notCenterline =
            m.role === 'outer' || m.role === 'inner'
              ? '<div class="osm-inspect-not-centerline">NOT a waterway centerline</div>'
              : '';
          const openClosed = m.closed ? 'closed' : 'open';
          return `<li>
<strong>${escapeHtml(m.osm_type)}/${m.osm_id}</strong>
<div>role: <code>${escapeHtml(m.role || '(empty)')}</code></div>
<div>tags: ${tagStr}</div>
<div>geometry: ${openClosed} ${escapeHtml(m.geometry_type)}</div>
<div>vertices: ${m.vertex_count}</div>
<div>start: ${formatCoord(m.start)}</div>
<div>end: ${formatCoord(m.end)}</div>
<div>in relation: ${m.in_relation ? 'yes' : 'no'}</div>
${notCenterline}
</li>`;
        })
        .join('');
      return `<p class="osm-inspect-role-head">${escapeHtml(label)} (${g.members.length})</p>
<ul class="osm-inspect-members">${items}</ul>`;
    })
    .join('');
  return `<div class="osm-inspect-anatomy">
<p class="osm-inspect-anatomy-title">OSM object anatomy</p>
<p><strong>relation/${relId}</strong></p>
${head || '<em>relation tags: none</em>'}
<p>member count: ${members.length}
 · outer ${roles.outer}
 · inner ${roles.inner}
 · main_stream ${roles.main_stream}
 · side_stream ${roles.side_stream}
${roles.other ? ` · other ${roles.other}` : ''}</p>
${blocks}
</div>`;
}

export function formatOsmFamily(family: OsmObjectFamily): string {
  const tags = family.relation_tags;
  const head = formatKeyTags(tags, ['type', 'natural', 'water', 'waterway', 'name']);
  const polygonLine = family.is_water_polygon
    ? `${family.role_counts.outer} outer · ${family.role_counts.inner} inner`
    : 'none';
  const centerlineRel = family.is_waterway_relation ? 'yes (type=waterway)' : 'none';
  const centerlineMembers = family.is_waterway_relation
    ? String(family.centerline_member_count)
    : 'none';
  const waterwayMembers = family.is_water_polygon
    ? family.waterway_tagged_members
      ? String(family.waterway_tagged_members)
      : 'none'
    : family.is_waterway_relation
      ? String(family.waterway_tagged_members)
      : 'none';
  return `<div class="osm-inspect-family">
<p class="osm-inspect-anatomy-title">OSM FAMILY</p>
<p><strong>relation/${family.relation_id}</strong></p>
${head}
<p>Water polygon:<br>${polygonLine}</p>
<p>Centerline relation:<br>${centerlineRel}</p>
<p>centerline members:<br>${centerlineMembers}</p>
<p>Waterway members (tag waterway=* on member):<br>${waterwayMembers}</p>
<p>related polygon / centerline relation:<br><strong>НЕ ИСКАТЬ автоматически</strong> — только OSM membership, не geometry</p>
</div>`;
}

export function formatOsmMembership(memberships: InspectMembership[]): string {
  if (!memberships.length) return '';
  const items = memberships
    .map((m) => {
      const name = m.relation_tags['name:ru'] || m.relation_tags.name || '';
      return `<li>relation/${m.relation_id}
 · role: <code>${escapeHtml(m.role || '(empty)')}</code>
 · type=<code>${escapeHtml(m.relation_type || '—')}</code>
${name ? ` · ${escapeHtml(name)}` : ''}</li>`;
    })
    .join('');
  return `<div class="osm-inspect-membership">
<p class="osm-inspect-anatomy-title">OSM relation membership</p>
<p>это запись member в OSM relation, <strong>не вычисленная topology</strong></p>
<ul>${items}</ul>
</div>`;
}

export function formatInspectStatsHtml(stats: InspectViewportStats): string {
  if (stats.source === 'catalog') {
    return `<div class="osm-inspect-stats">
<strong>viewport</strong>
<p>каталог ${stats.catalog_bboxes} bbox — <em>не OSM geometry</em></p>
<p>lake/reservoir/river-area/centerline/MP: нет (этот кадр без Overpass)</p>
</div>`;
  }
  const row = (label: string, n: number) =>
    `<tr><td>${escapeHtml(label)}</td><td>${n}</td></tr>`;
  return `<div class="osm-inspect-stats">
<strong>viewport OSM</strong>
<table>
${row('lake polygons', stats.lake_polygons)}
${row('reservoir polygons', stats.reservoir_polygons)}
${row('river-area polygons', stats.river_area_polygons)}
${row('river centerlines', stats.river_centerlines)}
${row('canal centerlines', stats.canal_centerlines)}
${row('stream centerlines', stats.stream_centerlines)}
${row('multipolygon relations', stats.multipolygon_relations)}
${row('waterway relations', stats.waterway_relations)}
${row('outer members', stats.outer_members)}
${row('inner members', stats.inner_members)}
</table>
<p class="osm-inspect-muted">только загруженные объекты этого кадра / запроса, не вся Россия</p>
</div>`;
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
  const family = props.family ? formatOsmFamily(props.family) : '';
  const anatomy = formatOsmAnatomy(props);
  const membership = formatOsmMembership(props.osm_memberships || []);
  const boundaryNote = isBoundary
    ? `<p class="osm-inspect-not-centerline">это boundary way multipolygon, не waterway=river centerline</p>
<p>member of ${escapeHtml(relRef || 'relation')} · role: <code>${escapeHtml(props.relation_role || '')}</code></p>`
    : '';
  const tagSource =
    props.osm_type === 'relation' || props.relation_role === 'area'
      ? props.tags
      : props.member_tags || props.tags;
  const ends =
    props.start || props.end
      ? `<p>start: ${formatCoord(props.start)}<br>end: ${formatCoord(props.end)}</p>`
      : '';
  return `<div class="osm-inspect-popup">
<p><strong>${title}</strong></p>
<p>OSM: ${escapeHtml(ref)}${relRef && props.osm_type !== 'relation' ? ` · ${escapeHtml(relRef)}` : ''}</p>
<p>internal/area id: нет (это live OSM inspect, не строка water.objects)</p>
<p>layer: <code>${escapeHtml(props.layer)}</code></p>
<p>geometry: <code>${escapeHtml(props.geometry_type)}</code>
 · closed: ${props.closed ? 'yes' : 'no'}</p>
${
  props.geometry_type === 'Overpass-bbox'
    ? '<p>это bbox объекта OSM из Overpass, не полное кольцо (на широком кадре). Приблизьте для geom.</p>'
    : ''
}
${boundaryNote}
${ends}
<p>parts: ${props.part_count} · holes/inners: ${props.hole_count}</p>
${
  typeof props.vertex_count === 'number'
    ? `<p>vertices: OSM ${props.vertex_count}${
        typeof props.vertex_count_drawn === 'number' && props.vertex_count_drawn !== props.vertex_count
          ? `, на карте ${props.vertex_count_drawn} (inspect simplify, не topology)`
          : ''
      }</p>`
    : ''
}
${anatomy}
${family}
${membership}
<p>centerline «связи»: не вычисляются (нет topology). Inspector не ищет соседей по геометрии и не пишет «одна река».</p>
<p>теги ${props.osm_type === 'relation' || props.relation_role === 'area' ? 'relation' : 'этого way'}:</p>
${formatTags(tagSource)}
${
  relRef && (isBoundary || props.osm_type !== 'relation')
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
