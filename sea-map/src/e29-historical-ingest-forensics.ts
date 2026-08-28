/**
 * E2.9 — Historical ingest regression forensics (diagnostic only).
 *
 * Embeds evidence from git archaeology + E2.6–E2.8. Does not mutate history,
 * enable relation-aware ingest, or change production routing.
 */

export type ChangeType =
  | 'INGEST_CODE'
  | 'BBOX'
  | 'QUERY'
  | 'RELATION_HANDLING'
  | 'FIXTURE'
  | 'DATA_SOURCE'
  | 'ROUTING_LOGIC'
  | 'UNKNOWN';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type ForensicCorridor = {
  route: string;
  historicalStatus: string;
  currentStatus: string;
  recoverableGeometryKm: number;
  lastGoodCommit: string | null;
  firstBadCommit: string | null;
  commitRangeNote: string | null;
  changeTypes: ChangeType[];
  rootCause: string;
  confidence: Confidence;
  evidenceHistoricalSuccessUsedThisGeometry: 'YES' | 'NO_EVIDENCE' | 'PARTIAL';
  evidenceProjectChangeCausedLoss: 'YES' | 'NO_EVIDENCE' | 'PARTIAL';
};

export type HistoricalCommit = {
  commit: string;
  date: string;
  title: string;
  role: string;
  changeTypes: ChangeType[];
  codeEvidence: string;
  safeToRecoverAsIngestBehavior: boolean;
  unsafeIfRecoveredAsRouting: boolean;
};

export type E29Report = {
  schemaVersion: 'e2.9-historical-ingest-forensics';
  diagnosticOnly: true;
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  noSeam: true;
  noSyntheticGeometry: true;
  timeline: HistoricalCommit[];
  corridors: ForensicCorridor[];
  pipelineDiagram: {
    old: string[];
    current: string[];
    divergencePoints: string[];
  };
  answers: {
    projectChangeCausedOsmGeometryLoss: string;
    historicalGoodRoutesUsedRecoverableGeometry: string;
  };
  safeHistoricalBehaviorToRecover: string[];
  unsafeHistoricalBehaviorMustNotRecover: string[];
  remainingUnknowns: string[];
  summary: string;
};

