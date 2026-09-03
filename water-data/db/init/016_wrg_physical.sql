-- WRG-001 — Isolated physical Water Routing Graph overlay (offline).
-- Lake + reservoir areas + E1 incidence portals + area boundary links.
-- Does NOT mutate water.wg_edges / wg_nodes / objects.
-- Does NOT create proximity / distance / snap / hub / chord edges.

CREATE TABLE IF NOT EXISTS water.wrg_build (
  wrg_build_id            BIGSERIAL PRIMARY KEY,
  wg_build_id             BIGINT NOT NULL REFERENCES water.wg_build(build_id) ON DELETE CASCADE,
  built_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  builder                 TEXT NOT NULL DEFAULT 'ingest/wrg_offline_build.py',
  builder_version         TEXT NOT NULL DEFAULT 'wrg-001-1',
  area_rule               TEXT NOT NULL DEFAULT 'lake_reservoir_polygon_only',
  portal_rule             TEXT NOT NULL DEFAULT
    'incidence only: ST_Covers(area,endpoint) OR line ST_Intersection length>0; no DWithin',
  area_link_rule          TEXT NOT NULL DEFAULT
    'ST_Touches AND shared boundary LineString length_m>0; no distance',
  e1_edge_count_before    BIGINT NOT NULL,
  e1_edge_count_after     BIGINT NOT NULL,
  area_count              BIGINT NOT NULL DEFAULT 0,
  portal_count            BIGINT NOT NULL DEFAULT 0,
  area_link_count         BIGINT NOT NULL DEFAULT 0,
  physical_component_count BIGINT NOT NULL DEFAULT 0,
  extras                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT wrg_build_e1_unchanged_chk
    CHECK (e1_edge_count_before = e1_edge_count_after)
);

COMMENT ON TABLE water.wrg_build IS
  'WRG-001 physical overlay build fingerprint. Isolated from AquaRoute production routing.';

CREATE TABLE IF NOT EXISTS water.wrg_areas (
  wrg_build_id   BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  area_id        BIGSERIAL,
  object_id      BIGINT NOT NULL,
  osm_type       TEXT NOT NULL,
  osm_id         BIGINT NOT NULL,
  name           TEXT,
  water_type     TEXT NOT NULL,
  geom           geometry(Geometry, 4326) NOT NULL,
  PRIMARY KEY (wrg_build_id, area_id),
  CONSTRAINT wrg_areas_water_type_chk
    CHECK (water_type IN ('lake', 'reservoir')),
  CONSTRAINT wrg_areas_object_uq UNIQUE (wrg_build_id, object_id)
);

COMMENT ON TABLE water.wrg_areas IS
  'Eligible lake/reservoir polygons copied by identity from water.objects. Not river_area/pond.';

CREATE INDEX IF NOT EXISTS wrg_areas_geom_gix
  ON water.wrg_areas USING GIST (geom);
CREATE INDEX IF NOT EXISTS wrg_areas_osm_idx
  ON water.wrg_areas (wrg_build_id, osm_type, osm_id);
CREATE INDEX IF NOT EXISTS wrg_areas_type_idx
  ON water.wrg_areas (wrg_build_id, water_type);

CREATE TABLE IF NOT EXISTS water.wrg_portals (
  wrg_build_id          BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  portal_id             BIGSERIAL,
  area_id               BIGINT NOT NULL,
  edge_id               BIGINT NOT NULL REFERENCES water.wg_edges(edge_id),
  from_node_id          BIGINT NOT NULL,
  to_node_id            BIGINT NOT NULL,
  evidence_kind         TEXT NOT NULL
    CHECK (evidence_kind IN (
      'endpoint_in_or_on_area',
      'edge_intersection'
    )),
  start_in_or_on        BOOLEAN NOT NULL,
  end_in_or_on          BOOLEAN NOT NULL,
  intersection_type     TEXT,
  intersection_length_m DOUBLE PRECISION,
  intersection_geom     geometry(Geometry, 4326),
  evidence              JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, portal_id),
  CONSTRAINT wrg_portals_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE,
  CONSTRAINT wrg_portals_edge_uq UNIQUE (wrg_build_id, area_id, edge_id)
);

COMMENT ON TABLE water.wrg_portals IS
  'Proven E1-edge incidence on a WRG area. Provenance is endpoint cover or '
  'positive-length line intersection. Not a snap/seam and not a new wg_edge.';

