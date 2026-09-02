# E8 — Navigation semantics over WaterGraph

Separates **topology** (E1 / E5 / E6 `ALLOWED_TOPOLOGY`) from **navigation** evidence derived from OSM tags.

Statuses: **NAVIGABLE** | **BLOCKED** | **UNKNOWN**.

Insufficient evidence → **UNKNOWN** (never invent navigability).

**Not** production navigation. **Not** wired to AquaRoute / sea-map / BRouter. Does **not** change E1 topology.

---

## Policy (evidence-only)

| Status | Rule |
|--------|------|
| **NAVIGABLE** | `CEMT` class on linear waterway (`river`/`canal`/…), including `lock=yes` chambers with CEMT; or craft tags `boat`/`ship`/`motorboat` = yes/designated |
| **BLOCKED** | `waterway=dam` (no lock), `weir`/`waterfall`; explicit `boat=no` / `ship=no` without CEMT/craft override |
| **UNKNOWN** | Default; Ladoga rings without craft/CEMT; lock without CEMT/craft |

`ALLOWED_TOPOLOGY` ≠ `NAVIGABLE`.

Tables: `water.wg_navigation_run`, `water.wg_edge_navigation`  
Tool: [`ingest/e8_navigation_semantics.py`](../ingest/e8_navigation_semantics.py)

```bash
python3 ingest/e8_navigation_semantics.py \
  --json-out data/e8_navigation_semantics.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e8_navigation_semantics.sql
```

---

## Global counts (build_id=1)

| Status | Edges |
|--------|------:|
| NAVIGABLE | **321** |
| BLOCKED | **1811** |
| UNKNOWN | **173041** |
| total | 175173 |

Tag inventory (edges): CEMT=174, boat=yes=231, boat=no=1403, ship=yes=5, lock=yes=24, dam=210, weir=184.

Navigable fraction ≈ **0.18%** → WaterGraph is **not** a general navigation graph yet.

---

## Belomor: 9 lock-edges

All nine E6-UNKNOWN Belomor lock chambers have `waterway=canal`, `lock=yes`, **`CEMT=Va`**.

| OSM way | Lock | E8 |
|--------:|------|----|
| 358557777 | Lock no 1 | NAVIGABLE |
| 358550036 | Lock no 2 | NAVIGABLE |
| 358560045 | Lock no. 3 | NAVIGABLE |
| 358560317 | Lock № 4 | NAVIGABLE |
| 358560488 | Lock № 5 | NAVIGABLE |
| 266390293 | Lock № 6 | NAVIGABLE |
| 358560671 | Lock № 7 | NAVIGABLE |
| 358561569 | Lock № 18 | NAVIGABLE |
| 358560986 | Lock № 19 | NAVIGABLE |

Decision: **include as NAVIGABLE** via inland-waterway class evidence (`CEMT=Va`). Not a free-flow / schedule guarantee.

---

## Full Belomor navigation test

Dijkstra on **NAVIGABLE-only** Belomor edges (all **29** are NAVIGABLE).

| Field | Value |
|-------|------:|
| start_node_id | 1171 |
| end_node_id | 76548 |
| found | **true** |
| edge_count | **29** |
| total_length_km | **216.963** |
| decision | **PASS_FULL** |

Contrast E7: ALLOWED-only largest subcomponent was **12 edges / 202 km** because locks were E6 UNKNOWN.

---

## Regressions

| Case | Decision |
|------|----------|
| Belomor full NAVIGABLE route | **PASS_FULL** |
| Volga–Baltic gap (no E1 / no nav path) | **BLOCKED_NO_ROUTE** |
| Volga / Akhtuba shared nav nodes | **NO_ROUTE** (0) |
| N06 | **NO_WG_ROUTE_FALLBACK** |
| N08 | **NO_WG_ROUTE_FALLBACK** |
| Ladoga rings as centerline | **NOT_CENTERLINE** (0 NAVIGABLE) |
| Crossings as connections | **NOT_CONNECTIONS** |

---

## Can WaterGraph be a navigation source?

**CONDITIONAL.**

- **Yes** for evidence-backed corridors (Belomor with CEMT=Va including lock chambers).
- **No** as a general navigability graph: ~99.8% UNKNOWN; N06/N08 uncovered; VB gap remains; topology ALLOWED ≠ navigable.
- **Not** for AquaRoute production without further gates.

---

## Explicit non-goals

- No AquaRoute / frontend / API / BRouter changes  
- No E1 topology / proximity stitching  
- No inventing NAVIGABLE without OSM evidence  
