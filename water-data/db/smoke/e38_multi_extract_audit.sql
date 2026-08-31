-- AquaRoute E3.8 multi-extract audit (read-only queries).
\set ON_ERROR_STOP on

\echo '=== fingerprint ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members,
  (SELECT count(*) FROM water.import_batches) AS batches,
  (SELECT count(*) FROM water.object_conflicts) AS conflicts,
  (SELECT count(*) FROM water.object_batch_links) AS links;

\echo '=== duplicate object identities (expect 0) ==='
SELECT osm_type, osm_id, count(*) AS n
FROM water.objects
GROUP BY 1, 2
HAVING count(*) > 1
LIMIT 20;

\echo '=== duplicate members (expect 0) ==='
SELECT parent_osm_type, parent_osm_id, member_osm_type, member_osm_id, member_role, count(*) AS n
FROM water.object_members
GROUP BY 1, 2, 3, 4, 5
HAVING count(*) > 1
LIMIT 20;

\echo '=== Belomor 9909116 ==='
SELECT
  o.osm_id, o.name, GeometryType(o.geometry) AS geom_type,
  round(ST_Length(o.geometry::geography)::numeric, 1) AS length_m,
  count(m.*) AS members_total,
  count(mw.osm_id) AS members_present,
  count(m.*) FILTER (WHERE m.member_role = 'main_stream') AS main_stream
FROM water.objects o
JOIN water.object_members m ON m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id
LEFT JOIN water.objects mw ON mw.osm_type=m.member_osm_type AND mw.osm_id=m.member_osm_id
WHERE o.osm_type='relation' AND o.osm_id=9909116
GROUP BY 1,2,3,4;

\echo '=== invalid geometry (expect 0) ==='
SELECT count(*) AS invalid_geoms
FROM water.objects
WHERE NOT ST_IsValid(geometry);

\echo '=== orphan members (parent relation missing) ==='
SELECT count(*) AS orphan_member_rows
FROM water.object_members m
LEFT JOIN water.objects o
  ON o.osm_type = m.parent_osm_type AND o.osm_id = m.parent_osm_id
WHERE o.osm_id IS NULL;

\echo '=== conflict summary ==='
SELECT conflict_type, resolution, status, count(*) AS n
FROM water.object_conflicts
GROUP BY 1, 2, 3
ORDER BY n DESC;

\echo '=== batches ==='
SELECT id, batch_key, source_version, dataset_name, status, imported_at
FROM water.import_batches
ORDER BY id;
