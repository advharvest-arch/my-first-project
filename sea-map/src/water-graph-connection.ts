/**
 * E2.4 — WaterGraph Connection Evidence + Provenance (data model only).
 *
 * Prepares a safe confirmed-vs-candidate API for a future seam stage.
 * NEVER creates edges / seams. NEVER mutates the graph.
 * Distance / fairway / mask / name / knowledge-cooccurrence alone
 * are NEVER sufficient for CONFIRMED_CONNECTION.
 *
 * USE_WATER_GRAPH stays false; production routing unchanged.
 */

import type { LngLat } from './geo';
import type { LakeMask } from './open-lake';
import type { CenterlineSource, WaterGraph } from './water-graph-types';
import type { WaterGraphTopology } from './water-graph-topology';
import {
  buildWaterCorridorEvidence,
  type CorridorEvidenceInput,
  type FinalCorridorClassification,
  type WaterCorridorEvidence,
  type WaterCorridorEvidenceReport,
} from './water-corridor-evidence';

/** Connection relation (diagnostic taxonomy). */
export type ConnectionRelationType =
  | 'same_water_object'
  | 'continuation'
  | 'canal_continuation'
  | 'river_continuation'
  | 'waterway_to_mask'
  | 'mask_to_waterway'
  | 'lock_transition'
  | 'possible_distributary'
  | 'separate_water_object'
  | 'data_gap'
  | 'unknown';

export type ConnectionEvidenceLevel =
  | 'CONFIRMED'
  | 'STRONG'
  | 'WEAK'
  | 'NONE'
  | 'CONTRADICTED';

export type ConnectionStatus = 'confirmed' | 'candidate' | 'rejected';

export type EvidenceSourceType =
  | 'osm'
  | 'mask'
  | 'knowledge'
  | 'known_barrier'
  | 'fairway'
  | 'derived'
  | 'unknown';

export type ConnectionProvenance = {
  sourceType: EvidenceSourceType;
  sourceId: string | null;
  sourceDetail: string;
};

/**
 * Signals that are explicitly insufficient for CONFIRMED_CONNECTION
 * when they appear alone (or only in combination with each other).
 */
export const INSUFFICIENT_FOR_CONFIRMED = [
  'distance_alone',
  'same_name_alone',
  'fairway_proximity_alone',
  'mask_proximity_alone',
  'same_river_tag_alone',
  'geographic_closeness',
  'knowledge_cooccurrence_alone',
] as const;

export type InsufficientSignal = (typeof INSUFFICIENT_FOR_CONFIRMED)[number];

export type WaterGraphConnectionEvidence = {
  fromComponent: string;
  toComponent: string | null;

  relationType: ConnectionRelationType;
  connectionStatus: ConnectionStatus;

  /** Overall evidence level (never CONFIRMED unless status=confirmed). */
  evidenceLevel: ConnectionEvidenceLevel;

  physicalConnectionEvidence: ConnectionEvidenceLevel;
  navigableConnectionEvidence: ConnectionEvidenceLevel;

  evidenceSources: ConnectionProvenance[];
  sourceObjects: string[];

  waterIds: string[];
  names: string[];

  distanceKm: number;

  physicalConnection: 'proven' | 'suggested' | 'none' | 'unknown';
  navigableEvidence: 'proven' | 'suggested' | 'none' | 'unknown';

  barrierEvidence: ConnectionEvidenceLevel;
  lockEvidence: ConnectionEvidenceLevel;
  maskEvidence: ConnectionEvidenceLevel;
  fairwayEvidence: ConnectionEvidenceLevel;

  /** Why this cannot be confirmed (when applicable). */
  insufficientSignals: InsufficientSignal[];
  rejectionReasons: string[];

  confidence: number;
  /** Echo of E2.3 analytic class when mapped from corridor evidence. */
  corridorClassification?: FinalCorridorClassification;

  diagnosticOnly: true;
};

export type WaterGraphConnectionsReport = {
  confirmedCount: number;
  candidateCount: number;
  rejectedCount: number;
  connections: WaterGraphConnectionEvidence[];
  /** Explicit policy note for consumers. */
  policy: {
    distanceAloneConfirms: false;
    fairwayAloneConfirms: false;
    maskAloneConfirms: false;
    nameAloneConfirms: false;
    knowledgeCooccurrenceAloneConfirms: false;
    confirmedCreatesEdges: false;
    diagnosticOnly: true;
  };
  diagnosticOnly: true;
};

