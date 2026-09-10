import { describe, expect, it } from 'vitest';
import {
  buildInspectOverpassQuery,
  catalogFeaturesFromBodies,
  classifyInspectLayer,
  formatInspectPopup,
  inspectDetailLevel,
  parseOverpassToInspectFeatures,
  russiaWaterTopologyDebugEnabledFromSearchParams,
  simplifyInspectFeatureForDisplay,
  spanTooWide,
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

  it('classifies lake polygon vs river/canal centerline vs hole', () => {
    expect(classifyInspectLayer({ natural: 'water', water: 'lake' }, 'polygon')).toBe('polygon-lake');
    expect(classifyInspectLayer({ water: 'reservoir' }, 'polygon')).toBe('polygon-reservoir');
    expect(classifyInspectLayer({ water: 'river' }, 'polygon')).toBe('polygon-river-area');
    expect(classifyInspectLayer({ waterway: 'river' }, 'line')).toBe('centerline-river');
    expect(classifyInspectLayer({ waterway: 'canal' }, 'line')).toBe('centerline-canal');
    expect(classifyInspectLayer({ waterway: 'stream' }, 'line')).toBe('centerline-stream');
    expect(classifyInspectLayer({}, 'inner')).toBe('mp-inner');
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
    const outers = features.filter((f) => f.properties.relation_role === 'outer');
    const inners = features.filter((f) => f.properties.layer === 'mp-inner');
    expect(outers).toHaveLength(2);
    expect(inners).toHaveLength(1);
    expect(outers[0].geometry.type).toBe('Polygon');
    expect(outers[1].geometry.type).toBe('Polygon');
    expect(features.some((f) => f.geometry.type === 'LineString' && f.properties.layer.startsWith('centerline'))).toBe(
      false,
    );
    expect(outers[0].properties.part_count).toBe(2);
    expect(outers[0].properties.hole_count).toBe(1);
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
    expect(q).not.toContain('out geom');
    expect(q).not.toContain('waterway=stream');
    expect(q).not.toContain('way["waterway"]');
    expect(q).not.toContain('way["waterway"~"^(river|canal)$"]');
    const full = buildInspectOverpassQuery(57.0, 32.8, 57.6, 33.4, 'full');
    expect(full).not.toContain('stream');
    const streams = buildInspectOverpassQuery(57.1, 33.0, 57.3, 33.2, 'streams');
    expect(streams).toContain('way["waterway"]');
  });

  it('catalog features are European bboxes and popups refuse OSM geometry claim', () => {
    const features = catalogFeaturesFromBodies([
      { n: 'Ладожское озеро', k: 'l', b: [29.8, 59.98, 33.2, 61.75] },
      { n: 'Байкал', k: 'l', b: [103.6, 51.4, 110.0, 55.9] },
    ]);
    expect(features).toHaveLength(1);
    expect(features[0].properties.layer).toBe('catalog-water');
    expect(features[0].properties.osm_type).toBe('catalog');
    const html = formatInspectPopup(features[0].properties);
    expect(html).toContain('не OSM-геометрия');
    expect(html).toContain('Ладожское озеро');
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
});
