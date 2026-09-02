-- AquaRoute E3.5 — incomplete relation QA (read-only; no fixes).
\set ON_ERROR_STOP on

\echo '=== Belomor 9909116 completeness ==='
SELECT
  o.osm_id,
  o.name,
  o.water_type,
  GeometryType(o.geometry) AS geom_type,
  round(ST_Length(o.geometry::geography)::numeric, 1) AS length_m,
  count(m.*) AS members_total,
  count(mw.osm_id) AS members_present,
  count(m.*) - count(mw.osm_id) AS members_missing
FROM water.objects o
JOIN water.object_members m
  ON m.parent_osm_type = 'relation' AND m.parent_osm_id = o.osm_id
LEFT JOIN water.objects mw
  ON mw.osm_type = m.member_osm_type AND mw.osm_id = m.member_osm_id
WHERE o.osm_type = 'relation' AND o.osm_id = 9909116
GROUP BY 1, 2, 3, 4, 5;

\echo '=== incomplete relation summary ==='
WITH per_rel AS (
  SELECT
    m.parent_osm_id AS relation_osm_id,
    count(*) AS members_total,
    count(o.osm_id) AS members_present,
    count(*) - count(o.osm_id) AS members_missing,
    count(*) FILTER (
      WHERE m.member_osm_type = 'way' AND o.osm_id IS NULL
    ) AS missing_ways,
    count(*) FILTER (
      WHERE m.member_osm_type = 'node' AND o.osm_id IS NULL
    ) AS missing_nodes,
    count(*) FILTER (
      WHERE m.member_osm_type = 'relation' AND o.osm_id IS NULL
    ) AS missing_relations
  FROM water.object_members m
  LEFT JOIN water.objects o
    ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
  WHERE m.parent_osm_type = 'relation'
  GROUP BY 1
  HAVING count(*) - count(o.osm_id) > 0
)
SELECT
  count(*) AS incomplete_relations,
  sum(members_missing) AS missing_members,
  sum(missing_ways) AS missing_ways,
  sum(missing_nodes) AS missing_nodes,
  sum(missing_relations) AS missing_relations
FROM per_rel;

\echo '=== incomplete relations detail ==='
WITH per_rel AS (
  SELECT
    m.parent_osm_id AS relation_osm_id,
    count(*) AS members_total,
    count(o.osm_id) AS members_present,
    count(*) - count(o.osm_id) AS members_missing,
    count(*) FILTER (
      WHERE m.member_osm_type = 'way' AND o.osm_id IS NULL
    ) AS missing_ways,
    count(*) FILTER (
      WHERE m.member_osm_type = 'node' AND o.osm_id IS NULL
    ) AS missing_nodes,
    count(*) FILTER (
      WHERE m.member_osm_type = 'relation' AND o.osm_id IS NULL
    ) AS missing_relations
  FROM water.object_members m
  LEFT JOIN water.objects o
    ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
  WHERE m.parent_osm_type = 'relation'
  GROUP BY 1
  HAVING count(*) - count(o.osm_id) > 0
)
SELECT
  p.relation_osm_id,
  r.name,
  r.water_type,
  p.members_total,
  p.members_present,
  p.members_missing,
  p.missing_ways,
  p.missing_nodes,
  p.missing_relations,
  ST_XMin(r.geometry) AS xmin,
  ST_YMin(r.geometry) AS ymin,
  ST_XMax(r.geometry) AS xmax,
  ST_YMax(r.geometry) AS ymax,
  r.tags
FROM per_rel p
JOIN water.objects r
  ON r.osm_type = 'relation' AND r.osm_id = p.relation_osm_id
ORDER BY p.members_missing DESC, p.relation_osm_id;

\echo '=== extract bbox (from imported objects) ==='
SELECT
  ST_XMin(g) AS xmin, ST_YMin(g) AS ymin,
  ST_XMax(g) AS xmax, ST_YMax(g) AS ymax
FROM (SELECT ST_Extent(geometry)::geometry AS g FROM water.objects) e;

\echo '=== dataset fingerprint (should match E3.4) ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members,
  (SELECT count(*) FROM water.objects WHERE osm_type = 'relation') AS relations;