export type ConnectionEvidenceInput = CorridorEvidenceInput & {
  /** Optional precomputed E2.3 report (avoids double work). */
  corridorReport?: WaterCorridorEvidenceReport | null;
};

function mapRelationType(ev: WaterCorridorEvidence): ConnectionRelationType {
  const types = new Set(ev.evidenceTypes);
  if (types.has('data_gap') || ev.finalDiagnosticClassification === 'DATA_GAP') {
    return 'data_gap';
  }
  if (types.has('possible_separate_waterbody') || types.has('possible_distributary')) {
    // Prefer separate_water_object when both appear (distributary is a soft tag).
    if (types.has('possible_separate_waterbody')) return 'separate_water_object';
    return 'possible_distributary';
  }
  if (types.has('canal_continuation')) return 'canal_continuation';
  if (types.has('river_continuation')) return 'river_continuation';
  if (types.has('named_continuation') || types.has('connected_waterway_tags')) {
    return 'continuation';
  }
  if (types.has('same_water_object')) return 'same_water_object';
  if (ev.evidenceType === 'river_to_mask_candidate' || types.has('river_to_mask_candidate')) {
    if (ev.relation.includes('mask_to_waterway')) return 'mask_to_waterway';
    return 'waterway_to_mask';
  }
  if (types.has('lock_transition_candidate')) return 'lock_transition';
  if (ev.finalDiagnosticClassification === 'SEPARATE_WATER_OBJECT') {
    return 'separate_water_object';
  }
  return 'unknown';
}

function levelFromPhysical(
  p: WaterCorridorEvidence['physicalConnection'],
): ConnectionEvidenceLevel {
  if (p === 'proven') return 'STRONG';
  if (p === 'suggested') return 'WEAK';
  if (p === 'none') return 'NONE';
  return 'NONE';
}

function levelFromNavigable(
  n: WaterCorridorEvidence['navigableConnection'],
): ConnectionEvidenceLevel {
  if (n === 'proven') return 'CONFIRMED'; // only if later promoted — see classify
  if (n === 'suggested') return 'WEAK';
  if (n === 'none') return 'NONE';
  return 'NONE';
}

function provenanceFromCorridor(ev: WaterCorridorEvidence): ConnectionProvenance[] {
  const out: ConnectionProvenance[] = [];
  for (const s of ev.evidenceSources) {
    if (s.startsWith('knowledge:') || s.startsWith('knowledge_')) {
      out.push({
        sourceType: 'knowledge',
        sourceId: s.replace(/^knowledge(_\w+)?:/, '').split(':').pop() ?? s,
        sourceDetail: s,
      });
    } else if (s.startsWith('lake_mask:') || s.startsWith('lake:') || s.includes('mask')) {
      out.push({
        sourceType: 'mask',
        sourceId: s.includes(':') ? s.split(':').slice(1).join(':') : null,
        sourceDetail: s,
      });
    } else if (s.startsWith('barrier:') || s === 'illegal_barrier_crossing') {
      out.push({
        sourceType: 'known_barrier',
        sourceId: s.startsWith('barrier:') ? s.slice('barrier:'.length) : s,
        sourceDetail: s,
      });
    } else if (s.includes('fairway') || s.startsWith('from_fairway')) {
      out.push({
        sourceType: 'fairway',
        sourceId: null,
        sourceDetail: s,
      });
    } else if (
      s.startsWith('same_waterId:') ||
      s.startsWith('shared_name:') ||
      s.startsWith('osm_feature_ids:') ||
      s.includes('canal_tags') ||
      s.includes('river_tags')
    ) {
      const idMatch = s.match(/osm_feature_ids:([^,]*)/);
      out.push({
        sourceType: 'osm',
        sourceId: idMatch?.[1] ?? (s.includes(':') ? s.split(':').slice(1).join(':') : null),
        sourceDetail: s,
      });
    } else if (s.startsWith('topology:') || s.startsWith('distanceKm:')) {
      out.push({
        sourceType: 'derived',
        sourceId: null,
        sourceDetail: s,
      });
    } else if (s.startsWith('lock_near_gap:') || s.startsWith('distant_locks')) {
      out.push({
        sourceType: s.includes('knowledge') ? 'knowledge' : 'derived',
        sourceId: s.includes(':') ? s.split(':').slice(1).join(':') : null,
        sourceDetail: s,
      });
    } else {
      out.push({
        sourceType: 'unknown',
        sourceId: null,
        sourceDetail: s,
      });
    }
  }
  if (!out.length) {
    out.push({
      sourceType: 'unknown',
      sourceId: null,
      sourceDetail: 'no_provenance',
    });
  }
  return out;
}

