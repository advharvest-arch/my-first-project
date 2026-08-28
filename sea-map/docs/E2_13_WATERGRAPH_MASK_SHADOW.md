# E2.13 — WaterGraph lake-mask shadow experiment

**Status:** SHADOW / DIAGNOSTIC ONLY.  
`USE_WATER_GRAPH=false`. No production enablement. No long-distance river seams. No Volga↔Akhtuba. No safety changes.

Script: `npx tsx scripts/e213-mask-shadow.ts`  
Module: `src/water-graph-mask-shadow.ts`

---

## Hypothesis

E2.12 showed N06/N08 have `maskAvail=true` but WaterGraph did not use the mask because `cachedLakeMaskAlongPath([A,B])` needs **≥3 bbox hits** (two endpoints never qualify). Legacy still wins via Phase B **BRouter**.

E2.13 asks: if we resolve the **same** Kuibyshev verified mask (densified corridor lookup / Phase A warm) and feed it into existing `buildWaterGraph` mask mesh + waterway↔mask proximity seams (0.45 km), does WaterGraph recover a safe path **without BRouter**?

---

## Why mask was unused (E2.12)

| Lookup | Result |
| --- | --- |
| `cachedLakeMaskAlongPath([A,B])` | **null** (max 2 hits) |
| densify A–B then lookup | **Kuibyshev complete mask** |
| Phase A `routeAcrossOpenLake` | loads bundled mask into cache |

No mask pipeline rewrite — only a shadow resolve adapter: `resolveLakeMaskForShadow`.

---

## CURRENT vs MASK_SHADOW (Overpass centerlines + shadow resolve)

| route | legacy | CURRENT | MASK_SHADOW | comps before→after | maskNodes | maskEdges | ww↔mask | helped | noBrouter | residual |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | --- | --- | --- |
| N06 | OK 76.39 (Phase B BRouter) | FAIL disconnected | FAIL disconnected | 53→51 | 371 | 648 | 50 | true* | **false** | B ~23.9 km from mask |
| N08 | OK 41.896 (Phase B BRouter) | FAIL disconnected | **OK 39.919** | 137→133 | 371 | 592 | 103 | true | **true** | none |
| BELOMOR | OK 215.852 | OK 217.031 | OK 217.031 | 3→3 | 0 | 0 | 0 | false | true | no shared lake |
| VG-mid | FAIL | FAIL chord | FAIL chord | 4→4 | 0 | 0 | 0 | false | false | no sew |

\*N06: largestComponentKm **105 → 684** (mask helps topology) but path still missing.

### Deterministic note (no Overpass)

With empty OSM ingest (fairway/lock defaults only): N06 **without** mask → `terminal_unbound`; **with** mask → validated path ~49 km. Proves mask mesh can carry N06 when endpoints bind to mask/open water — Overpass fragments can bind B to an isolated shore waterway (~24 km from mask).

---

## Answers

### A. Did the existing lake-mask help WaterGraph?
**Yes** for N06/N08 when correctly resolved: mask nodes/edges appear; largest component grows; N08 gets a validated path.

### B. Components / gaps / path
- N06: comps 53→51, largestKm 106→684, path false→false  
- N08: comps 137→133, largestKm 111→805, path false→**true (~39.9 km)**  
- Belomor / VG-mid unchanged (no Kuibyshev mask)

### C. WaterGraph N06/N08 without BRouter?
- **N08: YES** (MASK_SHADOW accepted ~39.9 km vs legacy ~41.9 km)  
- **N06: NO** with Overpass centerlines still bound poorly at B

### D. Remaining N06 gap
- Endpoint **B** not in open water; nearest mask **~23.9 km** (seam threshold 0.45 km)  
- A is on-water (~0.41 km to mask)  
- Need: shore snap to open water / bind B to mask-connected geometry — **not** a 24 km synthetic seam

### E. Safety regression?
**NO.** VG-mid stays rejected; no Volga↔Akhtuba; thresholds unchanged.

### F. Next step if successful
1. Wire densified/shared-lake mask resolve into WaterGraph **shadow** for Kuibyshev.  
2. For N06: endpoint shore-snap / bind diagnostics before any graph-first.  
3. Still **do not** enable `USE_WATER_GRAPH` or replace BRouter.

---

## Production

**Not enabled.** Experiment only.
