/**
 * E2.3 — Water corridor evidence unit tests (diagnostic only).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  geojsonToCenterlineFeatures,
  ingestCenterlineFeaturesSync,
} from '../water-graph-ingest';
import { buildWaterGraph } from '../water-graph';
import { diagnoseWaterGraphTopology } from '../water-graph-topology';
import {
  buildWaterCorridorEvidence,
  classifySameWaterDataGap,
  classifySeparateWaterbodies,
  lockRelevanceLabel,
} from '../water-corridor-evidence';
import { getRouteFeatureFlags } from '../route-feature-flags';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(here, '../__fixtures__/centerlines', name), 'utf8'),
  );

describe('E2.3 water corridor evidence', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('same water object + empty gap → DATA_GAP classifier', () => {
    expect(
      classifySameWaterDataGap({
        sameWaterId: true,
        gapContentsNothingKnown: true,
        barrier: false,
      }),
    ).toBe('DATA_GAP');
  });

  it('separate water objects stay SEPARATE (no navigable upgrade)', () => {
    const r = classifySeparateWaterbodies({
      waterIdA: 'ww:волга',
      waterIdB: 'ww:ахтуба',
      knowledgeCoListed: true,
    });
    expect(r.classification).toBe('SEPARATE_WATER_OBJECT');
    expect(r.navigableConnection).toBe('none');
    expect(r.evidenceTypes).toContain('possible_distributary');
  });

  it('unrelated lock distance → distant_unrelated', () => {
    expect(lockRelevanceLabel(900)).toBe('distant_unrelated');
    expect(lockRelevanceLabel(10)).toBe('related_to_gap');
  });

  it('VG-mid: Volga↔Akhtuba is SEPARATE_WATER_OBJECT, not navigable', () => {
    const a = { lon: 45.9, lat: 47.75 };
    const b = { lon: 46.95, lat: 47.0 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('lower-volga-mid.geojson')),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topology = diagnoseWaterGraphTopology(g, { a, b });
    const report = buildWaterCorridorEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: ingest.centerlines,
    });
    expect(report.diagnosticOnly).toBe(true);
    const pair = report.candidates.find(
      (c) =>
        c.waterIds.some((w) => w.includes('волга')) &&
        c.waterIds.some((w) => w.includes('ахтуба')),
    );
    expect(pair).toBeTruthy();
    expect(pair!.finalDiagnosticClassification).toBe('SEPARATE_WATER_OBJECT');
    expect(pair!.navigableConnection).toBe('none');
    expect(pair!.evidenceTypes).toContain('possible_separate_waterbody');
    expect(pair!.safetyFlags).toContain('distance_not_connection_proof');
    // Dubna/Rybinsk must not be related_to_gap for Lower Volga
    expect(
      pair!.locks.every(
        (l) =>
          l.relevance === 'distant_unrelated' ||
          !l.source.includes('DUBNA') && !l.source.includes('RYBINSK')
            ? true
            : l.relevance === 'distant_unrelated',
      ),
    ).toBe(true);
    expect(
      pair!.locks
        .filter((l) => l.source.includes('DUBNA') || l.source.includes('RYBINSK'))
        .every((l) => l.relevance === 'distant_unrelated'),
    ).toBe(true);
  });

  it('Belomor: DATA_GAP with same canal water object evidence', () => {
    const a = { lon: 34.82, lat: 62.86 };
    const b = { lon: 34.77, lat: 64.52 };
    const ingest = ingestCenterlineFeaturesSync(
      a,
      b,
      geojsonToCenterlineFeatures(fixture('belomor.geojson')),
    );
    const g = buildWaterGraph({
      a,
      b,
      centerlines: ingest.centerlines,
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topology = diagnoseWaterGraphTopology(g, { a, b });
    const report = buildWaterCorridorEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: ingest.centerlines,
    });
    const gap = report.candidates.find(
      (c) => c.finalDiagnosticClassification === 'DATA_GAP',
    );
    expect(gap).toBeTruthy();
    expect(gap!.evidenceTypes).toContain('same_water_object');
    expect(gap!.evidenceTypes).toContain('data_gap');
    expect(gap!.evidenceTypes).toContain('canal_continuation');
    expect(gap!.navigableConnection).toBe('unknown');
  });

  it('no evidence path when empty topology gaps', () => {
    const a = { lon: 40, lat: 55 };
    const b = { lon: 40.05, lat: 55 };
    const g = buildWaterGraph({
      a,
      b,
      centerlines: [
        {
          id: 'one',
          kind: 'waterway',
          coords: [a, b],
          name: 'Solo',
          waterId: 'ww:solo',
        },
      ],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topology = diagnoseWaterGraphTopology(g, { a, b });
    const report = buildWaterCorridorEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: [],
    });
    // Single component → no pairwise candidates
    expect(report.candidateCount).toBe(0);
    expect(report.noEvidenceCount).toBe(0);
  });

  it('waterway→mask candidate stays physical-only (not navigable proof)', () => {
    const a = { lon: 48.9, lat: 54.7 };
    const b = { lon: 49.1, lat: 54.35 };
    // Minimal synthetic: fairway-like centerline near points; no real lake needed for type shape
    const g = buildWaterGraph({
      a,
      b,
      centerlines: [
        {
          id: 'fw',
          kind: 'fairway',
          coords: [
            { lon: 48.9, lat: 54.7 },
            { lon: 49.0, lat: 54.5 },
            { lon: 49.1, lat: 54.35 },
          ],
          name: null,
          waterId: 'fairway-test',
          source: 'REGIONAL_FAIRWAYS',
        },
      ],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topology = diagnoseWaterGraphTopology(g, { a, b });
    // Inject a synthetic mask candidate
    topology.waterwayMaskCandidates.push({
      fromComponent: 'comp-0',
      toComponent: null,
      toLayer: 'mask',
      distanceKm: 0.3,
      candidateType: 'waterway_to_mask',
      safetyFlags: ['from_fairway'],
      confidence: 0.4,
      fromNodeId: [...g.nodes.keys()][0]!,
      toNodeId: null,
      diagnosticOnly: true,
    });
    const report = buildWaterCorridorEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: [],
      lake: null,
    });
    const maskCand = report.candidates.find(
      (c) => c.evidenceType === 'river_to_mask_candidate',
    );
    expect(maskCand).toBeTruthy();
    // Without lake → NO_EVIDENCE for mask transition
    expect(maskCand!.finalDiagnosticClassification).toBe('NO_EVIDENCE');
    expect(maskCand!.navigableConnection).toBe('none');
  });
});
