-- WRG-003 — Unified physical connectivity (offline).
-- E1 (wg_nodes/wg_edges, read-only) ∪ WRG-002 mesh (per area part) ∪ portal attachments.
-- Does NOT mutate wg_edges. No proximity, hubs, chords, Area-Bridge, or area cliques.
-- MultiPolygon parts are never mesh-joined.

CREATE TABLE IF NOT EXISTS water.wrg_unified_component (
  wrg_build_id              BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  physical_component_id     INTEGER NOT NULL,
  e1_node_count             INTEGER NOT NULL DEFAULT 0,
  mesh_vertex_count         INTEGER NOT NULL DEFAULT 0,
  portal_attachment_count   INTEGER NOT NULL DEFAULT 0,
  area_part_count           INTEGER NOT NULL DEFAULT 0,
  min_e1_node_id            BIGINT,
  min_area_id               BIGINT,
  min_part                  INTEGER,
  min_vertex_id             INTEGER,
  evidence                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, physical_component_id),
  CONSTRAINT wrg_unified_comp_id_chk CHECK (physical_component_id >= 0)
);

COMMENT ON TABLE water.wrg_unified_component IS
  'WRG-003 deterministic physical components: E1 adjacency ∪ mesh triangle edges '
  '(one water part) ∪ portal E1-endpoint ↔ mesh-vertex attachments.';

CREATE TABLE IF NOT EXISTS water.wrg_unified_e1_node (
  wrg_build_id           BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  node_id                BIGINT NOT NULL REFERENCES water.wg_nodes(node_id),
  physical_component_id  INTEGER NOT NULL,
  PRIMARY KEY (wrg_build_id, node_id),
  CONSTRAINT wrg_unified_e1_comp_fk
    FOREIGN KEY (wrg_build_id, physical_component_id)
    REFERENCES water.wrg_unified_component (wrg_build_id, physical_component_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wrg_unified_e1_cid_idx
  ON water.wrg_unified_e1_node (wrg_build_id, physical_component_id);

CREATE TABLE IF NOT EXISTS water.wrg_unified_mesh_vertex (
  wrg_build_id           BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  area_id                BIGINT NOT NULL,
  part                   INTEGER NOT NULL,
  vertex_id              INTEGER NOT NULL,
  physical_component_id  INTEGER NOT NULL,
  PRIMARY KEY (wrg_build_id, area_id, part, vertex_id),
  CONSTRAINT wrg_unified_mv_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE,
  CONSTRAINT wrg_unified_mv_comp_fk
    FOREIGN KEY (wrg_build_id, physical_component_id)
    REFERENCES water.wrg_unified_component (wrg_build_id, physical_component_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wrg_unified_mv_cid_idx
  ON water.wrg_unified_mesh_vertex (wrg_build_id, physical_component_id);

CREATE TABLE IF NOT EXISTS water.wrg_unified_attachment (
  wrg_build_id   BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  portal_id      BIGINT NOT NULL,
  area_id        BIGINT NOT NULL,
  part           INTEGER NOT NULL,
  vertex_id      INTEGER NOT NULL,
  edge_id        BIGINT NOT NULL REFERENCES water.wg_edges(edge_id),
  from_node_id   BIGINT NOT NULL,
  to_node_id     BIGINT NOT NULL,
  triangle_id    INTEGER,
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, portal_id),
  CONSTRAINT wrg_unified_att_portal_fk
    FOREIGN KEY (wrg_build_id, portal_id)
    REFERENCES water.wrg_portals (wrg_build_id, portal_id) ON DELETE CASCADE,
  CONSTRAINT wrg_unified_att_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE
);

COMMENT ON TABLE water.wrg_unified_attachment IS
  'Proven WRG-002 mesh portal linking an E1 edge (both endpoints) to a mesh vertex '
  'of one polygon part. Not a snap, DWithin, or new wg_edge.';

CREATE INDEX IF NOT EXISTS wrg_unified_att_area_idx
  ON water.wrg_unified_attachment (wrg_build_id, area_id, part);