/** Commits verified via git show / blame (short SHAs resolve in this repo). */
export const E29_TIMELINE: HistoricalCommit[] = [
  {
    commit: '246a212',
    date: '2026-07-27',
    title: 'Fix inland waterway routing — bbox Overpass with relations',
    role: 'Early Overpass-centric ingest: buildWaterwayQuery included relation[waterway=river|canal] + type=waterway',
    changeTypes: ['QUERY', 'RELATION_HANDLING', 'INGEST_CODE'],
    codeEvidence:
      'waterways.ts buildWaterwayQuery: way[...] + relation["waterway"="canal|river"] + relation["type"="waterway"]',
    safeToRecoverAsIngestBehavior: true,
    unsafeIfRecoveredAsRouting: false,
  },
  {
    commit: '612dadde',
    date: '2026-07-27',
    title: 'Around-based Overpass UX',
    role: 'LAST_GOOD for waterway relation clauses in around-queries',
    changeTypes: ['QUERY', 'RELATION_HANDLING'],
    codeEvidence:
      'relation(around:...)["waterway"~"^(river|canal)$"] and relation(around:...)["type"="waterway"] still present',
    safeToRecoverAsIngestBehavior: true,
    unsafeIfRecoveredAsRouting: false,
  },
  {
    commit: '35bb549',
    date: '2026-07-27',
    title: 'Cell cache + speed — around/cell ways-only',
    role: 'FIRST_BAD for legacy Overpass waterway relation fetch',
    changeTypes: ['QUERY', 'RELATION_HANDLING', 'INGEST_CODE'],
    codeEvidence:
      'aroundWaterQuery/cellBboxQuery: only way["waterway"~...]; waterway relation(around) clauses removed. Parser still accepts relations if returned.',
    safeToRecoverAsIngestBehavior: true,
    unsafeIfRecoveredAsRouting: false,
  },
  {
    commit: '54eb6e5',
    date: '2026-07-27',
    title: 'Skip Overpass hang for span >120 km',
    role: 'Latency tradeoff — long-fail paths no longer crawl Overpass',
    changeTypes: ['ROUTING_LOGIC', 'QUERY'],
    codeEvidence:
      'if (routeSpanKm(waypoints) > 120) return directFallback(); comment: Overpass cell crawl hangs, cannot connect Seliger→Vokhma',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: true,
  },
  {
    commit: '4f60ab8',
    date: '2026-07-28',
    title: 'Volga fairway recovery + softer accept (3.5×)',
    role: 'Routing coverage via softer accept — NOT an ingest geometry restore',
    changeTypes: ['ROUTING_LOGIC'],
    codeEvidence: 'Softer excess / pin-scored fairway accept (later hardened)',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: true,
  },
  {
    commit: '1e5bcfc',
    date: '2026-07-28',
    title: 'Moscow-canal spur bbox missing lonMax (fixed)',
    role: 'Example of real BBOX coverage regression then fix',
    changeTypes: ['BBOX'],
    codeEvidence: 'inMoscowCanalEastSpur matched any lon≥37.545 — cascade Volga rewritten through Moscow Canal',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: false,
  },
  {
    commit: 'afc2623',
    date: '2026-08-25',
    title: 'BRouter first, polish in background',
    role: 'Architecture: critical path no longer waits on Overpass snap',
    changeTypes: ['ROUTING_LOGIC', 'INGEST_CODE'],
    codeEvidence: 'Paint on BRouter; Overpass polish async — changes when geometry is fetched, not OSM contents',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: false,
  },
  {
    commit: 'edd2603',
    date: '2026-08-25',
    title: 'Harden: no false directs, universal validator',
    role: 'Safety hardening — coverage↓ for false OK',
    changeTypes: ['ROUTING_LOGIC'],
    codeEvidence: 'Ban START→FINISH chords; validate-water-route',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: true,
  },
  {
    commit: 'f181ecb',
    date: '2026-08-25',
    title: 'MAX water snap endpoint reach',
    role: 'Safety hardening (Volga→Vetluga false success)',
    changeTypes: ['ROUTING_LOGIC'],
    codeEvidence: 'MAX_WATER_SNAP_DISTANCE_METERS=3000',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: true,
  },
  {
    commit: '21b571c',
    date: '2026-08-27',
    title: 'E1 full Kuibyshev lake mask',
    role: 'Mask-era success for N06/N08/L2 without OSM centerline WaterGraph ingest',
    changeTypes: ['DATA_SOURCE', 'INGEST_CODE'],
    codeEvidence: 'Bundled Kuibyshev complete + Cheboksary partial masks; Phase A path',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: false,
  },
  {
    commit: '65dfe1d',
    date: '2026-08-27',
    title: 'E2.1 centerline ingest + Belomor/Lower Volga fixtures',
    role: 'FIRST_BAD for Belomor WaterGraph fixture DATA_GAP; WaterGraph Overpass ways-only from birth',
    changeTypes: ['FIXTURE', 'BBOX', 'QUERY'],
    codeEvidence:
      'belomor.geojson fake ids 502000x at lon≈34.8 with mid tear; WG_INGEST_CORRIDOR_PAD_DEG=0.35; bboxQuery ways-only (no relation[...])',
    safeToRecoverAsIngestBehavior: false,
    unsafeIfRecoveredAsRouting: false,
  },
];

