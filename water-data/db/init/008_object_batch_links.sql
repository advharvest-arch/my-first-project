-- AquaRoute E3.7: which batches contributed to a canonical OSM object.

CREATE TABLE IF NOT EXISTS water.object_batch_links (
  osm_type   TEXT NOT NULL,
  osm_id     BIGINT NOT NULL,
  batch_id   BIGINT NOT NULL REFERENCES water.import_batches (id) ON DELETE CASCADE,
  link_role  TEXT NOT NULL DEFAULT 'object',
  linked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT object_batch_links_osm_type_check
    CHECK (osm_type IN ('node', 'way', 'relation')),
  CONSTRAINT object_batch_links_role_check
    CHECK (link_role IN ('object', 'member_contrib')),
  CONSTRAINT object_batch_links_pk
    PRIMARY KEY (osm_type, osm_id, batch_id, link_role)
);

COMMENT ON TABLE water.object_batch_links IS
  'Many-to-many: canonical (osm_type, osm_id) ← contributing import_batches.';

CREATE INDEX IF NOT EXISTS object_batch_links_batch_idx
  ON water.object_batch_links (batch_id);
