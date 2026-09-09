/**
 * Pure helpers for the Seliger topology visual overlay (?seligerTopologyDebug=1).
 * No Leaflet / WRG / routing imports. Does not re-run discovery.
 */

export const SELIGER_TOPOLOGY_DEBUG_GEOJSON =
  'seliger-topology-debug.geojson';

export const TOPOLOGY_LEGEND = {
  DIRECT_OSM: '#facc15',
  WATERWAY_CONNECTOR: '#22c55e',
  NEARBY_CANDIDATE: '#f59e0b',
  PORTAGE_CANDIDATE: '#fb7185',
  UNCERTAIN: '#ef4444',
  ISLAND_WATER: '#c026d3',
  CONFIRMED_WATER: '#38bdf8',
  SEED: '#3b82f6',
  OSM_CONTOUR: '#eab308',
} as const;

export type TopologyDebugProps = {
  layer?: string;
  name?: string;
  osm_type?: string;
  osm_id?: number;
  key?: string;
  tags?: Record<string, string>;
  area_m2?: number | null;
  length_m?: number | null;
  relation_membership?: Array<{ relation?: number; role?: string }>;
  status?: string;
  bfs_hops?: number | null;
  parent_island_way_ids?: number[];
  island?: boolean;
  role?: string;
  in_confirmed_component?: boolean;
  connection_type?: string;
  from_key?: string;
  to_key?: string;
  from_name?: string;
  to_name?: string;
  connector_osm_id?: number | null;
  connector_key?: string;
  shared_node_ids?: number[];
  shared_edge_ids?: number[];
  evidence?: Record<string, unknown>;
  incident_count?: number;
  incidents?: Array<Record<string, unknown>>;
  seed_part?: number;
  inner_index?: number;
};

export type TopologyDebugCollection = {
  type: 'FeatureCollection';
  name?: string;
  properties?: {
    source?: string;
    seed_outers?: number;
    inner_polygons?: number;
    confirmed_features?: number;
    waterway_connector_features?: number;
    skipped_centroid_connection_lines?: number;
    focus_labels_placed?: string[];
    focus_labels_missing?: string[];
    summary?: Record<string, number | undefined>;
  };
  features: Array<{
    type: 'Feature';
    properties: TopologyDebugProps;
    geometry: GeoJSON.Geometry;
  }>;
};

export function seligerTopologyDebugEnabledFromSearchParams(
  search: string | URLSearchParams,
): boolean {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('seligerTopologyDebug') === '1';
}

export function countTopologyDebugLayers(fc: TopologyDebugCollection): {
  seedOuters: number;
  innerPolygons: number;
  outerContours: number;
  waterwayConnectors: number;
  directOsmNodes: number;
  directOsmLines: number;
  nearby: number;
  islandWater: number;
  focusLabels: number;
} {
  let seedOuters = 0;
  let innerPolygons = 0;
  let outerContours = 0;
  let waterwayConnectors = 0;
  let directOsmNodes = 0;
  let directOsmLines = 0;
  let nearby = 0;
  let islandWater = 0;
  let focusLabels = 0;
  for (const f of fc.features) {
    const layer = f.properties.layer;
    const geomType = f.geometry?.type;
    if (layer === 'seed-outer') seedOuters += 1;
    else if (layer === 'osm-contour-inner') innerPolygons += 1;
    else if (layer === 'osm-contour-outer') outerContours += 1;
    else if (layer === 'waterway-connector') waterwayConnectors += 1;
    else if (layer === 'direct-osm-node') directOsmNodes += 1;
    else if (layer === 'nearby-candidate') nearby += 1;
    else if (layer === 'island-water') islandWater += 1;
    else if (layer === 'focus-label') focusLabels += 1;
    if (
      f.properties.connection_type === 'DIRECT_OSM' &&
      (geomType === 'LineString' || geomType === 'MultiLineString')
    ) {
      directOsmLines += 1;
    }
  }
  return {
    seedOuters,
    innerPolygons,
    outerContours,
    waterwayConnectors,
    directOsmNodes,
    directOsmLines,
    nearby,
    islandWater,
    focusLabels,
  };
}