function collectInsufficient(ev: WaterCorridorEvidence): InsufficientSignal[] {
  const signals: InsufficientSignal[] = [];
  const types = new Set(ev.evidenceTypes);
  const sources = ev.evidenceSources.join(' ');

  // Always note distance is observed but insufficient alone
  signals.push('distance_alone');
  signals.push('geographic_closeness');

  if (types.has('named_continuation') && !types.has('same_water_object') && !types.has('data_gap')) {
    signals.push('same_name_alone');
  }
  if (ev.fairwayEvidence.present) {
    signals.push('fairway_proximity_alone');
  }
  if (ev.maskEvidence.present && (ev.maskEvidence.bothNearMask || ev.maskEvidence.midInMask)) {
    signals.push('mask_proximity_alone');
  }
  if (
    types.has('connected_waterway_tags') &&
    !types.has('same_water_object') &&
    !types.has('data_gap')
  ) {
    signals.push('same_river_tag_alone');
  }
  if (types.has('possible_distributary') || sources.includes('knowledge_co_listed')) {
    signals.push('knowledge_cooccurrence_alone');
  }

  return [...new Set(signals)];
}

/**
 * Classify one corridor evidence row into connection model status/levels.
 *
 * CONFIRMED requires navigable proof beyond insufficient-alone signals.
 * Current open fixtures do not yield CONFIRMED edges (by design).
 */
