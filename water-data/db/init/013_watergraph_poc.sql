-- E5 — Isolated WaterGraph PoC schema (E1 exact-endpoint topology).
-- Separate layer OVER routing_segments. Not wired to AquaRoute / sea-map / BRouter.
-- Does NOT mutate water.objects / object_members / routing_*.
--
-- Connection rule: E4.5 E1 only (exact endpoint identity).
-- Crossing / proximity / tolerance / name / relation-membership do NOT create edges.

CREATE TABLE IF NOT EXISTS water.wg_build (
  build_id          BIGSERIAL PRIMARY KEY,
  built_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  rule_id           TEXT NOT NULL DEFAULT 'E1',
  rule_note         TEXT NOT NULL DEFAULT
    'exact endpoint match round(lon/lat,7); no tolerance; no crossing edges',
  source_view       TEXT NOT NULL DEFAULT 'water.routing_segments',
  segment_count     BIGINT NOT NULL,
  node_count        BIGINT NOT NULL,
  edge_count        BIGINT NOT NULL,
  component_count   BIGINT NOT NULL,
  builder           TEXT NOT NULL DEFAULT 'ingest/e5_watergraph_poc_build.py',
  builder_version   TEXT NOT NULL DEFAULT 'e5-poc-1',
  extras            JSONB NOT NULL DEFAULT '{}'::jsonb
);

COMMENT ON TABLE water.wg_build IS
  'WaterGraph PoC build fingerprint for reproducibility. Isolated — not production routing.';

CREATE TABLE IF NOT EXISTS water.wg_nodes (
  node_id           BIGSERIAL PRIMARY KEY,
  build_id          BIGINT NOT NULL REFERENCES water.wg_build(build_id) ON DELETE CASCADE,
  e1_lon            NUMERIC(12,7) NOT NULL,
  e1_lat            NUMERIC(12,7) NOT NULL,
  geom              geometry(Point, 4326) NOT NULL,
  degree            INTEGER NOT NULL DEFAULT 0,
  component_id      INTEGER,
  CONSTRAINT wg_nodes_e1_uq UNIQUE (build_id, e1_lon, e1_lat)
);

COMMENT ON TABLE water.wg_nodes IS
  'E1 endpoint nodes: one node per unique round(lon,7)/round(lat,7). Not navigability.';

CREATE INDEX IF NOT EXISTS wg_nodes_build_component_idx
  ON water.wg_nodes (build_id, component_id);
CREATE INDEX IF NOT EXISTS wg_nodes_geom_gix
  ON water.wg_nodes USING GIST (geom);

CREATE TABLE IF NOT EXISTS water.wg_edges (
  edge_id               BIGSERIAL PRIMARY KEY,
  build_id              BIGINT NOT NULL REFERENCES water.wg_build(build_id) ON DELETE CASCADE,
  -- segment identity (from routing_segments)
  osm_type              TEXT NOT NULL,
  osm_id                BIGINT NOT NULL,
  part_index            INTEGER NOT NULL,
  object_id             BIGINT,  -- water.objects.id when available
  -- E1 endpoints
  from_node_id          BIGINT NOT NULL REFERENCES water.wg_nodes(node_id) ON DELETE CASCADE,
  to_node_id            BIGINT NOT NULL REFERENCES water.wg_nodes(node_id) ON DELETE CASCADE,
  -- provenance / classification (copied, not authoritative beyond segments)
  name                  TEXT,
  water_type            TEXT,
  waterway              TEXT,
  category              TEXT,
  relevance             TEXT,
  is_relation_member    BOOLEAN,
  parent_relation_ids   BIGINT[],
  -- geometry metadata (same as segment; not rewritten)
  geom                  geometry(LineString, 4326) NOT NULL,
  length_m              DOUBLE PRECISION NOT NULL,
  point_count           INTEGER,
  component_id          INTEGER,
  is_zero_length        BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT wg_edges_osm_type_check CHECK (osm_type IN ('way')),
  CONSTRAINT wg_edges_segment_uq UNIQUE (build_id, osm_type, osm_id, part_index)
);

COMMENT ON TABLE water.wg_edges IS
  'One undirected PoC edge per routing_segments row. from→to follows segment start→end '
  '(orientation preserved as metadata only; directionality not implemented). '
  'Relation membership is provenance on the edge — not an extra connection.';

CREATE INDEX IF NOT EXISTS wg_edges_build_component_idx
  ON water.wg_edges (build_id, component_id);
CREATE INDEX IF NOT EXISTS wg_edges_from_node_idx
  ON water.wg_edges (from_node_id);
CREATE INDEX IF NOT EXISTS wg_edges_to_node_idx
  ON water.wg_edges (to_node_id);
CREATE INDEX IF NOT EXISTS wg_edges_parent_rel_gin
  ON water.wg_edges USING GIN (parent_relation_ids);
CREATE INDEX IF NOT EXISTS wg_edges_geom_gix
  ON water.wg_edges USING GIST (geom);
CREATE INDEX IF NOT EXISTS wg_edges_osm_idx
  ON water.wg_edges (build_id, osm_type, osm_id);
