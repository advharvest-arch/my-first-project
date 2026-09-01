-- E8 smoke: navigation semantics layer (read-mostly; assumes e8 script has run)
\pset pager off

\echo '=== A. fingerprint (canonical + graph) ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts,
       (SELECT count(*) FROM water.wg_nodes) AS wg_nodes,
       (SELECT count(*) FROM water.wg_edges) AS wg_edges;

\echo '=== B. navigation status counts (latest run) ==='
SELECT n.status, count(*) AS n
FROM water.wg_edge_navigation n
WHERE n.navigation_run_id = (SELECT max(navigation_run_id) FROM water.wg_navigation_run)
GROUP BY 1
ORDER BY 1;

\echo '=== C. Belomor: all 29 edges NAVIGABLE ==='
SELECT n.status, count(*) AS n
FROM water.wg_edges e
JOIN water.wg_edge_navigation n ON n.edge_id = e.edge_id
  AND n.navigation_run_id = (SELECT max(navigation_run_id) FROM water.wg_navigation_run)
WHERE e.build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 9909116 = ANY (e.parent_relation_ids)
GROUP BY 1
ORDER BY 1;

\echo '=== D. Belomor lock=yes edges (expect 9 NAVIGABLE via CEMT) ==='
SELECT e.osm_id, o.tags->>'lock' AS lock, o.tags->>'CEMT' AS cemt, n.status
FROM water.wg_edges e
JOIN water.objects o ON o.osm_type = e.osm_type AND o.osm_id = e.osm_id
JOIN water.wg_edge_navigation n ON n.edge_id = e.edge_id
  AND n.navigation_run_id = (SELECT max(navigation_run_id) FROM water.wg_navigation_run)
WHERE e.build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 9909116 = ANY (e.parent_relation_ids)
  AND o.tags->>'lock' IN ('yes', 'true', '1')
ORDER BY e.osm_id;

\echo '=== E. VB gap ways still not E1-connected ==='
WITH b AS (SELECT max(build_id) AS id FROM water.wg_build),
a AS (SELECT from_node_id, to_node_id FROM water.wg_edges, b WHERE build_id=b.id AND osm_id=28433211),
c AS (SELECT from_node_id, to_node_id FROM water.wg_edges, b WHERE build_id=b.id AND osm_id=824398188)
SELECT (a.from_node_id IN (c.from_node_id, c.to_node_id)
     OR a.to_node_id IN (c.from_node_id, c.to_node_id)) AS would_E1_connect
FROM a, c;

\echo '=== F. Ladoga: no NAVIGABLE from ring membership alone ==='
SELECT count(*) FILTER (WHERE n.status = 'NAVIGABLE') AS ladoga_navigable,
       count(*) AS ladoga_total
FROM water.wg_edges e
JOIN water.wg_edge_navigation n ON n.edge_id = e.edge_id
  AND n.navigation_run_id = (SELECT max(navigation_run_id) FROM water.wg_navigation_run)
WHERE e.build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 21149039 = ANY (e.parent_relation_ids);
