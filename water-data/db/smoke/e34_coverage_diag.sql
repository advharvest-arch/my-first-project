-- AquaRoute E3.4 coverage diagnostics (read-only).
\set ON_ERROR_STOP on

\echo '=== osm_type counts ==='
SELECT osm_type, count(*) AS n
FROM water.objects
GROUP BY 1
ORDER BY 1;

\echo '=== water_type counts ==='
SELECT coalesce(water_type, '(null)') AS water_type, count(*) AS n
FROM water.objects
GROUP BY 1
ORDER BY n DESC, water_type;

\echo '=== geometry types ==='
SELECT GeometryType(geometry) AS geom_type, count(*) AS n
FROM water.objects
GROUP BY 1
ORDER BY n DESC, geom_type;

\echo '=== null geometry (should be 0) ==='
SELECT count(*) AS null_geometry_rows
FROM water.objects
WHERE geometry IS NULL;

\echo '=== global bbox ==='
SELECT
  ST_XMin(g) AS xmin, ST_YMin(g) AS ymin,
  ST_XMax(g) AS xmax, ST_YMax(g) AS ymax
FROM (
  SELECT ST_Extent(geometry)::geometry AS g FROM water.objects
) e;

\echo '=== relation / members totals ==='
SELECT
  (SELECT count(*) FROM water.objects WHERE osm_type = 'relation') AS relations,
  (SELECT count(*) FROM water.object_members) AS member_rows;

\echo '=== relation completeness (way/node/relation members vs water.objects) ==='
WITH per_rel AS (
  SELECT
    m.parent_osm_id AS relation_osm_id,
    count(*) AS members_total,
    count(o.osm_id) AS members_present,
    count(*) - count(o.osm_id) AS members_missing
  FROM water.object_members m
  LEFT JOIN water.objects o
    ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
  WHERE m.parent_osm_type = 'relation'
  GROUP BY 1
)
SELECT
  count(*) AS relations_with_members,
  count(*) FILTER (WHERE members_missing = 0) AS relations_complete,
  count(*) FILTER (WHERE members_missing > 0) AS relations_incomplete,
  sum(members_total) AS members_total,
  sum(members_present) AS members_present,
  sum(members_missing) AS members_missing
FROM per_rel;

\echo '=== incomplete relations (top 30 by missing) ==='
WITH per_rel AS (
  SELECT
    m.parent_osm_id AS relation_osm_id,
    o.name,
    o.water_type,
    count(*) AS members_total,
    count(o2.osm_id) AS members_present,
    count(*) - count(o2.osm_id) AS members_missing
  FROM water.object_members m
  LEFT JOIN water.objects o
    ON o.osm_type = 'relation' AND o.osm_id = m.parent_osm_id
  LEFT JOIN water.objects o2
    ON o2.osm_type = m.member_osm_type AND o2.osm_id = m.member_osm_id
  WHERE m.parent_osm_type = 'relation'
  GROUP BY 1, 2, 3
)
SELECT *
FROM per_rel
WHERE members_missing > 0
ORDER BY members_missing DESC, relation_osm_id
LIMIT 30;

\echo '=== Belomor relation 9909116 ==='
SELECT
  osm_id, name, water_type, source, source_version,
  GeometryType(geometry) AS geom_type,
  ST_SRID(geometry) AS srid,
  ST_NPoints(geometry) AS npoints,
  round(ST_Length(geometry::geography)::numeric, 1) AS length_m_geog,
  ST_XMin(geometry) AS xmin, ST_YMin(geometry) AS ymin,
  ST_XMax(geometry) AS xmax, ST_YMax(geometry) AS ymax
FROM water.objects
WHERE osm_type = 'relation' AND osm_id = 9909116;

SELECT count(*) AS belomor_member_rows,
       count(*) FILTER (WHERE member_role = 'main_stream') AS main_stream_rows
FROM water.object_members
WHERE parent_osm_type = 'relation' AND parent_osm_id = 9909116;

\echo '=== synthetic seam tags (expect 0) ==='
SELECT count(*) AS synthetic_seam_tagged
FROM water.objects
WHERE tags ? '_synthetic_seam'
   OR tags ? 'synthetic_seam'
   OR coalesce(tags->>'_smoke', '') = 'seam';

\echo '=== data_sources (latest) ==='
SELECT id, source_name, source_version, imported_at, left(notes, 120) AS notes
FROM water.data_sources
ORDER BY id DESC
LIMIT 5;
