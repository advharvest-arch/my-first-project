# E4.3 — Routing segment / endpoint inventory

**READ-ONLY** linear geometry preparation for a future WaterGraph.

Does **not** create graph nodes or edges. Does **not** imply navigability. Does **not** stitch gaps.

---

## Views

| View | Role |
|------|------|
| `water.routing_geometry_class` | Diagnostic class of each `routing_candidates` row |
| `water.routing_segments` | LINESTRING / MULTILINESTRING **way** parts + endpoints |

DDL: [`db/init/012_routing_segments.sql`](../db/init/012_routing_segments.sql)

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/012_routing_segments.sql
```

---

## Segment rules

**Source:** `water.routing_candidates`.

**Included in `routing_segments`:** candidate **ways** with `LINESTRING` or `MULTILINESTRING` only.

| Rule | Behavior |
|------|----------|
| LINESTRING | One segment; geometry unchanged; `part_index = 0`; `segment_kind = LINEAR_SEGMENT` |
| MULTILINESTRING | `ST_Dump` each part; **no** `ST_LineMerge`; `part_index` 0-based; `segment_kind = MULTILINE_PART` |
| POLYGON / MULTIPOLYGON / POINT | Not segments |
| **Relation** geometries | Classified diagnostically; **not** expanded into `routing_segments` (member ways are SoT) |

### Endpoints (geometry only)

- `start_point` / `end_point` via `ST_StartPoint` / `ST_EndPoint`
- `point_count` = `ST_NPoints`
- `length_m` = `ST_Length(geometry::geography)`

Endpoint proximity is **not** a connection proof.

### Source fields

`osm_type`, `osm_id`, `part_index`, `category` (= candidate_category), `relevance`, `water_type`, `waterway`, `name`, `is_relation_member`, `parent_relation_ids` (from existing `object_members` / candidates — not proximity).

Identity of a segment row: `(osm_type, osm_id, part_index)`.

---

## Geometry class (diagnostic)

| Class | Meaning |
|-------|---------|
| `LINEAR_SEGMENT` | Candidate with LINESTRING (ways become segments) |
| `MULTILINE_PART` | Candidate with MULTILINESTRING (relation MLS classified here; ways would dump to parts) |
| `AREA_NOT_SEGMENT` | POLYGON / MULTIPOLYGON |
| `POINT_NOT_SEGMENT` | POINT |

---

## Inventory (objects=455001 fingerprint)

### Geometry class

| geometry_class | count |
|----------------|------:|
| LINEAR_SEGMENT | 175173 |
| AREA_NOT_SEGMENT | 30596 |
| MULTILINE_PART | 1428 (all **relations** in this DB) |
| POINT_NOT_SEGMENT | 619 |

### Segments

| Metric | Value |
|--------|------:|
| **segments** | **175173** |
| LINEAR_SEGMENT (way LINESTRING) | 175173 |
| MULTILINE_PART expanded | **0** (no MULTILINESTRING ways in candidates) |
| no endpoints | 0 |
| invalid geometry | 0 |
| zero-length | 0 |
| duplicate `(osm_type,osm_id,part_index)` | 0 |
| relation-member segments | 124510 |

### Length distribution

| bucket | count |
|--------|------:|
| 0–10 m | 5386 |
| 10–100 m | 53519 |
| 100 m–1 km | 84719 |
| 1–10 km | 28450 |
| 10 km+ | 3099 |

Summary: min ≈0.14 m · p50 ≈199 m · p90 ≈2.1 km · max ≈182 km · total ≈177938 km

---

## Key checks

### Belomor `9909116`

- Relation geometry **not** a `routing_segments` row (0)
- **29** member-way segments; all have endpoints
- Member ways = source geometry

### Volga–Baltic `16738852`

- Relation geometry **not** a segment (0)
- **106** member-way segments (separate identities)
- Ways `28433211` and `824398188` (seq 53→54) remain **two** segments
- Min endpoint gap ≈ **8.784 km** (diagnostic only — **not** connected)

### Ladoga `21149039`

- Relation class `MULTILINE_PART` / multipolygon shell; **not** a routing segment (0)
- **10364** member-way segments (rings/shells — **not** one centerline)

---

## Invariants (unchanged)

objects **455001** · members **199570** · conflicts **92**

Unchanged: `water.objects`, `object_members`, `routing_relevance`, `routing_candidates`, sea-map.

---

## Limitations

- Lake multipolygon ring ways appear as LINEAR_SEGMENT (they are linestrings); they are not navigable centerlines.
- No MULTILINESTRING ways in current candidates → dump path unexercised on live data (kept for correctness).
- No graph nodes/edges; endpoints are not snapped or clustered.

---

## Next step (proposal only — not started)

**E4.4 (proposal):** optional endpoint clustering / coincidence inventory for diagnostics — still without creating graph nodes/edges unless separately requested.
