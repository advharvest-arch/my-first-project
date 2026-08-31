# E4.4 — READ-ONLY topology inference audit

Diagnose how `water.routing_segments` could become a future topology —
**without** creating graph nodes/edges or mutating canonical data.

---

## Scope

| Do | Do not |
|----|--------|
| Endpoint connectivity diagnostics (exact / 1 / 5 / 10 m) | Create `graph_nodes` / `graph_edges` |
| Classify geometric crossings | Treat crossing as automatic junction |
| Relation-scoped audits (Belomor, Volga–Baltic, Ladoga) | Stitch gaps / synthetic geometry |
| TEMP / tooling only | Change objects, members, relevance, candidates |

**Linear SoT:** `water.routing_segments` only.

---

## Tooling

```bash
# Full audit (includes global crossing pass ~15–30s)
python3 ingest/e44_topology_inference_audit.py \
  --json-out data/e44_topology_inference.json

# Faster (skip global crossings)
python3 ingest/e44_topology_inference_audit.py --skip-crossings

docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/smoke/e44_topology_inference.sql
```

Script: [`ingest/e44_topology_inference_audit.py`](../ingest/e44_topology_inference_audit.py)  
Smoke: [`db/smoke/e44_topology_inference.sql`](../db/smoke/e44_topology_inference.sql)

---

## Method

### Endpoints

Each segment contributes `start_point` and `end_point` (E4.3).

| Mode | Clustering (diagnostic) |
|------|-------------------------|
| **exact** | Round lon/lat to 7 decimals (~1.1 cm) |
| **1 / 5 / 10 m** | `ST_SnapToGrid` on EPSG:3857 (approx metres; not a geometry edit) |

Metrics per mode:

- `unique_endpoints` — distinct cluster locations  
- `connected_clusters` — degree ≥ 2 (shared by ≥2 segments)  
- `isolated_endpoints` — degree = 1  
- `junction_candidates` — degree ≥ 3 (**not** nodes)  
- `segments_without_connection` — both ends degree 1  

**Endpoint proximity ≠ routing connection proof.**

### Crossings

Pairwise `ST_Intersects` among segments (GIST-assisted):

| Class | Meaning |
|-------|---------|
| `crossings` (`ST_Crosses`) | Interior intersection — **not** an auto-junction |
| `touches_only` | Boundary/endpoint contact |
| `overlaps` | Linear overlap |

### Relations

- **Belomor `9909116`:** 29 member-way segments; seq-chain continuity ≤10 m (expect continuous).  
- **Volga–Baltic `16738852`:** 106 members; preserve gap ways `28433211`↔`824398188` (~8.8 km); **do not stitch**.  
- **Ladoga `21149039`:** multipolygon rings — **not** a centerline; no continuity-as-routing success.

---

## Results (fingerprint objects=455001)

| Metric | Value |
|--------|------:|
| segments | 175173 |
| endpoint rows | 350346 |
| unique endpoints (exact) | 203818 |
| connected clusters (exact, degree≥2) | 119266 |
| isolated endpoints (exact) | 84552 |
| junction candidates (exact, degree≥3) | 2466 |
| segments without connection (exact) | 46712 |
| unique endpoints @1 m | 203816 |
| unique endpoints @5 m | 203697 |
| unique endpoints @10 m | 203255 |
| proper crossings (`ST_Crosses`) | 2366 |
| touches_only pairs | 147778 |

### Degree distribution (exact)

| degree | clusters |
|-------:|---------:|
| 1 | 84552 |
| 2 | 116800 |
| 3 | 2332 |
| 4 | 132 |
| 5 | 2 |

### Relations

| Relation | Result |
|----------|--------|
| Belomor | 29 segments; continuous chain 28/28 links ≤10 m |
| Volga–Baltic | 106 segments; gap seq 53→54 ≈ **8.765 km** (not stitched) |
| Ladoga | 10364 ring segments; not treated as centerline |

Canonical unchanged: objects **455001** · members **199570** · conflicts **92**.

---

## Limitations

- EPSG:3857 SnapToGrid is approximate at high latitudes (audit tolerance, not a node snap).  
- Global crossings enumerate all intersecting pairs — informative, not a graph.  
- Degree counts treat a location shared by N segments as one cluster of degree N.  
- No directed orientation / flow inference.

---

## Next step

**Not in E4.4.** Graph schema / nodes / edges require a separate explicit task.
