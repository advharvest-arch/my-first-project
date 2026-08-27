# E1.7 — Long-Span Routing Report

**Status:** E1.7_READY (experiments + reports). Production routing **unchanged** (flags default off).  
**Commit base:** E1.6 `7406408`

## A. Baseline (flag defaults)

| route | total_ms | brouter_ms | brouter_calls | trials | method | ok | reject / failure |
| --- | ---: | ---: | ---: | ---: | --- | --- | --- |
| L01 | 63 | 0 | 0 | 0 | lake | Y | — |
| L05 | 692 | ~ | 1 | 0 | lake | Y | — |
| L07 | 547 | 0 | 0 | 0 | lake | Y | — |
| R01 | 640 | ~ | 1 | 0 | lake | Y | — |
| R03 (N03 stand-in) | 14 | 0 | 0 | 0 | lake | Y | — |
| VG-D | 332 | ~ | 1 | 0 | waterway | Y | — |
| VG-mid | 2478 | ~ | ≥1 | >0 | route_not_found | N | `span_gt_120` / data_gap |
| BELOMOR | 468 | ~ | 1 | 0 | waterway | Y | — |

Reproduce: `cd sea-map && npm run bench:e17`

## B. Cache

VG-D warm second request: **~28 ms**, `brouter_calls=0`, `cacheHits=1` (success TTL).  
Dedup key = `profile` + lon/lat to **6 dp** (nearby points not merged).

## C. Segmentation (`USE_LONG_SPAN_SEGMENTATION`)

| mode | VG-D | VG-mid | BELOMOR |
| --- | --- | --- | --- |
| monolithic | OK ~411 ms | FAIL `span_gt_120` ~11 s | OK ~144 ms |
| flag on (fallthrough) | OK via Phase B | FAIL `span_gt_120` | OK via Phase B |
| **direct segmented** | **FAIL `joint_snap_fail`** | **FAIL `joint_snap_fail`** | **FAIL `joint_snap_fail`** |

### Root cause (segmentation)

Water-aware joints require snap to OSM waterway/fairway/mask.

- Lower Volga: **no regional fairway** within ~700 km of corridor (VOLGA_NAV is upper cascade).
- Belomor: outside NW via box; no curated fairway.
- Cell Overpass warm often empty/flaky in this environment → `snapClickToWater` returns null → `joint_snap_fail`.

**Segmentation cannot invent centerline.** Without Hybrid WaterGraph / proven centerline, joints cannot be placed safely (geodesic joints are forbidden).

## D. Candidate budget (`PHASE_C_MAX_PAIRS_OVERRIDE`)

On L07/L05 Phase A often wins → trials stay 0 (budget irrelevant).  
Useful when Phase C is reached (N06/N08/VG failure paths). **Production default remains 9.** Recommendation: keep 9 until Phase-C-heavy corridors are benchmarked with forced B-fail; tentatively **5** is a future A/B candidate only behind flag.

## E. Parallel prototype (`USE_PARALLEL_CANDIDATES`)

L07 seq / parallel(2) / parallel(3): identical (~530 ms, Phase A lake) — no Phase C work.  
**No reliability signal** on this sample. Cap remains ≤3; do not enable in production without Phase-C-heavy stress.

## F. Lower Volga

| Case | Monolithic | Segmented |
| --- | --- | --- |
| VG-D good snaps | OK ~460 km track | Joint snap fails → fallthrough OK |
| VG-mid | Often `span_gt_120` | Joint snap fails → same gate |
| Intermediate→Astrakhan | Endpoint-sensitive | Needs centerline |

**Conclusion:** segmentation does **not** yet solve Lower Volga long-span without WaterGraph/centerline. Snap quality + `span_gt_120` remain the gates.

## G. Belomor segment coverage table

Direct BRouter probes on geodesic midpoints (search seeds only — not production joints):

| segment | geo_km | BRouter | valid | reason |
| --- | ---: | --- | --- | --- |
| 0 Povenets→~63.2 | 38 | fail* | N | brouter_fail / provider |
| 1 mid | 33.5 | fail* | N | brouter_fail |
| 2 mid | 44.7 | fail* | N | brouter_fail / historically bogus_short |
| 3 →Belomorsk | 69 | fail* | N | brouter_fail |

\*Environment-dependent; prior E1.6 probes saw full-corridor OK and mid bogus_short.  
OSM canal geometry: **present**. Lock portals: **not modeled**. DATA_GAP for AquaRoute graph north of 63°N.

## H. Safety

Unchanged: MAX_WATER_SNAP, residuals, STEM/VETL/DAM, hydro-gate, Dubna/Rybinsk.  
Segment chains must pass full `validateWaterRoute` + hydro on stitched geometry (implemented; not reached when joints fail).

## I. AI-ready signals (no AI code)

RouteTrace now carries: `performance.brouterCalls|CacheHits|Misses|dedupedRequests|candidateTrials`, `longSpan{enabled,segmented,segmentCount,failedSegment,seamFailures}`, `segments[]`, `failure.category` including `seam_failure`.

### Future training signals (≥5)

1. Repeated failure at same corridor  
2. Snap / joint_snap failure  
3. BRouter fail / bogus_short  
4. User-selected alternative bind  
5. User correction after not-found  
6. Success after segmentation (when joints exist)  
7. Success after mask / Phase A  
8. Official/open-data disagreement (knowledge)

## Decision gate

**CASE B + D:** Segmentation improves architecture readiness and diagnostics, but **does not solve** Belomor / Lower Volga without centerline data → **prepare E2 Hybrid WaterGraph**. BRouter RTT remains primary latency bottleneck (CASE C also applies).

| Merge now | Flag-only | Needs E2 |
| --- | --- | --- |
| RouteTrace longSpan/segments, cache stats, Overpass warm catch | `USE_LONG_SPAN_SEGMENTATION`, `USE_PARALLEL_CANDIDATES`, pair budget override | Water-aware centerline, lock portals, Lower Volga/Belomor graph |

## Strategy scorecard

| strategy | success | latency | BRouter calls | quality | production-safe |
| --- | --- | ---: | ---: | --- | --- |
| current | high on warm snaps | 0.3–0.7 s typical | 0–1 | good | yes |
| cache | same | **15×** on hit | 0 on hit | same | yes (TTL) |
| segmentation | blocked on joint snap | n/a | n/a | n/a until centerline | flag off |
| candidate budget | same when Phase A wins | — | — | TBD Phase C | flag null |
| parallel ≤3 | same on L07 | same | same | same | flag off |
