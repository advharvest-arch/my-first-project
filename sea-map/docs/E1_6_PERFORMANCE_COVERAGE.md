# E1.6 — Performance + Open Water Coverage Diagnostics

## Summary

Instrumentation + safe provider cache + coverage reports. Production accept/reject / thresholds / Phase ranking unchanged. Early-stop behind `USE_ROUTE_EARLY_STOP=false`.

## Deliverables

| Artifact | Path |
| --- | --- |
| Performance report | `docs/PERFORMANCE_REPORT.md` |
| Belomor coverage | `docs/BELOMOR_COVERAGE_REPORT.md` |
| Lower Volga coverage | `docs/LOWER_VOLGA_COVERAGE_REPORT.md` |
| Long-span design | `docs/LONG_SPAN_DESIGN.md` |
| RouteTrace schema | v2 (`src/route-trace.ts`) |
| Benchmark | `npm run bench:e16` |

## PRODUCTION

**Routing logic:** unchanged (early-stop off).  
**Safe adds:** BRouter TTL cache + request dedup; RouteTrace timing/performance/failure/coverage; advisory knowledge corridors `belomor` / `lower_volga` / `volga_baltic`.