export function osmRef(osmType: string | undefined, osmId: number | undefined): string {
  if (osmId == null) return '—';
  if (osmType === 'relation') return `relation/${osmId}`;
  if (osmType === 'way') return `way/${osmId}`;
  if (osmType === 'node') return `node/${osmId}`;
  return `osm:${osmId}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTags(tags: Record<string, string> | undefined): string {
  if (!tags || !Object.keys(tags).length) return '<em>нет</em>';
  return Object.entries(tags)
    .map(([k, v]) => `<code>${escapeHtml(k)}=${escapeHtml(String(v))}</code>`)
    .join('<br>');
}

function formatMembership(
  membership: Array<{ relation?: number; role?: string }> | undefined,
): string {
  if (!membership?.length) return '—';
  return membership
    .map((m) => `r${m.relation ?? '?'}${m.role ? ` (${escapeHtml(String(m.role))})` : ''}`)
    .join(', ');
}

function formatEvidence(evidence: Record<string, unknown> | undefined): string {
  if (!evidence || !Object.keys(evidence).length) return '<em>нет</em>';
  return `<pre>${escapeHtml(JSON.stringify(evidence, null, 2))}</pre>`;
}

function formatArea(m2: number | null | undefined): string {
  if (m2 == null || !Number.isFinite(m2)) return '—';
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} км²`;
  return `${Math.round(m2).toLocaleString('ru-RU')} м²`;
}

function ids(list: number[] | undefined): string {
  if (!list?.length) return '—';
  return list.join(', ');
}

function waterTitle(props: TopologyDebugProps): string {
  const name = (props.name || '').trim();
  const ref = osmRef(props.osm_type, props.osm_id);
  return name ? `${name} · ${ref}` : ref;
}

/** Popup HTML for a water object (named or nameless). */
export function formatTopologyWaterPopup(props: TopologyDebugProps): string {
  const parent =
    props.parent_island_way_ids && props.parent_island_way_ids.length
      ? props.parent_island_way_ids.map((id) => `way/${id}`).join(', ')
      : '—';
  const hops =
    props.bfs_hops == null ? '—' : String(props.bfs_hops);
  return `<div class="seliger-topo-popup">
<p><strong>${escapeHtml(waterTitle(props))}</strong></p>
<p>OSM type: ${escapeHtml(props.osm_type || '—')}</p>
<p>OSM ID: ${escapeHtml(osmRef(props.osm_type, props.osm_id))}</p>
<p>status: <code>${escapeHtml(props.status || '—')}</code>${
    props.in_confirmed_component ? ' · confirmed graph' : ' · не в confirmed graph'
  }</p>
<p>BFS hops от Селигера: ${escapeHtml(hops)}</p>
<p>area: ${escapeHtml(formatArea(props.area_m2))}</p>
<p>relation membership: ${formatMembership(props.relation_membership)}</p>
<p>parent island: ${escapeHtml(parent)}</p>
<p>теги:</p>
${formatTags(props.tags)}
</div>`;
}

/** Popup HTML for a topology connection (DIRECT_OSM / WATERWAY_CONNECTOR / candidates). */
export function formatTopologyConnectionPopup(props: TopologyDebugProps): string {
  const connType = props.connection_type || props.layer || '—';
  const connector =
    props.connector_osm_id != null
      ? `way/${props.connector_osm_id}`
      : props.connector_key || '—';
  const from = props.from_name || props.from_key || '—';
  const to = props.to_name || props.to_key || '—';
  return `<div class="seliger-topo-popup">
<p><strong>${escapeHtml(String(connType))}</strong></p>
<p>FROM: ${escapeHtml(String(from))}</p>
<p>TO: ${escapeHtml(String(to))}</p>
<p>connection type: <code>${escapeHtml(String(connType))}</code></p>
<p>connector OSM ID: ${escapeHtml(String(connector))}</p>
<p>shared node IDs: ${escapeHtml(ids(props.shared_node_ids))}</p>
<p>shared edge IDs: ${escapeHtml(ids(props.shared_edge_ids))}</p>
<p>status: <code>${escapeHtml(props.status || '—')}</code></p>
<p>evidence:</p>
${formatEvidence(props.evidence)}
</div>`;
}

export function isConnectionLayer(layer: string | undefined): boolean {
  return (
    layer === 'waterway-connector' ||
    layer === 'direct-osm-node' ||
    layer === 'portage-candidate' ||
    layer === 'uncertain-connection'
  );
}
