# E2.0 — Hybrid WaterGraph Foundation

**Status:** E2.0_READY (shadow foundation). Production routing **UNCHANGED** (`USE_WATER_GRAPH=false`).

## What shipped

| Module | Role |
| --- | --- |
| `src/water-graph-types.ts` | Node/edge/path/terminal/shadow types |
| `src/water-graph-cost.ts` | Soft class multipliers + portal/lock fees |
| `src/water-graph.ts` | normalize, densify, build, seams, locks, Dijkstra, path→geometry, shadow runner |

## Layers

1. **CENTERLINE** — caller-supplied polylines (legacy BRouter/OSM samples) + optional regional fairways  
2. **MASK** — reuse `pointInOpenWater` / lake masks; grid step 0.7 km; cost ×0.85  
3. **FAIRWAY** — soft edges (×0.7), not filters  
4. **LOCK/BARRIER** — Dubna corridor as `lock` edges; detect-only barriers as `barrier_block` (no crest edges)

## Pipeline (shadow)

```
bind → buildWaterGraph → Dijkstra → path→geometry → validateWaterRoute → hydro-gate → RouteTrace.graph
```

Legacy `measureWaterChain` result is always returned. Shadow only fills `trace.graph` when `USE_WATER_GRAPH=true`.

## Cost model

| kind | multiplier | fee |
| --- | ---: | --- |
| fairway | 0.7 | — |
| mask | 0.85 | — |
| waterway | 1.0 | — |
| canal | 1.05 | — |
| seam | 1.1 | portal 0.15 |
| lock | 1.0 | lock 0.25 |

Seam threshold default **0.45 km** (`WG_LAKE_CONNECT_KM`) — independent of user snap.

## Normalization rules

- Densify along existing geometry only  
- Dedupe nodes only within the **same `waterId`**  
- Forbidden: nearest-node connect across waters

## Acceptance checklist

1. Graph builds for corridor — **yes**  
2. Centerline used — **yes** (inputs + fairways)  
3. Mask connectable — **yes** (when lake complete in cache)  
4. Fairway soft edge — **yes**  
5. Lock portals — **yes** (Dubna / Rybinsk)  
6. Barrier crest not normal edge — **yes** (`barrier_block`)  
7. A/B bind — **yes**  
8. Dijkstra typed path — **yes**  
9. Path→geometry — **yes**  
10. Validator/hydro final judges — **yes** (shadow)  
11. Shadow does not change production — **yes** (flag default false)  
12. RouteTrace graph vs legacy — **yes** (`legacyCompare`)  
13–14. Lower Volga / Belomor component diagnostics — **reports**  
15. Safety regression — unit suite green  

## Recommendation

**E2.1** — ingest Overpass/water-core centerlines into builder for Lower Volga & Belomor; keep shadow until agree% is proven.
