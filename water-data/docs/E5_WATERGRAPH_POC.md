# E5 — Isolated WaterGraph PoC (E1)

First **real** WaterGraph built from `water.routing_segments`, using **only** E4.5 rule **E1** (exact endpoint identity).

This is an **isolated PoC layer** — not production routing, not wired to AquaRoute / sea-map / BRouter.

---

## Schema

DDL: [`db/init/013_watergraph_poc.sql`](../db/init/013_watergraph_poc.sql)

| Table | Role |
|-------|------|
| `water.wg_build` | Build fingerprint (rule, counts, builder version) for reproducibility |
| `water.wg_nodes` | One node per unique E1 key `round(lon,7)` / `round(lat,7)` + Point geom, degree, `component_id` |
| `water.wg_edges` | One undirected PoC edge per `routing_segments` row: `from_node`/`to_node` = segment start/end, OSM identity, relation provenance, relevance/water_type, geometry, `length_m` |

Builder: [`ingest/e5_watergraph_poc_build.py`](../ingest/e5_watergraph_poc_build.py)

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/013_watergraph_poc.sql

python3 ingest/e5_watergraph_poc_build.py --json-out data/e5_watergraph_poc.json
python3 ingest/e5_watergraph_poc_build.py --qa-only

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e5_watergraph_poc.sql
```

Re-running the builder **truncates** `wg_*` and creates a new `build_id` (reproducible from current `routing_segments`).

---

## Connection rules (enforced)

| Allowed | Forbidden |
|---------|-----------|
| E1 exact endpoint match → shared `wg_nodes` | 1 / 5 / 10 m tolerance |
| One edge per linear segment | Crossing / overlap as connection |
| Relation ids on edge as **provenance** | Relation membership as extra edge |
| | Synthetic seams / gap fill |
| | Navigability / directionality / structure snap |
| | Ladoga ring → artificial centerline |

---

## Measured build (fingerprint objects=455001)

| Metric | Value |
|--------|------:|
| nodes | **203818** |
| edges | **175173** |
| connected components | **62822** |
| isolated single-edge components | 46712 |
| nontrivial components | 16110 |
| dead-end nodes (degree 1) | 59962 |
| junction nodes (degree ≥3) | 2509 |
| isolated nodes (degree 0) | 0 |
| zero-length / invalid edges | 0 / 0 |

Matches E4.6 in-memory E1 component PoC (same segment set / E1 definition).

### Largest components (by edge count)

4131 · 3215 · 2863 · 1911 · 1588 …

---

## Required checks

### Belomor `9909116`

- 29 member edges  
- **1** induced connected component  
- **28** internal E1 shared nodes (path connections)  
- geometry / length preserved from segments (Σ length ≈ 216.96 km)

### Volga–Baltic `16738852`

- 106 edges  
- **≥2** induced components (measured **2**)  
- seq 53→54 ways `28433211` / `824398188`: `would_E1_connect=false`, gap ≈ **8.765 km**, not stitched

### Ladoga `21149039`

- 10364 ring edges remain geometric segments  
- **2095** induced E1 components  
- **not** an artificial centerline; topology ≠ navigation

### Crossings

- proper crossing edge pairs: 2366  
- interior-only: 2350  
- builder does **not** create edges from crossings

---

## What this is / is not

**Is:** reproducible isolated graph tables over routing_segments for future WaterGraph work.  
**Is not:** AquaRoute routing, BRouter input, navigability graph, production flag, or public API.

---

## Invariants

canonical objects **455001** · members **199570** · conflicts **92**  
`routing_segments` / relevance / candidates unchanged by builder (read-only source).  
sea-map unchanged.
