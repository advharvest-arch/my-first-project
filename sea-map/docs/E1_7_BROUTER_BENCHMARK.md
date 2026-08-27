# E1.7 — BRouter Benchmark

Companion to `E1_7_LONG_SPAN_REPORT.md`. Live numbers from `npm run bench:e17` (Cloud Agent VM, 2026-08-27).

## External-call focus

| scenario | brouter_calls | cache | total_ms | notes |
| --- | ---: | --- | ---: | --- |
| VG-D cold | 1 | miss | ~330–430 | Phase B oneshot |
| VG-D warm | 0 | hit | ~28 | success TTL |
| L01/L07 Phase A | 0 | — | 14–550 | no BRouter |
| L05/R01 Phase B | 1 | miss | 640–700 | lake method via BRouter |
| VG-mid fail | multi | miss | 2–11 s | Phase B/C then `span_gt_120` |
| Belomor full | 1 | miss | ~150–470 | oneshot OK in baseline |

## Duplicate elimination

- Request scope dedupe + TTL success (5 min) / negative (30 s)
- Key: `river:` + lon,lat **6 decimal places** (no fuzzy merge)
- Session counters: `hit` / `miss` / `deduped` exposed on RouteTrace `performance.brouterCache`

## Failed trials cost

Phase C ×9 is the multiplicative risk when A/B miss. Budget override exists for experiments only; production stays at 9.

Parallel(2/3) prototype exists; L07 sample did not enter Phase C (Phase A win).

## Recommendation

1. Keep BRouter TTL cache on (already default).  
2. Do **not** enable long-span segmentation in production until WaterGraph supplies joints.  
3. Prioritize E2 centerline for Lower Volga + Belomor to cut both `span_gt_120` dead-ends and failed joint snaps.  
4. Next perf win after cache: reduce Phase C trials on easy accepts (early-stop still off pending proof).
