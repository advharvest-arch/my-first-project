-- E6 smoke: WaterGraph safety layer invariants
\pset pager off

\echo '=== A. canonical + graph ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts,
       (SELECT count(*) FROM water.wg_nodes) AS wg_nodes,
       (SELECT count(*) FROM water.wg_edges) AS wg_edges;

\echo '=== B. latest safety run ==='
SELECT safety_run_id, build_id, validator_version, ran_at,
       summary->'safety_categories' AS categories
FROM water.wg_safety_run
ORDER BY safety_run_id DESC
LIMIT 1;

\echo '=== C. status counts ==='
SELECT status, count(*) AS n
FROM water.wg_edge_safety
WHERE safety_run_id = (SELECT max(safety_run_id) FROM water.wg_safety_run)
GROUP BY 1 ORDER BY 1;

\echo '=== D. REJECTED must be 0 ==='
SELECT count(*) AS rejected
FROM water.wg_edge_safety
WHERE safety_run_id = (SELECT max(safety_run_id) FROM water.wg_safety_run)
  AND status = 'REJECTED_TOPOLOGY';

\echo '=== E. Belomor / VB gap / Ladoga ==='
SELECT count(*) AS belomor_edges FROM water.wg_edges
WHERE build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 9909116 = ANY(parent_relation_ids);

WITH b AS (SELECT max(build_id) AS id FROM water.wg_build),
a AS (SELECT from_node_id, to_node_id FROM water.wg_edges, b WHERE build_id=b.id AND osm_id=28433211),
c AS (SELECT from_node_id, to_node_id FROM water.wg_edges, b WHERE build_id=b.id AND osm_id=824398188)
SELECT (a.from_node_id IN (c.from_node_id,c.to_node_id)
     OR a.to_node_id IN (c.from_node_id,c.to_node_id)) AS vb_would_E1_connect
FROM a,c;

SELECT count(*) AS ladoga_edges FROM water.wg_edges
WHERE build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 21149039 = ANY(parent_relation_ids);
