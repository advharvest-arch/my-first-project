-- AquaRoute E3.7: staging tables for one extract batch (not canonical).

CREATE TABLE IF NOT EXISTS water.staging_objects (
  id              BIGSERIAL PRIMARY KEY,
  batch_id        BIGINT NOT NULL REFERENCES water.import_batches (id) ON DELETE CASCADE,
  osm_type        TEXT NOT NULL,
  osm_id          BIGINT NOT NULL,
  name            TEXT,
  water_type      TEXT,
  geometry        geometry(Geometry, 4326) NOT NULL,
  tags            JSONB NOT NULL DEFAULT '{}'::jsonb,
  source          TEXT NOT NULL DEFAULT 'osm',
  source_version  TEXT,

  CONSTRAINT staging_objects_osm_type_check
    CHECK (osm_type IN ('node', 'way', 'relation')),
  CONSTRAINT staging_objects_batch_identity_uq
    UNIQUE (batch_id, osm_type, osm_id)
);

COMMENT ON TABLE water.staging_objects IS
  'Per-batch OSM water objects prior to merge into water.objects.';

CREATE INDEX IF NOT EXISTS staging_objects_batch_idx
  ON water.staging_objects (batch_id);

CREATE INDEX IF NOT EXISTS staging_objects_identity_idx
  ON water.staging_objects (osm_type, osm_id);

CREATE TABLE IF NOT EXISTS water.staging_members (
  id               BIGSERIAL PRIMARY KEY,
  batch_id         BIGINT NOT NULL REFERENCES water.import_batches (id) ON DELETE CASCADE,
  parent_osm_type  TEXT NOT NULL,
  parent_osm_id    BIGINT NOT NULL,
  seq              INTEGER NOT NULL,
  member_osm_type  TEXT NOT NULL,
  member_osm_id    BIGINT NOT NULL,
  member_role      TEXT NOT NULL DEFAULT '',

  CONSTRAINT staging_members_parent_type_check
    CHECK (parent_osm_type IN ('relation')),
  CONSTRAINT staging_members_member_type_check
    CHECK (member_osm_type IN ('node', 'way', 'relation')),
  CONSTRAINT staging_members_batch_parent_seq_uq
    UNIQUE (batch_id, parent_osm_type, parent_osm_id, seq)
);

COMMENT ON TABLE water.staging_members IS
  'Per-batch OSM relation membership prior to ordered-union merge.';

CREATE INDEX IF NOT EXISTS staging_members_batch_parent_idx
  ON water.staging_members (batch_id, parent_osm_type, parent_osm_id);
