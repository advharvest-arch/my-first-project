/**
 * Pure helpers for the Seliger OSM 399081 diagnostic overlay.
 * No Leaflet / WRG / routing imports.
 */

export type SeligerDebugWay = {
  wayId: number;
  tags: Record<string, string>;
};

export type SeligerDebugProps = {
  label: string;
  part: 'south' | 'north';
  role: 'outer' | 'inner';
  kind: 'water-area' | 'contour';
  wayIds: number[];
  wayCount?: number;
  innerCount?: number;
  vertexCount?: number;
  name?: string | null;
  names?: string[];
  ways?: SeligerDebugWay[];
  labelLonLat?: [number, number];
  osmRelation?: number;
  relationTags?: Record<string, string | undefined>;
};

export type SeligerDebugCollection = {
  type: 'FeatureCollection';
  properties?: {
    outerCount?: number;
    innerCount?: number;
    southInnerCount?: number;
    northInnerCount?: number;
    source?: string;
    polonovkaIncluded?: boolean;
  };
  features: Array<{
    type: 'Feature';
    properties: SeligerDebugProps;
    geometry: GeoJSON.Geometry;
  }>;
};

export function seligerDebugEnabledFromSearchParams(
  search: string | URLSearchParams,
): boolean {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('seligerDebug') === '1';
}

export type WaterRouterFeatureProps = {
  kind: 'water-route' | 'water-route-endpoint';
  routeId: string;
  label: string;
  status?: string;
  lengthM?: number;
  visitedFeatures?: string[];
  visitedCorridors?: string[];
  pointCount?: number;
  endpointRole?: 'start' | 'goal';
  color?: string;
};

export type WaterRouterCollection = {
  type: 'FeatureCollection';
  properties?: {
    seed?: string;
    routeCount?: number;
  };
  features: Array<{
    type: 'Feature';
    properties: WaterRouterFeatureProps;
    geometry: GeoJSON.Geometry;
  }>;
};

export function waterRouterEnabledFromSearchParams(
  search: string | URLSearchParams,
): boolean {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('waterRouter') === '1';
}

export function waterRouterShowMeshFromSearchParams(
  search: string | URLSearchParams = window.location.search,
): boolean {
  const params =
    typeof search === 'string' ? new URLSearchParams(search) : search;
  return params.get('showMesh') === '1';
}

export function formatWaterRouterPopup(props: WaterRouterFeatureProps): string {
  const km =
    typeof props.lengthM === 'number'
      ? `${(props.lengthM / 1000).toFixed(2)} км (${Math.round(props.lengthM)} м)`
      : '—';
  const feats = props.visitedFeatures?.length
    ? props.visitedFeatures.join(' → ')
    : '—';
  const corrs = props.visitedCorridors?.length
    ? props.visitedCorridors.join(', ')
    : 'нет';
  return `<div class="seliger-debug-popup">
<p><strong>${escapeHtml(props.label)}</strong></p>
<p>маршрут: <code>${escapeHtml(props.routeId)}</code> · статус: <code>${escapeHtml(props.status ?? 'OK')}</code></p>
<p>длина (A* + Funnel): <strong>${escapeHtml(km)}</strong></p>
<p>водные объекты: <code>${escapeHtml(feats)}</code></p>
<p>коридоры: <code>${escapeHtml(corrs)}</code></p>
</div>`;
}

export function countSeligerDebugContours(fc: SeligerDebugCollection): {
  waterAreas: number;
  outerContours: number;
  innerContours: number;
} {
  let waterAreas = 0;
  let outerContours = 0;
  let innerContours = 0;
  for (const f of fc.features) {
    const p = f.properties;
    if (p.kind === 'water-area') waterAreas += 1;
    else if (p.kind === 'contour' && p.role === 'outer') outerContours += 1;
    else if (p.kind === 'contour' && p.role === 'inner') innerContours += 1;
  }
  return { waterAreas, outerContours, innerContours };
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

/** Popup HTML for a reconstructed ring / water area. */
export function formatSeligerDebugPopup(props: SeligerDebugProps): string {
  const wayIds = props.wayIds?.length
    ? props.wayIds.map((id) => `way/${id}`).join(', ')
    : '—';
  const name = props.name ? escapeHtml(props.name) : 'нет';
  const wayBlocks = (props.ways ?? [])
    .map((w) => {
      const tagHtml = formatTags(w.tags);
      return `<div class="seliger-debug-way"><strong>way/${w.wayId}</strong><br>${tagHtml}</div>`;
    })
    .join('');
  const relTags = props.relationTags
    ? formatTags(
        Object.fromEntries(
          Object.entries(props.relationTags).filter(
            (kv): kv is [string, string] => typeof kv[1] === 'string',
          ),
        ),
      )
    : '';
  return `<div class="seliger-debug-popup">
<p><strong>${escapeHtml(props.label)}</strong></p>
<p>площадь: ${props.part === 'south' ? 'южная' : 'северная'} · роль: ${props.role}</p>
<p>OSM way ID: ${escapeHtml(wayIds)}</p>
<p>ways в кольце: ${props.wayCount ?? props.wayIds?.length ?? 0}${
    typeof props.innerCount === 'number' ? ` · отверстий: ${props.innerCount}` : ''
  }</p>
<p>название: ${name}</p>
${relTags ? `<p>теги relation 399081:</p>${relTags}` : ''}
<p>теги исходных ways:</p>
${wayBlocks || '<em>нет</em>'}
</div>`;
}
