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
4. Ingest OSM waterways in a local pad around the endpoint.
5. Measure nearest waterway distance + name/provenance.
6. Test whether that waterway geometry enters or seam-connects (`WG_LAKE_CONNECT_KM = 0.45`) to the mask.
7. Classify location + emit a **diagnostic-only** candidate (never a graph edge).
8. Attach BRouter residual forensics from the legacy `measureWaterChain` RouteTrace.

Controls: **N06** (target), **N08** (mask-positive), **BELOMOR** (relation-aware), **VG-mid** (must refuse cross-body).

---

## Results table

| route | endpoint | nearest mask | nearest waterway | nearest water polygon | candidate | confidence | reason |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| N06 | A | *(suite)* | *(suite)* | *(suite)* | *(suite)* | *(suite)* | *(suite)* |
| N06 | B | ~23.4–23.9 km | ~3.56 km (Урень) | ~23.9 km (mask open water) | `waterway_chain_to_mask_unproven` | LOW | Waterway close; chain to mask not proven |
| N08 | A/B | near / on mask | *(suite)* | near / on mask | `already_on_mask` / short snap | HIGH | Positive mask control |
| BELOMOR | A/B | — (no shared lake) | relation waterways | — | `none` / local | — | Relation-aware control |
| VG-mid | A/B | — | present locally | — | `negative_control_no_cross_body` | HIGH | Refuse Volga↔Akhtuba sew |

*(Run `npm run bench:e214` to refresh measured numbers into `/tmp/e214-endpoint-binding.json`.)*

---

## Answers

### 1. Why is N06 endpoint B ~23.9 km from the mask?

Preset B `{lon: 49.1, lat: 54.35}` lies **outside** the verified Kuibyshev lake-mask polygon. Shared-lake catalog detection still fires (bbox / densified corridor), so WaterGraph tries the Kuibyshev mask — but B is not on open water. Nearest mask ring vertex is ~23–24 km away (shore tip near ~`{48.83, 54.49}`). A is much closer / on-water.

### 2. Are there real water data between B and the mask?

Yes, **near B**: OSM waterway **Урень** (`way/178554106` and related) at ~3.56 km — same tip BRouter residual lands on.  
No proven geometric chain in endpoint-local ingest from Урень into the Kuibyshev mask (does not enter open water; does not come within the 0.45 km seam threshold). Separate named ways (e.g. Майна) can sit *in* the mask without proving Урень→mask connectivity.  
No in-repo port/pier/harbour or lock layer binds this endpoint.

### 3. What allows BRouter to build N06?

Legacy Phase B **BRouter** (`method=lake`). Geometry ends within the water snap budget of B (`finishKm ≈ 3.56`, `snapKm = 5.5`). BRouter follows a water routing network that includes this tributary approach; our WaterGraph mask mesh does not cover that approach, and Урень does not seam-connect into the mask under current ingest. We are **not** copying BRouter here.

### 4. Can we safely bind B to the existing water network?

**Not as a mask auto-bind today.** Candidate type `waterway_chain_to_mask_unproven` (or `unsafe_long_gap` if waterway ingest fails). Confidence LOW/NONE. A short shore snap to Урень alone does **not** create a safe path to the reservoir without a proven chain.

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
