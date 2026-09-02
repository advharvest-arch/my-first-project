/**
 * E1 — full / partial lake mask cache + completeness sanity.
 */
import { describe, expect, it } from 'vitest';
import {
  MASK_COMPLETE_BBOX_AREA_RATIO,
  MASK_COMPLETE_INTERSECT_AREA_RATIO,
  MASK_COMPLETE_LAT_COVERAGE,
  MASK_COMPLETE_LON_COVERAGE,
  assessMaskCompleteness,
  isLakeMaskComplete,
  pointInOpenWater,
  routeAcrossOpenLake,
  type LakeMask,
} from '../open-lake';
import lakeMaskCache from '../lake-mask-cache.json';
import waterBodies from '../water-bodies.json';

type BBox = [number, number, number, number];

const catalogBBox = (name: string): BBox => {
  const body = (waterBodies as Array<{ n: string; b: BBox }>).find((b) => b.n === name);
  if (!body) throw new Error(name);
  return body.b;
};

describe('E1 mask completeness sanity', () => {
  it('exports coverage thresholds', () => {
    expect(MASK_COMPLETE_LON_COVERAGE).toBe(0.55);
    expect(MASK_COMPLETE_LAT_COVERAGE).toBe(0.55);
    expect(MASK_COMPLETE_BBOX_AREA_RATIO).toBe(0.3);
    expect(MASK_COMPLETE_INTERSECT_AREA_RATIO).toBe(0.25);
  });

  it('rejects tip-only Kuibyshev Nominatim bbox vs catalog', () => {
    const catalog = catalogBBox('Куйбышевское водохранилище');
    // Historical tip fragment R116060
    const tip: BBox = [47.9776, 55.8528, 48.3175, 55.9597];
    const m = assessMaskCompleteness(tip, catalog);
    expect(m.complete).toBe(false);
    expect(m.lonCoverage).toBeLessThan(0.2);
    expect(m.latCoverage).toBeLessThan(0.1);
  });

  it('rejects tip-only Cheboksary Nominatim bbox vs catalog', () => {
    const catalog = catalogBBox('Чебоксарское водохранилище');
    const tip: BBox = [46.8208, 56.1169, 47.4675, 56.2283];
    const m = assessMaskCompleteness(tip, catalog);
    expect(m.complete).toBe(false);
  });

  it('accepts Rybinsk-scale bbox vs catalog', () => {
    const catalog = catalogBBox('Рыбинское водохранилище');
    // Approx full Nominatim span
    const full: BBox = [37.12, 58.08, 39.01, 59.13];
    const m = assessMaskCompleteness(full, catalog);
    expect(m.complete).toBe(true);
  });
});

describe('E1 bundled lake-mask-cache', () => {
  it('bundles Kuibyshev as complete fragment union', () => {
    const entry = lakeMaskCache.masks['куйбышевское водохранилище'];
    expect(entry).toBeTruthy();
    expect(entry.complete).toBe(true);
    expect(entry.polygons.length).toBeGreaterThanOrEqual(5);
    expect(entry.osmIds).toContain(116061);
    expect(entry.osmIds).toContain(2101875);
    const m = assessMaskCompleteness(entry.bbox as BBox, entry.catalogBBox as BBox);
    expect(m.complete).toBe(true);
    // Mid-pool L2 / N06 corridor must sit inside union bbox
    expect(entry.bbox[0]).toBeLessThan(49.0);
    expect(entry.bbox[2]).toBeGreaterThan(49.3);
    expect(entry.bbox[1]).toBeLessThan(54.0);
    expect(entry.bbox[3]).toBeGreaterThan(55.5);
  });

  it('bundles Cheboksary as incomplete partial (eastern fragments only)', () => {
    const entry = lakeMaskCache.masks['чебоксарское водохранилище'];
    expect(entry).toBeTruthy();
    expect(entry.complete).toBe(false);
    expect(entry.polygons.length).toBeGreaterThanOrEqual(2);
    const m = assessMaskCompleteness(entry.bbox as BBox, entry.catalogBBox as BBox);
    expect(m.complete).toBe(false);
  });

  it('does not ship tip-sized Kuibyshev as the only polygon', () => {
    const entry = lakeMaskCache.masks['куйбышевское водохранилище'];
    const spanLon = entry.bbox[2] - entry.bbox[0];
    const spanLat = entry.bbox[3] - entry.bbox[1];
    expect(spanLon).toBeGreaterThan(2);
    expect(spanLat).toBeGreaterThan(2);
  });
});

describe('E1 routeAcrossOpenLake complete gate', () => {
  it('Phase A succeeds on Kuibyshev mid-pool (bundled complete mask)', async () => {
    // L2-like mid-pool — both clicks on open water inside fragment union
    const a = { lon: 49.1, lat: 55.4 };
    const b = { lon: 49.2, lat: 55.1 };
    const open = await routeAcrossOpenLake([a, b]);
    expect(open).not.toBeNull();
    expect(open!.waterName).toMatch(/Куйбышев/i);
    expect(open!.lengthKm).toBeGreaterThan(10);
    expect(open!.points.length).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('Phase A does not verify incomplete Cheboksary western stem (X3 A outside partial)', async () => {
    const a = { lon: 46.2, lat: 56.55 };
    const b = { lon: 46.5, lat: 56.35 };
    const open = await routeAcrossOpenLake([a, b]);
    // Incomplete mask → no openWaterVerified Phase A
    expect(open).toBeNull();
  }, 10000);

  it('isLakeMaskComplete mirrors complete flag', () => {
    const fake: LakeMask = {
      name: 't',
      osmId: 1,
      outer: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
      outerBBox: [0, 0, 1, 1],
      holes: [],
      bbox: [0, 0, 1, 1],
      complete: false,
    };
    expect(isLakeMaskComplete(fake)).toBe(false);
    expect(isLakeMaskComplete({ ...fake, complete: true })).toBe(true);
    expect(isLakeMaskComplete(null)).toBe(false);
  });

  it('tip-sized Nominatim bbox still fails completeness (N06 cannot Phase-A via tip)', () => {
    const catalog = catalogBBox('Куйбышевское водохранилище');
    const tip: BBox = [47.9776, 55.8528, 48.3175, 55.9597];
    expect(assessMaskCompleteness(tip, catalog).complete).toBe(false);
  });
});

describe('E1 multipolygon point-in-water', () => {
  it('pointInOpenWater accepts any outer ring of a multi-outer mask', () => {
    const lake: LakeMask = {
      name: 'multi',
      osmId: 1,
      outer: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
        [0, 0],
      ],
      outerBBox: [0, 0, 1, 1],
      outers: [
        {
          ring: [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
            [0, 0],
          ],
          bbox: [0, 0, 1, 1],
        },
        {
          ring: [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 11],
            [10, 10],
          ],
          bbox: [10, 10, 11, 11],
        },
      ],
      holes: [],
      bbox: [0, 0, 11, 11],
      complete: true,
    };
    expect(pointInOpenWater({ lon: 0.5, lat: 0.5 }, lake)).toBe(true);
    expect(pointInOpenWater({ lon: 10.5, lat: 10.5 }, lake)).toBe(true);
    expect(pointInOpenWater({ lon: 5, lat: 5 }, lake)).toBe(false);
  });
});
