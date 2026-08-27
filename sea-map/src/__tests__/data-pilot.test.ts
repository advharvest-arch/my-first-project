/**
 * E2 DATA_PILOT — research adapter tests (no production routing).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  PILOT_REQUIRED_CLASSES,
  S57_TO_AQUAROUTE,
  coverageReport,
  draftAiLearningSignal,
  parseS57Collection,
  proofSummary,
  toWaterGraph,
} from '../../research/data-pilot/index.ts';

const fixture = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../research/data-pilot/fixtures/synthetic-volga-pilot.json'),
    'utf8',
  ),
);

describe('DATA_PILOT S-57 → WaterGraph (research)', () => {
  it('maps required pilot classes from synthetic fixture', () => {
    const collection = parseS57Collection(fixture);
    const coverage = coverageReport(collection);
    expect(coverage.missingRequired).toEqual([]);
    for (const c of PILOT_REQUIRED_CLASSES) {
      expect(coverage.counts[c]).toBeGreaterThan(0);
    }

    const graph = toWaterGraph(collection);
    expect(graph.edges.some((e) => e.kind === 'official_axis')).toBe(true);
    expect(graph.edges.some((e) => e.kind === 'preferred_fairway')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'lock')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'dam')).toBe(true);
    expect(graph.nodes.some((n) => n.kind === 'hazard')).toBe(true);
    expect(graph.zones.some((z) => z.kind === 'depth_area')).toBe(true);
    expect(graph.provenance.folioIds).toEqual(['8R4001', '8R5001', '8R5002', '8R4002']);
    expect(proofSummary(graph)).toContain('DATA_PILOT adapter');
  });

  it('exposes static S-57 → AquaRoute mapping for RECTRC/FAIRWY/…', () => {
    expect(S57_TO_AQUAROUTE.RECTRC.aquaRoute).toMatch(/судового хода/);
    expect(S57_TO_AQUAROUTE.GATCON.waterGraph).toContain('lock');
    expect(S57_TO_AQUAROUTE.DAMCON.priority).toBe('pilot');
  });

  it('drafts AI learning signal without touching RouteTrace', () => {
    const graph = toWaterGraph(parseS57Collection(fixture));
    const signal = draftAiLearningSignal(
      graph,
      [
        { lon: 39, lat: 57.8 },
        { lon: 43.9, lat: 56.3 },
      ],
      0.2,
    );
    expect(signal.learningHint).toBeTruthy();
    expect(signal.officialFairwaySample?.length).toBeGreaterThan(1);
  });
});
