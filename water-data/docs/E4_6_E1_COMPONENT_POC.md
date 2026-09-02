# E4.6 — READ-ONLY E1 topology component PoC

**Question answered:**

> What connected components do we get from existing `routing_segments` if we allow **only** proven E1 exact endpoint connections — with no extra heuristics?

---

## Scope

| Do | Do not |
|----|--------|
| In-memory E1 adjacency + connected components | Create graph tables / nodes / edges |
| Exact endpoint match only (E4.5 **E1**) | 1 m / 5 m / 10 m connections |
| Relation-scoped induced components | Crossing-as-edge, proximity, name, stitching |
| Length sum of segments in a component | Mutate `routing_segments` / canonical data |

Tooling: [`ingest/e46_e1_component_poc.py`](../ingest/e46_e1_component_poc.py)  
Smoke: [`db/smoke/e46_e1_component_poc.sql`](../db/smoke/e46_e1_component_poc.sql)

```bash
python3 ingest/e46_e1_component_poc.py --json-out data/e46_e1_components.json
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e46_e1_component_poc.sql
```

---

## E1 definition

Two segment endpoints are connected **iff**:

```text
round(lon, 7) and round(lat, 7) are equal
```

(~1.1 cm at equator). **No** spatial tolerance. **No** SnapToGrid metres.

A **component** = connected component of the undirected graph where:

- vertices = `routing_segments` rows `(osm_type, osm_id, part_index)`
- edges = pairs of segments that share at least one E1 endpoint key

### What is NOT a connection

- 1 / 5 / 10 m proximity  
- `ST_Crosses` / interior intersection  
- relation membership alone  
- name / water_type similarity  
- synthetic seams / gap fill  
- lake multipolygon “centerline” semantics  

---

## Algorithm

1. Load all `routing_segments` with start/end coordinates + provenance fields.  
2. Map each endpoint → E1 key.  
3. For each E1 key with ≥2 segment incidences, union those segments (Union-Find).  
4. Emit component size stats + largest-component provenance.  
5. Relation PoC = **induced** E1 graph on that relation’s member segments only.  
6. Crossing safety: count `ST_Crosses` pairs; confirm algorithm never adds edges from crossings.

All structures are **temporary in-memory**. DB writes: none (TEMP tables for crossing audit are rolled back).

---

## Results (fingerprint objects=455001)

| Metric | Value |
|--------|------:|
| total segments | **175173** |
| endpoint rows | **350346** |
| unique exact endpoints | **203818** |
| connected components | **62822** |
| nontrivial (size ≥2) | **16110** |
| isolated segments (size 1) | **46712** |
| E1 adjacency links (star edges) | measured in JSON |

### Component size buckets

| size | components |
|------|----------:|
| 1 | 46712 |
| 2 | 4949 |
| 3–5 | 6239 |
| 6–10 | 2810 |
| 11–50 | 1886 |
| 51–100 | 151 |
| 101–1000 | 70 |
| 1001+ | 5 |

Largest components (segment counts): **4131**, **3215**, **2863**, … (see JSON for water_type / category / parent relations / examples).

Component length = sum of member `length_m` (geography lengths from E4.3) — **no** geometry rewrite.

---

## Belomor `9909116`

| Check | Result |
|-------|--------|
| member segments | 29 |
| induced E1 components | **1** |
| largest induced size | **29** |
| E1 chain preserved | **true** |

All 29 members form one induced E1 component (expected).

---

## Volga–Baltic `16738852`

| Check | Result |
|-------|--------|
| member segments | 106 |
| induced E1 components | **2** |
| largest induced size | 54 |
| seq 53→54 `would_E1_connect` | **false** |
| gap | ≈ **8.765 km** |
| stitched | **false** |

Gap ways `28433211` / `824398188` remain disconnected under E1.

---

## Ladoga `21149039`

| Check | Result |
|-------|--------|
| member ring segments | 10364 |
| induced E1 components | **2095** |
| largest induced size | 2616 |
| navigation routes? | **false** |
| seq-chain as centerline? | **false** |

Ring endpoint clustering ≠ open-water / centerline routing.

---

## Crossing safety

| Metric | Value |
|--------|------:|
| proper crossing pairs | 2366 |
| also share E1 endpoint | 16 |
| interior-only crossings | 2350 |
| algorithm uses crossing as edge | **false** |

---

## Limitations

- Global components mix waterways that touch at shared OSM nodes (expected under E1).  
- Induced relation views are the right lens for Belomor/VB/Ladoga chain questions.  
- No navigability, direction, lake mask, or structure snap.  
- Not a production WaterGraph.

---

## Invariants

objects **455001** · members **199570** · conflicts **92**  
No sea-map / AquaRoute changes.
