/**
 * E2.6 — Historical routing regression archaeology (forensic / diagnostic only).
 *
 * Embeds evidence gathered from git history + in-repo docs/fixtures/benchmarks.
 * Does not mutate git history, production routing, thresholds, or USE_WATER_GRAPH.
 */

export type EvidenceClass =
  | 'CONFIRMED_WORKING'
  | 'PROBABLY_WORKING'
  | 'NO_EVIDENCE';

export type GapKind =
  | 'DATA_GAP'
  | 'DATA_REGRESSION'
  | 'PIPELINE_ARTIFACT'
  | 'SAFETY_COVERAGE_TRADEOFF'
  | 'NO_EVIDENCE'
  | 'UNKNOWN';

export type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type ModernBaseline = {
  route: string;
  result: 'OK' | 'FAIL' | 'FLAKY' | 'NOT_BENCHED';
  rejectReason: string | null;
  totalMs: number | null;
  phaseTimings: string;
  brouterCalls: number | null;
  overpassCalls: number | null;
  graphStatus: string;
  geometryCoverageSignals: string;
  source: string;
};

export type HistoricalFinding = {
  route: string;
  historicalSuccess: EvidenceClass;
  evidenceNotes: string[];
  oldCommit: string | null;
  oldResult: string | null;
  currentResult: string;
  firstKnownRegressionCommit: string | null;
  changedSubsystem: string;
  geometryDifference: string;
  fallbackDifference: string;
  safetyDifference: string;
  confidence: Confidence;
  gapKind: GapKind;
};

export type PipelineChange = {
  commit: string;
  date: string;
  title: string;
  subsystem: string;
  kind: 'COVERAGE_REGRESSION' | 'SAFETY_HARDENING' | 'LATENCY_TRADEOFF' | 'FIXTURE_ARTIFACT' | 'COVERAGE_FIX' | 'ARCHITECTURE';
  summary: string;
  affectsRoutes: string[];
  safeToConsiderRestoringWithoutWeakeningSafety: boolean;
};

export type E26Report = {
  schemaVersion: 'e2.6-historical-routing-regression';
  useWaterGraphMustStayFalse: true;
  productionRoutingUnchanged: true;
  modernBaselines: ModernBaseline[];
  historicalFindings: HistoricalFinding[];
  pipelineChanges: PipelineChange[];
  comparisonTable: Array<{
    route: string;
    oldCommit: string | null;
    oldResult: string | null;
    currentResult: string;
    firstKnownRegressionCommit: string | null;
    changedSubsystem: string;
    geometryDifference: string;
    fallbackDifference: string;
    safetyDifference: string;
    confidence: Confidence;
  }>;
  answers: {
    evidenceRoutesWorkedBetterHistorically: string;
    explanatoryChanges: string[];
    restorablesWithoutWeakeningSafety: string[];
    dataGapVsRegression: Record<string, string>;
  };
  belomor: {
    fixtureCorridorLon: string;
    realOsmLon: string;
    osmRelationId: number;
    fixtureIntroducedIn: string;
    classification: string;
  };
  summary: string;
};

