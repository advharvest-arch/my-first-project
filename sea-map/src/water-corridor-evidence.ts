/**
 * E2.3 — Water Corridor Evidence (diagnostic only).
 *
 * Answers: do existing open data sources give evidence that two WaterGraph
 * components belong to one *navigable* water corridor?
 *
 * NEVER creates seams / edges. Distance alone is NEVER connection proof.
 * USE_WATER_GRAPH stays false; production routing unchanged.
 */

import { haversineKm, type LngLat } from './geo';
import type { LakeMask } from './open-lake';
import { nearestOpenWater, pointInOpenWater } from './open-lake';
import {
  DUBNA_LOCK,
  DUBNA_LOCK_LOWER,
  DUBNA_LOCK_UPPER,
  KNOWN_BARRIERS,
  RYBINSK_LOCK,
  RYBINSK_LOCK_11,
  RYBINSK_LOCK_12,
  hasIllegalBarrierCrossing,
} from './routing-rules';
import type { CenterlineSource, WaterGraph } from './water-graph-types';
import type {
  TopologyGapSummary,
  TopologySeamCandidate,
  WaterGraphTopology,
} from './water-graph-topology';
import {
  getWaterKnowledgeCorpus,
  type WaterKnowledgeFact,
} from './water-knowledge';

export type CorridorEvidenceType =
  | 'same_water_object'
  | 'same_osm_relation'
  | 'connected_waterway_tags'
  | 'named_continuation'
  | 'canal_continuation'
  | 'river_continuation'
  | 'river_to_mask_candidate'
  | 'lock_transition_candidate'
  | 'possible_distributary'
  | 'possible_separate_waterbody'
  | 'data_gap'
  | 'no_evidence'
  | 'unknown';

/** Analytic labels only — never used for routing decisions. */
export type FinalCorridorClassification =
  | 'NAVIGABLE_CONNECTION_EVIDENCE'
  | 'PHYSICAL_CONNECTION_ONLY'
  | 'DATA_GAP'
  | 'BARRIER'
  | 'LOCK_TRANSITION'
  | 'SEPARATE_WATER_OBJECT'
  | 'NO_EVIDENCE'
  | 'UNKNOWN';

export type LockRelevance = {
  location: LngLat;
  distanceToGapKm: number;
  source: string;
  relatedComponent: string | null;
  lockPresent: boolean;
  barrierPresent: boolean;
  relevance: 'related_to_gap' | 'nearest_unrelated' | 'distant_unrelated';
};

export type WaterCorridorEvidence = {
  fromComponent: string;
  toComponent: string | null;
  relation: string;
  evidenceType: CorridorEvidenceType;
  evidenceTypes: CorridorEvidenceType[];
  evidenceSources: string[];
  distanceKm: number;
  waterIds: string[];
  names: string[];
  confidence: number;
  safetyFlags: string[];
  barriers: string[];
  locks: LockRelevance[];
  maskEvidence: {
    present: boolean;
    lakeName: string | null;
    bothNearMask: boolean;
    midInMask: boolean;
    note: string | null;
  };
  fairwayEvidence: {
    present: boolean;
    crossesBoundary: boolean;
    softPreferenceOnly: true;
    note: string | null;
  };
  physicalConnection: 'proven' | 'suggested' | 'none' | 'unknown';
  navigableConnection: 'proven' | 'suggested' | 'none' | 'unknown';
  finalDiagnosticClassification: FinalCorridorClassification;
  gapContents: string[];
  gapEndpoints: {
    from: LngLat;
    to: LngLat | null;
  };
  diagnosticOnly: true;
};

export type WaterCorridorEvidenceReport = {
  candidateCount: number;
  strongEvidenceCount: number;
  weakEvidenceCount: number;
  noEvidenceCount: number;
  candidates: WaterCorridorEvidence[];
  diagnosticOnly: true;
};

export type CorridorEvidenceInput = {
  a: LngLat;
  b: LngLat;
  topology: WaterGraphTopology;
  graph?: WaterGraph | null;
  centerlines?: CenterlineSource[];
  lake?: LakeMask | null;
};

