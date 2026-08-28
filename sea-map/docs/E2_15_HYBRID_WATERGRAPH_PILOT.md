# E2.15 — Hybrid WaterGraph pilot

**Status:** PILOT behind feature flag.  
Default: `USE_WATER_GRAPH=false` (legacy Phase A/B/C unchanged).  
When `USE_WATER_GRAPH=true`: WaterGraph → existing validator+hydro + terminal-snap gate → if OK use it; else **BRouter/legacy fallback**.

Module: `src/watergraph-hybrid-router.ts`  
Wire: early attempt in `measureWaterChain`  
RouteTrace: `hybridRouter`  
Enable UI: `?wg=1` or DEV panel checkbox  
Script: `npm run bench:e215`

---

## Measured control run (`npm run bench:e215`)

| route | selected | fallback | wgResult | pathKm | attemptMs | e2eMs | reason |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| BELOMOR | **watergraph** | false | ok | 217.0 | 32 | 37 | — |
| N08 | **watergraph** | false | ok | 45.9 | 214 | 215 | lake_mask_only |
| N06 | **brouter** | true | terminal_unbound | 76.4 | 111 | 3628 | B snap 23.9 km > 10 km — no artificial seam |
| VG-mid | **none** | true | terminal_unbound | — | 64s | 81s | no Volga↔Akhtuba; legacy also fails |
| N08 flag-off | **legacy** | false | skipped | 41.9 | 0 | 567 | default behavior unchanged |

Ratios ≫ 1.0 where a path exists → not a geodesic chord.

---

## What changed

| Piece | Behavior |
| --- | --- |
| Flag off | Identical legacy routing; `hybridRouter.routerMode=legacy` |
| Flag on | Try WaterGraph first: relation (geographic) → densified mask → Overpass |
| Accept | `validateWaterRoute` + hydro + terminal dist ≤ legacy endpoint snap |
| Miss | Fall through Phase A/B/C unchanged; `fallbackUsed=true` + reason |
| No | Route-name `if`s, synthetic seams, snap inflation, Volga↔Akhtuba sew, BRouter deletion |

---

## Production

**Default off.** Do not treat this as global WaterGraph enablement. Stop here for a go/no-go decision before any default flip.
