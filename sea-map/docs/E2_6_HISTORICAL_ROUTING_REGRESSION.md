# E2.6 — Historical Routing Regression Archaeology

**Status:** FORENSIC / DIAGNOSTIC ONLY.  
**No** production routing, thresholds, safety, BRouter, Overpass runtime, UI, accept/reject, or `USE_WATER_GRAPH` changes (`USE_WATER_GRAPH=false`).  
**No** rollback, seams, or synthetic geometry.

Script: `npx tsx scripts/e26-historical-routing-regression.ts`  
Module: `src/e26-historical-routing-regression.ts`

---

## A. Changed files

| Path | Role |
| --- | --- |
| `docs/E2_6_HISTORICAL_ROUTING_REGRESSION.md` | This report |
| `src/e26-historical-routing-regression.ts` | Deterministic evidence model + markdown |
| `scripts/e26-historical-routing-regression.ts` | CLI (optional `--verify-git`, read-only) |
| `src/__tests__/e26-historical-routing-regression.test.ts` | Reporting/classification tests only |

---

## B. Commit / PR

See PR for this branch (`cursor/aquaroute-e26-historical-regression-arch-eb0a`). Base: E2.5 Belomor recovery branch.

---

## C. Tests / build

- `vitest` E2.6 suite: classification/reporting only (no live routing).
- Full `npm test` must PASS; production behavior unchanged.

---

## 1. Modern baselines (control routes)

Sources: `E2_2_E2E_LATENCY_BASELINE.md`, `E2_2_1_VGMID_FALLBACK_DIAG.md`, `E2_2_2_OVERPASS_PREFLIGHT_DIAG.md`, presets, E2.3–E2.5 graph docs. **No uncontrolled mass Overpass.**

| route | result | rejectReason | totalMs | BR calls | OP calls | phase / graph / coverage |
| --- | --- | --- | ---: | ---: | ---: | --- |
| **VG-mid** | FAIL | `snap_empty` | ~16645 | 3 | ~8 | A~0 B~617 C~18 then ~16s empty Overpass; span~115; graph Volga↔Akhtuba **SEPARATE** |
| **N06** | OK | — | ~3151 | 1 | 0 | Phase B; shared Kuibyshev; graph PHYSICAL_CONNECTION_ONLY |
| **N08** | OK | — | ~364 | 1 | 0 | Phase B; shared lake |
| **Belomor** | OK | — | ~365 | 1 | 0 | Phase B full oneshot; fixture still shows north DATA_GAP (E2.5 artifact) |
| **X3** | FLAKY | — | ~347 (E2.2 OK sample) | 1 | 0 | preset `fail_expected`; graph **NO_EVIDENCE** |
| **L2** | NOT_BENCHED (e22) | — | — | — | — | preset `ok_expected`; E1 Kuibyshev mid-pool |

Coordinates (bench/presets):

| route | A | B | ≈geo km |
| --- | --- | --- | ---: |
| VG-mid | 45.9E 47.75N | 46.95E 47.0N | 115 |
| Belomor | 34.82E 62.86N | 34.77E 64.52N | 185 |
| N06 / N08 / X3 / L2 | `user-test-presets.ts` | | 34–114 |

---

## 2–3. Git history focus + evidence rule

Investigated: `waterways.ts`, snap/candidates/validator, Overpass cell/around, masks, Phase A/B/C, fairway, WaterGraph ingest/fixtures, Belomor/Lower Volga docs.

**Rule applied:** old code existing ≠ route worked. Required fixtures, docs, benchmarks, commit/PR text, presets, or saved diagnostics.

---

## D. Per-route historical success

| route | class | notes |
| --- | --- | --- |
| VG-mid (bench A/B) | **NO_EVIDENCE** | E1.6→E2.2 consistently FAIL; no OK trace for this A/B |
| VG-mid as Volga↔Akhtuba | **NO_EVIDENCE** | Graph SEPARATE; never confirmed navigable join |
| N06 | **PROBABLY_WORKING** | OK now; E1 mask era; preset still flaky hint |
| N08 | **PROBABLY_WORKING** | OK now; same mask family |
| Belomor full | **CONFIRMED_WORKING** | USER_TEST + E1.6 + E2.2 OK ~216 km / ~365 ms |
| Belomor mid | (quality gap) | Bogus-short BRouter documented — not historical full success |
| X3 | **NO_EVIDENCE** | `fail_expected`; incomplete mask + missing Vetluga |
| L2 | **PROBABLY_WORKING** | `ok_expected` after E1 |

