-- AquaRoute: empty GVR water-objects storage (structure only).
-- Separate identity from OSM (water.objects) and WaterGraph (wg_*).
-- No geometry until GVR provides it. No OSM↔GVR links. No data import.

CREATE TABLE IF NOT EXISTS water.gvr_water_objects (
  id                BIGSERIAL PRIMARY KEY,
  gvr_code          TEXT NOT NULL,
  name              TEXT,
  water_object_type TEXT,
  category          TEXT,
  basin_district    TEXT,
  basin_name        TEXT,
  raw               JSONB NOT NULL DEFAULT '{}'::jsonb,
  source            TEXT NOT NULL DEFAULT 'GVR',
  source_version    TEXT,
  dataset_name      TEXT,
  imported_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT gvr_water_objects_code_uq UNIQUE (gvr_code),
  CONSTRAINT gvr_water_objects_source_check CHECK (source = 'GVR')
);

COMMENT ON TABLE water.gvr_water_objects IS
  'Official GVR «Водные объекты» rows. Identity = gvr_code only. '
  'Not OSM; not WaterGraph; no geometry until source provides it; no OSM links.';

COMMENT ON COLUMN water.gvr_water_objects.gvr_code IS
  'Official State Water Registry object code/ID (unique identity).';
COMMENT ON COLUMN water.gvr_water_objects.raw IS
  'Full original GVR row as JSONB so no source fields are lost.';
COMMENT ON COLUMN water.gvr_water_objects.source IS
  'Dataset origin; always GVR for this table.';

CREATE INDEX IF NOT EXISTS gvr_water_objects_type_idx
  ON water.gvr_water_objects (water_object_type);

CREATE INDEX IF NOT EXISTS gvr_water_objects_raw_gin
  ON water.gvr_water_objects USING GIN (raw);