export const E29_CORRIDORS: ForensicCorridor[] = [
  {
    route: 'Belomor',
    historicalStatus: 'CONFIRMED_WORKING (production BRouter full; E2.6)',
    currentStatus: 'WaterGraph fixture: 2 comps, ~18.96 km tear; production BRouter often still OK',
    recoverableGeometryKm: 94.864,
    lastGoodCommit: '612dadde',
    firstBadCommit: '65dfe1d',
    commitRangeNote:
      'Two layers: (1) legacy Overpass relation drop FIRST_BAD=35bb549 after LAST_GOOD=612dadde; (2) WaterGraph Belomor fixture FIRST_BAD=65dfe1d — no prior good WaterGraph Belomor fixture exists (NO EVIDENCE of last-good fixture). Historical OK was BRouter, not this fixture.',
    changeTypes: ['FIXTURE', 'BBOX', 'RELATION_HANDLING', 'QUERY'],
    rootCause:
      'E2.1 simplified fixture chord at ~34.8E + 0.35° pad cuts western OSM canal (~34.2E). Parallel: 35bb549 removed waterway relation fetches from legacy around/cell queries; bench samples along wrong chord also miss western ways.',
    confidence: 'HIGH',
    evidenceHistoricalSuccessUsedThisGeometry: 'PARTIAL',
    evidenceProjectChangeCausedLoss: 'YES',
  },
  {
    route: 'X3',
    historicalStatus: 'fail_expected / NO_EVIDENCE of WaterGraph Vetluga centerlines',
    currentStatus: 'INGEST_ARTIFACT (E2.8): Vetluga OSM rel 382593 exists; CURRENT fairway-only / water-core 0 Vetluga',
    recoverableGeometryKm: 87.5,
    lastGoodCommit: null,
    firstBadCommit: null,
    commitRangeNote:
      'NO EVIDENCE of a commit that removed Vetluga from CURRENT WaterGraph centerlines — water-core never contained Ветлуга (git -S empty); no Vetluga centerline fixture was ever added. Under-ingest from birth of WaterGraph path, not a proven success→loss flip.',
    changeTypes: ['DATA_SOURCE', 'UNKNOWN'],
    rootCause:
      'Vetluga OSM geometry exists but was never loaded into water-core / WaterGraph fixtures. Legacy ways-only Overpass could still fetch named river ways if corridor samples hit them; CURRENT E2.8 audit path uses fairwaySourcesInCorridor without OSM Vetluga centerlines.',
    confidence: 'MEDIUM',
    evidenceHistoricalSuccessUsedThisGeometry: 'NO_EVIDENCE',
    evidenceProjectChangeCausedLoss: 'NO_EVIDENCE',
  },
  {
    route: 'N06',
    historicalStatus: 'PROBABLY_WORKING after E1 mask (21b571c)',
    currentStatus: 'Phase A/B often OK via mask; WaterGraph centerline under-ingest (E2.8 INGEST_ARTIFACT)',
    recoverableGeometryKm: 144,
    lastGoodCommit: null,
    firstBadCommit: null,
    commitRangeNote:
      'NO EVIDENCE WaterGraph ever ingested the ~96 OSM waterway ways then lost them. Mask era (21b571c) improved routing without centerline ingest. Distinguish layer gap (fairway/mask) from Belomor-style lost canal centerline.',
    changeTypes: ['DATA_SOURCE', 'UNKNOWN'],
    rootCause:
      'Architectural: production success via open-lake mask; WaterGraph CURRENT lacks OSM centerline fixtures for Kuibyshev. Not proven as a regression from a prior centerline-rich WaterGraph state.',
    confidence: 'MEDIUM',
    evidenceHistoricalSuccessUsedThisGeometry: 'NO_EVIDENCE',
    evidenceProjectChangeCausedLoss: 'NO_EVIDENCE',
  },
  {
    route: 'N08',
    historicalStatus: 'PROBABLY_WORKING after E1 mask',
    currentStatus: 'Same Kuibyshev family as N06',
    recoverableGeometryKm: 120,
    lastGoodCommit: null,
    firstBadCommit: null,
    commitRangeNote: 'Same as N06 — no proven centerline last-good/first-bad pair.',
    changeTypes: ['DATA_SOURCE', 'UNKNOWN'],
    rootCause: 'Same as N06 — mask-era success ≠ historical OSM centerline WaterGraph ingest.',
    confidence: 'MEDIUM',
    evidenceHistoricalSuccessUsedThisGeometry: 'NO_EVIDENCE',
    evidenceProjectChangeCausedLoss: 'NO_EVIDENCE',
  },
  {
    route: 'L2',
    historicalStatus: 'ok_expected after E1 Kuibyshev mid-pool mask',
    currentStatus: 'Mask path; centerline under-ingest (E2.8)',
    recoverableGeometryKm: 105,
    lastGoodCommit: null,
    firstBadCommit: null,
    commitRangeNote: 'Same as N06/N08.',
    changeTypes: ['DATA_SOURCE', 'UNKNOWN'],
    rootCause: 'Complete bundled mask explains historical OK without OSM centerline WaterGraph coverage.',
    confidence: 'MEDIUM',
    evidenceHistoricalSuccessUsedThisGeometry: 'NO_EVIDENCE',
    evidenceProjectChangeCausedLoss: 'NO_EVIDENCE',
  },
  {
    route: 'VG-D',
    historicalStatus: 'CONFIRMED_WORKING with good water clicks (BRouter)',
    currentStatus: 'SEPARATE_WATER_OBJECT (Volga vs Akhtuba); not an ingest tear to sew',
    recoverableGeometryKm: 0,
    lastGoodCommit: null,
    firstBadCommit: null,
    commitRangeNote:
      'lower-volga.geojson introduced in 65dfe1d already as separate Volga+Akhtuba features — matches OSM relations 1730417 / 1230074. NO EVIDENCE they were ever one navigable WaterGraph object then split by a bug.',
    changeTypes: ['FIXTURE'],
    rootCause: 'Separate water objects by design/OSM identity — not a historical ingest regression.',
    confidence: 'HIGH',
    evidenceHistoricalSuccessUsedThisGeometry: 'NO_EVIDENCE',
    evidenceProjectChangeCausedLoss: 'NO_EVIDENCE',
  },
  {
    route: 'VG-mid',
    historicalStatus: 'NO_EVIDENCE of historical OK for this A/B or Volga↔Akhtuba join (E2.6)',
    currentStatus: 'SEPARATE_WATER_OBJECT; ~14.5 km topology gap; recoverable join km=0',
    recoverableGeometryKm: 0,
    lastGoodCommit: null,
    firstBadCommit: null,
    commitRangeNote:
      'Fixture lower-volga-mid.geojson (65dfe1d) ships two waterIds from birth. OSM: separate Volga/Akhtuba relations. Must not sew.',
    changeTypes: ['FIXTURE'],
    rootCause: 'Not an ingest regression — separate objects; no first-bad that broke a prior join.',
    confidence: 'HIGH',
    evidenceHistoricalSuccessUsedThisGeometry: 'NO_EVIDENCE',
    evidenceProjectChangeCausedLoss: 'NO_EVIDENCE',
  },
];

