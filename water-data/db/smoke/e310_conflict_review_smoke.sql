-- AquaRoute E3.10 smoke: review semantics + fingerprint (read-mostly).
\pset pager off

\echo '=== conflict recommendation vs review status ==='
SELECT conflict_type, resolution AS recommendation, status, count(*) AS n
FROM water.object_conflicts
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

\echo '=== e38 geometry conflicts still open (must remain 49 unless manually reviewed) ==='
SELECT count(*) AS open_geometry_e38
FROM water.object_conflicts c
JOIN water.import_batches b ON b.id = c.batch_id
WHERE b.batch_key = 'e38-leningrad-oblast'
  AND c.conflict_type = 'geometry'
  AND c.status = 'open';

\echo '=== fingerprint ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members;

\echo '=== Belomor / Ladoga ==='
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
WHERE o.osm_type='relation' AND o.osm_id IN (9909116, 21149039)
ORDER BY o.osm_id;

\echo '=== audits ==='
SELECT
  (SELECT count(*) FROM (
     SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
   ) t) AS identity_dups,
  (SELECT count(*) FROM water.object_members m
   LEFT JOIN water.objects o ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
   WHERE o.id IS NULL) AS orphan_parent_members,
  (SELECT count(*) FROM water.objects
   WHERE geometry IS NOT NULL AND NOT ST_IsValid(geometry)) AS invalid_geom,
  (SELECT count(*) FROM (
     SELECT parent_osm_id, member_osm_type, member_osm_id, member_role
     FROM water.object_members
     GROUP BY 1,2,3,4 HAVING count(*)>1
   ) t) AS legitimate_dup_membership_keys;

\echo '=== relation 14000871 occurrences (unchanged) ==='
SELECT seq, member_osm_type, member_osm_id, member_role
FROM water.object_members
WHERE parent_osm_id = 14000871 AND member_osm_id IN (134221487, 1456380890)
ORDER BY seq;