---

## E–I. Comparison table

| route | oldCommit | oldResult | currentResult | firstKnownRegressionCommit | changedSubsystem | geometryDifference | fallbackDifference | safetyDifference | confidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| VG-mid | — | — | FAIL snap_empty | — (no proven working baseline) | snap / Overpass | Volga present; Akhtuba separate | ≤120 → Overpass still runs, empty ~16s | no weaker-safety success evidence | HIGH |
| N06 | 21b571c | OK after E1 mask | OK ~3s | — | masks / Phase A–B | complete Kuibyshev | Overpass not reached | harder than soft-accept era | MEDIUM |
| N08 | 21b571c | OK after E1 | OK ~0.4s | — | masks | Kuibyshev | no OP | fairway≠navigability | MEDIUM |
| Belomor | 8c595ea / 7406408 docs | OK full BRouter | OK full; fixture DATA_GAP | **65dfe1d** (fixture/ingest only) | fixture + ingest bbox | chord 34.8E vs OSM 34.2E | if BRouter fail → span_gt_120 skip OP | NW via box ≤63°N coverage | HIGH |
| X3 | — | — | FLAKY / fail_expected | — | mask / Vetluga / reach | Vetluga absent | lake Phase A cannot fix stem | f181ecb + STEM guards | MEDIUM |
| L2 | 21b571c | ok_expected | ok_expected | — | Kuibyshev mask | complete vs tip-only | Phase A | completeness gate | MEDIUM |

---

## J. Belomor historical finding

1. **Production full corridor:** CONFIRMED often OK via BRouter (diagnostics + E2.2). Not a current global “Belomor always FAIL”.
2. **Fixture DATA_GAP (~19 km):** introduced with **`65dfe1d`** (`belomor.geojson` lon≈34.77–34.9). Real canal (relation **9909116**) at ≈**34.20–34.31E** (E2.5 `FULL_GEOMETRY_FOUND`).
3. **Corridor/bbox:** default `WG_INGEST_CORRIDOR_PAD_DEG=0.35` cuts lon ≲34.42 → misses western swing. **PIPELINE_ARTIFACT**, not OSM hole.
4. **Earlier Overpass:** `246a212` queried waterway **relations**; cell/around path from **`35bb549`** is **ways-only** (relations still parsed if present). Coverage regression candidate for relation-centric canals — restore-safe as query widening, not safety soften.
5. **`54eb6e5`:** skip Overpass when span>120 — Belomor geo≈185 km; if BRouter fails, no Overpass recovery (latency tradeoff). Mid fails remain BRouter quality / validator.

**Verdict:** Belomor “DATA_GAP” in WaterGraph fixtures is **ingest/fixture regression artifact**. Production full route evidence does **not** show a fall from working→broken in the E2 era; mid quality was already bad in USER_TEST_DIAGNOSTICS_01.

---

## K. N06 / N08 historical finding

- **Geometry:** Kuibyshev open-lake mask (E1 `21b571c`) is the main coverage win; fairway remains soft evidence only (E2.4 PHYSICAL_CONNECTION_ONLY).
- **Snap / candidates:** Phase C not needed on current OK path; BRouter 1 call.
- **Fallback:** Overpass not reached when Phase A/B accept.
- **Fairway hard/soft:** soft-accept / dense fairway era (`d59e0ef`, `4f60ab8`) then **safety harden** (`edd2603`, `e0d0424`, …). Current OK is mask+BRouter, not restored soft excess.
- **Past real pipeline bug:** `1e5bcfc` Moscow-canal spur missing `lonMax` falsely wrecked cascade Volga tracks — fixed; pattern of bbox coverage loss.

**Do not conclude** “old code was correct because coverage was higher” for the soft-accept window — that was partly **SAFETY** tradeoff.

