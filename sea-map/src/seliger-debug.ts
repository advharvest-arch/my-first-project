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
