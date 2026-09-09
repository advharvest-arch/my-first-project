import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  countSeligerDebugContours,
  formatSeligerDebugPopup,
  seligerDebugEnabledFromSearchParams,
  type SeligerDebugCollection,
  type SeligerDebugProps,
} from '../seliger-debug';

const here = dirname(fileURLToPath(import.meta.url));
const DEBUG_GEOJSON = resolve(here, '../../public/seliger-399081-debug.geojson');

describe('seligerDebug overlay (OSM 399081 diagnostic)', () => {
  it('enables only on ?seligerDebug=1', () => {
    expect(seligerDebugEnabledFromSearchParams('?seligerDebug=1')).toBe(true);
    expect(seligerDebugEnabledFromSearchParams('seligerDebug=1')).toBe(true);
    expect(seligerDebugEnabledFromSearchParams('?seligerDebug=true')).toBe(false);
    expect(seligerDebugEnabledFromSearchParams('?wrgDemo=1')).toBe(false);
    expect(seligerDebugEnabledFromSearchParams('')).toBe(false);
  });

  it('counts 2 outer + 137 inner without merging extra objects', () => {
    const fc: SeligerDebugCollection = {
      type: 'FeatureCollection',
      properties: { outerCount: 2, innerCount: 137, polonovkaIncluded: false },
      features: [
        {
          type: 'Feature',
          properties: {
            label: 'SOUTH-OUTER',
            part: 'south',
            role: 'outer',
            kind: 'water-area',
            wayIds: [1],
          },
          geometry: { type: 'Polygon', coordinates: [] },
        },
        {
          type: 'Feature',
          properties: {
            label: 'NORTH-OUTER',
            part: 'north',
            role: 'outer',
            kind: 'water-area',
            wayIds: [2],
          },
          geometry: { type: 'Polygon', coordinates: [] },
        },
        {
          type: 'Feature',
          properties: {
            label: 'SOUTH-OUTER',
            part: 'south',
            role: 'outer',
            kind: 'contour',
            wayIds: [1],
          },
          geometry: { type: 'LineString', coordinates: [] },
        },
        {
          type: 'Feature',
          properties: {
            label: 'NORTH-OUTER',
            part: 'north',
            role: 'outer',
            kind: 'contour',
            wayIds: [2],
          },
          geometry: { type: 'LineString', coordinates: [] },
        },
        ...Array.from({ length: 137 }, (_, i) => ({
          type: 'Feature' as const,
          properties: {
            label: i < 93 ? `SOUTH-INNER-${String(i + 1).padStart(3, '0')}` : `NORTH-INNER-${String(i - 92).padStart(3, '0')}`,
            part: (i < 93 ? 'south' : 'north') as 'south' | 'north',
            role: 'inner' as const,
            kind: 'contour' as const,
            wayIds: [1000 + i],
          },
          geometry: { type: 'LineString' as const, coordinates: [] },
        })),
      ],
    };
    expect(countSeligerDebugContours(fc)).toEqual({
      waterAreas: 2,
      outerContours: 2,
      innerContours: 137,
    });
  });

  it('popup lists contour number, OSM way ids, role, name and tags', () => {
    const props: SeligerDebugProps = {
      label: 'SOUTH-INNER-016',
      part: 'south',
      role: 'inner',
      kind: 'contour',
      wayIds: [31057309],
      wayCount: 1,
      name: 'остров Фомичев',
      ways: [
        {
          wayId: 31057309,
          tags: { name: 'остров Фомичев', place: 'islet' },
        },
      ],
    };
    const html = formatSeligerDebugPopup(props);
    expect(html).toContain('SOUTH-INNER-016');
    expect(html).toContain('way/31057309');
    expect(html).toContain('inner');
    expect(html).toContain('остров Фомичев');
    expect(html).toContain('place=islet');
  });

  it('bundled diagnostic geojson is 2 outer / 137 inner without Polonovka', () => {
    const fc = JSON.parse(readFileSync(DEBUG_GEOJSON, 'utf8')) as SeligerDebugCollection;
    expect(fc.properties?.polonovkaIncluded).toBe(false);
    expect(fc.properties?.outerCount).toBe(2);
    expect(fc.properties?.innerCount).toBe(137);
    expect(fc.properties?.southInnerCount).toBe(93);
    expect(fc.properties?.northInnerCount).toBe(44);
    const counts = countSeligerDebugContours(fc);
    expect(counts).toEqual({
      waterAreas: 2,
      outerContours: 2,
      innerContours: 137,
    });
    const labels = fc.features
      .filter((f) => f.properties.kind === 'contour')
      .map((f) => f.properties.label);
    expect(labels).toContain('SOUTH-OUTER');
    expect(labels).toContain('NORTH-OUTER');
    expect(labels).toContain('SOUTH-INNER-001');
    expect(labels).toContain('SOUTH-INNER-093');
    expect(labels).toContain('NORTH-INNER-001');
    expect(labels).toContain('NORTH-INNER-044');
    const fomichev = fc.features.find((f) => f.properties.label === 'SOUTH-INNER-016');
    expect(fomichev?.properties.wayIds).toEqual([31057309]);
    expect(fomichev?.properties.name).toBe('остров Фомичев');
  });
});
