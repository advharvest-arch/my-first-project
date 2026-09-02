-- AquaRoute E3.2 smoke checks for water.objects (no real OSM import).
-- Safe to re-run: inserts a temporary row, asserts constraints, then deletes it.
-- Expect: exit 0 and zero leftover smoke rows in water.objects.

\set ON_ERROR_STOP on

DO $$
DECLARE
  v_cnt            bigint;
  v_geom_udt       text;
  v_tags_udt       text;
  v_srid           integer;
  v_has_gist       boolean;
  v_has_water_type boolean;
  v_has_tags_gin   boolean;
  v_dup_ok         boolean := false;
BEGIN
  -- Table exists
  IF to_regclass('water.objects') IS NULL THEN
    RAISE EXCEPTION 'smoke fail: water.objects does not exist';
  END IF;

  -- geometry + tags column types
  SELECT c.udt_name INTO v_geom_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'water' AND c.table_name = 'objects' AND c.column_name = 'geometry';

  SELECT c.udt_name INTO v_tags_udt
  FROM information_schema.columns c
  WHERE c.table_schema = 'water' AND c.table_name = 'objects' AND c.column_name = 'tags';

  IF v_geom_udt IS DISTINCT FROM 'geometry' THEN
    RAISE EXCEPTION 'smoke fail: geometry column missing or wrong type (%)', v_geom_udt;
  END IF;
  IF v_tags_udt IS DISTINCT FROM 'jsonb' THEN
    RAISE EXCEPTION 'smoke fail: tags column missing or wrong type (%)', v_tags_udt;
  END IF;

  -- SRID on geometry column (typmod / geometry_columns)
  SELECT g.srid INTO v_srid
  FROM geometry_columns g
  WHERE g.f_table_schema = 'water'
    AND g.f_table_name = 'objects'
    AND g.f_geometry_column = 'geometry';

  IF v_srid IS DISTINCT FROM 4326 THEN
    RAISE EXCEPTION 'smoke fail: expected SRID 4326, got %', v_srid;
  END IF;

  -- Indexes
  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'water' AND tablename = 'objects'
      AND indexdef ILIKE '%USING gist%'
      AND indexdef ILIKE '%geometry%'
  ) INTO v_has_gist;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'water' AND tablename = 'objects'
      AND indexname = 'objects_water_type_idx'
  ) INTO v_has_water_type;

  SELECT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'water' AND tablename = 'objects'
      AND indexdef ILIKE '%USING gin%'
      AND indexdef ILIKE '%tags%'
  ) INTO v_has_tags_gin;

  IF NOT v_has_gist THEN
    RAISE EXCEPTION 'smoke fail: GIST index on geometry missing';
  END IF;
  IF NOT v_has_water_type THEN
    RAISE EXCEPTION 'smoke fail: water_type index missing';
  END IF;
  IF NOT v_has_tags_gin THEN
    RAISE EXCEPTION 'smoke fail: GIN index on tags missing';
  END IF;

  -- Insert one temporary feature (synthetic coords; not real OSM)
  INSERT INTO water.objects (
    osm_type, osm_id, name, water_type, geometry, tags, source, source_version
  ) VALUES (
    'way',
    -1,
    'e32-smoke',
    'other',
    ST_SetSRID(ST_GeomFromText('LINESTRING(37.0 55.0, 37.1 55.1)'), 4326),
    '{"waterway":"canal","_smoke":"e32"}'::jsonb,
    'smoke',
    'e3.2'
  );

  -- Unique (osm_type, osm_id) must reject a duplicate
  BEGIN
    INSERT INTO water.objects (
      osm_type, osm_id, geometry, tags, source
    ) VALUES (
      'way',
      -1,
      ST_SetSRID(ST_GeomFromText('POINT(37.0 55.0)'), 4326),
      '{}'::jsonb,
      'smoke'
    );
  EXCEPTION
    WHEN unique_violation THEN
      v_dup_ok := true;
  END;

  IF NOT v_dup_ok THEN
    RAISE EXCEPTION 'smoke fail: UNIQUE (osm_type, osm_id) did not fire';
  END IF;

  -- Cleanup smoke rows
  DELETE FROM water.objects WHERE source = 'smoke' AND osm_id = -1;

  SELECT count(*) INTO v_cnt FROM water.objects WHERE source = 'smoke';
  IF v_cnt <> 0 THEN
    RAISE EXCEPTION 'smoke fail: leftover smoke rows (%)', v_cnt;
  END IF;

  RAISE NOTICE 'E3.2 smoke OK: water.objects, SRID 4326, UNIQUE(osm_type,osm_id), GIST/GIN/water_type indexes';
END $$;
