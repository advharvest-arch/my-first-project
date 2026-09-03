-- WRG-004 smoke: first-route MVP tables (read-only). Runtime is ingest/wrg_route.py.
\pset pager off

\echo '=== A. unified + mesh tables present ==='
SELECT to_regclass('water.wrg_unified_e1_node') IS NOT NULL AS unified_e1,
       to_regclass('water.wrg_unified_mesh_vertex') IS NOT NULL AS unified_mesh,
       to_regclass('water.wrg_mesh_triangles') IS NOT NULL AS mesh_tris,
       to_regclass('water.wrg_mesh_portals') IS NOT NULL AS mesh_portals,
       to_regclass('water.wrg_portals') IS NOT NULL AS wrg_portals;

\echo '=== B. E1 edges unchanged (fingerprint) ==='
SELECT e1_edge_count_before = e1_edge_count_after AS e1_count_unchanged,
       e1_edge_count_before
FROM water.wrg_build
ORDER BY wrg_build_id DESC
LIMIT 1;

\echo '=== C. Kovzha / Belozersky still same unified component ==='
SELECT e.edge_id, u.physical_component_id
FROM water.wg_edges e
JOIN water.wrg_unified_e1_node u
  ON u.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
 AND u.node_id = e.from_node_id
WHERE e.edge_id IN (8039, 2228)
ORDER BY e.edge_id;

\echo '=== D. land probe is farther than 25 m (no km snap) ==='
WITH pt AS (
  SELECT ST_SetSRID(ST_MakePoint(30.2348444, 59.94200785), 4326) AS g
)
SELECT round(min(ST_Distance(e.geom::geography, pt.g::geography))::numeric, 1) AS nearest_e1_m,
       min(ST_Distance(e.geom::geography, pt.g::geography)) > 25 AS beyond_bind_threshold
FROM water.wg_edges e, pt;

\echo '=== E. Strelka endpoints stay in distinct unified components ==='
SELECT node_id, physical_component_id
FROM water.wrg_unified_e1_node
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND node_id IN (160400, 4769)
ORDER BY node_id;
