# E2.14 — N06 endpoint binding diagnostic

**Status:** DIAGNOSTIC ONLY.  
`USE_WATER_GRAPH=false`. Production routing unchanged. No long seams. No soft accept. No snap-distance inflation. No Volga↔Akhtuba sew.

Script: `npx tsx scripts/e214-endpoint-binding-diag.ts` (`npm run bench:e214`)  
Module: `src/endpoint-binding-diag.ts`  
RouteTrace field: `endpointBindingDiag` (`wouldCreateGraphEdge` always false)

---

## Goal

After E2.13, N08 recovers via densified Kuibyshev mask shadow; N06 stays `graph_disconnected` because endpoint **B** is ~23.9 km from the lake mask.

E2.14 asks: is there **real** OSM / water geometry that can safely bind N06 B to the existing network — or prove that no such chain exists in current data?

Forbidden: inventing a ~24 km B→mask chord, seams, soft accept, production bind.

---

## Method

For each control corridor endpoint:

1. Record exact coordinates.
2. Resolve shared lake mask (same densified path as E2.13).
3. Measure nearest mask vertex / open-water distance.
4. Ingest OSM waterways once for the corridor (named streams included).
5. Measure nearest waterway distance + name/provenance (snap fallback if Overpass empty).
6. Test whether that waterway geometry enters or seam-connects (`WG_LAKE_CONNECT_KM = 0.45`) to the mask.
7. Classify location + emit a **diagnostic-only** candidate (never a graph edge).
8. Attach BRouter residual forensics from the legacy `measureWaterChain` RouteTrace.

Controls: **N06** (target), **N08** (mask-positive), **BELOMOR** (relation-aware), **VG-mid** (must refuse cross-body).

---

## Results table

Measured run (`npm run bench:e214` / N06 corridor probe):

| route | endpoint | nearest mask | nearest waterway | nearest water polygon | candidate | confidence | reason |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| N06 | A | 4.272 km | 2.304 km | 0 (on mask) | `already_on_mask` | HIGH | Inside verified Kuibyshev mask |
| N06 | B | **23.423 km** | **3.564 km** (Урень `way/178554106`) | 23.62 km | `waterway_chain_to_mask_unproven` | LOW | Урень close; approaches mask to **8.422 km** — no enter/seam (0.45 km) |
| N08 | A | 1.794 km | 0.194 km | 0 (on mask) | `already_on_mask` | HIGH | Positive mask control |
| N08 | B | 0.233 km | 0.832 km | 0 (on mask) | `already_on_mask` | HIGH | Positive mask control |
| BELOMOR | A | — | ~1.06 km | — | `none` | NONE | Relation-aware; no shared lake mask |
| BELOMOR | B | — | ~0.68 km | — | `none` | NONE | Relation-aware; no shared lake mask |
| VG-mid | A | — | local | — | `negative_control_no_cross_body` | HIGH | Refuse Volga↔Akhtuba sew |
| VG-mid | B | — | local | — | `negative_control_no_cross_body` | HIGH | Refuse Volga↔Akhtuba sew |

---

## Answers

### 1. Why is N06 endpoint B ~23.9 km from the mask?

Preset B `{lon: 49.1, lat: 54.35}` lies **outside** the verified Kuibyshev lake-mask polygon (`locationClass=shore_near_waterway`). Shared-lake catalog detection still fires (bbox / densified corridor), so WaterGraph tries the Kuibyshev mask — but B is not on open water. Nearest mask ring vertex ≈ **23.423 km**. Endpoint A is inside / near the mask.

### 2. Are there real water data between B and the mask?

**Near B, yes:** OSM waterway **Урень** (`way/178554106`, `ww:урень`) at **3.564 km** — same tip as BRouter geometry end.  
**Chain to mask: no.** Ingested Урень geometry approaches open water to **8.422 km** but does **not** enter the mask and does **not** come within the 0.45 km waterway↔mask seam threshold.  
No in-repo port/pier/harbour or lock layer binds this endpoint.  
Do **not** treat the 23.4 km mask gap as fillable.

### 3. What allows BRouter to build N06?

Legacy Phase B **BRouter** (`method=lake`). Geometry ends within the water snap budget of B (`finishKm ≈ 3.564`, `snapKm = 5.5`). Geom tip coincides with Урень centerline. BRouter follows a water routing network that includes this tributary approach; our WaterGraph mask mesh does not cover that approach, and Урень does not seam-connect into the mask under current ingest. We are **not** copying BRouter here.

### 4. Can we safely bind B to the existing water network?

**Not as a mask auto-bind today.** Candidate type `waterway_chain_to_mask_unproven`, confidence **LOW**, `wouldCreateGraphEdge=false`. A short shore snap to Урень alone does **not** create a safe path to the reservoir without a proven chain (8.4 km remaining gap from waterway tip to mask ≫ 0.45 km).

### 5. If not — what data do we need?

1. OSM / centreline geometry proving Урень (or another tributary) **enters or seam-connects** to the Kuibyshev mask; **or**
2. An expanded **verified** mask covering the river mouth near B; **or**
3. An explicit navigable centreline from tributary to reservoir with provenance.

Not: a 24 km synthetic edge, inflated snap, or soft accept.

### 6. Can the same mechanism accidentally sew VG-mid (Volga↔Akhtuba)?

**No.** VG-mid endpoints are typed `negative_control_no_cross_body` with HIGH confidence. The diagnostic never emits a cross-body candidate and never sets `wouldCreateGraphEdge`.

---

## Production

**Not enabled.** No production bind. `USE_WATER_GRAPH` remains `false`. Stop here — implement binding only after an explicit follow-up decision.
