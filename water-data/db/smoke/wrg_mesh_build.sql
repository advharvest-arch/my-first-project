-- WRG-002 smoke: constrained mesh overlay on the 5-object validation corpus.
-- Read-only checks after wrg_mesh_build.py. Does not run routing.
\pset pager off

\echo '=== A. mesh tables exist for latest wrg_build ==='
SELECT b.wrg_build_id, b.builder_version AS wrg001_builder,
       (SELECT count(*) FROM water.wrg_mesh_triangles t
         WHERE t.wrg_build_id = b.wrg_build_id) AS triangles,
       (SELECT count(DISTINCT area_id) FROM water.wrg_mesh_triangles t
         WHERE t.wrg_build_id = b.wrg_build_id) AS meshed_areas
FROM water.wrg_build b
ORDER BY wrg_build_id DESC
LIMIT 1;

\echo '=== B. E1 edges unchanged ==='
SELECT e1_edge_count_before = e1_edge_count_after AS e1_count_unchanged,
       e1_edge_count_before,
       (SELECT count(*) FROM water.wg_edges e
        WHERE e.build_id = b.wg_build_id) AS live_wg_edges
FROM water.wrg_build b
ORDER BY wrg_build_id DESC
LIMIT 1;

\echo '=== C. corpus osm coverage ==='
SELECT a.osm_id, left(coalesce(a.name,''),32) AS name,
       count(DISTINCT t.part) AS parts,
       count(*) AS triangles
FROM water.wrg_mesh_triangles t
JOIN water.wrg_areas a
  ON a.wrg_build_id = t.wrg_build_id AND a.area_id = t.area_id
WHERE t.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id IN (1603199, 21267937, 253836, 30406710, 2758761)
GROUP BY 1, 2
ORDER BY 1;

\echo '=== D. PostGIS triangle validity + CoveredBy sample ==='
SELECT count(*) FILTER (
         WHERE ST_IsEmpty(t.geom) OR ST_Area(t.geom) = 0 OR NOT ST_IsValid(t.geom)
       ) AS empty_or_invalid,
       count(*) AS triangles
FROM water.wrg_mesh_triangles t
WHERE t.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build);

SELECT count(*) FILTER (
         WHERE NOT ST_CoveredBy(s.geom, ST_GeometryN(a.geom, s.part))
       ) AS sample_not_covered,
       count(*) AS sample_n
FROM (
  SELECT t.geom, t.part, t.area_id, t.wrg_build_id
  FROM water.wrg_mesh_triangles t
  WHERE t.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  ORDER BY t.area_id, t.part, t.triangle_id
  LIMIT 200
) s
JOIN water.wrg_areas a
  ON a.wrg_build_id = s.wrg_build_id AND a.area_id = s.area_id;

\echo '=== E. Vygozero parts are separate (no cross-part vertex id sharing in adjacency) ==='
SELECT count(DISTINCT t.part) AS vygozero_parts
FROM water.wrg_mesh_triangles t
JOIN water.wrg_areas a
  ON a.wrg_build_id = t.wrg_build_id AND a.area_id = t.area_id
WHERE t.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 253836;

\echo '=== F. Talets three portals attached ==='
SELECT count(*) AS talets_portals
FROM water.wrg_mesh_portals p
JOIN water.wrg_areas a
  ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
WHERE p.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 30406710;

\echo '=== G. Kovzha 8039 and Belozersky 2228 attached on Beloye ==='
SELECT e.edge_id, e.name, p.part, p.attach_kind
FROM water.wrg_mesh_portals p
JOIN water.wrg_portals wp
  ON wp.wrg_build_id = p.wrg_build_id AND wp.portal_id = p.portal_id
JOIN water.wg_edges e ON e.edge_id = wp.edge_id
JOIN water.wrg_areas a
  ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
WHERE p.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 1603199
  AND e.edge_id IN (8039, 2228)
ORDER BY e.edge_id;

\echo '=== H. mesh area count is corpus-sized, not 26366 ==='
SELECT count(DISTINCT area_id) AS meshed_areas
FROM water.wrg_mesh_triangles
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build);
