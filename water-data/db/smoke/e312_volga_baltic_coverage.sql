-- AquaRoute E3.12 — Volga–Baltic coverage smoke (read-only).
\pset pager off

\echo '=== fingerprint ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members;

\echo '=== control relations ==='
SELECT o.osm_id, o.name,
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

\echo '=== Volga–Baltic member seq presence ==='
SELECT m.seq, m.member_osm_type, m.member_osm_id, m.member_role,
  EXISTS (
    SELECT 1 FROM water.objects o
    WHERE o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
  ) AS present
FROM water.object_members m
WHERE m.parent_osm_type='relation' AND m.parent_osm_id=16738852
ORDER BY m.seq;

\echo '=== audits ==='
SELECT
  (SELECT count(*) FROM (
     SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
   ) t) AS identity_dups,
  (SELECT count(*) FROM water.object_members m
   LEFT JOIN water.objects o ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
   WHERE o.id IS NULL) AS orphan_parents,
  (SELECT count(*) FROM water.objects WHERE NOT ST_IsValid(geometry)) AS invalid_geom;
