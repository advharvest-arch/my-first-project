import { describe, expect, it } from 'vitest';
import {
  classifyInspectLayer,
  formatInspectPopup,
  parseOverpassToInspectFeatures,
  russiaWaterTopologyDebugEnabledFromSearchParams,
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

  it('rejects oversized viewport fetches', () => {
    expect(spanTooWide(48, 27, 66, 55)).toBe(true);
    expect(spanTooWide(57.0, 32.8, 57.6, 33.4)).toBe(false);
  });
});
