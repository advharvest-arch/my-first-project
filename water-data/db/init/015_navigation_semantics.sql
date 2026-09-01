-- E8 — Navigation semantics layer over WaterGraph (isolated).
-- Does NOT change E1 topology, canonical OSM, or routing_segments.
-- NAVIGABLE ≠ navigable craft passage evidence from OSM tags — not a production guarantee.

CREATE TABLE IF NOT EXISTS water.wg_navigation_run (
  navigation_run_id BIGSERIAL PRIMARY KEY,
  build_id          BIGINT NOT NULL REFERENCES water.wg_build(build_id) ON DELETE CASCADE,
  safety_run_id     BIGINT REFERENCES water.wg_safety_run(safety_run_id) ON DELETE SET NULL,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  classifier        TEXT NOT NULL DEFAULT 'ingest/e8_navigation_semantics.py',
  classifier_version TEXT NOT NULL DEFAULT 'e8-1',
  summary           JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE water.wg_navigation_run IS
  'E8 navigation-semantics classification run. Isolated — not AquaRoute routing.';

CREATE TABLE IF NOT EXISTS water.wg_edge_navigation (
  navigation_run_id BIGINT NOT NULL REFERENCES water.wg_navigation_run(navigation_run_id) ON DELETE CASCADE,
  edge_id           BIGINT NOT NULL REFERENCES water.wg_edges(edge_id) ON DELETE CASCADE,
  build_id          BIGINT NOT NULL,
  status            TEXT NOT NULL
    CHECK (status IN ('NAVIGABLE', 'BLOCKED', 'UNKNOWN')),
  reasons           TEXT[] NOT NULL DEFAULT '{}',
  evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (navigation_run_id, edge_id)
);

COMMENT ON TABLE water.wg_edge_navigation IS
  'Per-edge navigation status from OSM tag evidence. Insufficient evidence => UNKNOWN.';

CREATE INDEX IF NOT EXISTS wg_edge_navigation_status_idx
  ON water.wg_edge_navigation (navigation_run_id, status);
