-- WRG-003 smoke: unified physical connectivity (read-only after builder).
\pset pager off

\echo '=== A. unified component counts ==='
SELECT count(*) AS unified_components,
       count(*) FILTER (WHERE mesh_vertex_count > 0) AS with_mesh,
       count(*) FILTER (WHERE portal_attachment_count > 0) AS with_portals
FROM water.wrg_unified_component
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build);

\echo '=== B. E1 edges unchanged ==='
SELECT e1_edge_count_before = e1_edge_count_after AS e1_count_unchanged,
       e1_edge_count_before,
       (SELECT count(*) FROM water.wg_edges e
        WHERE e.build_id = b.wg_build_id) AS live_wg_edges
FROM water.wrg_build b
ORDER BY wrg_build_id DESC
LIMIT 1;

\echo '=== C. Kovzha 8039 and Belozersky 2228 same unified component ==='
SELECT e.edge_id, e.name, u.physical_component_id
FROM water.wg_edges e
JOIN water.wrg_unified_e1_node u
  ON u.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
 AND u.node_id = e.from_node_id
WHERE e.edge_id IN (8039, 2228)
ORDER BY e.edge_id;

\echo '=== D. Strelka fork 3452 vs Srednyaya Neva 4769 stay distinct ==='
SELECT node_id, physical_component_id
FROM water.wrg_unified_e1_node
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND node_id IN (3452, 4769)
ORDER BY node_id;

\echo '=== E. Vygozero mesh parts present; no strelka areas ==='
SELECT v.part, count(*) AS mesh_vertices
FROM water.wrg_unified_mesh_vertex v
JOIN water.wrg_areas a
  ON a.wrg_build_id = v.wrg_build_id AND a.area_id = v.area_id
WHERE v.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 253836
GROUP BY v.part
ORDER BY v.part;

SELECT count(*) AS strelka_or_pond_areas
FROM water.wrg_areas
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND osm_id IN (72500, 1114249, 8613894);

\echo '=== F. Talets attachments ==='
SELECT count(*) AS talets_attachments,
       count(DISTINCT u.physical_component_id) AS unified_cids
FROM water.wrg_unified_attachment att
JOIN water.wrg_areas a
  ON a.wrg_build_id = att.wrg_build_id AND a.area_id = att.area_id
JOIN water.wrg_unified_e1_node u
  ON u.wrg_build_id = att.wrg_build_id AND u.node_id = att.from_node_id
WHERE att.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 30406710;

\echo '=== G. attachment count equals corpus mesh portals ==='
SELECT
  (SELECT count(*) FROM water.wrg_unified_attachment
    WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)) AS attachments,
  (SELECT count(*) FROM water.wrg_mesh_portals
    WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)) AS mesh_portals;
