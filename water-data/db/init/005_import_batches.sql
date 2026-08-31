-- AquaRoute E3.7: import batch registry (multi-extract provenance).

CREATE TABLE IF NOT EXISTS water.import_batches (
  id              BIGSERIAL PRIMARY KEY,
  batch_key       TEXT NOT NULL,
  source          TEXT NOT NULL DEFAULT 'osm',
  source_version  TEXT NOT NULL,
  dataset_name    TEXT NOT NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'loaded',
  notes           TEXT,

  CONSTRAINT import_batches_batch_key_uq UNIQUE (batch_key),
  CONSTRAINT import_batches_status_check
    CHECK (status IN ('loaded', 'merging', 'merged', 'failed', 'archived'))
);

COMMENT ON TABLE water.import_batches IS
  'One row per staging load / extract batch. Canonical objects link via object_batch_links.';

CREATE INDEX IF NOT EXISTS import_batches_status_idx
  ON water.import_batches (status);
