# E2.12 — Source-by-source route forensics

**Status:** DIAGNOSTIC / RESEARCH ONLY.  
`USE_WATER_GRAPH=false`. No seams, no synthetic geometry, no safety/BRouter/threshold changes.

Script: `npx tsx scripts/e212-source-forensics.ts` (`--quick` = Belomor+VG-D+VG-mid)  
Module: `src/source-by-source-forensics.ts`

---

## Evidence table

| route | legacyResult | graphResult | legacyGeometrySource | graphGeometrySource | OSMWays | OSMRelations | MaskAvailable | MaskUsedByGraph | FairwayAvailable | LocksAvailable | graphComponents | graphPathKm | legacyPathKm | graphRejectReason | missingEvidence | verdict |
| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| BELOMOR | OK 215.852km (waterway) | OK 217.031km | phase_B_brouter:waterway | relation_aware_snapshot:9909116 | 29 | 9909116 | false | false | false | true | 3 | 217.031 | 215.852 | — | — | GRAPH_AND_LEGACY_SHARE_DATA |
| N06 | OK 76.39km (lake) | FAIL graph_disconnected | phase_B_brouter:lake (Kuibyshev) | overpass | 120 | — | true | false | true | true | 62 | — | 76.39 | graph_disconnected | brouter_geometry; connected_mask_mesh_in_graph; connected_centerline_component | LEGACY_HAS_ADDITIONAL_DATA |
| N08 | OK 41.896km (lake) | FAIL graph_disconnected | phase_B_brouter:lake (Kuibyshev) | overpass | 179 | — | true | false | true | true | 71 | — | 41.896 | graph_disconnected | brouter_geometry; connected_mask_mesh_in_graph; connected_centerline_component | LEGACY_HAS_ADDITIONAL_DATA |
| VG-D | OK 455.693km (waterway) | FAIL near_geodesic_chord | phase_B_brouter:waterway | fixture:lower-volga | 5 | Volga/Akhtuba fixtures | false | false | false | true | 4 | raw≈373 | 455.693 | near_geodesic_chord | meander_fidelity_vs_brouter | GRAPH_GEOMETRY_SUSPECT |
| VG-mid | FAIL snap_empty | FAIL near_geodesic_chord | legacy reject | fixture:lower-volga-mid | 2 | Volga+Akhtuba | false | false | false | true | 4 | — | — | near_geodesic_chord | none_expected | CONTROL_CORRECT |

---

## 1. Belomor — why both succeed

| | Legacy | Graph |
| --- | --- | --- |
| Source | BRouter water profile | OSM relation **9909116** (29 `main_stream` ways, E2.10 snapshot) |
| Length | ~215.9 km | ~217.0 km |
| Safety | accepted | accepted |

They do **not** share the same bytes. They share **equivalent canal coverage**: BRouter already knew the corridor; relation-aware ingest restored OSM centerlines WaterGraph lacked under the fixture chord. Verdict: **GRAPH_AND_LEGACY_SHARE_DATA**.

---

## 2. N06 / N08 — what legacy has that graph lacks

### Legacy (actual RouteTrace)

- Phase A `open_lake_fail` (mask A* does **not** win).
- Phase B **BRouter** succeeds with `method=lake` on shared **Куйбышевское водохранилище**.
- Coverage: `maskCoverage=hit`, `fairwayCoverage=miss`.

### Graph (E2.11-style shadow wiring)

- Overpass ways: N06≈120, N08≈179 → **many components** (62 / 71) → `graph_disconnected`.
- Kuibyshev **mask exists** (complete; densified A–B lookup works).
- `cachedLakeMaskAlongPath([A,B])` returns **null** (needs ≥3 bbox hits) → **maskUsedByGraph=false**.
- Fairway/lock layers may be present; they do not bridge the fragmented centerlines for these endpoints.

### Hypothesis check (mask mesh)

> OSM centerline fragmented + open-water mask exists ⇒ graph *could* traverse via mask mesh.

**Evidence:** mask **available** and complete; mask **not used** by current shadow wiring; OSM centerlines **not connected**.  
**Not implemented** in E2.12 — only proven as missing wiring/data-use, not as a shipped fix.

Verdict: **LEGACY_HAS_ADDITIONAL_DATA** (primarily **BRouter** geometry; secondarily unused mask mesh opportunity).

---

## 3. VG-D — near_geodesic_chord (A or B?)

| Metric | Value |
| --- | --- |
| A↔B geodesic | ~369.7 km |
| Graph raw path | ~373.1 km (193 pts) |
| ratio raw/geo | **1.009** (≤1.04 → guard fires) |
| max graph edge | **~1.98 km** |
| edges >20 km | **0** |
| Legacy BRouter | ~455.7 km |

**Interpretation:** not a single long seam/chord edge. Overall fixture path is **near-geodesic** vs A↔B (over-simplified meander vs BRouter). Guard behaves as designed for non-`openWaterVerified` waterway paths.

- **A (shortcut seam)?** No single long edge — but overall geometry is suspect (too short/straight).
- **B (guard wrong)?** No — length ratio matches the rule; BRouter is ~82 km longer (real navigable meander).

Verdict: **GRAPH_GEOMETRY_SUSPECT** (lean A / fidelity, not B).

---

## 4. VG-mid control

Both reject; `seamCount=0`; Volga/Akhtuba remain separate. **CONTROL_CORRECT**.

---

## What legacy can that graph cannot

- N06/N08: **BRouter** lake-corridor tracks while OSM centerlines stay fragmented and mask mesh is not wired into the 2-point shadow lookup.
- VG-D: **BRouter meander** (~456 km) vs near-geodesic fixture path (~373 km).
- Belomor: BRouter still works independently (graph does not need it for shadow success).

## What graph can (independently)

- Belomor: validated ~217 km path from **OSM relation alone** (no BRouter in shadow).
- VG-D: can *find* a raw path on fixture centerlines — but safety correctly rejects it.

## UNKNOWN

- Exact N06/N08 Phase A `open_lake_fail` sub-cause (snap vs incomplete mask path) beyond RouteTrace `open_lake_fail` — while Phase B BRouter succeeds.
- Dense point-to-point Hausdorff Belomor BRouter↔OSM overlay (length match only).

---

## Production

**Do not enable.** E2.12 ends at knowledge: missing **BRouter / connected mask use / meander fidelity**, not a green light to weaken `near_geodesic_chord` or sew lakes.
