# E4.2 — Routing candidate extract

**READ-ONLY candidate layer** for a future WaterGraph. Built on `water.routing_relevance` (E4.1) and `water.object_members`.

Does **not** mutate canonical data. Does **not** imply navigability. Does **not** create graph nodes/edges.

---

## Purpose

Turn relevance labels into a concrete **candidate set**: objects that a later WaterGraph builder may consider, without copying geometry or inventing connections.

Identity of every candidate is `(osm_type, osm_id)` referencing `water.objects`. Geometry in the VIEW is the same row reference — not a synthetic copy.

---

## VIEW: `water.routing_candidates`

DDL: [`db/init/011_routing_candidates.sql`](../db/init/011_routing_candidates.sql)

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/011_routing_candidates.sql
```

Plain SQL VIEW (materializable later if needed). **Not** a materialized view in E4.2.

### Inclusion paths

| Source | Rule |
|--------|------|
| **HIGH_DIRECT** | `routing_relevance.relevance = 'HIGH'` |
| **MEDIUM_WATERWAY** | `relevance = 'MEDIUM'` and (`waterway=stream` or `water=river` or `water_type=river_area`) |
| **RELATION_MEMBER** | way members of **HIGH** relations that are `type=waterway` **or** lake/reservoir parents |
| **DUPLICATE_SOURCE** | same identity matched **more than one** of the paths above |

Geometry deduplication is **forbidden**. Collapse is by `(osm_type, osm_id)` only.

### Columns (minimum + diagnostics)

| Column | Role |
|--------|------|
| `id`, `osm_type`, `osm_id`, `name`, `water_type`, `geometry`, `tags` | Pass-through from `water.objects` |
| `relevance`, `relevance_reason` | From `routing_relevance` |
| `waterway`, `natural`, `water` | Tag extracts |
| `candidate_category`, `candidate_sources`, `is_multi_source` | Inclusion diagnostics |
| `is_relation`, `member_count`, `present_member_count` | Relation context (presence ≠ navigability / continuity) |
| `parent_relation_ids`, `parent_relation_count`, `is_high_relation_member` | Membership in HIGH waterway/lake parents |
| `geometry_type`, `has_geometry`, `is_valid_geometry` | Geometry diagnostics |

---

## Inventory (objects=455001 fingerprint)

| Metric | Value |
|--------|------:|
| **candidates** | **207816** |
| HIGH_DIRECT | 41992 |
| MEDIUM_WATERWAY | 41265 |
| RELATION_MEMBER | 116544 |
| DUPLICATE_SOURCE | 8015 |
| identity duplicates in VIEW | **0** |
| without geometry | **0** |

By relevance among candidates: HIGH 48339 · MEDIUM 42937 · LOW 163 · IGNORE 116377  
(IGNORE rows are almost entirely lake/reservoir **ring ways** pulled via RELATION_MEMBER — not centerlines.)

### Geometry types

| geometry_type | count |
|---------------|------:|
| LINESTRING | 175173 |
| MULTIPOLYGON | 30574 |
| MULTILINESTRING | 1428 |
| POINT | 619 |
| POLYGON | 22 |

---

## Key relation checks

| Relation | Present | Member ways in candidates | Identity dups |
|----------|---------|--------------------------:|--------------:|
| Belomor `9909116` | HIGH_DIRECT | 29 | 0 |
| Volga–Baltic `16738852` | HIGH_DIRECT | 106 | 0 |
| Ladoga `21149039` | HIGH_DIRECT | 10364 | 0 |

**Ladoga members are multipolygon rings / shells — not a single centerline.** Completeness of members is not a routing success metric (E3.15).

---

## Hard constraints (kept)

- `water.objects` / `object_members` / conflicts **unchanged** (455001 / 199570 / 92)
- No sea-map / AquaRoute / WaterGraph wiring
- No graph schema, nodes, or edges
- No proximity stitching, name similarity, synthetic geometry
- No new PBF downloads

---

## Limitations

- Large RELATION_MEMBER volume from lake multipolygon rings (expected; filter later for linear graph).
- Amenities / docks that are MEDIUM but not stream/river_area are **excluded** (by design).
- Candidate ≠ edge; no connectivity is asserted.
- VIEW can be slow on cold full-table scans; smoke queries are acceptable for QA.

---

## Next step (proposal only — not started)

**E4.3 (proposal):** optional physical materialization / indexed candidate extract for builder performance — still without graph nodes/edges unless separately requested.