/** Control-route modern baselines from E2.2 / E2.2.1 / E2.2.2 docs (USE_WATER_GRAPH=false). */
export const E26_MODERN_BASELINES: ModernBaseline[] = [
  {
    route: 'VG-mid',
    result: 'FAIL',
    rejectReason: 'snap_empty',
    totalMs: 16645,
    phaseTimings: 'A~0 B~617 C~18 op≪wall(~16s) val/hy~0',
    brouterCalls: 3,
    overpassCalls: 8,
    graphStatus: 'shadow off; fixture Volga↔Akhtuba SEPARATE_WATER_OBJECT',
    geometryCoverageSignals: 'span~115km; no shared lake; cache empty; Overpass cells empty',
    source: 'docs/E2_2_E2E_LATENCY_BASELINE.md + E2_2_1_VGMID_FALLBACK_DIAG.md',
  },
  {
    route: 'N06',
    result: 'OK',
    rejectReason: null,
    totalMs: 3151,
    phaseTimings: 'A~23–113 B~3126 C~0 op~0',
    brouterCalls: 1,
    overpassCalls: 0,
    graphStatus: 'shadow off; PHYSICAL_CONNECTION_ONLY mask↔fairway candidate',
    geometryCoverageSignals: 'shared Kuibyshev lake; Phase A/B accept path',
    source: 'docs/E2_2_E2E_LATENCY_BASELINE.md + E2_2_2_OVERPASS_PREFLIGHT_DIAG.md',
  },
  {
    route: 'N08',
    result: 'OK',
    rejectReason: null,
    totalMs: 364,
    phaseTimings: 'A~116–125 B~239 C~0 op~0',
    brouterCalls: 1,
    overpassCalls: 0,
    graphStatus: 'shadow off; PHYSICAL_CONNECTION_ONLY mask↔fairway candidate',
    geometryCoverageSignals: 'shared Kuibyshev lake; Phase B',
    source: 'docs/E2_2_E2E_LATENCY_BASELINE.md + E2_2_1_VGMID_FALLBACK_DIAG.md',
  },
  {
    route: 'Belomor',
    result: 'OK',
    rejectReason: null,
    totalMs: 365,
    phaseTimings: 'A~0 B~365 C~0 op~0 (full corridor oneshot)',
    brouterCalls: 1,
    overpassCalls: 0,
    graphStatus: 'shadow off; fixture DATA_GAP north tear (E2.3/E2.5 artifact)',
    geometryCoverageSignals:
      'Production BRouter full often OK; fixture chord ~34.8E vs OSM ~34.2–34.31E',
    source: 'docs/E2_2_E2E_LATENCY_BASELINE.md + BELOMOR_COVERAGE_REPORT.md + E2_5',
  },
  {
    route: 'X3',
    result: 'FLAKY',
    rejectReason: null,
    totalMs: 347,
    phaseTimings: 'A~0 B~347 C~0 op~0 (E2.2 sample OK via Phase B)',
    brouterCalls: 1,
    overpassCalls: 0,
    graphStatus: 'incomplete Cheboksary mask; no Vetluga centerline → NO_EVIDENCE graph',
    geometryCoverageSignals: 'preset fail_expected; E2.2 opportunistic BRouter OK ≠ stem proof',
    source: 'user-test-presets.ts + E2_2 baseline + E2_2_3 topology',
  },
  {
    route: 'L2',
    result: 'NOT_BENCHED',
    rejectReason: null,
    totalMs: null,
    phaseTimings: 'not in e22 cold table; ok_expected mid-pool Phase A target',
    brouterCalls: null,
    overpassCalls: null,
    graphStatus: 'Kuibyshev complete mask (E1)',
    geometryCoverageSignals: 'preset ok_expected; E1 Kuibyshev completeness gate',
    source: 'user-test-presets.ts + E1 full masks (21b571c)',
  },
];

