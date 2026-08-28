# E2.15 — Hybrid WaterGraph pilot

**Status:** PILOT behind feature flag.  
Default: `USE_WATER_GRAPH=false` (legacy Phase A/B/C unchanged).  
When `USE_WATER_GRAPH=true`: WaterGraph → existing validator+hydro → if OK use it; else **BRouter/legacy fallback**.

Module: `src/watergraph-hybrid-router.ts`  
Wire: early attempt in `measureWaterChain`  
RouteTrace: `hybridRouter`  
Enable UI: `?wg=1` or DEV panel checkbox  
Script: `npm run bench:e215`

---

## What changed

| Piece | Behavior |
| --- | --- |
| Flag off | Identical legacy routing; `hybridRouter.routerMode=legacy` |
| Flag on | Try WaterGraph first (densified lake mask + OSM ingest + geographic relation coverage) |
| Accept | Only if `validateWaterRoute` + hydro accept (same pipeline as shadow) |
| Miss | Fall through Phase A/B/C unchanged; `fallbackUsed=true` + reason |
| No | Route-name `if`s, synthetic seams, snap inflation, Volga↔Akhtuba sew, BRouter deletion |

---

## Control expectations

| Route | Expected selectedRouter | Fallback |
| --- | --- | --- |
| Belomor | `watergraph` | no |
| N08 | `watergraph` | no |
| N06 | `brouter` | yes (endpoint B far from mask; no artificial bind) |
| VG-mid | `brouter` or `none` | yes; must not sew Volga↔Akhtuba |

---

## Production

**Default off.** Do not treat this as global WaterGraph enablement. Stop here for a go/no-go decision before any default flip.
