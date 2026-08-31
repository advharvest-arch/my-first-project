-- AquaRoute E3.7: conflict log — never silent overwrite of canonical values.

CREATE TABLE IF NOT EXISTS water.object_conflicts (
  id                BIGSERIAL PRIMARY KEY,
  osm_type          TEXT NOT NULL,
  osm_id            BIGINT NOT NULL,
  batch_id          BIGINT NOT NULL REFERENCES water.import_batches (id) ON DELETE CASCADE,
  conflict_type     TEXT NOT NULL,
  canonical_value   JSONB NOT NULL,
  incoming_value    JSONB NOT NULL,
  resolution        TEXT NOT NULL DEFAULT 'keep_canonical',
  status            TEXT NOT NULL DEFAULT 'open',
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes             TEXT,

  CONSTRAINT object_conflicts_osm_type_check
    CHECK (osm_type IN ('node', 'way', 'relation')),
  CONSTRAINT object_conflicts_type_check
    CHECK (conflict_type IN (
      'geometry', 'tags', 'name', 'water_type', 'members_order', 'other'
    )),
  CONSTRAINT object_conflicts_resolution_check
    CHECK (resolution IN (
      'keep_canonical', 'take_incoming', 'merged', 'deferred'
    )),
  CONSTRAINT object_conflicts_status_check
    CHECK (status IN ('open', 'resolved', 'ignored')),
  -- Idempotent: same batch + object + conflict type recorded once
  CONSTRAINT object_conflicts_batch_object_type_uq
    UNIQUE (batch_id, osm_type, osm_id, conflict_type)
);

COMMENT ON TABLE water.object_conflicts IS
  'Detected staging vs canonical disagreements. Default resolution: keep_canonical.';

CREATE INDEX IF NOT EXISTS object_conflicts_object_idx
  ON water.object_conflicts (osm_type, osm_id);

CREATE INDEX IF NOT EXISTS object_conflicts_status_idx
  ON water.object_conflicts (status);
