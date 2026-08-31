-- AquaRoute E3.13 smoke — Vologda merge + Volga–Baltic completeness (read-only checks).
\pset pager off

\echo '=== fingerprint ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members,
  (SELECT count(*) FROM water.object_conflicts WHERE batch_id=(
     SELECT id FROM water.import_batches WHERE batch_key='e313-vologda-oblast')) AS vologda_conflicts;

\echo '=== control relations ==='
SELECT o.osm_id, o.name,
  (SELECT count(*) FROM water.object_members m WHERE m.parent_osm_id=o.osm_id) AS listed,
  (SELECT count(*) FROM water.object_members m WHERE m.parent_osm_id=o.osm_id
    AND EXISTS (SELECT 1 FROM water.objects x WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id)) AS present,
  GeometryType(o.geometry) AS gtype,
  ST_NPoints(o.geometry) AS npoints,
  round(ST_Length(o.geometry::geography)::numeric,1) AS length_m
FROM water.objects o
WHERE o.osm_type='relation' AND o.osm_id IN (9909116, 16738852, 21149039, 14000871)
ORDER BY o.osm_id;

\echo '=== 14000871 legitimate duplicates ==='
SELECT member_osm_id, member_role, count(*) AS n, array_agg(seq ORDER BY seq) AS seqs
FROM water.object_members WHERE parent_osm_id=14000871
GROUP BY 1,2 HAVING count(*)>1;

\echo '=== audits ==='
SELECT
  (SELECT count(*) FROM (
     SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
   ) t) AS identity_dups,
  (SELECT count(*) FROM water.object_members m
   LEFT JOIN water.objects o ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
   WHERE o.id IS NULL) AS orphan_parents,
  (SELECT count(*) FROM water.objects WHERE NOT ST_IsValid(geometry)) AS invalid_geom;
