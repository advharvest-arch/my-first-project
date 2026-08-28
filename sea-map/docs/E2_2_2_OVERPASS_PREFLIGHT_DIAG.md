# E2.2.2 — Overpass fallback usefulness preflight (diagnostic)

**Status:** DIAGNOSTIC ONLY. Production routing UNCHANGED. `USE_WATER_GRAPH=false`.  
**No skip thresholds. No Overpass execution changes.**

## Question

Can we tell **before** `fetchWaterNetwork` whether Overpass fallback after `snap_empty` is almost certainly useless?

## Answer

**No reliable signal yet** to separate *useful* vs *useless* Overpass outcomes among routes that actually enter fallback.

We **can** deterministically describe **whether Overpass will be entered**, but that is not the same as predicting usefulness.

---

## Path studied

```
Phase A/B fail → Phase C snap_empty
→ (if span ≤ 120 and stem_miss_early not taken)
→ routeOnCachedLines(cellCache) 
→ if empty: fetchWaterNetwork → routeOnCachedLines
→ often still FAIL/snap_empty
```

## Signals known BEFORE fetch (existing data only)

| Signal | Source |
| --- | --- |
| endpointDistanceKm | haversine A–B |
| sharedLakePresent / name | `findSharedOpenLake` |
| phaseCRejectReason / candidate counts | RouteTrace Phase C |
| brouterHadGeometry | Phase B |
| cached corridor waterway/lake lines | `cellCache` (water-core + prior cells) |
| nearestKnownWater* | cache-only scan (no prefetch) |
| estimatedCellCount / missingCellCount | `cellsAlong`, empty/missing cells, cap 24 |
| estimatedFallbackScope | span≤100 → around_query else cell_batch; span>120 skip |

Recorded on RouteTrace as `overpassPreflight` (never gates accept/reject).

## Live fixture table (`npx tsx scripts/e222-overpass-preflight.ts`)

| route | snap result | preflight signals | estimated cells (miss/total) | Overpass triggered | final result | E2E |
|---|---|---|---:|---|---|---:|
| VG-mid | snap_empty | no shared lake; cache empty; near∅; cands 0/0; brouter_no_geometry; span~115; all cells missing; scope=cell_batch | **8/8** | **true** (fetchWaterNetwork) | FAIL/snap_empty | ~16911 |
| N06 | n/a_ok | **shared lake** Kuibyshev; cache empty; scope=not_reached | 4/4 | false (accepted_before_overpass) | OK/lake | ~3461 |
| N08 | n/a_ok | **shared lake** Kuibyshev; scope=not_reached | 5/5 | false | OK/lake | ~371 |
| BELOMOR | n/a_ok | no shared lake; **span_gt_120**; brouter_had_geometry; scope=not_reached | 10/10 | false | OK/waterway | ~140 |
| L01 | n/a_ok | **shared lake** Rybinsk; scope=not_reached | 4/4 | false | OK/lake | ~577 |

## What separates cases today

| Discriminator | Separates | Predicts Overpass useless? |
| --- | --- | --- |
| `sharedLakePresent` | N06/N08/L01 never reach Overpass (Phase A) | N/A — Overpass not run |
| BRouter success / `brouterHadGeometry` | Belomor/N06 succeed earlier | N/A |
| `span > 120` | Belomor would skip Overpass if BRouter failed | Skip, not usefulness |
| `corridor_cache_empty` + `nearest∅` | Present on **VG-mid and** on successful lake routes | **No** — common on OK routes too |
| `phase_c:snap_empty` + `span_100_120` + no shared lake | Unique entry recipe for VG-mid Overpass | Entry only; **no positive Overpass-success control** in fixtures |

## Why “useful vs useless” cannot be proven yet

1. **Only VG-mid** in this set **triggers** Overpass.
2. There is **no fixture** where `snap_empty → Overpass fetch → OK`.
3. Without a positive control, any VG-mid-only pattern is an **entry signature**, not a validated uselessness classifier.
4. Cache emptiness is expected on cold Lower Volga / Belomor (water-core has **0** lines there) and also appears on Kuibyshev cold starts that still succeed via lake mask — so it does not mean “Overpass will fail”.

## Missing data (for a future analysis, not implemented)

- Fixtures where Overpass fallback **recovers** after snap_empty  
- Or an existing open OSM presence index readable **without** running the full cell-batch fetch  
- Graph-component connectivity for the corridor without enabling production WaterGraph

## Deliverables

- `src/overpass-preflight.ts`
- `trace.overpassPreflight` wiring in `waterways.ts` / `route-trace.ts`
- `scripts/e222-overpass-preflight.ts`
- `src/__tests__/e222-overpass-preflight.test.ts`

**Stop — no optimization / no Overpass skip threshold.**