---

## L. VG-mid historical finding

Two different meanings were mixed in conversation:

| Meaning | Evidence |
| --- | --- |
| Bench **VG-mid** A/B on Lower Volga stem | **NO_EVIDENCE** of historical OK; docs show FAIL |
| **Volga ↔ Akhtuba** navigable join | **NO_EVIDENCE**; graph SEPARATE_WATER_OBJECT; must not join |
| **VG-D** Volgograd→Astrakhan | **CONFIRMED_WORKING** with good water clicks (USER_TEST / LOWER_VOLGA reports) |

User memory that “VG-mid worked” most likely maps to **VG-D** or softer cascade accept — **not** proven for current VG-mid coords or Akhtuba cross.

Current fail chain: Phase C `snap_empty` → Overpass cell-batch empty (~16s) → still `snap_empty`. Span≈115 ≤120 so **`54eb6e5` skip does not apply**.

---

## M. X3 historical finding

| Label | Choice |
| --- | --- |
| Classification | **DATA_GAP** (+ safety guards) |
| Alternate | **NO_EVIDENCE** of reliable historical stem success |
| Not chosen | DATA_REGRESSION (no commit shows working Vetluga stem then loss) |

Incomplete Cheboksary mask + missing Vetluga centerline (E2.3). Endpoint-reach (`f181ecb`) and STEM/VETL rejects are **SAFETY_HARDENING**. E2.2 Phase B OK sample ≠ stem proof.

---

## Removed / narrowed capabilities (coverage archaeology)

| Change | Commit | Type |
| --- | --- | --- |
| Overpass skip span>120 | `54eb6e5` | LATENCY_TRADEOFF (coverage↓ on long fail) |
| Cell/around drop waterway relations | `35bb549` | COVERAGE_REGRESSION candidate |
| Soft excess / soft land-cut accept | reversed by later harden | SAFETY (intentional coverage↓) |
| Belomor simplified fixture + narrow pad | `65dfe1d` | FIXTURE_ARTIFACT |
| Moscow spur bbox unbounded | `1e5bcfc` (fixed) | past COVERAGE_REGRESSION |

**COVERAGE REGRESSION** vs **SAFETY REGRESSION** are separated above. Softening safety to regain coverage is **out of scope / not recommended**.

---

## Key answers (mandatory)

### 1. Evidence that routes worked better historically?

**Partial yes:** Belomor **full** and VG-**D** (good snaps) have in-repo confirmation. **No** confirmation for current VG-mid A/B or Volga↔Akhtuba. N06/N08/L2 are OK or better after E1 masks. Soft-accept era likely felt better via weaker gates.

### 2. Which changes could explain that feeling?

- Soft accept / dense fairway (`4f60ab8`, `d59e0ef`) later hardened  
- BRouter-first (`afc2623`) changes what fails first  
- Long-span Overpass skip (`54eb6e5`)  
- Ways-only Overpass cells (`35bb549`)  
- Belomor fixture/ingest chord (`65dfe1d`) for **graph** diagnostics  
- Occasional bbox bugs (`1e5bcfc`)  

### 3. Restorable without weakening current safety?

- **Yes (coverage-only candidates):** relation-aware / wider Belomor ingest (E2.5); optionally re-add waterway relation clauses to Overpass cell/around queries.  
- **No:** soft excess 3.5×, drop endpoint reach, remove `span_gt_120` without a safe substitute, join Volga↔Akhtuba.

### 4. True DATA_GAP vs pipeline REGRESSION?

| Item | Kind |
| --- | --- |
| Belomor fixture mid tear | **PIPELINE_ARTIFACT / ingest REGRESSION** (OSM has geometry) |
| Belomor mid BRouter quality | ROUTING quality (not OSM absence) |
| VG-mid snap_empty | snap/data quality; **NO_EVIDENCE** of prior success |
| Volga↔Akhtuba | separate objects — not a gap to sew |
| X3 Vetluga/mask | **DATA_GAP** |
| N06/N08 current | **not** an open regression |

---

## Explicitly not done

No fixes, no rollback, no seams, no threshold/UI/routing changes. Stop after this report.
