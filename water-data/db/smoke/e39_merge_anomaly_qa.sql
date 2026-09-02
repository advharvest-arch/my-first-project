-- AquaRoute E3.9 — merge anomaly QA (read-only).
-- Does not UPDATE/DELETE canonical data.

\pset pager off

\echo '=== fingerprint (must stay 422327 / 186823) ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members,
  (SELECT count(*) FROM water.object_conflicts) AS conflicts;

\echo '=== PART A: relation 14000871 duplicate membership ==='
SELECT o.osm_id, o.name, o.water_type, o.source_version,
       ST_GeometryType(o.geometry) AS gtype
FROM water.objects o
WHERE o.osm_type = 'relation' AND o.osm_id = 14000871;

SELECT m.seq, m.member_osm_type, m.member_osm_id, m.member_role,
       EXISTS (
         SELECT 1 FROM water.objects x
         WHERE x.osm_type = m.member_osm_type AND x.osm_id = m.member_osm_id
       ) AS member_in_objects
FROM water.object_members m
WHERE m.parent_osm_type = 'relation' AND m.parent_osm_id = 14000871
  AND m.member_osm_id IN (134221487, 1456380890)
ORDER BY m.member_osm_id, m.seq;

SELECT obl.link_role, b.batch_key, b.source_version, b.dataset_name
FROM water.object_batch_links obl
JOIN water.import_batches b ON b.id = obl.batch_id
WHERE obl.osm_type = 'relation' AND obl.osm_id = 14000871
ORDER BY b.id, obl.link_role;

\echo '=== duplicate membership keys (same type,id,role at >1 seq) ==='
SELECT parent_osm_id, member_osm_type, member_osm_id, member_role,
       count(*) AS n, array_agg(seq ORDER BY seq) AS seqs
FROM water.object_members
GROUP BY 1, 2, 3, 4
HAVING count(*) > 1
ORDER BY n DESC, parent_osm_id
LIMIT 20;

\echo '=== PART B: open geometry conflicts (e38-leningrad-oblast) ==='
SELECT c.osm_type, c.osm_id, o.water_type, o.name,
       c.resolution, c.status, c.notes,
       (c.canonical_value->>'npoints')::int AS c_pts,
       (c.incoming_value->>'npoints')::int AS i_pts,
       c.canonical_value->>'geometry_type' AS c_gtype,
       c.incoming_value->>'geometry_type' AS i_gtype
FROM water.object_conflicts c
JOIN water.import_batches b ON b.id = c.batch_id
LEFT JOIN water.objects o ON o.osm_type = c.osm_type AND o.osm_id = c.osm_id
WHERE b.batch_key = 'e38-leningrad-oblast'
  AND c.conflict_type = 'geometry'
ORDER BY
  abs((c.canonical_value->>'npoints')::int - (c.incoming_value->>'npoints')::int) DESC,
  c.osm_id;

\echo '=== conflict status summary (do not auto-resolve) ==='
SELECT conflict_type, resolution, status, count(*) AS n
FROM water.object_conflicts
GROUP BY 1, 2, 3
ORDER BY 1, 2, 3;

\echo '=== Belomor / Ladoga sanity ==='
SELECT o.osm_id, o.name,
  (SELECT count(*) FROM water.object_members m
   WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id) AS members,
  (SELECT count(*) FROM water.object_members m
   WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id
     AND EXISTS (
       SELECT 1 FROM water.objects x
       WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
     )) AS present
FROM water.objects o
WHERE o.osm_type='relation' AND o.osm_id IN (9909116, 21149039)
ORDER BY o.osm_id;

\echo '=== identity / orphan / invalid ==='
SELECT
  (SELECT count(*) FROM (
     SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
   ) t) AS identity_dups,
  (SELECT count(*) FROM water.object_members m
   LEFT JOIN water.objects o ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
   WHERE o.id IS NULL) AS orphan_parent_members,
  (SELECT count(*) FROM water.objects
   WHERE geometry IS NOT NULL AND NOT ST_IsValid(geometry)) AS invalid_geom;
