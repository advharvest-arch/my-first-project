# E2.11 — Shadow WaterGraph vs legacy real-corridor benchmark

**Status:** DIAGNOSTIC / BENCHMARK ONLY.  
`USE_WATER_GRAPH` **defaults false** — production routing unchanged.  
No seams, no synthetic geometry, no Volga↔Akhtuba sewing, no safety threshold changes.

Script: `npx tsx scripts/e211-watergraph-vs-legacy-bench.ts`  
(`--offline` = Belomor/VG-D/VG-mid fixtures; `--quick` = Belomor+VG-mid cold)  
Module: `src/watergraph-vs-legacy-bench.ts`  
npm: `npm run bench:e211`

---

## Question

On corridors where **legacy already builds a safe route**, how far is WaterGraph from being able to **reproduce** that result under the **same** safety stack — without inventing topology?

## Method

For each corridor, same A/B:

1. **Legacy** — `measureWaterChain` with `USE_WATER_GRAPH=false`
2. **WaterGraph shadow** — independent `runWaterGraphShadow` + existing `validateWaterRoute` / hydro / barriers / chord guards

Repeats: **cold → warm → cold_cleared** (provider + cell cache clear). Graph has no persistent cache.

### Centerline sources (explicit)

| Corridor | Source |
| --- | --- |
| BELOMOR | E2.10 relation-aware OSM snapshot (rel 9909116) |
| N06 / N08 / L2 | Live Overpass corridor ingest + lake/fairway layers |
| VG-D | Fixture `lower-volga.geojson` |
| VG-mid | Fixture `lower-volga-mid.geojson` (negative control) |

Missing connectivity is recorded as **DATA GAP / NEEDS_DATA**, not patched with seams.

## Summary table (representative: cold_cleared)

| route | legacy | graph | both_ok | graphKm | legacyKm | delta% | graphSafety | components | graphBuildMs | graphSearchMs | verdict |
| --- | --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
| BELOMOR | OK 215.852 | OK 217.031 | true | 217.031 | 215.852 | 0.55 | accepted | 3 | 5.089 | 2.585 | GRAPH_PROMISING |
| N06 | OK 76.39 | FAIL graph_disconnected | false | — | 76.39 | — | graph_disconnected | 55 | 50.016 | 0.351 | GRAPH_NEEDS_DATA |
| N08 | OK 41.896 | FAIL graph_disconnected | false | — | 41.896 | — | graph_disconnected | 115 | 112.422 | 0.023 | GRAPH_NEEDS_DATA |
| L2 | OK 40.042 | OK 45.622 | true | 45.622 | 40.042 | 13.94 | accepted | 90 | 61.334 | 0.13 | GRAPH_PROMISING |
| VG-D | OK 455.693 | FAIL near_geodesic_chord | false | — | 455.693 | — | near_geodesic_chord | 4 | 2.05 | 0.382 | GRAPH_REJECTS_SAFE_ROUTE |
| VG-mid | FAIL snap_empty | FAIL near_geodesic_chord | false | — | — | — | near_geodesic_chord | 4 | 1.338 | 0.638 | CONTROL_CORRECTLY_REJECTED |

## Verdict meanings

| Verdict | Meaning |
| --- | --- |
| GRAPH_PROMISING | both_ok under full safety; length within diagnostic band |
| GRAPH_NEEDS_DATA | Legacy OK; graph disconnected / missing usable topology |
| GRAPH_TOPOLOGY_RISK | Accepted sew / barrier / severe geometry divergence |
| GRAPH_REJECTS_SAFE_ROUTE | Legacy OK; graph finds no *safe* path (e.g. chord reject) |
| CONTROL_CORRECTLY_REJECTED | Negative control correctly does not accept a path |

## Divergence cases

- **N06 / N08:** Overpass ways present but fragmented → many components → `graph_disconnected` while legacy lake path succeeds → **GRAPH_NEEDS_DATA**
- **VG-D:** Fixture topology yields a path rejected by `near_geodesic_chord` → **GRAPH_REJECTS_SAFE_ROUTE** (not sewn; safety held)
- **VG-mid:** Legacy fails (`snap_empty`); graph also fails safety (`near_geodesic_chord`) — **no accepted Volga↔Akhtuba sew** → **CONTROL_CORRECTLY_REJECTED**
- **Safety failures (accepted bad path):** none in this run
- **Seam edges:** 0 on all corridors

## Timing (not UI speedup)

`graphSearchMs` / `graphBuildMs` are **shadow-only**. While `USE_WATER_GRAPH=false`, they are **potential** savings only.

| corridor | legacy E2E (cold_cleared) | graphBuildMs | graphSearchMs | shadowWallMs* |
| --- | ---: | ---: | ---: | ---: |
| BELOMOR | ~136 ms | ~5 | ~2.6 | ~9 |
| L2 | ~218 ms | ~61 | ~0.1 | ~2.8 s† |
| N06 | ~3.4 s | ~50 | ~0.4 | ~1.0 s† |
| N08 | ~0.6 s | ~112 | ~0.02 | ~6.1 s† |

\* Includes ingest+build+search for the shadow pass.  
† Shadow wall for Kuibyshev includes **Overpass centerline ingest** cost — often larger than Dijkstra search. Do not call this “app faster”.

Belomor shows the clearest *potential* graph-first latency advantage **if** production enablement is later approved (search+build ≪ BRouter E2E on a warm-ish corridor).

## Cold / warm / cold_cleared

All three modes were run per corridor. Verdicts were stable across modes. Warm reduces legacy BRouter time where cache hits (e.g. Belomor warm ~11 ms legacy); graph rebuild is still per-request (no graph cache).

## RouteTrace

Optional `waterGraphBenchmark` block attached by the E2.11 runner via `replaceLastRouteTrace` (does not change `final`). Existing schema fields preserved.

## What this proves

1. **Belomor + relation-aware** can safely mirror legacy length (~0.55% delta) under current validators → first production-quality *pattern* candidate (still shadow-only).
2. **L2** can both_ok with Overpass+layers (~14% longer) → promising but needs geometry sample review before enablement.
3. **N06/N08** show objective **topology/data** gap: raw OSM centerlines ≠ navigable Kuibyshev connectivity that lake/BRouter provides.
4. **VG-D** fixture path is not yet a safe WaterGraph replacement (chord guard fires).
5. **VG-mid** control: WaterGraph does **not** accept an artificial Volga↔Akhtuba join.

## Production status

**Do not enable `USE_WATER_GRAPH`.** No Phase/BRouter/threshold/hydro changes in this stage.