export function buildE29Report(): E29Report {
  return {
    schemaVersion: 'e2.9-historical-ingest-forensics',
    diagnosticOnly: true,
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    noSeam: true,
    noSyntheticGeometry: true,
    timeline: E29_TIMELINE,
    corridors: E29_CORRIDORS,
    pipelineDiagram: {
      old: [
        'OSM (ways + waterway relations in early Overpass queries)',
        '→ Overpass bbox/around (246a212–612dadde)',
        '→ local waterway graph snap / BRouter',
        '→ route (often BRouter-primary after afc2623)',
      ],
      current: [
        'OSM',
        '→ legacy around/cell ways-only (35bb549) OR skip if span>120 (54eb6e5)',
        '→ BRouter first (afc2623) + Phase A/B masks (21b571c)',
        '→ WaterGraph shadow fixtures (65dfe1d): simplified Belomor chord + pad 0.35°; ways-only ingest query',
        '→ diagnostic relation-aware (E2.7) NOT enabled',
      ],
      divergencePoints: [
        '35bb549: drop waterway relation Overpass clauses (legacy)',
        '54eb6e5: skip Overpass on long spans (recovery path)',
        '65dfe1d: Belomor/Lower Volga fixtures + WaterGraph ways-only bbox query + 0.35° pad',
        'Historical Belomor OK diverges from WaterGraph fixture path (BRouter ≠ fixture chord)',
      ],
    },
    answers: {
      projectChangeCausedOsmGeometryLoss:
        'YES for Belomor WaterGraph fixture/bbox (65dfe1d) and legacy Overpass relation handling (35bb549) — code/fixture diffs confirm. NO EVIDENCE for X3/N06/N08/L2 that a commit removed previously ingested WaterGraph centerlines. NO EVIDENCE VG-mid/VG-D were ever one object then split.',
      historicalGoodRoutesUsedRecoverableGeometry:
        'PARTIAL for Belomor: production BRouter used real canal geometry (CONFIRMED_WORKING); NO EVIDENCE that WaterGraph/simplified fixture ever carried relation 9909116 members. NO EVIDENCE N06/N08/L2 historical OK required the unused OSM centerline km (mask path). NO EVIDENCE X3 historically used Vetluga relation 382593 in CURRENT ingest. NO EVIDENCE VG-mid join used recoverable geometry (recoverable=0).',
    },
    safeHistoricalBehaviorToRecover: [
      'Waterway relation clauses in Overpass around/cell queries (inverse of 35bb549) — coverage only',
      'Relation-aware / wider-bbox Belomor centerline ingest (E2.7) — real OSM members only',
      'Optional OSM centerline ingest for Vetluga/Kuibyshev corridors behind diagnostic→gated enablement',
    ],
    unsafeHistoricalBehaviorMustNotRecover: [
      'Soft accept / excess 3.5× (4f60ab8)',
      'Removing span_gt_120 Overpass skip without a safe alternative (54eb6e5)',
      'Weakening MAX snap / validator / hydro / barrier gates (edd2603, f181ecb)',
      'Sewing Volga↔Akhtuba',
      'Synthetic chords / seams across gaps',
    ],
    remainingUnknowns: [
      'Whether live legacy Overpass ways-only ever returned Belomor western ways for user clicks on the real canal (vs bench chord at 34.8E)',
      'Full km of Vetluga relation 382593 / Kuibyshev OSM ways (E2.8 estimates only)',
      'Whether any pre-E2.1 unpublished local experiments had better Belomor fixtures (not in git)',
    ],
    summary:
      'Belomor WaterGraph tear is a project-introduced FIXTURE/BBOX artifact (65dfe1d) atop an earlier QUERY regression (35bb549). X3/Kuibyshev centerline under-ingest lacks last-good→first-bad evidence. VG separate objects are not ingest bugs. Safe recoveries are relation/wider ingest — not soft routing.',
  };
}