export function classifyConnectionEvidence(
  ev: WaterCorridorEvidence,
): WaterGraphConnectionEvidence {
  const relationType = mapRelationType(ev);
  const insufficientSignals = collectInsufficient(ev);
  const evidenceSources = provenanceFromCorridor(ev);
  const sourceObjects = [
    ...ev.waterIds,
    ...ev.names,
    ...(ev.maskEvidence.lakeName ? [`mask:${ev.maskEvidence.lakeName}`] : []),
  ];

  let physicalLevel = levelFromPhysical(ev.physicalConnection);
  let navigableLevel = levelFromNavigable(ev.navigableConnection);
  // Cap navigable: E2.3 "suggested" must not become CONFIRMED here
  if (navigableLevel === 'CONFIRMED' && ev.navigableConnection !== 'proven') {
    navigableLevel = 'WEAK';
  }
  if (ev.navigableConnection === 'proven') {
    // Still require that we are not relying only on insufficient signals —
    // no current fixture sets navigable=proven safely.
    navigableLevel = 'STRONG';
  }

  let barrierLevel: ConnectionEvidenceLevel = ev.barriers.length ? 'STRONG' : 'NONE';
  if (ev.finalDiagnosticClassification === 'BARRIER') barrierLevel = 'CONTRADICTED';

  let lockLevel: ConnectionEvidenceLevel = 'NONE';
  const relatedLocks = ev.locks.filter((l) => l.relevance === 'related_to_gap');
  if (relatedLocks.some((l) => !l.source.startsWith('knowledge:'))) {
    lockLevel = 'WEAK';
  } else if (relatedLocks.length) {
    lockLevel = 'WEAK';
  }

  let maskLevel: ConnectionEvidenceLevel = 'NONE';
  if (ev.maskEvidence.bothNearMask || ev.maskEvidence.midInMask) {
    maskLevel = ev.maskEvidence.present ? 'WEAK' : 'NONE';
  } else if (ev.maskEvidence.present) {
    maskLevel = 'NONE';
  }

  let fairwayLevel: ConnectionEvidenceLevel = 'NONE';
  if (ev.fairwayEvidence.present) {
    fairwayLevel = 'WEAK'; // soft preference only
  }

  // Identity-strong DATA_GAP: physical STRONG (same object), navigable unknown/STRONG identity but no edge
  if (ev.finalDiagnosticClassification === 'DATA_GAP') {
    physicalLevel = 'STRONG';
    navigableLevel = 'STRONG'; // strong *identity* for same navigable canal — still not a fillable edge
  }

  if (ev.finalDiagnosticClassification === 'SEPARATE_WATER_OBJECT') {
    physicalLevel = ev.evidenceTypes.includes('possible_distributary') ? 'WEAK' : 'NONE';
    navigableLevel = 'NONE';
  }

  if (ev.finalDiagnosticClassification === 'PHYSICAL_CONNECTION_ONLY') {
    physicalLevel = maskLevel !== 'NONE' ? 'WEAK' : 'WEAK';
    navigableLevel = 'NONE';
  }

  if (ev.finalDiagnosticClassification === 'NO_EVIDENCE') {
    physicalLevel = 'NONE';
    navigableLevel = 'NONE';
  }

  if (
    barrierLevel === 'CONTRADICTED' ||
    (barrierLevel === 'STRONG' && ev.barriers.length > 0)
  ) {
    navigableLevel = 'CONTRADICTED';
  }

  const rejectionReasons: string[] = [];
  let connectionStatus: ConnectionStatus = 'candidate';
  let evidenceLevel: ConnectionEvidenceLevel = 'WEAK';

  // --- CONFIRMED gate (intentionally strict; empty for current fixtures) ---
  const canConfirm = canConfirmConnection({
    navigableLevel,
    physicalLevel,
    barrierLevel,
    relationType,
    insufficientSignals,
    evidenceTypes: ev.evidenceTypes,
    finalClass: ev.finalDiagnosticClassification,
  });

  if (canConfirm.ok) {
    connectionStatus = 'confirmed';
    evidenceLevel = 'CONFIRMED';
    navigableLevel = 'CONFIRMED';
  } else {
    rejectionReasons.push(...canConfirm.reasons);
    if (
      ev.finalDiagnosticClassification === 'SEPARATE_WATER_OBJECT' ||
      ev.finalDiagnosticClassification === 'NO_EVIDENCE' ||
      navigableLevel === 'CONTRADICTED' ||
      barrierLevel === 'CONTRADICTED'
    ) {
      connectionStatus = 'rejected';
      evidenceLevel =
        navigableLevel === 'CONTRADICTED' || barrierLevel === 'CONTRADICTED'
          ? 'CONTRADICTED'
          : navigableLevel === 'NONE' && physicalLevel === 'NONE'
            ? 'NONE'
            : 'WEAK';
    } else if (ev.finalDiagnosticClassification === 'DATA_GAP') {
      // Strong identity candidate — awaiting geometry ingest, not a seam
      connectionStatus = 'candidate';
      evidenceLevel = 'STRONG';
      rejectionReasons.push('data_gap_missing_geometry_no_safe_edge');
    } else {
      connectionStatus = 'candidate';
      evidenceLevel =
        physicalLevel === 'STRONG' || navigableLevel === 'STRONG' ? 'STRONG' : 'WEAK';
    }
  }

  return {
    fromComponent: ev.fromComponent,
    toComponent: ev.toComponent,
    relationType,
    connectionStatus,
    evidenceLevel,
    physicalConnectionEvidence: physicalLevel,
    navigableConnectionEvidence: navigableLevel,
    evidenceSources,
    sourceObjects: [...new Set(sourceObjects)],
    waterIds: ev.waterIds.slice(),
    names: ev.names.slice(),
    distanceKm: ev.distanceKm,
    physicalConnection: ev.physicalConnection,
    navigableEvidence: ev.navigableConnection,
    barrierEvidence: barrierLevel,
    lockEvidence: lockLevel,
    maskEvidence: maskLevel,
    fairwayEvidence: fairwayLevel,
    insufficientSignals,
    rejectionReasons,
    confidence: ev.confidence,
    corridorClassification: ev.finalDiagnosticClassification,
    diagnosticOnly: true,
  };
}

/**
 * Strict gate for CONFIRMED_CONNECTION.
 * Returns ok=false for all current AquaRoute fixtures (safe default).
 */
