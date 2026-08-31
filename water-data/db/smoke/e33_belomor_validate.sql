-- AquaRoute E3.3 validation for Belomor relation 9909116 (read-only checks).
\set ON_ERROR_STOP on

\echo '=== counts ==='
SELECT osm_type, count(*) FROM water.objects GROUP BY 1 ORDER BY 1;
SELECT count(*) AS object_members_total FROM water.object_members;

\echo '=== relation 9909116 ==='
SELECT
  osm_type,
  osm_id,
  name,
  water_type,
  source,
  source_version,
  GeometryType(geometry) AS geom_type,
  ST_SRID(geometry) AS srid,
  ST_NPoints(geometry) AS npoints,
  round(ST_Length(geometry::geography)::numeric, 1) AS length_m_geog,
  ST_XMin(geometry) AS xmin,
  ST_YMin(geometry) AS ymin,
  ST_XMax(geometry) AS xmax,
  ST_YMax(geometry) AS ymax,
  tags
FROM water.objects
WHERE osm_type = 'relation' AND osm_id = 9909116;

\echo '=== members for 9909116 ==='
SELECT count(*) AS member_rows
FROM water.object_members
WHERE parent_osm_type = 'relation' AND parent_osm_id = 9909116;

SELECT member_role, count(*) AS n
FROM water.object_members
WHERE parent_osm_type = 'relation' AND parent_osm_id = 9909116
GROUP BY 1 ORDER BY 1;

SELECT seq, member_osm_type, member_osm_id, member_role
FROM water.object_members
WHERE parent_osm_type = 'relation' AND parent_osm_id = 9909116
ORDER BY seq
LIMIT 5;

SELECT seq, member_osm_type, member_osm_id, member_role
FROM water.object_members
WHERE parent_osm_type = 'relation' AND parent_osm_id = 9909116
ORDER BY seq DESC
LIMIT 5;

\echo '=== member ways present in water.objects ==='
SELECT
  count(*) AS member_ways_in_members,
  count(o.osm_id) AS member_ways_imported,
  count(o.geometry) AS member_ways_with_geometry
FROM water.object_members m
LEFT JOIN water.objects o
  ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
WHERE m.parent_osm_type = 'relation'
  AND m.parent_osm_id = 9909116
  AND m.member_osm_type = 'way';

\echo '=== waterway tags on imported member ways ==='
SELECT o.tags->>'waterway' AS waterway, count(*) AS n
FROM water.object_members m
JOIN water.objects o
  ON o.osm_type = 'way' AND o.osm_id = m.member_osm_id
WHERE m.parent_osm_type = 'relation' AND m.parent_osm_id = 9909116
GROUP BY 1 ORDER BY n DESC;

\echo '=== provenance ==='
SELECT count(*) AS osm_source_objects
FROM water.objects WHERE source = 'osm';

SELECT id, source_name, source_version, imported_at, notes
FROM water.data_sources
ORDER BY id DESC
LIMIT 5;

\echo '=== synthetic seam heuristic (should be 0 invented connectors) ==='
-- Importer never inserts seam features; flag any object explicitly marked as such.
SELECT count(*) AS synthetic_seam_tagged
FROM water.objects
WHERE tags ? '_synthetic_seam'
   OR tags ? 'synthetic_seam'
   OR coalesce(tags->>'_smoke', '') = 'seam';
