-- AquaRoute E3.1: minimal schema foundation only.
-- Do NOT create water_objects / water_edges / graph tables here yet.

CREATE SCHEMA IF NOT EXISTS water;

CREATE TABLE IF NOT EXISTS water.data_sources (
  id              BIGSERIAL PRIMARY KEY,
  source_name     TEXT NOT NULL,
  source_version  TEXT,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS data_sources_source_name_idx
  ON water.data_sources (source_name);