export function canConfirmConnection(input: {
  navigableLevel: ConnectionEvidenceLevel;
  physicalLevel: ConnectionEvidenceLevel;
  barrierLevel: ConnectionEvidenceLevel;
  relationType: ConnectionRelationType;
  insufficientSignals: InsufficientSignal[];
  evidenceTypes: string[];
  finalClass: FinalCorridorClassification;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (input.barrierLevel === 'CONTRADICTED' || input.barrierLevel === 'STRONG') {
    reasons.push('barrier_blocks_confirmed');
  }
  if (input.finalClass === 'SEPARATE_WATER_OBJECT') {
    reasons.push('separate_water_object');
  }
  if (input.finalClass === 'DATA_GAP') {
    reasons.push('data_gap_no_geometry_to_connect');
  }
  if (input.finalClass === 'NO_EVIDENCE' || input.finalClass === 'UNKNOWN') {
    reasons.push('insufficient_corridor_class');
  }
  if (input.finalClass === 'PHYSICAL_CONNECTION_ONLY') {
    reasons.push('physical_only_not_navigable');
  }
  if (input.relationType === 'waterway_to_mask' || input.relationType === 'mask_to_waterway') {
    reasons.push('mask_transition_not_confirmed');
  }
  if (input.relationType === 'possible_distributary') {
    reasons.push('distributary_not_navigable_proof');
  }
  if (input.navigableLevel === 'NONE' || input.navigableLevel === 'CONTRADICTED') {
    reasons.push('navigable_evidence_none');
  }
  // Alone-signal policy: if we only have insufficient signals as support, reject
  reasons.push('confirmed_requires_explicit_sufficient_evidence');
  reasons.push('distance_fairway_mask_name_knowledge_alone_forbidden');

  // Never ok until a future stage supplies explicit sufficient evidence flags
  return { ok: false, reasons: [...new Set(reasons)] };
}

/** Pure helpers documenting alone-signal policy (for tests / docs). */
export function distanceAloneMustNotConfirm(_distanceKm: number): boolean {
  return false;
}

export function fairwayAloneMustNotConfirm(): boolean {
  return false;
}

export function maskAloneMustNotConfirm(): boolean {
  return false;
}

export function knowledgeCooccurrenceAloneMustNotConfirm(): boolean {
  return false;
}

export function nameAloneMustNotConfirm(): boolean {
  return false;
}

/**
 * Build full connection evidence report from corridor/topology inputs.
 */
export function buildConnectionEvidence(
  input: ConnectionEvidenceInput,
): WaterGraphConnectionsReport {
  const corridor =
    input.corridorReport ??
    buildWaterCorridorEvidence({
      a: input.a,
      b: input.b,
      topology: input.topology,
      graph: input.graph,
      centerlines: input.centerlines,
      lake: input.lake,
    });

  const connections = corridor.candidates.map(classifyConnectionEvidence);
  return summarizeConnections(connections);
}

export function summarizeConnections(
  connections: WaterGraphConnectionEvidence[],
): WaterGraphConnectionsReport {
  return {
    confirmedCount: connections.filter((c) => c.connectionStatus === 'confirmed').length,
    candidateCount: connections.filter((c) => c.connectionStatus === 'candidate').length,
    rejectedCount: connections.filter((c) => c.connectionStatus === 'rejected').length,
    connections,
    policy: {
      distanceAloneConfirms: false,
      fairwayAloneConfirms: false,
      maskAloneConfirms: false,
      nameAloneConfirms: false,
      knowledgeCooccurrenceAloneConfirms: false,
      confirmedCreatesEdges: false,
      diagnosticOnly: true,
    },
    diagnosticOnly: true,
  };
}

/** Connections safe enough for a future seam stage (currently usually empty). */
export function getConfirmedConnections(
  report: WaterGraphConnectionsReport,
): WaterGraphConnectionEvidence[] {
  return report.connections.filter((c) => c.connectionStatus === 'confirmed');
}

/** Diagnostic candidates only — never fed to Dijkstra / edge creation. */
export function getCandidateConnections(
  report: WaterGraphConnectionsReport,
): WaterGraphConnectionEvidence[] {
  return report.connections.filter((c) => c.connectionStatus === 'candidate');
}

export function getRejectedConnections(
  report: WaterGraphConnectionsReport,
): WaterGraphConnectionEvidence[] {
  return report.connections.filter((c) => c.connectionStatus === 'rejected');
}

/** Convenience: topology + centerlines + lake → connections report. */
export function buildConnectionEvidenceFromParts(input: {
  a: LngLat;
  b: LngLat;
  topology: WaterGraphTopology;
  graph?: WaterGraph | null;
  centerlines?: CenterlineSource[];
  lake?: LakeMask | null;
}): WaterGraphConnectionsReport {
  return buildConnectionEvidence(input);
}
