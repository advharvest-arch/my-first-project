-- AquaRoute E3.2: source OSM water objects (storage only — no graph, no import).
-- Preserves provenance: osm_type/osm_id, raw tags, geometry, source metadata.
-- water_type is a normalized hint for later queries; it does NOT replace tags.

CREATE TABLE IF NOT EXISTS water.objects (
  id              BIGSERIAL PRIMARY KEY,
  osm_type        TEXT NOT NULL,
  osm_id          BIGINT NOT NULL,
  name            TEXT,
  water_type      TEXT,
  geometry        geometry(Geometry, 4326) NOT NULL,
  tags            JSONB NOT NULL DEFAULT '{}'::jsonb,
  source          TEXT NOT NULL DEFAULT 'osm',
  source_version  TEXT,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT objects_osm_type_check
    CHECK (osm_type IN ('node', 'way', 'relation')),
  CONSTRAINT objects_osm_identity_uq
    UNIQUE (osm_type, osm_id)
);

COMMENT ON TABLE water.objects IS
  'Source OSM water features stored for provenance and later WaterGraph ingest. '
  'Not a routing graph: no edges, no synthetic connections.';

COMMENT ON COLUMN water.objects.id IS
  'Internal surrogate key (AquaRoute DB).';
COMMENT ON COLUMN water.objects.osm_type IS
  'OSM element type: node, way, or relation.';
COMMENT ON COLUMN water.objects.osm_id IS
  'Original OSM object id (paired with osm_type for unique identity).';
COMMENT ON COLUMN water.objects.name IS
  'Optional display name from OSM (e.g. name / name:ru); nullable.';
COMMENT ON COLUMN water.objects.water_type IS
  'Normalized AquaRoute class (e.g. river, canal, lake, reservoir, stream, '
  'river_area, other). Does not replace tags — raw OSM tags stay in tags.';
COMMENT ON COLUMN water.objects.geometry IS
  'Source object geometry in EPSG:4326 (WGS84 lon/lat). Single column; '
  'mixed Point/LineString/Polygon/Multi* as produced by OSM.';
COMMENT ON COLUMN water.objects.tags IS
  'Full original OSM tag map (JSONB). Source of truth for classification audits.';
COMMENT ON COLUMN water.objects.source IS
  'Dataset origin label (default osm).';
COMMENT ON COLUMN water.objects.source_version IS
  'Version or extract date of the source dataset (nullable until import).';
COMMENT ON COLUMN water.objects.imported_at IS
  'When this row was loaded into aquaroute_water.';

-- Spatial queries: bbox, intersects, nearest (with <-> / ST_DWithin).
CREATE INDEX IF NOT EXISTS objects_geometry_gix
  ON water.objects USING GIST (geometry);

-- Filter by normalized class during diagnostics / selective ingest.
CREATE INDEX IF NOT EXISTS objects_water_type_idx
  ON water.objects (water_type);

-- Tag containment / key lookup (e.g. tags @> '{"waterway":"canal"}').
-- Justified: OSM audits and future importers query tags heavily; GIN is cheap at rest.
CREATE INDEX IF NOT EXISTS objects_tags_gin
  ON water.objects USING GIN (tags);
