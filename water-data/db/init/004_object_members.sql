-- AquaRoute E3.3: OSM relation membership (provenance only — not a routing graph).
-- Approved separately from tags JSONB so membership is queryable both ways.
-- No SQL FOREIGN KEY to water.objects: OSM import order and partial extracts mean
-- a member may be referenced before (or without) a matching water.objects row.

CREATE TABLE IF NOT EXISTS water.object_members (
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

COMMENT ON TABLE water.object_members IS
  'Ordered OSM relation members. Separate from water.objects.tags (tags stay original). '
  'Logical link to water.objects via (parent_osm_type, parent_osm_id) and '
  '(member_osm_type, member_osm_id) — no FK, because members need not all be imported.';

COMMENT ON COLUMN water.object_members.parent_osm_type IS
  'Parent OSM type; currently always relation.';
COMMENT ON COLUMN water.object_members.parent_osm_id IS
  'Parent OSM relation id (e.g. 9909116 Belomor).';
COMMENT ON COLUMN water.object_members.seq IS
  '0-based order of the member inside the relation (preserves OSM member list order).';
COMMENT ON COLUMN water.object_members.member_osm_type IS
  'Member element type: node, way, or relation.';
COMMENT ON COLUMN water.object_members.member_osm_id IS
  'Member OSM id.';
COMMENT ON COLUMN water.object_members.member_role IS
  'OSM member role (e.g. main_stream); empty string if unset.';

-- Direction 1: members of a given relation
CREATE INDEX IF NOT EXISTS object_members_parent_idx
  ON water.object_members (parent_osm_type, parent_osm_id);

-- Direction 2: relations that contain a given member (e.g. a way)
CREATE INDEX IF NOT EXISTS object_members_member_idx
  ON water.object_members (member_osm_type, member_osm_id);
