# E3.3 blocker: relation-aware storage needs a schema extension

Status: **STOPPED before schema change** (per E3.3 instructions).  
No importer implemented yet. `sea-map/` untouched.

## Probe: Belomor relation 9909116

Fetched once via official OSM API (not Overpass):

`GET https://api.openstreetmap.org/api/0.6/relation/9909116/full`

| Metric | Value |
|--------|--------|
| File size | ~105 KB |
| nodes | 439 |
| ways | 29 |
| relations | 1 (`9909116`) |
| member roles | all `main_stream` (29) |
| tags | `type=waterway`, `waterway=canal`, `name=Беломорканал`, … |

This is a suitable **small real** offline dataset for E3.3 (do not commit the XML/PBF to git).

## Tool comparison (short)

| Option | Fit for `water.objects` | Relations / members | Russia-scale later | Notes |
|--------|-------------------------|---------------------|--------------------|--------|
| **osm2pgsql** (flex) | Needs custom Lua → our tables or staging | Excellent (`object.members`, `as_multilinestring`) | **Best-in-class** | Mature PostGIS path; preferred long-term engine |
| **imposm3** | Mapping YAML → PostGIS | Good for mapped features | Strong | Less control than flex for custom membership tables |
| **pyosmium / osmium** | Direct upsert into our schema | Full access to members + way nodes | OK if streamed carefully | Best for **E3.3** control into existing DDL |
| **ogr2ogr OSM** | Possible | Weak / lossy on relations | Poor for our model | Not chosen |
| Custom PBF parser | — | — | — | Avoided |

**Intended choice after schema approval:**

- **E3.3 path:** `pyosmium` (or osmium + small Python loader) → `water.objects` (+ members table) with `ON CONFLICT` upsert. No Overpass, no AquaRoute.
- **Later Russia-scale:** keep osm2pgsql flex as the primary bulk engine (staging or direct flex tables), then normalize into `water.*` — same logical model.

osm2pgsql alone was not chosen for the *first* E3.3 cut because default/flex outputs do not match `water.objects` without either staging tables or a custom flex config that still needs a place to store **members**.

## Why `water.objects` is not enough

Current columns: identity, tags, geometry, source metadata.  
There is **no** field for relation membership (`type` / `ref` / `role` / order).

Without that:

- We can import the 29 member **ways** as rows and assemble a relation **MultiLineString** from their real OSM geometries (that assembly is *not* a synthetic seam — it is standard OSM relation geometry from members).
- We **cannot** later answer in SQL: “which ways belong to relation 9909116 with which roles?”
- Stuffing members into `tags` would corrupt the provenance rule (“`tags` = original OSM tags only”).

E3.3 explicitly requires seeing the relation **and** its members/composition → **schema extension required**.

## Minimal proposed extension (NOT applied)

Prefer a normalized child table (queryable, no tag pollution):

```sql
-- PROPOSAL ONLY — not applied in this stop.
CREATE TABLE water.object_members (
  id               BIGSERIAL PRIMARY KEY,
  parent_osm_type  TEXT NOT NULL,
  parent_osm_id    BIGINT NOT NULL,
  seq              INTEGER NOT NULL,
  member_osm_type  TEXT NOT NULL,
  member_osm_id    BIGINT NOT NULL,
  member_role      TEXT NOT NULL DEFAULT '',
  CONSTRAINT object_members_parent_type_check
    CHECK (parent_osm_type IN ('relation')),
  CONSTRAINT object_members_member_type_check
    CHECK (member_osm_type IN ('node', 'way', 'relation')),
  CONSTRAINT object_members_parent_seq_uq
    UNIQUE (parent_osm_type, parent_osm_id, seq)
);

CREATE INDEX object_members_parent_idx
  ON water.object_members (parent_osm_type, parent_osm_id);

CREATE INDEX object_members_member_idx
  ON water.object_members (member_osm_type, member_osm_id);

COMMENT ON TABLE water.object_members IS
  'Ordered OSM membership for relations. Provenance only — not a routing graph.';
```

Smaller alternative (if you want fewer objects): nullable `members JSONB` on `water.objects`  
`[{ "type":"way", "ref":358560986, "role":"main_stream" }, ...]`.  
Adequate for E3.3 audits; weaker for “find relations containing way X”.

**Recommendation:** `water.object_members` (normalized).

Also keep:

- Relation row in `water.objects` with `osm_type='relation'`, full `tags`, `source='osm'`
- `geometry` = `ST_Collect` / multilinestring of **member way geometries only** (real OSM coords; no invented seams)
- Member ways as their own `water.objects` rows
- Upsert on `UNIQUE (osm_type, osm_id)`; replace members for a relation in one transaction on re-import

## What was NOT done

- No `ALTER` / new migration applied
- No `water-data/ingest/` importer
- No OSM file committed
- No sea-map / router changes
- No graph / edges / connections

## Resume condition

Approve one of:

1. Add `water.object_members` as above, or  
2. Add `water.objects.members JSONB`

Then E3.3 can continue: download script (OSM API full or small PBF extract) → offline importer → validation SQL for relation `9909116`.