const KNOWN_LOCKS: Array<{ id: string; p: LngLat; lock: boolean }> = [
  { id: 'DUBNA_LOCK', p: DUBNA_LOCK, lock: true },
  { id: 'DUBNA_LOCK_UPPER', p: DUBNA_LOCK_UPPER, lock: true },
  { id: 'DUBNA_LOCK_LOWER', p: DUBNA_LOCK_LOWER, lock: true },
  { id: 'RYBINSK_LOCK', p: RYBINSK_LOCK, lock: true },
  { id: 'RYBINSK_LOCK_11', p: RYBINSK_LOCK_11, lock: true },
  { id: 'RYBINSK_LOCK_12', p: RYBINSK_LOCK_12, lock: true },
];

function mid(a: LngLat, b: LngLat): LngLat {
  return { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
}

function normalizeName(s: string | null | undefined): string {
  return (s ?? '').trim().toLocaleLowerCase('ru');
}

function waterIdBase(id: string): string {
  return id.replace(/^ww:/, '').replace(/^osm:/, '').replace(/^mask:/, '').replace(/^lock:/, '').replace(/^fairway-/, 'fairway:');
}

function namesFromCenterlines(
  waterIds: string[],
  centerlines: CenterlineSource[],
): string[] {
  const wanted = new Set(waterIds.map(normalizeName));
  const out = new Set<string>();
  for (const cl of centerlines) {
    const wid = normalizeName(cl.waterId ?? '');
    const nm = normalizeName(cl.name);
    if (wanted.has(wid) || (nm && wanted.has(`ww:${nm}`))) {
      if (cl.name) out.add(cl.name);
      else if (cl.waterId) out.add(cl.waterId);
    }
  }
  for (const w of waterIds) {
    if (w.startsWith('ww:')) out.add(w.slice(3));
  }
  return [...out];
}

function knowledgeNearGap(
  gapA: LngLat,
  gapB: LngLat,
  padKm = 80,
): WaterKnowledgeFact[] {
  const m = mid(gapA, gapB);
  const out: WaterKnowledgeFact[] = [];
  for (const f of getWaterKnowledgeCorpus()) {
    const g = f.geometry?.coordinates;
    if (g) {
      const p = { lon: g[0]!, lat: g[1]! };
      if (
        haversineKm(m, p) <= padKm ||
        haversineKm(gapA, p) <= padKm ||
        haversineKm(gapB, p) <= padKm
      ) {
        out.push(f);
        continue;
      }
    }
    if (f.bbox) {
      const [w, s, e, n] = f.bbox;
      if (m.lon >= w - 0.3 && m.lon <= e + 0.3 && m.lat >= s - 0.3 && m.lat <= n + 0.3) {
        out.push(f);
      }
    }
  }
  return out;
}

function lockRelevanceForGap(
  gapA: LngLat,
  gapB: LngLat,
  componentIds: string[],
  topology: WaterGraphTopology,
): LockRelevance[] {
  const m = mid(gapA, gapB);
  const out: LockRelevance[] = [];

  for (const k of KNOWN_LOCKS) {
    const d = haversineKm(m, k.p);
    let relevance: LockRelevance['relevance'] = 'distant_unrelated';
    if (d <= 25) relevance = 'related_to_gap';
    else if (d <= 80) relevance = 'nearest_unrelated';
    // Dubna/Rybinsk are hundreds of km from Lower Volga / Belomor — always distant.
    if (d > 80) relevance = 'distant_unrelated';

    const related =
      topology.lockPortalCandidates.find((c) => haversineKm(c.location, k.p) < 0.05)
        ?.nearbyComponents.filter((id) => componentIds.includes(id))[0] ?? null;

    out.push({
      location: { ...k.p },
      distanceToGapKm: Math.round(d * 1000) / 1000,
      source: k.id,
      relatedComponent: related,
      lockPresent: k.lock,
      barrierPresent: KNOWN_BARRIERS.some((b) =>
        b.id.includes(k.id.toLowerCase().includes('dubna') ? 'dubna' : 'rybinsk'),
      ),
      relevance,
    });
  }

  // Knowledge lock facts near gap
  for (const f of knowledgeNearGap(gapA, gapB, 40)) {
    if (!f.lock && !f.barrier) continue;
    const coords = f.geometry?.coordinates;
    const loc = coords
      ? { lon: coords[0]!, lat: coords[1]! }
      : m;
    const d = haversineKm(m, loc);
    out.push({
      location: loc,
      distanceToGapKm: Math.round(d * 1000) / 1000,
      source: `knowledge:${f.id}`,
      relatedComponent: null,
      lockPresent: Boolean(f.lock),
      barrierPresent: Boolean(f.barrier),
      relevance: d <= 25 ? 'related_to_gap' : d <= 80 ? 'nearest_unrelated' : 'distant_unrelated',
    });
  }

  return out.sort((a, b) => a.distanceToGapKm - b.distanceToGapKm);
}

function barrierFlags(gapA: LngLat, gapB: LngLat): string[] {
  const flags: string[] = [];
  if (hasIllegalBarrierCrossing([gapA, gapB])) flags.push('illegal_barrier_crossing');
  for (const b of KNOWN_BARRIERS) {
    if (b.crosses([gapA, mid(gapA, gapB), gapB])) flags.push(`barrier:${b.id}`);
  }
  return flags;
}

function strengthBucket(
  classification: FinalCorridorClassification,
  evidenceTypes: CorridorEvidenceType[],
): 'strong' | 'weak' | 'none' {
  if (
    classification === 'NAVIGABLE_CONNECTION_EVIDENCE' ||
    classification === 'DATA_GAP' ||
    classification === 'BARRIER' ||
    classification === 'LOCK_TRANSITION'
  ) {
    return 'strong';
  }
  if (classification === 'NO_EVIDENCE') return 'none';
  if (evidenceTypes.includes('no_evidence') && evidenceTypes.length === 1) return 'none';
  return 'weak';
}

/**
 * Build evidence for one topology gap (component pair).
 */
export function evidenceForGap(
  gap: TopologyGapSummary,
  input: CorridorEvidenceInput,
): WaterCorridorEvidence {
  const centerlines = input.centerlines ?? [];
  const lake = input.lake ?? null;
  const fromIds = gap.fromSide.waterIds;
  const toIds = gap.toSide.waterIds;
  const waterIds = [...new Set([...fromIds, ...toIds])];
  const names = namesFromCenterlines(waterIds, centerlines);
  const gapA = gap.fromSide.point;
  const gapB = gap.toSide.point;
  const m = mid(gapA, gapB);

  const evidenceTypes = new Set<CorridorEvidenceType>();
  const evidenceSources: string[] = [];
  const safetyFlags: string[] = ['distance_not_connection_proof'];

  const sameWaterId = fromIds.some((w) => toIds.includes(w));
  const fromLayer = gap.fromSide.layer;
  const toLayer = gap.toSide.layer;

  if (sameWaterId) {
    evidenceTypes.add('same_water_object');
    evidenceSources.push(`same_waterId:${fromIds.find((w) => toIds.includes(w))}`);
  }

  // Named continuation: same normalized name on both sides
  const fromNames = namesFromCenterlines(fromIds, centerlines).map(normalizeName);
  const toNames = namesFromCenterlines(toIds, centerlines).map(normalizeName);
  const sharedName = fromNames.find((n) => n && toNames.includes(n));
  if (sharedName) {
    evidenceTypes.add('named_continuation');
    evidenceSources.push(`shared_name:${sharedName}`);
  }

  if (fromLayer === 'canal' && toLayer === 'canal' && (sameWaterId || sharedName)) {
    evidenceTypes.add('canal_continuation');
    evidenceSources.push('canal_tags_both_sides');
  }
  if (fromLayer === 'waterway' && toLayer === 'waterway' && (sameWaterId || sharedName)) {
    evidenceTypes.add('river_continuation');
    evidenceSources.push('river_tags_both_sides');
  }

  if (!sameWaterId && fromLayer === 'waterway' && toLayer === 'waterway') {
    evidenceTypes.add('possible_separate_waterbody');
    evidenceSources.push('distinct_waterIds_from_names');
  }

  // Knowledge: co-listed rivers in same corridor fact ≠ navigable proof
  const facts = knowledgeNearGap(gapA, gapB);
  for (const f of facts) {
    evidenceSources.push(`knowledge:${f.id}`);
    const rivers = (f.rivers ?? []).map(normalizeName);
    const bodies = [f.river, f.waterBody].filter(Boolean).map((x) => normalizeName(String(x)));
    const nameHits = names.map(normalizeName).filter((n) => {
      const latinish = n
        .replace('волга', 'volga')
        .replace('ахтуба', 'akhtuba')
        .replace('беломорско-балтийский канал', 'belomorkanal')
        .replace('беломорканал', 'belomorkanal');
      return (
        rivers.includes(n) ||
        bodies.includes(n) ||
        rivers.includes(latinish) ||
        bodies.includes(latinish) ||
        (n.includes('волг') && rivers.includes('volga')) ||
        (n.includes('ахтуб') && rivers.includes('akhtuba')) ||
        (n.includes('беломор') && rivers.includes('belomorkanal'))
      );
    });
    if (nameHits.length >= 2 && !sameWaterId) {
      evidenceTypes.add('possible_distributary');
      evidenceSources.push(`knowledge_co_listed_rivers:${f.id}`);
      safetyFlags.push('knowledge_corridor_cooccurrence_not_navigable_proof');
    }
    if (f.lock) {
      evidenceTypes.add('lock_transition_candidate');
      evidenceSources.push(`knowledge_lock:${f.lock}`);
    }
  }

  // OSM relation continuity: centerlines sharing source relation id (rare in fixtures)
  const osmIds = centerlines
    .filter((c) => waterIds.includes(c.waterId ?? '') || names.includes(c.name ?? ''))
    .map((c) => c.sourceId ?? c.id);
  // Fixtures don't share a relation — mark absence explicitly
  if (sameWaterId && osmIds.length >= 2) {
    // Same waterId from name merge is not same OSM relation unless ids match relation
    evidenceSources.push(`osm_feature_ids:${[...new Set(osmIds)].join(',')}`);
  }

  // Gap geometry contents from topology
  if (gap.classification === 'DATA_GAP' || gap.gapContents.includes('nothing_known')) {
    if (sameWaterId) {
      evidenceTypes.add('data_gap');
      evidenceSources.push('topology:DATA_GAP');
    }
  }

  // Mask evidence
  let bothNearMask = false;
  let midInMask = false;
  if (lake) {
    const nearA = pointInOpenWater(gapA, lake) || nearestOpenWater(gapA, lake, 5);
    const nearB = pointInOpenWater(gapB, lake) || nearestOpenWater(gapB, lake, 5);
    bothNearMask = Boolean(nearA && nearB);
    midInMask = pointInOpenWater(m, lake);
    if (bothNearMask || midInMask) {
      evidenceTypes.add('river_to_mask_candidate');
      evidenceSources.push(`lake_mask:${lake.name}`);
      safetyFlags.push('mask_alone_not_navigable_proof');
    }
  }

  // Fairway soft evidence
  const fairwayComps = input.topology.components.filter((c) => c.layers.fairway);
  let fairwayPresent = fairwayComps.length > 0;
  let fairwayCrosses = false;
  if (fairwayComps.length) {
    evidenceSources.push('fairway_layer_present');
    safetyFlags.push('fairway_soft_preference_only');
    safetyFlags.push('fairway_not_navigability_proof');
    // Boundary cross: fairway component near both gap ends
    for (const fc of fairwayComps) {
      const dA = Math.min(
        ...fc.portals.map((p) => haversineKm(gapA, p)),
        ...[haversineKm(gapA, { lon: fc.bbox[0], lat: fc.bbox[1] })],
      );
      const dB = Math.min(
        ...fc.portals.map((p) => haversineKm(gapB, p)),
        ...[haversineKm(gapB, { lon: fc.bbox[2], lat: fc.bbox[3] })],
      );
      if (dA < 20 && dB < 20) fairwayCrosses = true;
    }
  }

  const barriers = barrierFlags(gapA, gapB);
  if (barriers.length) {
    evidenceSources.push(...barriers);
    safetyFlags.push(...barriers);
  }

  const locks = lockRelevanceForGap(
    gapA,
    gapB,
    [gap.fromComponent, gap.toComponent],
    input.topology,
  );
  // Concrete lock points only (KNOWN_* / graph) — knowledge text "multi_lock_stair"
  // is advisory evidence, not enough to reclassify a DATA_GAP as LOCK_TRANSITION.
  const relatedConcreteLocks = locks.filter(
    (l) =>
      l.relevance === 'related_to_gap' &&
      !l.source.startsWith('knowledge:'),
  );
  const relatedKnowledgeLocks = locks.filter(
    (l) => l.relevance === 'related_to_gap' && l.source.startsWith('knowledge:'),
  );
  if (relatedConcreteLocks.length) {
    evidenceTypes.add('lock_transition_candidate');
    evidenceSources.push(
      ...relatedConcreteLocks.map((l) => `lock_near_gap:${l.source}`),
    );
  } else if (relatedKnowledgeLocks.length) {
    evidenceTypes.add('lock_transition_candidate');
    evidenceSources.push(
      ...relatedKnowledgeLocks.map((l) => `knowledge_lock_near_gap:${l.source}`),
    );
    safetyFlags.push('knowledge_lock_unverified_at_gap');
  }
  const distantLocks = locks.filter((l) => l.relevance === 'distant_unrelated');
  if (distantLocks.length) {
    safetyFlags.push('unrelated_distant_locks_ignored');
    evidenceSources.push(
      `distant_locks_not_evidence:${distantLocks.map((d) => d.source).slice(0, 3).join(',')}`,
    );
  }

  // connected_waterway_tags: both sides waterway/canal with tags present
  if (
    (fromLayer === 'waterway' || fromLayer === 'canal') &&
    (toLayer === 'waterway' || toLayer === 'canal')
  ) {
    if (sameWaterId || sharedName) {
      evidenceTypes.add('connected_waterway_tags');
    }
  }

  if (evidenceTypes.size === 0) {
    evidenceTypes.add('no_evidence');
    evidenceSources.push('no_shared_identity_or_mask_or_lock');
  }

  // --- Classification (analytic only) ---
  let physical: WaterCorridorEvidence['physicalConnection'] = 'unknown';
  let navigable: WaterCorridorEvidence['navigableConnection'] = 'none';
  let classification: FinalCorridorClassification = 'UNKNOWN';
  let confidence = 0.2;

  if (barriers.length && barriers.some((b) => b.startsWith('barrier:') || b === 'illegal_barrier_crossing')) {
    classification = 'BARRIER';
    physical = 'none';
    navigable = 'none';
    confidence = 0.7;
  } else if (
    sameWaterId &&
    (evidenceTypes.has('data_gap') || gap.gapContents.includes('nothing_known'))
  ) {
    // Strong identity + missing mid geometry wins over soft knowledge lock notes.
    classification = 'DATA_GAP';
    physical = 'suggested';
    navigable = 'unknown';
    confidence = 0.75;
    evidenceSources.push('identity_strong_geometry_missing');
    if (relatedKnowledgeLocks.length || relatedConcreteLocks.length) {
      safetyFlags.push('lock_notes_do_not_fill_data_gap');
    }
  } else if (relatedConcreteLocks.length && sameWaterId) {
    classification = 'LOCK_TRANSITION';
    physical = 'suggested';
    navigable = 'suggested';
    confidence = 0.55;
    safetyFlags.push('lock_transition_unverified');
  } else if (!sameWaterId && evidenceTypes.has('possible_separate_waterbody')) {
    // Distributary / floodplain co-occurrence is hydrological, not navigable proof
    if (evidenceTypes.has('possible_distributary')) {
      classification = 'SEPARATE_WATER_OBJECT';
      physical = 'suggested';
      navigable = 'none';
      confidence = 0.55;
      safetyFlags.push('hydrological_link_not_navigable_proof');
    } else {
      classification = 'SEPARATE_WATER_OBJECT';
      physical = 'none';
      navigable = 'none';
      confidence = 0.7;
    }
  } else if (evidenceTypes.has('river_to_mask_candidate') && bothNearMask) {
    classification = 'PHYSICAL_CONNECTION_ONLY';
    physical = 'suggested';
    navigable = 'unknown';
    confidence = 0.4;
  } else if (evidenceTypes.has('no_evidence')) {
    classification = 'NO_EVIDENCE';
    physical = 'none';
    navigable = 'none';
    confidence = 0.15;
  } else {
    classification = 'UNKNOWN';
    confidence = 0.25;
  }

  // Distance must never upgrade classification to navigable
  safetyFlags.push(`observed_gap_km:${gap.distanceKm}`);

  const types = [...evidenceTypes];
  const primary =
    types.find((t) => t === 'data_gap') ??
    types.find((t) => t === 'possible_distributary') ??
    types.find((t) => t === 'possible_separate_waterbody') ??
    types.find((t) => t === 'same_water_object') ??
    types.find((t) => t === 'river_to_mask_candidate') ??
    types.find((t) => t === 'lock_transition_candidate') ??
    types[0] ??
    'unknown';

  return {
    fromComponent: gap.fromComponent,
    toComponent: gap.toComponent,
    relation: `${fromLayer}↔${toLayer}`,
    evidenceType: primary,
    evidenceTypes: types,
    evidenceSources,
    distanceKm: gap.distanceKm,
    waterIds,
    names: [...new Set(names)],
    confidence,
    safetyFlags: [...new Set(safetyFlags)],
    barriers,
    locks,
    maskEvidence: {
      present: Boolean(lake),
      lakeName: lake?.name ?? null,
      bothNearMask,
      midInMask,
      note: lake
        ? bothNearMask || midInMask
          ? 'gap endpoints/mid near lake mask'
          : 'lake present but gap not on mask'
        : 'no lake mask in corridor',
    },
    fairwayEvidence: {
      present: fairwayPresent,
      crossesBoundary: fairwayCrosses,
      softPreferenceOnly: true,
      note: fairwayPresent
        ? 'fairway is soft preference only — not navigability proof'
        : 'no fairway layer in graph',
    },
    physicalConnection: physical,
    navigableConnection: navigable,
    finalDiagnosticClassification: classification,
    gapContents: gap.gapContents.slice(),
    gapEndpoints: { from: gapA, to: gapB },
    diagnosticOnly: true,
  };
}

/**
 * Evidence for waterway/fairway → mask seam candidates (no edge created).
 */
export function evidenceForMaskCandidate(
  cand: TopologySeamCandidate,
  input: CorridorEvidenceInput,
): WaterCorridorEvidence {
  const lake = input.lake ?? null;
  const fromComp = input.topology.components.find((c) => c.id === cand.fromComponent);
  const waterIds = fromComp?.waterIds ?? [];
  const names = namesFromCenterlines(waterIds, input.centerlines ?? []);
  const fromNode = cand.fromNodeId
    ? input.graph?.nodes.get(cand.fromNodeId)
    : null;
  const fromPt = fromNode
    ? { lon: fromNode.lon, lat: fromNode.lat }
    : input.a;

  const evidenceTypes = new Set<CorridorEvidenceType>(['river_to_mask_candidate']);
  const evidenceSources = [`topology:${cand.candidateType}`, `distanceKm:${cand.distanceKm}`];
  const safetyFlags = [
    'distance_not_connection_proof',
    'mask_alone_not_navigable_proof',
    'fairway_not_navigability_proof',
    'no_auto_seam',
  ];

  let bothNearMask = false;
  let midInMask = false;
  if (lake) {
    evidenceSources.push(`lake:${lake.name}`);
    bothNearMask = Boolean(
      pointInOpenWater(fromPt, lake) || nearestOpenWater(fromPt, lake, 5),
    );
    midInMask = pointInOpenWater(fromPt, lake);
    if (lake.complete) evidenceSources.push('lake_mask_complete');
    else evidenceSources.push('lake_mask_incomplete');
  } else {
    evidenceSources.push('no_lake_mask');
  }

  if (cand.safetyFlags.includes('from_fairway')) {
    evidenceSources.push('from_fairway_layer');
    safetyFlags.push('fairway_soft_preference_only');
  }

  const locks = lockRelevanceForGap(fromPt, fromPt, [cand.fromComponent], input.topology);
  const barriers = barrierFlags(fromPt, {
    lon: fromPt.lon + 0.01,
    lat: fromPt.lat,
  });

  let classification: FinalCorridorClassification = 'PHYSICAL_CONNECTION_ONLY';
  let confidence = 0.35;
  let navigable: WaterCorridorEvidence['navigableConnection'] = 'unknown';
  let physical: WaterCorridorEvidence['physicalConnection'] = 'suggested';

  if (!lake) {
    classification = 'NO_EVIDENCE';
    evidenceTypes.add('no_evidence');
    physical = 'none';
    navigable = 'none';
    confidence = 0.15;
  } else if (barriers.length) {
    classification = 'BARRIER';
    confidence = 0.6;
  } else if (lake.complete && bothNearMask && cand.distanceKm < 2) {
    // Same reservoir body — physical open-water continuity plausible; still not auto-navigable proof via fairway
    classification = 'PHYSICAL_CONNECTION_ONLY';
    physical = 'suggested';
    navigable = 'unknown';
    confidence = 0.5;
    evidenceSources.push('same_reservoir_mask_proximity');
  } else {
    classification = 'UNKNOWN';
    confidence = 0.3;
    evidenceTypes.add('unknown');
  }

  return {
    fromComponent: cand.fromComponent,
    toComponent: cand.toComponent,
    relation: `${cand.candidateType}`,
    evidenceType: 'river_to_mask_candidate',
    evidenceTypes: [...evidenceTypes],
    evidenceSources,
    distanceKm: cand.distanceKm,
    waterIds,
    names,
    confidence,
    safetyFlags: [...new Set(safetyFlags)],
    barriers,
    locks,
    maskEvidence: {
      present: Boolean(lake),
      lakeName: lake?.name ?? null,
      bothNearMask,
      midInMask,
      note: lake
        ? 'mask transition candidate — diagnostic only'
        : 'missing mask',
    },
    fairwayEvidence: {
      present: cand.safetyFlags.includes('from_fairway'),
      crossesBoundary: false,
      softPreferenceOnly: true,
      note: 'fairway is soft preference only — not navigability proof',
    },
    physicalConnection: physical,
    navigableConnection: navigable,
    finalDiagnosticClassification: classification,
    gapContents: [],
    gapEndpoints: { from: fromPt, to: null },
    diagnosticOnly: true,
  };
}

/**
 * Full corridor-evidence report from topology (+ optional centerlines/lake).
 */
export function buildWaterCorridorEvidence(
  input: CorridorEvidenceInput,
): WaterCorridorEvidenceReport {
  const candidates: WaterCorridorEvidence[] = [];

  for (const gap of input.topology.gapSummary) {
    // Skip remote lock↔lock / lock↔anything noise beyond identity analysis:
    // still include if either side is waterway/canal/mask/fairway of interest
    const layers = [gap.fromSide.layer, gap.toSide.layer];
    const interesting = layers.some((l) =>
      ['waterway', 'canal', 'mask', 'fairway'].includes(l),
    );
    if (!interesting) continue;
    // Skip pairs that are only remote lock islands far from corridor
    if (layers.every((l) => l === 'lock')) continue;
    candidates.push(evidenceForGap(gap, input));
  }

  // Mask transition candidates (dedupe by fromComponent+type)
  const seenMask = new Set<string>();
  for (const cand of input.topology.waterwayMaskCandidates) {
    if (cand.candidateType !== 'waterway_to_mask') continue;
    const key = `${cand.fromComponent}:${cand.toComponent}:${cand.fromNodeId}`;
    if (seenMask.has(key)) continue;
    seenMask.add(key);
    candidates.push(evidenceForMaskCandidate(cand, input));
  }

  let strong = 0;
  let weak = 0;
  let none = 0;
  for (const c of candidates) {
    const b = strengthBucket(c.finalDiagnosticClassification, c.evidenceTypes);
    if (b === 'strong') strong += 1;
    else if (b === 'none') none += 1;
    else weak += 1;
  }

  return {
    candidateCount: candidates.length,
    strongEvidenceCount: strong,
    weakEvidenceCount: weak,
    noEvidenceCount: none,
    candidates,
    diagnosticOnly: true,
  };
}

/** Test helpers — pure classifiers without full graph. */
export function classifySameWaterDataGap(args: {
  sameWaterId: boolean;
  gapContentsNothingKnown: boolean;
  barrier: boolean;
}): FinalCorridorClassification {
  if (args.barrier) return 'BARRIER';
  if (args.sameWaterId && args.gapContentsNothingKnown) return 'DATA_GAP';
  if (!args.sameWaterId) return 'SEPARATE_WATER_OBJECT';
  return 'UNKNOWN';
}

export function classifySeparateWaterbodies(args: {
  waterIdA: string;
  waterIdB: string;
  knowledgeCoListed: boolean;
}): {
  evidenceTypes: CorridorEvidenceType[];
  classification: FinalCorridorClassification;
  navigableConnection: 'none' | 'unknown';
} {
  if (args.waterIdA === args.waterIdB) {
    return {
      evidenceTypes: ['same_water_object'],
      classification: 'UNKNOWN',
      navigableConnection: 'unknown',
    };
  }
  const types: CorridorEvidenceType[] = ['possible_separate_waterbody'];
  if (args.knowledgeCoListed) types.push('possible_distributary');
  return {
    evidenceTypes: types,
    classification: 'SEPARATE_WATER_OBJECT',
    navigableConnection: 'none',
  };
}

export function lockRelevanceLabel(
  distanceToGapKm: number,
): LockRelevance['relevance'] {
  if (distanceToGapKm <= 25) return 'related_to_gap';
  if (distanceToGapKm <= 80) return 'nearest_unrelated';
  return 'distant_unrelated';
}

void waterIdBase; // reserved for future osm-id normalization in evidence sources
