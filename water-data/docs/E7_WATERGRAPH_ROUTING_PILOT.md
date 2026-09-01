# E7 — Isolated WaterGraph routing pilot

First real route on the isolated WaterGraph, using **only** E6 `ALLOWED_TOPOLOGY` edges.

**Not** production navigation. **Not** wired to AquaRoute / sea-map / BRouter.

---

## Method

| Item | Choice |
|------|--------|
| Algorithm | Dijkstra |
| Weight | `edge.length_m` |
| Graph | undirected `wg_nodes` / `wg_edges` |
| Filter | E6 status = **ALLOWED_TOPOLOGY** only |
| Corridor | Belomor relation `9909116` |

Tool: [`ingest/e7_watergraph_routing_pilot.py`](../ingest/e7_watergraph_routing_pilot.py)

```bash
python3 ingest/e7_watergraph_routing_pilot.py \
  --json-out data/e7_routing_pilot.json

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e7_watergraph_routing_pilot.sql
```

---

## Belomor note (UNKNOWN locks)

Belomor has **29** member edges: **20 ALLOWED** + **9 UNKNOWN** (structure/lock tags → navigability unknown per E6).

E7 **excludes UNKNOWN**, so a single end-to-end Belomor path through locks is intentionally unavailable.  
The pilot routes the **largest ALLOWED-only Belomor subcomponent** (12 edges).

---

## Pilot result

| Field | Value |
|-------|------:|
| start_node_id | 1179 |
| end_node_id | 76545 |
| found | **true** |
| node_count | 13 |
| edge_count | 12 |
| total_length_km | **202.039** |
| decision | **PASS** |

OSM way ids (ordered):  
`26454857, 1020271524, 1020271526, 1020271525, 1020271529, 1020271530, 1002946116, 1020271532, 1220046010, 1220046008, 1220046007, 358560670`

### Safety checks on route

- only `ALLOWED_TOPOLOGY` ✓  
- all edges retain Belomor `parent_relation_ids` ✓  
- length = sum of edge lengths ✓  
- no UNKNOWN / REJECTED edges ✓  

---

## Regressions

| Case | Decision |
|------|----------|
| Belomor route | **PASS** |
| Volga–Baltic gap | **NOT_CONNECTED** |
| Volga / Akhtuba | **NOT_CONNECTED** |
| N06 | **NO_WG_ROUTE_FALLBACK** |
| N08 | **NO_WG_ROUTE_FALLBACK** |
| UNKNOWN not used | **PASS** |

---

## Explicit non-goals

- No AquaRoute / frontend / API integration  
- No production flag / BRouter changes  
- No tolerance, proximity, crossing, or synthetic seams  
- No lake/open-water routing  
- ALLOWED_TOPOLOGY still **≠ navigable**

---

## Invariants

canonical **455001 / 199570 / 92** · graph **203818 / 175173 / 62822** · sea-map unchanged.
