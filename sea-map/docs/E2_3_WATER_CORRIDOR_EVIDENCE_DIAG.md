# E2.3 — Navigable Water Corridor Evidence (diagnostic)

**Status:** DIAGNOSTIC ONLY. `USE_WATER_GRAPH=false`. No seams. No routing changes.  
**Distance alone is never connection proof.**

## Question

Do open data sources prove that two WaterGraph components belong to one *navigable* corridor?

## VG-mid — Волга ↔ Ахтуба (~14.5 km)

| Side | Component | waterId | name |
| --- | --- | --- | --- |
| A | comp-0 | `ww:волга` | Волга |
| B | comp-1 | `ww:ахтуба` | Ахтуба |

**Why separate in the graph?**  
`waterId` is derived from OSM `name`. Different names → different waterIds → same-water merge **refuses** to join them (by design).

**Evidence found**
- `possible_separate_waterbody` (distinct names/ids)
- `possible_distributary` (knowledge corridor lists both `volga` + `akhtuba` — co-occurrence only)
- Gap contents: `nothing_known` (no mask/canal/lock geometry in gap)
- Dubna/Rybinsk locks: **distant_unrelated** (~800+ km) — not evidence

**Navigable connection?** **No** (`navigableConnection: none`)  
**Physical/hydrological?** Suggested only via knowledge co-listing — **not** a proven channel at the portal pair.  
**Final:** `SEPARATE_WATER_OBJECT`

Honest options mapping: **D/E** — separate named water objects; floodplain relation is hydrological/advisory, not navigable proof in this fixture gap.

## Belomor — north tear (~19 km)

| Side | waterId | layer |
| --- | --- | --- |
| South/mid | `ww:беломорско-балтийский канал` | canal |
| North | **same** waterId | canal |

**Evidence:** `same_water_object`, `named_continuation`, `canal_continuation`, `data_gap`, soft `lock_transition_candidate` (knowledge `multi_lock_stair` — **unverified** at gap).  
**Intermediate OSM geometry in gap:** none in fixture.  
**Final:** `DATA_GAP` (identity strong; mid geometry missing). Not LOCK_TRANSITION without concrete lock points.

## N06 / N08

Multiple `river_to_mask_candidate` / fairway→mask pairs on Куйбышевское.  
**Strong navigable evidence:** none.  
**Typical final:** `PHYSICAL_CONNECTION_ONLY` (same reservoir mask proximity).  
Fairway flagged `fairway_not_navigability_proof`.

## X3

No in-scan waterway↔waterway / waterway↔mask evidence pairs. Missing complete Cheboksary mask + Vetluga centerline → cannot build connected navigable graph evidence.

## Deliverables

- `src/water-corridor-evidence.ts`
- `trace.waterCorridorEvidence`
- `scripts/e23-water-corridor-evidence.ts`
- tests in `e23-water-corridor-evidence.test.ts`

**Stop — no seams.**
