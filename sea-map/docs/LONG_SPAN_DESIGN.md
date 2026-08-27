# E1.6 — LONG_SPAN_SEGMENTED_ROUTING (design only)

**Status:** design + synthetic unit tests. **Not enabled in production.**

## Problem

For spans `routeSpanKm > 120`:

1. Phase A/B/C try BRouter (and shared-lake / Phase C where applicable).
2. If that fails, Overpass cell crawl is **skipped** (`span_gt_120`).
3. Result: `route_not_found` even when OSM waterways exist along the corridor.

Raising the 120 km threshold blindly is rejected: Overpass crawl on Seliger-class spans hangs the UI without connecting.

## Observed (USER_TEST_DIAGNOSTICS_01 / E1.6 probes)

| Corridor | Geo | BRouter with good snaps | Failure mode |
| --- | --- | --- | --- |
| Volgograd → Astrakhan | ~370 km | Often OK (~460 km track) | Bad shore snaps → 400 / short geometry → then `span_gt_120` |
| Belomor full | ~185 km | Often OK | Mid chunks can return bogus short tracks |
| Moscow/KIM → Volga long | >120 | Corridor-dependent | Same long-span gate |

## Proposed architecture (future stage)

```
A ──chunk1──► W1 ──chunk2──► W2 ──…──► B
     BRouter        BRouter
     (≤100 km)      (≤100 km)
         │              │
         └──── stitch + validate whole chain ────┘
```

### Principles

1. **Chunk budget:** target ≤100 km geo per BRouter oneshot (under existing 120 gate).
2. **Waypoints on water:** chunk joints must snap to waterway/fairway/mask — not geodesic midpoints on land.
3. **Reuse chain architecture:** `measureHybridChain` / multi-waypoint already stitches legs; long-span becomes “auto vias”.
4. **Cache:** per-chunk BRouter success cache (E1.6 provider cache) between segments.
5. **Centerline (later WaterGraph):** Hybrid WaterGraph centerline can supply joints; until then OSM/BRouter vias only.
6. **Accept whole path:** STEM / VETL / DAM / hydro / residual ceilings apply to the **stitched** route, not per-chunk shortcuts.
7. **Feature flag:** `USE_LONG_SPAN_SEGMENTED=false` until regression suite proves identity on short/medium routes.

### What this stage does NOT do

- Does not raise `span_gt_120`
- Does not add hardcoded Lower Volga / Belomor fairways
- Does not change Phase A/B/C ranking

### Synthetic tests

`src/__tests__/long-span-design.test.ts` — geodesic chunk splitting invariants only.

### Next implementation stage (separate PR)

1. Water-aware joint placement (snap + fairway prefer).
2. Sequential BRouter per chunk with request-scope cache.
3. Stitch + full-route validate.
4. Benchmark vs baseline on VG-D / Belomor / KIM→Volga.
5. Enable behind flag after STEM/VETL/DAM green.
