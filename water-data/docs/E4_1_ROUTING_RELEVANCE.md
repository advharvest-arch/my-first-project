# E4.1 — Routing relevance layer

**READ-ONLY classification.** No canonical mutations. No WaterGraph. No navigability claims.

Creates SQL **VIEW** `water.routing_relevance` over existing `water.objects` / `water.object_members`.

---

## Why this exists

E3.11 showed that the local water DB mixes core network candidates (rivers, canals, lakes) with high-volume collateral (ditch/drain, import noise). Before any WaterGraph work, objects need a **routing-relevance** label so later stages can filter without deleting or rewriting OSM data.

Relevance answers:

> Is this object worth considering when building a future WaterGraph?

It does **not** answer:

> Is this object navigable?

---

## Categories

| Category | Meaning |
|----------|---------|
| **HIGH** | Directly useful for future routing graph / open-water context / control structures |
| **MEDIUM** | Topology / snap / validation / amenities |
| **LOW** | Minor collateral water; optional reference |
| **IGNORE** | No obvious routing relevance from OSM attributes |

**HIGH ≠ navigable. MEDIUM ≠ navigable.**

---

## Classification rules (attribute / tag / type only)

Rules are evaluated in order (first match wins). **No** proximity, **no** nearest-object joins, **no** name heuristics, **no** geometry stitching.

### HIGH

| Signal | Reason label |
|--------|----------------|
| `waterway` ∈ {lock_gate, lock} / `lock`=yes / water_type ~ lock | `structure:lock` |
| `waterway`/`water`=dam / water_type ~ dam | `structure:dam` |
| `waterway`=weir | `structure:weir` |
| `waterway`=waterfall | `structure:waterfall` |
| `waterway` ∈ {river, canal, fairway, link, tidal_channel} | `waterway:<value>` |
| `water` ∈ {lake, reservoir} | `water:<value>` |
| `landuse`=reservoir | `landuse:reservoir` |
| `water_type` ∈ {lake, reservoir} | `water_type:<value>` |
| relation `type`=waterway | `relation type=waterway` |

### MEDIUM

| Signal | Reason label |
|--------|----------------|
| `waterway`=stream | `waterway:stream` |
| `water`=river / `water_type`=river_area | `river_area / water=river` |
| relation `route`=waterway | `relation route=waterway` |
| amenity/leisure/man_made water service tags; waterway ∈ {fuel, boatyard, dock, access_point, milestone} | `water amenity/service` |

### LOW

| Signal | Reason label |
|--------|----------------|
| `waterway` ∈ {ditch, drain, flowline, brook, rapids, fish_pass} | `minor waterway:<value>` |
| `water` ∈ {pond, oxbow, moat, reflecting_pool, wastewater, basin} / water_type ∈ {pond, oxbow} | `minor water body` |
| remaining `natural`=water | `natural=water (non lake/reservoir)` |

### IGNORE

Everything else (`no routing-relevant tags`).

---

## VIEW columns

| Column | Notes |
|--------|-------|
| `id`, `osm_type`, `osm_id`, `name`, `water_type`, `geometry`, `tags` | Pass-through from `water.objects` (full tags preserved) |
| `relevance`, `relevance_reason` | Classification |
| `is_relation` | `osm_type = 'relation'` |
| `member_count`, `present_member_count` | From `water.object_members` (NULL for non-relations). Presence = member identity exists in `water.objects`. **Not** a completeness/continuity/navigability verdict. |
| `geometry_type`, `has_geometry`, `is_valid_geometry` | Diagnostics only. Relation geometry is **not** rebuilt. |

DDL: [`db/init/010_routing_relevance.sql`](../db/init/010_routing_relevance.sql)

```bash
docker compose exec -T db \
  psql -U aquaroute -d aquaroute_water < db/init/010_routing_relevance.sql
```

---

## Inventory (post–E3.13 fingerprint; objects=455001)

### By relevance

| relevance | object_count |
|-----------|-------------:|
| HIGH | 48339 |
| MEDIUM | 43008 |
| LOW | 183222 |
| IGNORE | 180432 |

### HIGH aggregate (routing-focused)

| category | count |
|----------|------:|
| lakes | ~25682 |
| rivers | ~19465 |
| reservoirs | ~861 |
| canals | ~814 |
| waterway relations | ~357 |
| weirs / waterfalls / dams / locks | ~1096 |
| fairways / links / tidal_channels | ~88 |

(Exact category buckets use tag/`water_type` precedence similar to the VIEW; some objects can sit in overlapping tag spaces — see smoke SQL.)

---

## Relation handling

- Member stats come from the existing logical model `(parent_osm_type, parent_osm_id)` ↔ `(member_osm_type, member_osm_id)`.
- **Do not** treat `member_count == present_member_count` alone as geometric continuity or navigability (E3.15).
- Relation `objects.geometry` remains non-authoritative for WaterGraph; member ways are SoT.

### Important examples

| osm_type | osm_id | name | water_type | relevance | reason |
|----------|-------:|------|------------|-----------|--------|
| relation | 9909116 | Беломорканал | canal | HIGH | waterway:canal |
| relation | 16738852 | Волго-Балтийский канал | canal | HIGH | waterway:canal |
| relation | 21149039 | Ладожское озеро | lake | HIGH | water:lake |

Kuibyshev reservoir objects are **not** present under that name in the current regional extracts. Closest related hits in DB are Жигулёвское озеро / Жигулёвка (HIGH via lake/river tags).

---

## Negative QA

Way-level `waterway=ditch|drain` → **LOW** (never HIGH).  
Way-level `waterway=stream` → **MEDIUM** (never HIGH).

Named examples (name does **not** elevate relevance):

| waterway | example name | relevance |
|----------|--------------|-----------|
| ditch | Волковский канал (as drain) / named ditches | LOW |
| drain | named drains | LOW |
| stream | Тигода, Велья, … | MEDIUM |

A few **relations** with `type=waterway` and also `waterway=ditch|drain|stream` are **HIGH** because of `type=waterway` (structural parent), not because of name or proximity.

---

## Hard constraints (kept)

- Canonical data unchanged: objects **455001**, members **199570**, conflicts **92**
- identity duplicates **0**, orphan parents **0**, invalid geometry **0**
- No materialized view, no graph indexes/tables/nodes/edges
- No sea-map / AquaRoute / WaterGraph changes
- No synthetic proximity / stitching logic in the VIEW

---

## Limitations

- Classification is coarse OSM-attribute policy, not hydrographic expertise.
- `type=waterway` relations are always HIGH even if the relation’s own `waterway=*` is ditch/stream.
- Amenity/leisure/man_made MEDIUM match is broad (`amenity`/`leisure`/`man_made` non-empty).
- `water_type` LIKE patterns for lock/dam/weir are fallback signals; prefer raw tags.
- IGNORE volume is large (import collateral without water tags) — expected at this stage.
- Does not encode CEMT/boat/navigability attributes into relevance.

---

## Next step (proposal only — not started)

**E4.2 (proposal):** define a **routing candidate extract** query/policy that selects HIGH (+ optional MEDIUM) objects and relation member ways as input for a future WaterGraph builder — still without creating graph tables, still without claiming navigability.
