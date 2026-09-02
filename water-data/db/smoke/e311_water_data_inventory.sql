-- AquaRoute E3.11 — read-only inventory of current water-data (no mutations).
\pset pager off

\echo '=== fingerprint ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members;

\echo '=== osm_type / water_type / geometry ==='
SELECT osm_type, count(*) FROM water.objects GROUP BY 1 ORDER BY count(*) DESC;
SELECT COALESCE(water_type,'(null)') AS water_type, count(*) FROM water.objects GROUP BY 1 ORDER BY count(*) DESC;
SELECT GeometryType(geometry) AS gtype, count(*) FROM water.objects GROUP BY 1 ORDER BY count(*) DESC;

\echo '=== waterway tag ==='
SELECT COALESCE(tags->>'waterway','(none)') AS waterway, count(*)
FROM water.objects GROUP BY 1 ORDER BY count(*) DESC LIMIT 25;

\echo '=== natural=water subtypes ==='
SELECT COALESCE(tags->>'water','(none)') AS water, count(*)
FROM water.objects
WHERE tags->>'natural'='water' OR tags ? 'water' OR tags->>'landuse'='reservoir'
GROUP BY 1 ORDER BY count(*) DESC LIMIT 20;

\echo '=== relations ==='
SELECT COALESCE(tags->>'type','(none)') AS rel_type, count(*)
FROM water.objects WHERE osm_type='relation' GROUP BY 1 ORDER BY count(*) DESC;

WITH rels AS (
  SELECT o.osm_id, COALESCE(o.tags->>'type','(none)') AS rel_type,
    (SELECT count(*) FROM water.object_members m
     WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id) AS listed,
    (SELECT count(*) FROM water.object_members m
     WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id
       AND EXISTS (
         SELECT 1 FROM water.objects x
         WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
       )) AS present
  FROM water.objects o WHERE o.osm_type='relation'
)
SELECT rel_type,
  count(*) AS n,
  count(*) FILTER (WHERE present=listed AND listed>0) AS complete,
  count(*) FILTER (WHERE present<listed) AS incomplete
FROM rels GROUP BY 1 ORDER BY n DESC;

\echo '=== key examples ==='
SELECT o.osm_id, o.name, o.water_type, o.tags->>'type' AS rel_type,
  (SELECT count(*) FROM water.object_members m
   WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id) AS listed,
  (SELECT count(*) FROM water.object_members m
   WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id
     AND EXISTS (
       SELECT 1 FROM water.objects x
       WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
     )) AS present
FROM water.objects o
WHERE o.osm_type='relation' AND o.osm_id IN (9909116, 21149039, 16738852)
ORDER BY o.osm_id;

\echo '=== audits ==='
SELECT
  (SELECT count(*) FROM (
     SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
   ) t) AS identity_dups,
  (SELECT count(*) FROM water.object_members m
   LEFT JOIN water.objects o ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
   WHERE o.id IS NULL) AS orphan_parents,
  (SELECT count(*) FROM water.objects WHERE NOT ST_IsValid(geometry)) AS invalid_geom;
