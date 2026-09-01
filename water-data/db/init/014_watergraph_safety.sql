-- E6 — WaterGraph safety validation layer (isolated, read-only w.r.t. canonical).
-- Stores safety decisions for a given wg_build. Does not mutate objects/segments.

CREATE TABLE IF NOT EXISTS water.wg_safety_run (
  safety_run_id   BIGSERIAL PRIMARY KEY,
  build_id        BIGINT NOT NULL REFERENCES water.wg_build(build_id) ON DELETE CASCADE,
  ran_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  validator       TEXT NOT NULL DEFAULT 'ingest/e6_watergraph_safety.py',
  validator_version TEXT NOT NULL DEFAULT 'e6-1',
  summary         JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE water.wg_safety_run IS
  'E6 safety validation run against an isolated WaterGraph build. Not navigability.';

CREATE TABLE IF NOT EXISTS water.wg_edge_safety (
  safety_run_id   BIGINT NOT NULL REFERENCES water.wg_safety_run(safety_run_id) ON DELETE CASCADE,
  edge_id         BIGINT NOT NULL REFERENCES water.wg_edges(edge_id) ON DELETE CASCADE,
  build_id        BIGINT NOT NULL,
  status          TEXT NOT NULL
    CHECK (status IN ('ALLOWED_TOPOLOGY', 'REJECTED_TOPOLOGY', 'UNKNOWN')),
  reasons         TEXT[] NOT NULL DEFAULT '{}',
  flags           JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (safety_run_id, edge_id)
);

COMMENT ON TABLE water.wg_edge_safety IS
  'Per-edge topology safety. ALLOWED_TOPOLOGY ≠ navigable. UNKNOWN = caution flags.';

CREATE INDEX IF NOT EXISTS wg_edge_safety_status_idx
  ON water.wg_edge_safety (safety_run_id, status);
CREATE INDEX IF NOT EXISTS wg_edge_safety_build_idx
  ON water.wg_edge_safety (build_id, status);
