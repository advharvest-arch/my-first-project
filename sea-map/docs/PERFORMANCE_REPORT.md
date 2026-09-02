# E1.6 — PERFORMANCE_REPORT

Generated from live `npm run bench:e16` + cache micro-bench (2026-08-27).  
Environment: Cloud Agent VM; BRouter/Overpass network dependent. Warm `water-core` seed present.

## Baseline table

| route | total_ms | brouter_ms | overpass_ms | candidates | trials | cache_hit | final_method |
| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |
| L01 | 515 | 0 | 0 | 0 | 0 | N | lake (Phase A) |
| L05 | 726 | 486 | 0 | 0 | 0 | N | lake (Phase B) |
| L07 | 552 | 0 | 0 | 0 | 0 | N | lake (Phase A) |
| R01 | 270 | 136 | 0 | 0 | 0 | N | lake (Phase B) |
| R03 (N03 stand-in) | 344 | 0 | 0 | 0 | 0 | N | lake (Phase A) |
| VG-D Volgograd→Astrakhan | 208 | 176 | 0 | 0 | 0 | N | waterway (Phase B) |
| KIM→Volga | 542 | 485 | 0 | 0 | 0 | N | waterway (Phase B) |
| BELOMOR corridor | 134 | 122 | 0 | 0 | 0 | N | waterway (Phase B) |

Notes:

- **N03** is not in `USER_TEST_PRESETS`; **R03** used as medium open-lake control.
- Success-path Phase B/A dominates; Phase C trials = 0 when Phase A/B accept.
- Failure / Phase C paths (≤9 BRouter trials) are the high-latency regime (see TOP-5).

### BRouter result cache (same VG-D, successive requests)

| pass | total_ms | brouter_ms | brouter_calls | cacheHits |
| --- | ---: | ---: | ---: | ---: |
| cold | 469 | 426 | 1 | 0 |
| warm (TTL success cache) | 30 | 0 | 0 | 1 |

≈ **15×** wall-clock on identical lonlats within success TTL (5 min). Negatives TTL = 30 s.

## Suggested latency percentiles (baseline, success path)

| class | P50 (approx) | P90 (approx) | P95 (approx) |
| --- | ---: | ---: | ---: |
| short (L01/L05/L07) | ~550 ms | ~700 ms | ~750 ms |
| medium (R01/R03) | ~300 ms | ~350 ms | ~400 ms |
| long (VG/KIM/Belomor) | ~200–500 ms | ~550 ms | ~600 ms+ |

**Caveat:** cold Overpass + Phase C ×9 BRouter can push multi-second to tens of seconds. Instrument `performance.externalCalls` + `timing.phaseCMs` on those runs.

## TOP-5 latency sources

1. **BRouter network round-trips** (`timing.brouterMs`) — often 70–95% of Phase B wall time.
2. **Phase C exhaustive ≤9 trials** when A/B fail — multiplicative BRouter cost (flag `USE_ROUTE_EARLY_STOP` default **false**).
3. **Phase A open-lake / mask work** on shared reservoirs (L01/L07 ~500 ms class even without BRouter).
4. **Overpass cell fetch** on legacy fallback (cold cells); mitigated by cell cache + empty TTL 45 s.
5. **Repeated identical BRouter corridors** across rebuilds — fixed by E1.6 success/negative TTL cache + request dedup.

## Safe optimizations shipped (result-preserving)

| Optimization | Flag / mechanism | Effect |
| --- | --- | --- |
| BRouter success + negative TTL cache | `USE_BROUTER_RESULT_CACHE=true` | Dedupes network; negatives expire 30 s |
| Request-scoped BRouter dedup | `USE_BROUTER_REQUEST_DEDUP=true` | Same lonlats within one `measureWaterChain` |
| RouteTrace v2 timing / performance / failure | always on (diagnostic) | AI-ready signals; no ranking change |
| Overpass cell cache hit counters | always on | Observability only |

## Experimental (default off)

| Optimization | Flag | Status |
| --- | --- | --- |
| Phase C early-stop after excellent accept | `USE_ROUTE_EARLY_STOP=false` | Implemented; **off** until regression proves identity |

## Optimizations that need routing-logic change (NOT shipped)

1. Long-span segmented BRouter (`LONG_SPAN_DESIGN.md`) — needs water-aware joints + stitch validation.
2. Raising `span_gt_120` — rejected without segmentation.
3. Parallel fan-out of all Phase C BRouter pairs — risk of rate limits / races; needs budgeted parallelism design.
4. Hardcoded Belomor / Lower Volga fairways — coverage stage, not perf.
5. Weakening STEM/VETL/DAM/hydro — **forbidden**.

## Expected next-stage gains (with quality held)

| Measure | Expected |
| --- | --- |
| BRouter TTL cache on repeated rebuilds | 5–15× on cache hit |
| Early-stop (after proof) on Phase C | cut trials from 9 → 1–3 on easy accepts |
| Segmented long-span | recover VG-D / Belomor when oneshot fails without Overpass hang |
| Prefetch corridor cells on map pan | lower Overpass cold start |

## Safety

STEM / VETL / DAM / residual ceilings / hydro-gate / `MAX_WATER_SNAP` **unchanged**.  
Early-stop defaults **off** → production search identical when flag false.

## Reproduce

```bash
cd sea-map && npm run bench:e16
```
