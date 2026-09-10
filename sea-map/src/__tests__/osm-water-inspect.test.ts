import { describe, expect, it } from 'vitest';
import {
  buildInspectOverpassQuery,
  catalogFeaturesFromBodies,
  classifyInspectLayer,
  formatInspectPopup,
  inspectDetailLevel,
  parseOverpassToInspectFeatures,
  russiaWaterTopologyDebugEnabledFromHost,
  russiaWaterTopologyDebugEnabledFromSearchParams,
  simplifyInspectFeatureForDisplay,
  spanTooWide,
  buildInspectViewportStats,
  type OverpassInspectElement,
} from '../osm-water-inspect';
import { seligerTopologyDebugEnabledFromSearchParams } from '../seliger-topology-debug';
import { seligerDebugEnabledFromSearchParams } from '../seliger-debug';

describe('russiaWaterTopologyDebug inspect', () => {
  it('enables only on ?russiaWaterTopologyDebug=1 and does not collide with Seliger flags', () => {
    expect(russiaWaterTopologyDebugEnabledFromSearchParams('?russiaWaterTopologyDebug=1')).toBe(true);
    expect(russiaWaterTopologyDebugEnabledFromSearchParams('?russiaWaterTopologyDebug=true')).toBe(false);
    expect(russiaWaterTopologyDebugEnabledFromSearchParams('?seligerTopologyDebug=1')).toBe(false);
    expect(seligerTopologyDebugEnabledFromSearchParams('?russiaWaterTopologyDebug=1')).toBe(false);
    expect(seligerDebugEnabledFromSearchParams('?russiaWaterTopologyDebug=1')).toBe(false);
  });

  it('enables hosted preview via window flag or hash when query string is unusable', () => {
    expect(russiaWaterTopologyDebugEnabledFromHost({ inspectFlag: true })).toBe(true);
    expect(
      russiaWaterTopologyDebugEnabledFromHost({ hash: '#russiaWaterTopologyDebug=1' }),
    ).toBe(true);
    expect(
      russiaWaterTopologyDebugEnabledFromHost({
        search: '?https://github.com/example/open.html',
      }),
    ).toBe(false);
    expect(russiaWaterTopologyDebugEnabledFromHost({})).toBe(false);
  });

  it('classifies lake polygon vs river/canal centerline vs hole', () => {
    expect(classifyInspectLayer({ natural: 'water', water: 'lake' }, 'polygon')).toBe('polygon-lake');
    expect(classifyInspectLayer({ water: 'reservoir' }, 'polygon')).toBe('polygon-reservoir');
    expect(classifyInspectLayer({ water: 'river' }, 'polygon')).toBe('polygon-river-area');
    expect(
      classifyInspectLayer({ type: 'multipolygon', natural: 'water', water: 'river' }, 'polygon'),
    ).toBe('polygon-river-area');
    expect(classifyInspectLayer({ waterway: 'river' }, 'line')).toBe('centerline-river');
    expect(classifyInspectLayer({ waterway: 'canal' }, 'line')).toBe('centerline-canal');
    expect(classifyInspectLayer({ waterway: 'stream' }, 'line')).toBe('centerline-stream');
    expect(classifyInspectLayer({}, 'inner')).toBe('mp-inner');
    expect(classifyInspectLayer({}, 'outer')).toBe('mp-outer');
    expect(
      classifyInspectLayer({ type: 'multipolygon', natural: 'water', water: 'river' }, 'line'),
    ).toBe('mp-outer');
  });

  it('keeps MultiPolygon outers as separate parts and inners as holes, without invented A–B lines', () => {
    const els: OverpassInspectElement[] = [
      {
        type: 'relation',
        id: 399081,
        tags: { type: 'multipolygon', natural: 'water', water: 'lake', name: 'Селигер' },
        members: [
          {
            type: 'way',
            role: 'outer',
            geometry: [
              { lon: 33, lat: 57 },
              { lon: 33.2, lat: 57 },
              { lon: 33.2, lat: 57.2 },
              { lon: 33, lat: 57.2 },
              { lon: 33, lat: 57 },
            ],
          },
          {
            type: 'way',
            role: 'outer',
            geometry: [
              { lon: 33.3, lat: 57.3 },
              { lon: 33.4, lat: 57.3 },
              { lon: 33.4, lat: 57.4 },
              { lon: 33.3, lat: 57.4 },
              { lon: 33.3, lat: 57.3 },
            ],
          },
          {
            type: 'way',
            role: 'inner',
            geometry: [
              { lon: 33.05, lat: 57.05 },
              { lon: 33.08, lat: 57.05 },
              { lon: 33.08, lat: 57.08 },
              { lon: 33.05, lat: 57.08 },
              { lon: 33.05, lat: 57.05 },
            ],
          },
        ],
      },
    ];
    const features = parseOverpassToInspectFeatures(els);
    const areas = features.filter((f) => f.properties.layer.startsWith('polygon'));
    const outers = features.filter((f) => f.properties.layer === 'mp-outer');
    const inners = features.filter((f) => f.properties.layer === 'mp-inner');
    expect(areas).toHaveLength(2);
    expect(outers).toHaveLength(2);
    expect(inners).toHaveLength(1);
    expect(areas.every((f) => f.geometry.type === 'Polygon')).toBe(true);
    expect(features.some((f) => f.properties.layer.startsWith('centerline'))).toBe(false);
    expect(areas[0].properties.part_count).toBe(2);
    expect(inners[0].properties.hole_count).toBe(1);
    expect(outers.every((f) => f.properties.relation_id === 399081)).toBe(true);
    expect(outers.every((f) => f.properties.layer === 'mp-outer')).toBe(true);
  });

  it('renders waterway centerline and water polygon as two objects, not a computed link', () => {
    const els: OverpassInspectElement[] = [
      {
        type: 'way',
        id: 1,
        tags: { natural: 'water', water: 'lake', name: 'озеро' },
        geometry: [
          { lon: 0, lat: 0 },
          { lon: 1, lat: 0 },
          { lon: 1, lat: 1 },
          { lon: 0, lat: 1 },
          { lon: 0, lat: 0 },
        ],
      },
      {
        type: 'way',
        id: 2,
        tags: { waterway: 'river', name: 'река' },
        geometry: [
          { lon: 0.2, lat: 0.2 },
          { lon: 0.8, lat: 0.8 },
        ],
      },
    ];
    const features = parseOverpassToInspectFeatures(els);
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.properties.layer).sort()).toEqual(['centerline-river', 'polygon-lake']);
    expect(features.every((f) => f.properties.osm_id === 1 || f.properties.osm_id === 2)).toBe(true);
  });

  it('nameless popup still shows OSM id and refuses invented connections', () => {
    const html = formatInspectPopup({
      layer: 'centerline-canal',
      name: '',
      osm_type: 'way',
      osm_id: 167688573,
      tags: { waterway: 'canal' },
      geometry_type: 'LineString',
      part_count: 1,
      hole_count: 0,
    });
    expect(html).toContain('way/167688573');
    expect(html).toContain('не вычисляются');
  });

  it('rejects oversized viewport fetches for full OSM, but Ladoga-sized is major not empty', () => {
    expect(spanTooWide(48, 27, 66, 55)).toBe(true);
    expect(spanTooWide(57.0, 32.8, 57.6, 33.4)).toBe(false);
    expect(inspectDetailLevel(6, 48.2, 27, 66.8, 55)).toBe('catalog');
    expect(inspectDetailLevel(8, 59.98, 29.8, 61.75, 33.2)).toBe('major');
    expect(inspectDetailLevel(6, 59.5, 29, 62.2, 34)).toBe('major');
    expect(inspectDetailLevel(9, 57.0, 32.8, 57.6, 33.4)).toBe('full');
    expect(inspectDetailLevel(11, 57.1, 33.0, 57.3, 33.2)).toBe('streams');
    expect(inspectDetailLevel(4, 57.0, 32.8, 57.6, 33.4)).toBe('catalog');
  });

  it('major Overpass query is named waters only and has no streams', () => {
    const q = buildInspectOverpassQuery(59.98, 29.8, 61.75, 33.2, 'major');
    expect(q).toContain('["name"]');
    expect(q).toContain('out tags bb');
    expect(q).toContain('water"~"^(lake|reservoir)$');
    expect(q).not.toContain('out geom');
    expect(q).not.toContain('waterway=stream');
    expect(q).not.toContain('way["waterway"]');
    expect(q).not.toContain('way["waterway"~"^(river|canal)$"]');
    const full = buildInspectOverpassQuery(57.0, 32.8, 57.6, 33.4, 'full');
    expect(full).not.toContain('stream');
    expect(full).toContain('way(r.q)');
    const streams = buildInspectOverpassQuery(57.1, 33.0, 57.3, 33.2, 'streams');
    expect(streams).toContain('way["waterway"]');
  });

  it('catalog features are European bboxes and popups refuse OSM geometry claim', () => {
    const features = catalogFeaturesFromBodies([
      { n: 'Ладожское озеро', k: 'l', b: [29.8, 59.98, 33.2, 61.75] },
      { n: 'Онежское озеро', k: 'l', b: [34.5, 61.0, 36.5, 62.9] },
      { n: 'Байкал', k: 'l', b: [103.6, 51.4, 110.0, 55.9] },
    ]);
    expect(features).toHaveLength(2);
    expect(features[0].properties.layer).toBe('catalog-water');
    expect(features[0].properties.osm_type).toBe('catalog');
    const html = formatInspectPopup(features[0].properties);
    expect(html).toContain('не OSM-геометрия');
    expect(html).toContain('Ладожское озеро');
    const stats = buildInspectViewportStats(features, 'catalog');
    expect(stats.catalog_bboxes).toBe(2);
    expect(stats.lake_polygons).toBe(0);
    expect(stats.multipolygon_relations).toBe(0);
  });

  it('parses Overpass bbox-only elements as OSM extents, not invented links', () => {
    const features = parseOverpassToInspectFeatures([
      {
        type: 'relation',
        id: 2020202,
        tags: { natural: 'water', water: 'lake', name: 'Ладожское озеро' },
        bounds: { minlat: 59.98, minlon: 29.8, maxlat: 61.75, maxlon: 33.2 },
      },
    ]);
    expect(features).toHaveLength(1);
    expect(features[0].properties.geometry_type).toBe('Overpass-bbox');
    expect(features[0].properties.layer).toBe('polygon-lake');
    expect(formatInspectPopup(features[0].properties)).toContain('не полное кольцо');
  });

  it('display simplify keeps closed rings but drops vertices for Leaflet', () => {
    const ring: number[][] = [];
    for (let i = 0; i < 2000; i += 1) ring.push([30 + i / 10000, 60]);
    ring.push(ring[0]);
    const simplified = simplifyInspectFeatureForDisplay({
      type: 'Feature',
      properties: {
        layer: 'polygon-lake',
        osm_type: 'way',
        osm_id: 1,
        tags: {},
        geometry_type: 'Polygon',
        part_count: 1,
        hole_count: 0,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
    const drawn = (simplified.geometry as GeoJSON.Polygon).coordinates[0];
    expect(simplified.properties.vertex_count).toBe(2001);
    expect(drawn.length).toBeLessThan(600);
    expect(drawn[0]).toEqual(drawn[drawn.length - 1]);
    const html = formatInspectPopup(simplified.properties);
    expect(html).toContain('inspect simplify');
  });

  it('treats multipolygon water=river as river-area, and short untagged outer as boundary not centerline', () => {
    const els: OverpassInspectElement[] = [
      {
        type: 'relation',
        id: 2406778,
        tags: { type: 'multipolygon', natural: 'water', water: 'river' },
        members: [
          {
            type: 'way',
            ref: 180396592,
            role: 'outer',
            geometry: [
              { lon: 33.545707, lat: 56.812748 },
              { lon: 33.5463, lat: 56.8128 },
              { lon: 33.546923, lat: 56.812912 },
            ],
          },
          {
            type: 'way',
            ref: 180396594,
            role: 'outer',
            geometry: [
              { lon: 33.545707, lat: 56.812748 },
              { lon: 33.5, lat: 56.83 },
              { lon: 33.455044, lat: 56.853745 },
            ],
          },
          {
            type: 'way',
            ref: 191714173,
            role: 'outer',
            geometry: [
              { lon: 33.455044, lat: 56.853745 },
              { lon: 33.4554, lat: 56.85366 },
              { lon: 33.4557, lat: 56.853572 },
            ],
          },
          {
            type: 'way',
            ref: 191714151,
            role: 'outer',
            geometry: [
              { lon: 33.4557, lat: 56.853572 },
              { lon: 33.5, lat: 56.83 },
              { lon: 33.545163, lat: 56.817057 },
            ],
          },
          {
            type: 'way',
            ref: 180396620,
            role: 'outer',
            geometry: [
              { lon: 33.545163, lat: 56.817057 },
              { lon: 33.546, lat: 56.815 },
              { lon: 33.546923, lat: 56.812912 },
            ],
          },
          {
            type: 'way',
            ref: 273432251,
            role: 'inner',
            geometry: [
              { lon: 33.502, lat: 56.834 },
              { lon: 33.503, lat: 56.834 },
              { lon: 33.503, lat: 56.835 },
              { lon: 33.502, lat: 56.835 },
              { lon: 33.502, lat: 56.834 },
            ],
          },
        ],
      },
      {
        type: 'way',
        id: 273432251,
        tags: { place: 'islet' },
      },
      {
        type: 'way',
        id: 28237778,
        tags: { waterway: 'river', name: 'Селижаровка' },
        geometry: [
          { lon: 33.54, lat: 56.82 },
          { lon: 33.55, lat: 56.81 },
        ],
      },
    ];
    const features = parseOverpassToInspectFeatures(els);
    const area = features.filter((f) => f.properties.layer === 'polygon-river-area');
    const yellowTrap = features.filter((f) => f.properties.layer.startsWith('centerline-other'));
    const outer = features.filter((f) => f.properties.layer === 'mp-outer');
    const inner = features.filter((f) => f.properties.layer === 'mp-inner');
    const center = features.filter((f) => f.properties.layer === 'centerline-river');
    expect(yellowTrap).toHaveLength(0);
    expect(area.length).toBeGreaterThanOrEqual(1);
    expect(area[0].properties.osm_id).toBe(2406778);
    expect(area[0].geometry.type).toBe('Polygon');
    expect(area[0].properties.hole_count).toBe(1);
    expect(outer).toHaveLength(5);
    expect(inner).toHaveLength(1);
    const short = outer.find((f) => f.properties.osm_id === 180396592);
    expect(short).toBeTruthy();
    expect(short!.geometry.type).toBe('LineString');
    expect(short!.properties.relation_role).toBe('outer');
    expect(short!.properties.relation_id).toBe(2406778);
    expect(formatInspectPopup(short!.properties)).toContain('не waterway=river centerline');
    expect(formatInspectPopup(short!.properties)).toContain('NOT a waterway centerline');
    expect(formatInspectPopup(short!.properties)).toContain('way/180396592');
    expect(formatInspectPopup(short!.properties)).toContain('vertices: 3');
    expect(formatInspectPopup(short!.properties)).toContain('open LineString');
    expect(short!.properties.start).toEqual([33.545707, 56.812748]);
    expect(short!.properties.in_relation ?? short!.properties.osm_memberships?.length).toBeTruthy();
    const areaHtml = formatInspectPopup(area[0].properties);
    expect(areaHtml).toContain('relation/2406778');
    expect(areaHtml).toContain('OUTER');
    expect(areaHtml).toContain('INNER');
    expect(areaHtml).toContain('outer 5');
    expect(areaHtml).toContain('inner 1');
    expect(areaHtml).toContain('way/180396592');
    expect(areaHtml).toContain('OSM FAMILY');
    expect(areaHtml).toContain('НЕ ИСКАТЬ автоматически');
    expect(areaHtml).toContain('place=islet');
    expect(center).toHaveLength(1);
    expect(center[0].properties.osm_id).toBe(28237778);
    expect(center[0].properties.tags.waterway).toBe('river');
  });

  it('shows waterway relation anatomy as OSM membership, not computed polygon links', () => {
    const els: OverpassInspectElement[] = [
      {
        type: 'relation',
        id: 379295,
        tags: { type: 'waterway', waterway: 'river', name: 'Селижаровка' },
        members: [
          {
            type: 'way',
            ref: 28838371,
            role: 'main_stream',
            geometry: [
              { lon: 33.3, lat: 57.0 },
              { lon: 33.35, lat: 56.95 },
            ],
          },
          {
            type: 'way',
            ref: 28237780,
            role: 'main_stream',
            geometry: [
              { lon: 33.35, lat: 56.95 },
              { lon: 33.45, lat: 56.88 },
            ],
          },
          {
            type: 'way',
            ref: 28237778,
            role: 'main_stream',
            geometry: [
              { lon: 33.45, lat: 56.88 },
              { lon: 33.55, lat: 56.81 },
            ],
          },
        ],
      },
      {
        type: 'way',
        id: 28237778,
        tags: { waterway: 'river', name: 'Селижаровка' },
        geometry: [
          { lon: 33.45, lat: 56.88 },
          { lon: 33.55, lat: 56.81 },
        ],
      },
    ];
    const features = parseOverpassToInspectFeatures(els);
    const center = features.filter((f) => f.properties.layer === 'centerline-river');
    expect(center).toHaveLength(3);
    expect(features.filter((f) => f.properties.layer.startsWith('polygon'))).toHaveLength(0);
    expect(features.filter((f) => f.properties.layer === 'centerline-other')).toHaveLength(0);
    const mouth = center.find((f) => f.properties.osm_id === 28237778);
    expect(mouth).toBeTruthy();
    expect(mouth!.properties.relation_id).toBe(379295);
    expect(mouth!.properties.relation_role).toBe('main_stream');
    expect(mouth!.properties.osm_memberships?.some((m) => m.relation_id === 379295)).toBe(true);
    expect(mouth!.properties.family?.is_waterway_relation).toBe(true);
    expect(mouth!.properties.family?.is_water_polygon).toBe(false);
    expect(mouth!.properties.family?.centerline_member_count).toBe(3);
    const html = formatInspectPopup(mouth!.properties);
    expect(html).toContain('relation/379295');
    expect(html).toContain('MAIN_STREAM');
    expect(html).toContain('way/28838371');
    expect(html).toContain('way/28237780');
    expect(html).toContain('way/28237778');
    expect(html).toContain('role: <code>main_stream</code>');
    expect(html).toContain('OSM relation membership');
    expect(html).toContain('не вычисленная topology');
    expect(html).toContain('НЕ ИСКАТЬ автоматически');
    expect(html).toContain('не вычисляются');
    expect(html).not.toContain('nearest');
    expect(html).not.toContain('same water body');
    expect(html).not.toContain('belongs to polygon');
    expect(html.toLowerCase()).not.toContain('st_dwithin');
  });

  it('keeps a large river-area of unclosed LineString outers as MP boundary, not centerline', () => {
    const members: NonNullable<OverpassInspectElement['members']> = [
      {
        type: 'way',
        ref: 258000001,
        role: 'outer',
        geometry: [
          { lon: 33.27, lat: 56.9 },
          { lon: 33.43, lat: 56.9 },
        ],
      },
      {
        type: 'way',
        ref: 258000002,
        role: 'outer',
        geometry: [
          { lon: 33.43, lat: 56.9 },
          { lon: 33.43, lat: 57.03 },
        ],
      },
      {
        type: 'way',
        ref: 258000003,
        role: 'outer',
        geometry: [
          { lon: 33.43, lat: 57.03 },
          { lon: 33.27, lat: 57.03 },
        ],
      },
      {
        type: 'way',
        ref: 258000004,
        role: 'outer',
        geometry: [
          { lon: 33.27, lat: 57.03 },
          { lon: 33.27, lat: 56.9 },
        ],
      },
    ];
    for (let i = 0; i < 4; i += 1) {
      const lon = 33.28 + i * 0.02;
      members.push({
        type: 'way',
        ref: 258000010 + i,
        role: 'outer',
        geometry: [
          { lon, lat: 56.94 },
          { lon: lon + 0.004, lat: 56.941 },
          { lon: lon + 0.008, lat: 56.942 },
        ],
      });
    }
    members.push({
      type: 'way',
      ref: 258000099,
      role: 'inner',
      geometry: [
        { lon: 33.33, lat: 56.96 },
        { lon: 33.331, lat: 56.96 },
        { lon: 33.331, lat: 56.961 },
        { lon: 33.33, lat: 56.961 },
        { lon: 33.33, lat: 56.96 },
      ],
    });
    const features = parseOverpassToInspectFeatures([
      {
        type: 'relation',
        id: 2580469,
        tags: { type: 'multipolygon', natural: 'water', water: 'river' },
        members,
      },
    ]);
    expect(features.filter((f) => f.properties.layer.startsWith('centerline'))).toHaveLength(0);
    expect(features.filter((f) => f.properties.layer === 'mp-outer')).toHaveLength(8);
    expect(features.filter((f) => f.properties.layer === 'mp-inner')).toHaveLength(1);
    expect(features.filter((f) => f.properties.layer === 'polygon-river-area').length).toBeGreaterThanOrEqual(1);
    const stats = buildInspectViewportStats(features, 'overpass');
    expect(stats.river_area_polygons).toBeGreaterThanOrEqual(1);
    expect(stats.multipolygon_relations).toBe(1);
    expect(stats.waterway_relations).toBe(0);
    expect(stats.outer_members).toBe(8);
    expect(stats.inner_members).toBe(1);
    expect(stats.river_centerlines).toBe(0);
  });

  it('attaches OSM membership to a standalone centerline way without inventing a polygon family', () => {
    const features = parseOverpassToInspectFeatures([
      {
        type: 'way',
        id: 10,
        tags: { waterway: 'river', name: 'река' },
        geometry: [
          { lon: 1, lat: 1 },
          { lon: 2, lat: 2 },
        ],
      },
      {
        type: 'relation',
        id: 99,
        tags: { type: 'waterway', waterway: 'river', name: 'река' },
        members: [{ type: 'way', ref: 10, role: 'main_stream' }],
      },
    ]);
    const way = features.find((f) => f.properties.osm_id === 10);
    expect(way?.properties.layer).toBe('centerline-river');
    expect(way?.properties.osm_memberships).toEqual([
      expect.objectContaining({ relation_id: 99, role: 'main_stream' }),
    ]);
    const html = formatInspectPopup(way!.properties);
    expect(html).toContain('OSM relation membership');
    expect(html).not.toContain('Water polygon:<br>1 outer');
  });
});