/** Key pipeline commits affecting coverage / safety / fallback (forensic). */
export const E26_PIPELINE_CHANGES: PipelineChange[] = [
  {
    commit: '246a212',
    date: '2026-07-27',
    title: 'Fix inland waterway routing for rivers, lakes and reservoirs',
    subsystem: 'Overpass / graph snap',
    kind: 'ARCHITECTURE',
    summary:
      'Early Overpass-centric navigable graph; bbox queries included waterway relations + ways.',
    affectsRoutes: ['all'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: '612dadde',
    date: '2026-07-27',
    title: 'Fix inland routing UX — around-based Overpass',
    subsystem: 'Overpass query shape',
    kind: 'ARCHITECTURE',
    summary:
      'Switched primary fetch toward around-queries; still queried waterway relations around points.',
    affectsRoutes: ['all'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: '35bb549',
    date: '2026-07-27',
    title: 'Speed up inland routing — cell cache',
    subsystem: 'Overpass cell/around queries',
    kind: 'COVERAGE_REGRESSION',
    summary:
      'Introduced cellBboxQuery/aroundWaterQuery that fetch ways only (no waterway=canal/river relations). Parser still accepts relations if returned.',
    affectsRoutes: ['Belomor', 'VG-mid', 'X3'],
    safeToConsiderRestoringWithoutWeakeningSafety: true,
  },
  {
    commit: '54eb6e5',
    date: '2026-07-27',
    title: 'Skip Overpass hang for spans >120 km',
    subsystem: 'fallback / Overpass',
    kind: 'LATENCY_TRADEOFF',
    summary:
      'After BRouter fail, skip Overpass cell crawl when routeSpanKm>120 → span_gt_120. Prevents multi-minute empty hangs (Seliger→Vokhma). Coverage loss on long fail paths.',
    affectsRoutes: ['Belomor', 'VG-D'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: 'd59e0ef',
    date: 'pre-Phase',
    title: 'Recover Cheboksary–Kuibyshev via dense fairway snaps',
    subsystem: 'fairway / accept',
    kind: 'COVERAGE_FIX',
    summary: 'Softer land-cut + dense fairway snaps restored reservoir routes.',
    affectsRoutes: ['N06', 'N08', 'L2', 'X3'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: '4f60ab8',
    date: 'pre-Phase',
    title: 'Systemic Volga fairway recovery and softer accept',
    subsystem: 'accept thresholds / fairway',
    kind: 'COVERAGE_FIX',
    summary:
      'Softer excess (3.5×) and pin-scored fairway accept increased coverage; later safety work intentionally tightened this class of accept — restoring would weaken safety.',
    affectsRoutes: ['N06', 'N08', 'L2', 'X3', 'VG-mid'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: 'edd2603',
    date: 'pre-Phase',
    title: 'Harden water routing: no false directs, universal validator',
    subsystem: 'validator / safety',
    kind: 'SAFETY_HARDENING',
    summary: 'Banned START→FINISH chords; universal validator. Intentional coverage↓ for false OK.',
    affectsRoutes: ['all'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: 'f181ecb',
    date: '2026-08-25',
    title: 'Enforce START/FINISH reach within MAX water snap',
    subsystem: 'snap / endpoint reach',
    kind: 'SAFETY_HARDENING',
    summary:
      'MAX_WATER_SNAP_DISTANCE_METERS=3000; rejects far endpoint snaps (Volga→Vetluga false success).',
    affectsRoutes: ['X3', 'VETL', 'STEM'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: 'afc2623',
    date: '2026-08-25',
    title: 'BRouter first, polish in background',
    subsystem: 'routing architecture',
    kind: 'ARCHITECTURE',
    summary:
      'Critical path no longer waits on Overpass snap / Nominatim before paint. Changes failure order users observe.',
    affectsRoutes: ['all'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: '1e5bcfc',
    date: 'pre-Phase',
    title: 'Fix Moscow-canal spur bbox missing lonMax',
    subsystem: 'bbox / fairway rewrite',
    kind: 'COVERAGE_FIX',
    summary:
      'Unbounded lon≥37.545 spur rewrote Cheboksary/Kuibyshev tracks through Moscow Canal → reject. Example of real pipeline bbox regression then fix.',
    affectsRoutes: ['N06', 'N08', 'L2', 'X3'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: '21b571c',
    date: 'E1',
    title: 'Full Kuibyshev lake mask + completeness gate',
    subsystem: 'masks / Phase A',
    kind: 'COVERAGE_FIX',
    summary: 'Bundled complete Kuibyshev + partial Cheboksary masks; improved N06/N08/L2 Phase A.',
    affectsRoutes: ['N06', 'N08', 'L2', 'X3'],
    safeToConsiderRestoringWithoutWeakeningSafety: false,
  },
  {
    commit: '65dfe1d',
    date: '2026-08-27',
    title: 'E2.1 centerline ingest + belomor.geojson fixture',
    subsystem: 'WaterGraph fixture / ingest bbox',
    kind: 'FIXTURE_ARTIFACT',
    summary:
      'Simplified Belomor centerlines at lon≈34.77–34.9 create ~19 km DATA_GAP; real OSM relation 9909116 is ~34.20–34.31E. Default pad 0.35° misses western swing.',
    affectsRoutes: ['Belomor'],
    safeToConsiderRestoringWithoutWeakeningSafety: true,
  },
];

export const E26_HISTORICAL_FINDINGS: HistoricalFinding[] = [
  {
    route: 'VG-mid',
    historicalSuccess: 'NO_EVIDENCE',
    evidenceNotes: [
      'Preset coords (45.9,47.75)→(46.95,47.0) span≈115 km — not a Volga↔Akhtuba join test.',
      'E1.6/E1.7/E2.2 docs consistently FAIL: span_gt_120 or snap_empty; no saved OK trace for this A/B.',
      'VG-D (Volgograd→Astrakhan) CONFIRMED OK with good water clicks — likely confused with “VG-mid worked”.',
      'Graph fixture Volga↔Akhtuba: SEPARATE_WATER_OBJECT; no confirmed navigable connection evidence.',
    ],
    oldCommit: null,
    oldResult: null,
    currentResult: 'FAIL snap_empty (~16.6s Overpass hang after Phase C)',
    firstKnownRegressionCommit: null,
    changedSubsystem: 'snap / Overpass fallback (not a proven success→fail flip)',
    geometryDifference: 'OSM Volga present; Akhtuba branch separate; water-core sparse on Lower Volga',
    fallbackDifference:
      '≤120 km so Overpass still runs after snap_empty; empty cells ~16s (E2.2.1). >120 skip (54eb6e5) does not apply.',
    safetyDifference: 'No evidence that weaker safety ever made this A/B succeed',
    confidence: 'HIGH',
    gapKind: 'NO_EVIDENCE',
  },
  {
    route: 'N06',
    historicalSuccess: 'PROBABLY_WORKING',
    evidenceNotes: [
      'Current E2.2 baseline OK via Kuibyshev shared lake / Phase B.',
      'Preset flaky_or_unknown — historically sensitive to snap/mask.',
      'd59e0ef/4f60ab8 recovered cascade routes; 21b571c E1 mask made Phase A reliable.',
      '1e5bcfc documents a past bbox rewrite that falsely rejected cascade corridors (then fixed).',
    ],
    oldCommit: '21b571c',
    oldResult: 'OK expected after E1 complete Kuibyshev mask',
    currentResult: 'OK (~3.1s cold)',
    firstKnownRegressionCommit: null,
    changedSubsystem: 'masks / fairway (improved, not regressed in current baseline)',
    geometryDifference: 'Complete bundled Kuibyshev mask vs earlier tip-only Nominatim',
    fallbackDifference: 'Overpass not reached (accepted before overpass)',
    safetyDifference:
      'Post-edd2603/f181ecb/e0d0424 safety harder than soft-accept era — intentional',
    confidence: 'MEDIUM',
    gapKind: 'UNKNOWN',
  },
  {
    route: 'N08',
    historicalSuccess: 'PROBABLY_WORKING',
    evidenceNotes: [
      'E2.2 / E2.2.1 cold OK (~0.4–0.6s), 0 Overpass calls.',
      'Same Kuibyshev mask story as N06; preset still flaky_or_unknown for human testers.',
    ],
    oldCommit: '21b571c',
    oldResult: 'OK after E1 mask',
    currentResult: 'OK (~0.4s cold)',
    firstKnownRegressionCommit: null,
    changedSubsystem: 'masks / Phase A–B',
    geometryDifference: 'Kuibyshev mask coverage',
    fallbackDifference: 'No Overpass on success path',
    safetyDifference: 'Fairway≠navigability; E2.4 PHYSICAL_CONNECTION_ONLY only',
    confidence: 'MEDIUM',
    gapKind: 'UNKNOWN',
  },
  {
    route: 'Belomor',
    historicalSuccess: 'CONFIRMED_WORKING',
    evidenceNotes: [
      'USER_TEST_DIAGNOSTICS_01 + BELOMOR_COVERAGE_REPORT: full Povenets↔Belomorsk-ish BRouter OK ~216 km.',
      'E2.2 baseline: BELOMOR cold OK ~365 ms Phase B, 0 Overpass.',
      'Mid corridor: documented bogus-short BRouter — not a historical full-route success.',
      'Fixture DATA_GAP (~19 km at 34.8E) introduced with E2.1 belomor.geojson — not proof OSM missing.',
      'E2.5: OSM relation 9909116 FULL_GEOMETRY_FOUND at ~34.20–34.31E.',
    ],
    oldCommit: '8c595ea / 7406408 (documented OK)',
    oldResult: 'OK full corridor via BRouter',
    currentResult: 'OK full (production); fixture/graph DATA_GAP is ingest artifact',
    firstKnownRegressionCommit: '65dfe1d',
    changedSubsystem: 'WaterGraph fixture + WG_INGEST_CORRIDOR_PAD_DEG bbox',
    geometryDifference:
      'Fixture chord lon≈34.77–34.9 vs real canal ~34.20–34.31; water-core has 0 Belomor lines',
    fallbackDifference:
      'Full span≈185 km → if BRouter failed, 54eb6e5 skips Overpass (span_gt_120). Mid quality fails stay validator.',
    safetyDifference: 'NW via box caps ~63°N — coverage hole, not safety weaken',
    confidence: 'HIGH',
    gapKind: 'PIPELINE_ARTIFACT',
  },
  {
    route: 'X3',
    historicalSuccess: 'NO_EVIDENCE',
    evidenceNotes: [
      'Preset fail_expected: incomplete Cheboksary / Vetluga stem weakness.',
      'E2.2 sample OK via Phase B is opportunistic — not a stem-connection proof.',
      'E2.3/E2.4 graph: NO_EVIDENCE (incomplete mask, no Vetluga centerline).',
      'f181ecb endpoint-reach + STEM/VETL safety reject false Volga→Vetluga success.',
    ],
    oldCommit: null,
    oldResult: null,
    currentResult: 'FLAKY Phase B / fail_expected preset; graph NO_EVIDENCE',
    firstKnownRegressionCommit: null,
    changedSubsystem: 'mask completeness / Vetluga geometry / snap reach',
    geometryDifference: 'Partial Cheboksary mask; Vetluga absent from water-core and ingest',
    fallbackDifference: 'No Overpass on E2.2 OK sample; stem problem not recovered by lake Phase A',
    safetyDifference: 'Endpoint reach + stem guards are SAFETY_HARDENING, not accidental loss',
    confidence: 'MEDIUM',
    gapKind: 'DATA_GAP',
  },
  {
    route: 'L2',
    historicalSuccess: 'PROBABLY_WORKING',
    evidenceNotes: [
      'Preset ok_expected: E1 target complete Kuibyshev mid-pool Phase A.',
      'Not in E2.2 cold bench table; same mask family as N06/N08.',
      'No document of L2 historically FAIL after E1 masks.',
    ],
    oldCommit: '21b571c',
    oldResult: 'ok_expected Phase A',
    currentResult: 'ok_expected (not re-benched in E2.2 table)',
    firstKnownRegressionCommit: null,
    changedSubsystem: 'Kuibyshev mask',
    geometryDifference: 'Complete mask vs tip-only Nominatim (pre-E1)',
    fallbackDifference: 'Phase A open-lake path; Overpass not required',
    safetyDifference: 'Completeness gate rejects tip-only masks (safety+quality)',
    confidence: 'MEDIUM',
    gapKind: 'UNKNOWN',
  },
];

export function buildE26Report(): E26Report {
  const comparisonTable = E26_HISTORICAL_FINDINGS.map((f) => ({
    route: f.route,
    oldCommit: f.oldCommit,
    oldResult: f.oldResult,
    currentResult: f.currentResult,
    firstKnownRegressionCommit: f.firstKnownRegressionCommit,
    changedSubsystem: f.changedSubsystem,
    geometryDifference: f.geometryDifference,
    fallbackDifference: f.fallbackDifference,
    safetyDifference: f.safetyDifference,
    confidence: f.confidence,
  }));

  return {
    schemaVersion: 'e2.6-historical-routing-regression',
    useWaterGraphMustStayFalse: true,
    productionRoutingUnchanged: true,
    modernBaselines: E26_MODERN_BASELINES,
    historicalFindings: E26_HISTORICAL_FINDINGS,
    pipelineChanges: E26_PIPELINE_CHANGES,
    comparisonTable,
    answers: {
      evidenceRoutesWorkedBetterHistorically:
        'Partial. Confirmed historical full Belomor OK and VG-D OK with good snaps exist in-repo. No confirmed evidence that VG-mid (current A/B) or Volga↔Akhtuba ever succeeded. N06/N08/L2 are OK or improved after E1 masks. Soft-accept era (4f60ab8) likely felt “better” via weaker safety — not a restore candidate.',
      explanatoryChanges: [
        '54eb6e5: Overpass skip >120 km (latency vs long-fail coverage)',
        '35bb549: cell/around queries dropped waterway relation fetches (ways-only)',
        'afc2623: BRouter-first architecture changes observed failure order',
        'edd2603/f181ecb/e0d0424/3417e4d: safety hardenings rejecting false OK',
        '65dfe1d: Belomor simplified fixture + narrow ingest pad → false DATA_GAP',
        '1e5bcfc: past bbox bug pattern (cascade falsely rejected) — fixed',
      ],
      restorablesWithoutWeakeningSafety: [
        'Relation-aware / wider-bbox Belomor centerline ingest (E2.5 FULL_GEOMETRY_FOUND) — coverage only',
        'Optional: restore waterway relation clauses in Overpass cell/around queries (35bb549 inverse) behind diagnostics — does not soften validator/snap ceilings',
        'Do NOT restore soft excess 3.5×, remove endpoint-reach, or drop span_gt_120 without a safe alternative',
      ],
      dataGapVsRegression: {
        'VG-mid':
          'NO_EVIDENCE of prior success; current snap_empty + empty Overpass — data/snap quality, not proven pipeline regression from a working state',
        'VG-mid Volga↔Akhtuba':
          'SEPARATE_WATER_OBJECT — not a missing seam; joining would be incorrect',
        Belomor_production_full: 'CONFIRMED historically/currently often OK via BRouter',
        Belomor_fixture_DATA_GAP:
          'PIPELINE_ARTIFACT / ingest bbox (65dfe1d + pad 0.35°) — not global OSM hole',
        'N06/N08': 'Current OK; earlier flakiness improved by E1 masks — not an open regression',
        X3: 'DATA_GAP (Vetluga/mask) + safety guards; not proven coverage regression',
        L2: 'ok_expected after E1 — no regression evidence',
      },
    },
    belomor: {
      fixtureCorridorLon: '≈34.77–34.9E (simplified N–S chord)',
      realOsmLon: '≈34.20–34.31E (relation 9909116)',
      osmRelationId: 9909116,
      fixtureIntroducedIn: '65dfe1d (E2.1 centerline ingest)',
      classification:
        'FULL_GEOMETRY_FOUND in OSM; fixture DATA_GAP = PIPELINE_ARTIFACT (not production routing regression)',
    },
    summary:
      'Forensic only: real historical success evidence is strong for Belomor full + VG-D (good snaps), weak/absent for VG-mid A/B and Volga↔Akhtuba join. Belomor fixture DATA_GAP is an ingest/corridor artifact. Several “felt better” eras coincide with softer accept (safety tradeoff) or later-fixed bbox bugs — not safe rollbacks.',
  };
}

/** Pure helpers for tests / script formatting. */
export function evidenceClassFor(route: string): EvidenceClass | null {
  return E26_HISTORICAL_FINDINGS.find((f) => f.route === route)?.historicalSuccess ?? null;
}

export function pipelineChangesSafeToRestore(): PipelineChange[] {
  return E26_PIPELINE_CHANGES.filter((c) => c.safeToConsiderRestoringWithoutWeakeningSafety);
}

export function formatE26Markdown(report: E26Report = buildE26Report()): string {
  const lines: string[] = [
    '# E2.6 — Historical Routing Regression Archaeology',
    '',
    '**Status:** FORENSIC / DIAGNOSTIC ONLY. No production routing changes. `USE_WATER_GRAPH=false`.',
    '',
    report.summary,
    '',
    '## Modern baselines (control routes)',
    '',
    '| route | result | reject | totalMs | BR | OP | graph / geometry |',
    '| --- | --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const b of report.modernBaselines) {
    lines.push(
      `| ${b.route} | ${b.result} | ${b.rejectReason ?? '—'} | ${b.totalMs ?? '—'} | ${b.brouterCalls ?? '—'} | ${b.overpassCalls ?? '—'} | ${b.graphStatus} |`,
    );
  }
  lines.push(
    '',
    '## Historical success evidence',
    '',
    '| route | class | confidence | gapKind | first differing commit |',
    '| --- | --- | --- | --- | --- |',
  );
  for (const f of report.historicalFindings) {
    lines.push(
      `| ${f.route} | ${f.historicalSuccess} | ${f.confidence} | ${f.gapKind} | ${f.firstKnownRegressionCommit ?? '—'} |`,
    );
  }
  lines.push('', '## Comparison table', '', '| route | oldCommit | oldResult | currentResult | subsystem | geometry | fallback | safety | confidence |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of report.comparisonTable) {
    lines.push(
      `| ${r.route} | ${r.oldCommit ?? '—'} | ${r.oldResult ?? '—'} | ${r.currentResult} | ${r.changedSubsystem} | ${r.geometryDifference} | ${r.fallbackDifference} | ${r.safetyDifference} | ${r.confidence} |`,
    );
  }
  lines.push('', '## Pipeline changes of interest', '');
  for (const c of report.pipelineChanges) {
    lines.push(
      `- \`${c.commit}\` (${c.date}) **${c.kind}** — ${c.title}: ${c.summary} _restore-safe? ${c.safeToConsiderRestoringWithoutWeakeningSafety}_`,
    );
  }
  lines.push(
    '',
    '## Belomor',
    '',
    `- Fixture corridor: ${report.belomor.fixtureCorridorLon}`,
    `- Real OSM: ${report.belomor.realOsmLon} (relation ${report.belomor.osmRelationId})`,
    `- Fixture since: ${report.belomor.fixtureIntroducedIn}`,
    `- ${report.belomor.classification}`,
    '',
    '## Key answers',
    '',
    `1. ${report.answers.evidenceRoutesWorkedBetterHistorically}`,
    '',
    '2. Explanatory changes:',
    ...report.answers.explanatoryChanges.map((x) => `   - ${x}`),
    '',
    '3. Restorable without weakening safety:',
    ...report.answers.restorablesWithoutWeakeningSafety.map((x) => `   - ${x}`),
    '',
    '4. DATA_GAP vs REGRESSION:',
    ...Object.entries(report.answers.dataGapVsRegression).map(
      ([k, v]) => `   - **${k}**: ${v}`,
    ),
    '',
    '## Explicitly not done',
    '',
    '- No rollback, no seam, no threshold/safety/BRouter/Overpass runtime/UI changes',
    '- No ACCEPT/REJECT policy change',
    '',
  );
  return lines.join('\n');
}
