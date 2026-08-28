/**
 * E2.4 — WaterGraph connection model / provenance unit tests.
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
import { buildWaterCorridorEvidence } from '../water-corridor-evidence';
import {
  buildConnectionEvidence,
  canConfirmConnection,
  classifyConnectionEvidence,
  distanceAloneMustNotConfirm,
  fairwayAloneMustNotConfirm,
  getCandidateConnections,
  getConfirmedConnections,
  knowledgeCooccurrenceAloneMustNotConfirm,
  maskAloneMustNotConfirm,
  nameAloneMustNotConfirm,
  INSUFFICIENT_FOR_CONFIRMED,
} from '../water-graph-connection';
import { getRouteFeatureFlags } from '../route-feature-flags';
import type { WaterCorridorEvidence } from '../water-corridor-evidence';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(
    readFileSync(join(here, '../__fixtures__/centerlines', name), 'utf8'),
  );
const expectedDoc = JSON.parse(
  readFileSync(join(here, '../__fixtures__/connections/e24-expected.json'), 'utf8'),
);

function stubCorridor(partial: Partial<WaterCorridorEvidence>): WaterCorridorEvidence {
  return {
    fromComponent: 'comp-0',
    toComponent: 'comp-1',
    relation: 'waterway↔waterway',
    evidenceType: 'unknown',
    evidenceTypes: ['unknown'],
    evidenceSources: [],
    distanceKm: 10,
    waterIds: [],
    names: [],
    confidence: 0.2,
    safetyFlags: [],
    barriers: [],
    locks: [],
    maskEvidence: {
      present: false,
      lakeName: null,
      bothNearMask: false,
      midInMask: false,
      note: null,
    },
    fairwayEvidence: {
      present: false,
      crossesBoundary: false,
      softPreferenceOnly: true,
      note: null,
    },
    physicalConnection: 'unknown',
    navigableConnection: 'none',
    finalDiagnosticClassification: 'UNKNOWN',
    gapContents: [],
    gapEndpoints: { from: { lon: 0, lat: 0 }, to: { lon: 1, lat: 1 } },
    diagnosticOnly: true,
    ...partial,
  };
}

describe('E2.4 connection model', () => {
  it('USE_WATER_GRAPH stays false', () => {
    expect(getRouteFeatureFlags().USE_WATER_GRAPH).toBe(false);
  });

  it('policy: alone signals must NOT confirm', () => {
    expect(distanceAloneMustNotConfirm(0.1)).toBe(false);
    expect(fairwayAloneMustNotConfirm()).toBe(false);
    expect(maskAloneMustNotConfirm()).toBe(false);
    expect(nameAloneMustNotConfirm()).toBe(false);
    expect(knowledgeCooccurrenceAloneMustNotConfirm()).toBe(false);
    expect(INSUFFICIENT_FOR_CONFIRMED).toContain('distance_alone');
  });

  it('canConfirmConnection always denies without explicit sufficient evidence', () => {
    const r = canConfirmConnection({
      navigableLevel: 'STRONG',
      physicalLevel: 'STRONG',
      barrierLevel: 'NONE',
      relationType: 'canal_continuation',
      insufficientSignals: ['distance_alone'],
      evidenceTypes: ['same_water_object', 'data_gap'],
      finalClass: 'DATA_GAP',
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.length).toBeGreaterThan(0);
  });

  it('separate water objects → rejected, no confirmed', () => {
    const ev = stubCorridor({
      waterIds: ['ww:волга', 'ww:ахтуба'],
      names: ['Волга', 'Ахтуба'],
      evidenceTypes: ['possible_separate_waterbody', 'possible_distributary'],
      evidenceType: 'possible_distributary',
      evidenceSources: ['knowledge_co_listed_rivers:info-lower-volga-corridor-e16'],
      physicalConnection: 'suggested',
      navigableConnection: 'none',
      finalDiagnosticClassification: 'SEPARATE_WATER_OBJECT',
      distanceKm: 14.5,
    });
    const c = classifyConnectionEvidence(ev);
    expect(c.relationType).toBe('separate_water_object');
    expect(c.connectionStatus).toBe('rejected');
    expect(c.navigableConnectionEvidence).toBe('NONE');
    expect(c.insufficientSignals).toContain('knowledge_cooccurrence_alone');
    expect(c.diagnosticOnly).toBe(true);
  });

  it('same water object DATA_GAP → strong candidate, not confirmed edge', () => {
    const ev = stubCorridor({
      waterIds: ['ww:беломорско-балтийский канал'],
      names: ['Беломорско-Балтийский канал'],
      evidenceTypes: [
        'same_water_object',
        'named_continuation',
        'canal_continuation',
        'data_gap',
      ],
      evidenceType: 'data_gap',
      evidenceSources: [
        'same_waterId:ww:беломорско-балтийский канал',
        'topology:DATA_GAP',
      ],
      physicalConnection: 'suggested',
      navigableConnection: 'unknown',
      finalDiagnosticClassification: 'DATA_GAP',
      gapContents: ['nothing_known'],
      distanceKm: 19,
    });
    const c = classifyConnectionEvidence(ev);
    expect(c.relationType).toBe('data_gap');
    expect(c.connectionStatus).toBe('candidate');
    expect(c.evidenceLevel).toBe('STRONG');
    expect(c.physicalConnectionEvidence).toBe('STRONG');
    expect(c.navigableConnectionEvidence).toBe('STRONG');
    expect(c.rejectionReasons).toContain('data_gap_missing_geometry_no_safe_edge');
  });

  it('candidate waterway→mask stays candidate; fairway/mask alone not confirmed', () => {
    const ev = stubCorridor({
      relation: 'waterway_to_mask',
      evidenceType: 'river_to_mask_candidate',
      evidenceTypes: ['river_to_mask_candidate'],
      evidenceSources: ['lake:Куйбышевское водохранилище', 'from_fairway_layer'],
      physicalConnection: 'suggested',
      navigableConnection: 'unknown',
      finalDiagnosticClassification: 'PHYSICAL_CONNECTION_ONLY',
      maskEvidence: {
        present: true,
        lakeName: 'Куйбышевское водохранилище',
        bothNearMask: true,
        midInMask: true,
        note: 'near',
      },
      fairwayEvidence: {
        present: true,
        crossesBoundary: false,
        softPreferenceOnly: true,
        note: 'soft',
      },
      distanceKm: 0.3,
      waterIds: ['fairway-0'],
    });
    const c = classifyConnectionEvidence(ev);
    expect(c.relationType).toBe('waterway_to_mask');
    expect(c.connectionStatus).toBe('candidate');
    expect(c.navigableConnectionEvidence).toBe('NONE');
    expect(c.insufficientSignals).toContain('mask_proximity_alone');
    expect(c.insufficientSignals).toContain('fairway_proximity_alone');
  });

  it('provenance preserved from corridor sources', () => {
    const ev = stubCorridor({
      evidenceSources: [
        'same_waterId:ww:x',
        'knowledge:info-belomor-corridor-e16',
        'lake_mask:Test',
        'barrier:dubna-lock-1',
      ],
      evidenceTypes: ['same_water_object'],
      finalDiagnosticClassification: 'DATA_GAP',
      navigableConnection: 'unknown',
      physicalConnection: 'suggested',
    });
    const c = classifyConnectionEvidence(ev);
    const types = c.evidenceSources.map((p) => p.sourceType);
    expect(types).toContain('osm');
    expect(types).toContain('knowledge');
    expect(types).toContain('mask');
    expect(types).toContain('known_barrier');
    expect(c.evidenceSources.every((p) => p.sourceDetail.length > 0)).toBe(true);
  });

  it('VG-mid fixture matches e24 expected (separate, no confirmed)', () => {
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
    const report = buildConnectionEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: ingest.centerlines,
    });
    const exp = expectedDoc.cases['VG-mid'].expected;
    expect(report.confirmedCount).toBe(exp.confirmedCount);
    expect(getConfirmedConnections(report)).toHaveLength(0);
    const primary = report.connections[0]!;
    expect(primary.relationType).toBe(exp.primaryRelationType);
    expect(primary.connectionStatus).toBe(exp.connectionStatus);
    expect(primary.navigableConnectionEvidence).toBe(exp.navigableConnectionEvidence);
    expect(report.policy.confirmedCreatesEdges).toBe(false);
  });

  it('Belomor fixture: DATA_GAP strong candidate, confirmed empty', () => {
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
    const corridor = buildWaterCorridorEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: ingest.centerlines,
    });
    const report = buildConnectionEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: ingest.centerlines,
      corridorReport: corridor,
    });
    const exp = expectedDoc.cases.BELOMOR.expected;
    expect(report.confirmedCount).toBe(0);
    const gap = report.connections.find((c) => c.relationType === 'data_gap');
    expect(gap).toBeTruthy();
    expect(gap!.connectionStatus).toBe(exp.connectionStatus);
    expect(gap!.evidenceLevel).toBe(exp.evidenceLevel);
    expect(getCandidateConnections(report).length).toBeGreaterThan(0);
  });

  it('X3-like empty corridor → no connections / no confirmed', () => {
    const a = { lon: 47.25, lat: 56.15 };
    const b = { lon: 45.9, lat: 56.85 };
    const g = buildWaterGraph({
      a,
      b,
      centerlines: [],
      options: { includeMask: false, includeFairway: false, includeLocks: false },
    });
    const topology = diagnoseWaterGraphTopology(g, { a, b });
    const report = buildConnectionEvidence({
      a,
      b,
      topology,
      graph: g,
      centerlines: [],
    });
    expect(report.confirmedCount).toBe(0);
    // Without fairway/locks, may be empty; with defaults locks may add noise —
    // filter: no confirmed ever
    expect(getConfirmedConnections(report)).toHaveLength(0);
  });
});
