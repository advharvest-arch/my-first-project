-- E7 smoke: isolated routing pilot prerequisites (read-only)
\pset pager off

\echo '=== A. fingerprint ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts,
       (SELECT count(*) FROM water.wg_nodes) AS wg_nodes,
       (SELECT count(*) FROM water.wg_edges) AS wg_edges;

\echo '=== B. Belomor safety split ==='
SELECT s.status, count(*) AS n
FROM water.wg_edges e
JOIN water.wg_edge_safety s ON s.edge_id = e.edge_id
  AND s.safety_run_id = (SELECT max(safety_run_id) FROM water.wg_safety_run)
WHERE e.build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 9909116 = ANY (e.parent_relation_ids)
GROUP BY 1 ORDER BY 1;

\echo '=== C. VB gap not E1-connected ==='
WITH b AS (SELECT max(build_id) AS id FROM water.wg_build),
a AS (SELECT from_node_id, to_node_id FROM water.wg_edges, b WHERE build_id=b.id AND osm_id=28433211),
c AS (SELECT from_node_id, to_node_id FROM water.wg_edges, b WHERE build_id=b.id AND osm_id=824398188)
SELECT (a.from_node_id IN (c.from_node_id, c.to_node_id)
     OR a.to_node_id IN (c.from_node_id, c.to_node_id)) AS would_E1_connect
FROM a, c;

\echo '=== D. ALLOWED edge count ==='
SELECT count(*) AS allowed_edges
FROM water.wg_edge_safety
WHERE safety_run_id = (SELECT max(safety_run_id) FROM water.wg_safety_run)
  AND status = 'ALLOWED_TOPOLOGY';