CREATE INDEX IF NOT EXISTS wrg_portals_area_idx
  ON water.wrg_portals (wrg_build_id, area_id);
CREATE INDEX IF NOT EXISTS wrg_portals_edge_idx
  ON water.wrg_portals (wrg_build_id, edge_id);

CREATE TABLE IF NOT EXISTS water.wrg_area_links (
  wrg_build_id       BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  link_id            BIGSERIAL,
  area_id_a          BIGINT NOT NULL,
  area_id_b          BIGINT NOT NULL,
  evidence_kind      TEXT NOT NULL DEFAULT 'touches_shared_boundary'
    CHECK (evidence_kind = 'touches_shared_boundary'),
  shared_boundary_m  DOUBLE PRECISION NOT NULL,
  evidence           JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (wrg_build_id, link_id),
  CONSTRAINT wrg_area_links_order_chk CHECK (area_id_a < area_id_b),
  CONSTRAINT wrg_area_links_len_chk CHECK (shared_boundary_m > 0),
  CONSTRAINT wrg_area_links_a_fk
    FOREIGN KEY (wrg_build_id, area_id_a)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE,
  CONSTRAINT wrg_area_links_b_fk
    FOREIGN KEY (wrg_build_id, area_id_b)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE,
  CONSTRAINT wrg_area_links_pair_uq UNIQUE (wrg_build_id, area_id_a, area_id_b)
);

COMMENT ON TABLE water.wrg_area_links IS
  'Lake/reservoir pairs that ST_Touches with positive shared boundary length. '
  'Distance-only adjacency is forbidden.';

CREATE INDEX IF NOT EXISTS wrg_area_links_a_idx
  ON water.wrg_area_links (wrg_build_id, area_id_a);
CREATE INDEX IF NOT EXISTS wrg_area_links_b_idx
  ON water.wrg_area_links (wrg_build_id, area_id_b);

CREATE TABLE IF NOT EXISTS water.wrg_physical_component (
  wrg_build_id            BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  physical_component_id   INTEGER NOT NULL,
  e1_node_count           INTEGER NOT NULL DEFAULT 0,
  area_count              INTEGER NOT NULL DEFAULT 0,
  portal_count            INTEGER NOT NULL DEFAULT 0,
  min_e1_node_id          BIGINT,
  min_area_osm_id         BIGINT,
  PRIMARY KEY (wrg_build_id, physical_component_id)
);

COMMENT ON TABLE water.wrg_physical_component IS
  'Deterministic physical components: E1 adjacency ∪ portal incidence ∪ area boundary links. '
  'IDs assigned by sort(min_e1_node_id, min_area_osm_id).';

CREATE TABLE IF NOT EXISTS water.wrg_e1_node_component (
  wrg_build_id           BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  node_id                BIGINT NOT NULL REFERENCES water.wg_nodes(node_id),
  physical_component_id  INTEGER NOT NULL,
  PRIMARY KEY (wrg_build_id, node_id),
  CONSTRAINT wrg_e1_node_comp_fk
    FOREIGN KEY (wrg_build_id, physical_component_id)
    REFERENCES water.wrg_physical_component (wrg_build_id, physical_component_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wrg_e1_node_comp_cid_idx
  ON water.wrg_e1_node_component (wrg_build_id, physical_component_id);

CREATE TABLE IF NOT EXISTS water.wrg_area_component (
  wrg_build_id           BIGINT NOT NULL REFERENCES water.wrg_build(wrg_build_id) ON DELETE CASCADE,
  area_id                BIGINT NOT NULL,
  physical_component_id  INTEGER NOT NULL,
  PRIMARY KEY (wrg_build_id, area_id),
  CONSTRAINT wrg_area_comp_area_fk
    FOREIGN KEY (wrg_build_id, area_id)
    REFERENCES water.wrg_areas (wrg_build_id, area_id) ON DELETE CASCADE,
  CONSTRAINT wrg_area_comp_cid_fk
    FOREIGN KEY (wrg_build_id, physical_component_id)
    REFERENCES water.wrg_physical_component (wrg_build_id, physical_component_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS wrg_area_comp_cid_idx
  ON water.wrg_area_component (wrg_build_id, physical_component_id);
