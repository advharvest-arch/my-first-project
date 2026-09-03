-- WRG-002 — Isolated constrained mesh overlay on WRG-001 lake/reservoir areas.
-- Shapely CDT + portal attach. Does NOT mutate wg_edges / wg_nodes / objects / wrg_areas.
-- Does NOT create proximity / hub / chord edges. Parts of a MultiPolygon are never joined.

CREATE TABLE IF NOT EXISTS water.wrg_mesh_vertices (
  wrg_build_id   BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  area_id        BIGINT NOT NULL,
  part           INTEGER NOT NULL,
  vertex_id      INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  geom           geometry(Point, 4326) NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, area_id, part, vertex_id),
  CONSTRAINT wrg_mesh_vertices_part_chk CHECK (part >= 1),
  CONSTRAINT wrg_mesh_vertices_vid_chk CHECK (vertex_id >= 0),
  CONSTRAINT wrg_mesh_vertices_kind_chk CHECK (kind IN (
    'boundary', 'hole', 'portal_steiner'
  )),
  CONSTRAINT wrg_mesh_vertices_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE
);

COMMENT ON TABLE water.wrg_mesh_vertices IS
  'WRG-002 CDT vertices per area polygon part. Portal Steiner points are extra; '
  'parts never share vertex identity.';

CREATE INDEX IF NOT EXISTS wrg_mesh_vertices_area_idx
  ON water.wrg_mesh_vertices (wrg_build_id, area_id, part);
CREATE INDEX IF NOT EXISTS wrg_mesh_vertices_gix
  ON water.wrg_mesh_vertices USING GIST (geom);

CREATE TABLE IF NOT EXISTS water.wrg_mesh_triangles (
  wrg_build_id   BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  area_id        BIGINT NOT NULL,
  part           INTEGER NOT NULL,
  triangle_id    INTEGER NOT NULL,
  v0             INTEGER NOT NULL,
  v1             INTEGER NOT NULL,
  v2             INTEGER NOT NULL,
  geom           geometry(Polygon, 4326) NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, area_id, part, triangle_id),
  CONSTRAINT wrg_mesh_triangles_part_chk CHECK (part >= 1),
  CONSTRAINT wrg_mesh_triangles_tid_chk CHECK (triangle_id >= 0),
  CONSTRAINT wrg_mesh_triangles_distinct_chk CHECK (
    v0 <> v1 AND v1 <> v2 AND v2 <> v0
  ),
  CONSTRAINT wrg_mesh_triangles_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE
);

COMMENT ON TABLE water.wrg_mesh_triangles IS
  'WRG-002 constrained triangles. v0,v1,v2 are CCW, rotated so v0 is the smallest id. '
  'triangle_id assigned by sort(v0,v1,v2). Each triangle is covered by its water part.';

CREATE INDEX IF NOT EXISTS wrg_mesh_triangles_area_idx
  ON water.wrg_mesh_triangles (wrg_build_id, area_id, part);
CREATE INDEX IF NOT EXISTS wrg_mesh_triangles_gix
  ON water.wrg_mesh_triangles USING GIST (geom);

CREATE TABLE IF NOT EXISTS water.wrg_mesh_adjacency (
  wrg_build_id    BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  area_id         BIGINT NOT NULL,
  part            INTEGER NOT NULL,
  triangle_id_a   INTEGER NOT NULL,
  triangle_id_b   INTEGER NOT NULL,
  edge_v0         INTEGER NOT NULL,
  edge_v1         INTEGER NOT NULL,
  PRIMARY KEY (wrg_build_id, area_id, part, triangle_id_a, triangle_id_b),
  CONSTRAINT wrg_mesh_adj_order_chk CHECK (triangle_id_a < triangle_id_b),
  CONSTRAINT wrg_mesh_adj_edge_chk CHECK (edge_v0 < edge_v1),
  CONSTRAINT wrg_mesh_adj_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE
);

COMMENT ON TABLE water.wrg_mesh_adjacency IS
  'Undirected triangle dual edges inside one (area, part). Never crosses MultiPolygon parts.';

CREATE INDEX IF NOT EXISTS wrg_mesh_adj_area_idx
  ON water.wrg_mesh_adjacency (wrg_build_id, area_id, part);

CREATE TABLE IF NOT EXISTS water.wrg_mesh_portals (
  wrg_build_id   BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  portal_id      BIGINT NOT NULL,
  area_id        BIGINT NOT NULL,
  part           INTEGER NOT NULL,
  vertex_id      INTEGER NOT NULL,
  attach_kind    TEXT NOT NULL,
  attach_geom    geometry(Point, 4326) NOT NULL,
  evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, portal_id),
  CONSTRAINT wrg_mesh_portals_kind_chk CHECK (attach_kind IN (
    'existing_vertex', 'edge_split', 'interior_split'
  )),
  CONSTRAINT wrg_mesh_portals_portal_fk
    FOREIGN KEY (wrg_build_id, portal_id)
    REFERENCES water.wrg_portals (wrg_build_id, portal_id) ON DELETE CASCADE,
  CONSTRAINT wrg_mesh_portals_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE
);

COMMENT ON TABLE water.wrg_mesh_portals IS
  'WRG-001 portal attached to a mesh vertex of the covering polygon part. '
  'Not a snap/DWithin; attach point comes from incidence geometry.';

CREATE INDEX IF NOT EXISTS wrg_mesh_portals_area_idx
  ON water.wrg_mesh_portals (wrg_build_id, area_id, part);
CREATE INDEX IF NOT EXISTS wrg_mesh_portals_vertex_idx
  ON water.wrg_mesh_portals (wrg_build_id, area_id, part, vertex_id);
