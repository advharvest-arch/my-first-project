-- WRG-001 smoke: physical overlay invariants (read-only checks after builder).
\pset pager off

\echo '=== A. latest WRG build fingerprint ==='
SELECT wrg_build_id, wg_build_id, builder_version,
       e1_edge_count_before, e1_edge_count_after,
       area_count, portal_count, area_link_count, physical_component_count
FROM water.wrg_build
ORDER BY wrg_build_id DESC
LIMIT 1;

\echo '=== B. E1 edges unchanged (before = after) ==='
SELECT e1_edge_count_before = e1_edge_count_after AS e1_count_unchanged,
       e1_edge_count_before,
       (SELECT count(*) FROM water.wg_edges e
        WHERE e.build_id = b.wg_build_id) AS live_wg_edges
FROM water.wrg_build b
ORDER BY wrg_build_id DESC
LIMIT 1;

\echo '=== C. areas: lake/reservoir only; no pond; no Strelka river_area ==='
SELECT water_type, count(*) AS n
FROM water.wrg_areas
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
GROUP BY 1
ORDER BY 1;

SELECT count(*) AS forbidden_osm_in_areas
FROM water.wrg_areas
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND osm_id IN (72500, 1114249, 8613894);

\echo '=== D. Beloye portals: Kovzha and Belozersky incidence ==='
SELECT e.name, p.evidence_kind, count(*) AS portals
FROM water.wrg_portals p
JOIN water.wg_edges e ON e.edge_id = p.edge_id
JOIN water.wrg_areas a
  ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
WHERE p.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 1603199
  AND e.name IN ('Ковжа', 'Белозерский')
GROUP BY 1, 2
ORDER BY 1, 2;

\echo '=== E. Kovzha and Belozersky share one physical component via Beloye ==='
SELECT count(DISTINCT c.physical_component_id) AS distinct_components
FROM water.wrg_portals p
JOIN water.wrg_areas a
  ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
JOIN water.wrg_e1_node_component c
  ON c.wrg_build_id = p.wrg_build_id AND c.node_id = p.from_node_id
JOIN water.wg_edges e ON e.edge_id = p.edge_id
WHERE p.wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND a.osm_id = 1603199
  AND e.name IN ('Ковжа', 'Белозерский');

\echo '=== F. Strelka land: river_area polygons are not WRG areas (NO_WATER_CONNECTION on area layer) ==='
SELECT count(*) AS strelka_or_pond_areas
FROM water.wrg_areas
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build)
  AND osm_id IN (72500, 1114249, 8613894);

\echo '=== G. component counts ==='
SELECT count(*) AS physical_components,
       count(*) FILTER (WHERE area_count > 0) AS with_areas,
       count(*) FILTER (WHERE portal_count > 0) AS with_portals,
       count(*) FILTER (WHERE area_count = 0) AS e1_only
FROM water.wrg_physical_component
WHERE wrg_build_id = (SELECT max(wrg_build_id) FROM water.wrg_build);