export function formatE29Markdown(report: E29Report = buildE29Report()): string {
  const lines: string[] = [
    '# E2.9 — Historical ingest regression forensics',
    '',
    report.summary,
    '',
    '## Timeline',
    '',
  ];
  for (const t of report.timeline) {
    lines.push(
      `- \`${t.commit}\` (${t.date}) **${t.changeTypes.join('+')}** — ${t.title}: ${t.role}`,
    );
  }
  lines.push(
    '',
    '## Corridor table',
    '',
    '| route | hist | current | recKm | lastGood | firstBad | changeType | rootCause | conf |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- | --- |',
  );
  for (const c of report.corridors) {
    lines.push(
      `| ${c.route} | ${c.historicalStatus} | ${c.currentStatus} | ${c.recoverableGeometryKm} | ${c.lastGoodCommit ?? '—'} | ${c.firstBadCommit ?? '—'} | ${c.changeTypes.join('+')} | ${c.rootCause} | ${c.confidence} |`,
    );
  }
  lines.push(
    '',
    '## Pipeline divergence',
    '',
    'OLD:',
    ...report.pipelineDiagram.old.map((x) => `- ${x}`),
    '',
    'CURRENT:',
    ...report.pipelineDiagram.current.map((x) => `- ${x}`),
    '',
    'Divergence:',
    ...report.pipelineDiagram.divergencePoints.map((x) => `- ${x}`),
    '',
    '## Key answers',
    '',
    `1. Project change caused OSM geometry loss? ${report.answers.projectChangeCausedOsmGeometryLoss}`,
    '',
    `2. Historical good routes used this recoverable geometry? ${report.answers.historicalGoodRoutesUsedRecoverableGeometry}`,
    '',
    '## Safe vs unsafe',
    '',
    'Safe to recover (ingest):',
    ...report.safeHistoricalBehaviorToRecover.map((x) => `- ${x}`),
    '',
    'Must NOT recover:',
    ...report.unsafeHistoricalBehaviorMustNotRecover.map((x) => `- ${x}`),
    '',
  );
  return lines.join('\n');
}

export function belomorFirstBadCommit(): string | null {
  return E29_CORRIDORS.find((c) => c.route === 'Belomor')?.firstBadCommit ?? null;
}

export function belomorLastGoodCommit(): string | null {
  return E29_CORRIDORS.find((c) => c.route === 'Belomor')?.lastGoodCommit ?? null;
}
