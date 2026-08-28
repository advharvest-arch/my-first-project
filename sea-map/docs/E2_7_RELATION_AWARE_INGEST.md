# E2.7 — Relation-aware waterway ingest prototype

**Status:** DIAGNOSTIC PROTOTYPE ONLY.  
`USE_WATER_GRAPH=false`. No production ingest enablement. No seams. No synthetic geometry.

Script: `npx tsx scripts/e27-relation-aware-ingest.ts`  
Module: `src/relation-aware-ingest.ts`  
Fixture: `src/__fixtures__/belomor-recovery/osm-relation-9909116-full-ways.json`

---

## Why the Belomor gap was an artifact

E2.5/E2.6 showed:

- OSM relation **9909116** (`Беломорканал`) already has continuous `main_stream` geometry near **34.20–34.31E**.
- The E2.1 fixture `belomor.geojson` uses a simplified N–S chord near **34.8E**, leaving an ~**18.96 km** tear between ~63.95N and ~64.12N.
- Default `WG_INGEST_CORRIDOR_PAD_DEG=0.35` bbox from bench endpoints also cuts western lon ≲ **34.42**, so bbox-only ingest would miss the real swing even with live Overpass.

That tear is a **pipeline / fixture artifact**, not a global OSM hole.

## CURRENT vs RELATION_AWARE

| | CURRENT | RELATION_AWARE |
| --- | --- | --- |
| Geometry source | Simplified `belomor.geojson` (fake ids 502000x) | OSM relation 9909116 member ways only |
| BBox | Default corridor pad from A/B (~34.42–35.17E) | Relation extent + small pad (~34.15–35.04E) |
| Ways fully inside relation members | 22 full / 2 partial / **5 outside** | **29 / 0 / 0** |
| Artificial ~19 km gap | **Present (18.959 km)** | **Absent** |
| Components | 2 | **1** |
| Diagnostic A→B path | false (`graph_disconnected`) | **true** (~217 km) |

Both variants use the **same** `buildWaterGraph` / topology / Dijkstra helpers. No cost, validator, or safety changes.

## Why this is safer than a seam

- Geometry is **copied from OSM way node chains** — no interpolated chord between gap endpoints.
- Discontinuities between members are **classified** (shared endpoint / near-touch / discontinuity); close ends are **not** auto-joined into fake edges beyond the existing merge radius for shared coordinates.
- Every segment carries `sourceType=osm`, real `way/<id>`, `diagnosticOnly=true`, `confidence=HIGH`.
- A seam would invent navigability across an empty band; relation-aware ingest **imports geometry that already exists**.

## Continuity (relation order)

All 28 consecutive member links share endpoints (0 m). Many members are **orientation-reversed** relative to relation order (`start-end` / `end-end` pairs) — the undirected WaterGraph still connects shared vertices. **No fabricated discontinuities and no synthetic fills.**

## E2.6 historical context

Belomor full was **CONFIRMED_WORKING** via BRouter; fixture DATA_GAP = **PIPELINE_ARTIFACT**. Relation-aware ingest shows how **coverage improves when real OSM relation geometry is used** instead of a simplified chord / narrow bbox — consistent with E2.6 notes on earlier relation-capable Overpass queries and ingest bbox regressions. This is **supporting evidence**, not sole proof of historical causality.

## Remaining limitations (why not production yet)

1. Offline committed snapshot — not a live production Overpass path.
2. Belomor-only prototype; VG-mid / X3 untouched.
3. Lock staircase portals still unmodeled.
4. Terminal bind uses existing diagnostic graph helpers (not a production accept path).
5. `USE_WATER_GRAPH` remains **false** — shadow/diagnostic only.
6. Needs explicit product decision + gating before any production ingest enablement.

## Production safety proof

- Flag stays false; no accept/reject / BRouter / validator / hydro / threshold / fallback changes.
- Existing routing tests unchanged in behavior.
- Diagnostic builds do not mutate an empty caller graph.
- No seam edges added to fill the DATA_GAP; no synthetic polylines.

## Key answers

1. **Does relation-aware ingest eliminate the artificial Belomor DATA_GAP without seam/synthetic geometry?**  
   **Yes.** CURRENT keeps the ~18.96 km tear (2 components, no A→B path). RELATION_AWARE: 1 component, gapCount 0, diagnostic path ~217 km from real OSM members only.

2. **Safe future production WaterGraph ingest candidate?**  
   **Yes, as a gated candidate** — provenance-clean, no seam, removes a known artifact. **Not enabled here.** Still needs live-fetch policy, multi-corridor validation, and an explicit enablement stage.
