-- AquaRoute E3.14 — read-only Volga–Baltic geometry recon smoke.
\pset pager off

\echo '=== fingerprint (must stay 455001 / 199570) ==='
SELECT
  (SELECT count(*) FROM water.objects) AS objects,
  (SELECT count(*) FROM water.object_members) AS members;

\echo '=== VB completeness + member geom ==='
SELECT
  count(*) AS listed,
  count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM water.objects o
      WHERE o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
    )
  ) AS present,
  count(*) FILTER (
    WHERE EXISTS (
      SELECT 1 FROM water.objects o
      WHERE o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
        AND o.geometry IS NOT NULL AND ST_IsValid(o.geometry)
    )
  ) AS present_valid_geom
FROM water.object_members m
WHERE m.parent_osm_id=16738852;

\echo '=== diagnostic collect vs canonical (SELECT only) ==='
SELECT 'canonical' AS src,
  GeometryType(geometry) AS gtype,
  ST_NumGeometries(CASE WHEN GeometryType(geometry) LIKE 'MULTI%' THEN geometry ELSE ST_Multi(geometry) END) AS n_parts,
  ST_NPoints(geometry) AS npoints,
  round(ST_Length(geometry::geography)::numeric,1) AS length_m,
  round(ST_XMax(geometry)::numeric,5) AS xmax
FROM water.objects WHERE osm_type='relation' AND osm_id=16738852
UNION ALL
SELECT 'collect',
  GeometryType(geom), ST_NumGeometries(geom), ST_NPoints(geom),
  round(ST_Length(geom::geography)::numeric,1), round(ST_XMax(geom)::numeric,5)
FROM (
  SELECT ST_Collect(o.geometry ORDER BY m.seq) AS geom
  FROM water.object_members m
  JOIN water.objects o ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
  WHERE m.parent_osm_id=16738852
) t
UNION ALL
SELECT 'linemerge',
  GeometryType(geom),
  ST_NumGeometries(CASE WHEN GeometryType(geom) LIKE 'MULTI%' THEN geom ELSE ST_Multi(geom) END),
  ST_NPoints(geom),
  round(ST_Length(geom::geography)::numeric,1), round(ST_XMax(geom)::numeric,5)
FROM (
  SELECT ST_LineMerge(ST_Collect(o.geometry ORDER BY m.seq)) AS geom
  FROM water.object_members m
  JOIN water.objects o ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
  WHERE m.parent_osm_id=16738852
) t;

\echo '=== audits ==='
SELECT
  (SELECT count(*) FROM (
     SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
   ) t) AS identity_dups,
  (SELECT count(*) FROM water.object_members m
   LEFT JOIN water.objects o ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
   WHERE o.id IS NULL) AS orphan_parents,
  (SELECT count(*) FROM water.objects WHERE NOT ST_IsValid(geometry)) AS invalid_geom;
