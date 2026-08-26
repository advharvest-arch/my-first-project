/**
 * Offline safety checks for open-water display straighten (no BRouter / network).
 */
import { describe, expect, it } from 'vitest';
import {
  chooseSafeDisplayGeometry,
  isSafeDisplayVsRouting,
  maxPathDeviationKm,
  type LakeMask,
} from '../open-lake';
import type { LngLat } from '../geo';

/** Axis-aligned lake polygon (lon/lat degrees). */
function rectLake(
  name: string,
  west: number,
  south: number,
  east: number,
  north: number,
): LakeMask {
  const outer: Array<[number, number]> = [
    [west, south],
    [east, south],
    [east, north],
    [west, north],
    [west, south],
  ];
  const bbox: [number, number, number, number] = [west, south, east, north];
  return {
    name,
    osmId: 1,
    outer,
    outerBBox: bbox,
    holes: [],
    bbox,
  };
}

const p = (lon: number, lat: number): LngLat => ({ lon, lat });

describe('open-water display safety', () => {
  const lake = rectLake('Test Reservoir', 38.0, 57.8, 39.0, 58.4);

  it('A: large landward chord vs routing → keep routing as display', () => {
    // Shore-hugging routing along south edge of the lake.
    const routing = [p(38.2, 57.85), p(38.4, 57.86), p(38.6, 57.85), p(38.8, 57.86)];
    // Display invents a north bulge that leaves the lake (lat 58.5 > north 58.4).
    const badDisplay = [p(38.2, 57.85), p(38.5, 58.55), p(38.8, 57.86)];
    expect(maxPathDeviationKm(routing, badDisplay)).toBeGreaterThan(3);
    expect(isSafeDisplayVsRouting(routing, badDisplay, lake)).toBe(false);
    const chosen = chooseSafeDisplayGeometry(routing, badDisplay, lake);
    expect(chosen).toEqual(routing);
  });

  it('B: open-water shortcut with moderate/far but on-water samples → allow', () => {
    const routing = [
      p(38.2, 57.9),
      p(38.35, 57.92),
      p(38.5, 57.91),
      p(38.65, 57.93),
      p(38.8, 57.92),
    ];
    // Straight chord across open water inside the mask (north of shore routing).
    const goodDisplay = [p(38.2, 57.9), p(38.5, 58.15), p(38.8, 57.92)];
    expect(maxPathDeviationKm(routing, goodDisplay)).toBeGreaterThan(3);
    expect(isSafeDisplayVsRouting(routing, goodDisplay, lake)).toBe(true);
    expect(chooseSafeDisplayGeometry(routing, goodDisplay, lake)).toEqual(goodDisplay);
  });

  it('C: chooseSafeDisplayGeometry never mutates routing array identity on fallback', () => {
    const routing = [p(38.2, 57.85), p(38.8, 57.86)];
    const bad = [p(38.2, 57.85), p(38.5, 59.0), p(38.8, 57.86)];
    const chosen = chooseSafeDisplayGeometry(routing, bad, lake);
    expect(chosen).toBe(routing);
  });

  it('D: Myshkin-like bulge (far north of shore track) rejected without needing place names', () => {
    // Approximate diagnosis: routing maxLat ~58.17, bad display ~58.26 outside/at edge.
    const routing = [
      p(38.45, 57.78),
      p(38.40, 58.05),
      p(38.45, 58.17),
      p(38.65, 58.13),
      p(38.85, 58.05),
    ];
    const badDisplay = [
      p(38.45, 57.78),
      p(38.60, 58.26),
      p(38.85, 58.05),
    ];
    // Use a mask that covers routing but NOT the landward bulge.
    const tightLake = rectLake('Rybinsk-like', 38.2, 57.7, 39.0, 58.20);
    expect(isSafeDisplayVsRouting(routing, badDisplay, tightLake)).toBe(false);
    expect(chooseSafeDisplayGeometry(routing, badDisplay, tightLake)).toBe(routing);
  });

  it('E: long open-water chord (Cherepovets-like) stays accepted when on water', () => {
    const big = rectLake('Big open', 37.5, 58.0, 39.0, 59.2);
    const routing = [
      p(38.85, 58.05),
      p(38.6, 58.25),
      p(38.4, 58.5),
      p(38.2, 58.8),
      p(37.95, 59.05),
    ];
    const display = [p(38.85, 58.05), p(38.4, 58.55), p(37.95, 59.05)];
    expect(isSafeDisplayVsRouting(routing, display, big)).toBe(true);
    expect(chooseSafeDisplayGeometry(routing, display, big)).toEqual(display);
  });

  it('large deviation without lake mask is rejected', () => {
    const routing = [p(38.2, 57.9), p(38.8, 57.9)];
    const display = [p(38.2, 57.9), p(38.5, 58.2), p(38.8, 57.9)];
    expect(isSafeDisplayVsRouting(routing, display, null)).toBe(false);
    expect(chooseSafeDisplayGeometry(routing, display, null)).toBe(routing);
  });

  it('small deviation is always accepted even without a mask', () => {
    const routing = [p(38.2, 57.9), p(38.5, 57.91), p(38.8, 57.9)];
    const display = [p(38.2, 57.9), p(38.5, 57.915), p(38.8, 57.9)];
    expect(maxPathDeviationKm(routing, display)).toBeLessThan(3);
    expect(isSafeDisplayVsRouting(routing, display, null)).toBe(true);
  });
});
