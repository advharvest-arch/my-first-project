-- AquaRoute E3.15 smoke — topology audit invariants (read-only).
\pset pager off

\echo '=== fingerprint ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members,
  (SELECT count(*) FROM water.object_conflicts) AS conflicts;

\echo '=== control completeness ==='
SELECT o.osm_id, o.name,
  (SELECT count(*) FROM water.object_members m WHERE m.parent_osm_id=o.osm_id) AS listed,
  (SELECT count(*) FROM water.object_members m WHERE m.parent_osm_id=o.osm_id
    AND EXISTS (
      SELECT 1 FROM water.objects x
      WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
        AND x.geometry IS NOT NULL AND ST_IsValid(x.geometry)
    )) AS present_valid
FROM water.objects o
WHERE o.osm_type='relation' AND o.osm_id IN (9909116, 16738852, 21149039)
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
