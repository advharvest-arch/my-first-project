-- E5 smoke: isolated WaterGraph PoC invariants (read-only checks)
\pset pager off

\echo '=== A. canonical ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;

\echo '=== B. latest build ==='
SELECT build_id, rule_id, segment_count, node_count, edge_count, component_count,
       builder_version, built_at
FROM water.wg_build
ORDER BY build_id DESC
LIMIT 1;

\echo '=== C. node / edge QA ==='
SELECT count(*) AS nodes,
       count(*) FILTER (WHERE degree = 0) AS deg0,
       count(*) FILTER (WHERE degree = 1) AS deg1,
       count(*) FILTER (WHERE degree >= 3) AS deg_ge3
FROM water.wg_nodes
WHERE build_id = (SELECT max(build_id) FROM water.wg_build);

SELECT count(*) AS edges,
       count(*) FILTER (WHERE is_zero_length) AS zero_len,
       count(*) FILTER (WHERE NOT ST_IsValid(geom)) AS invalid_geom
FROM water.wg_edges
WHERE build_id = (SELECT max(build_id) FROM water.wg_build);

\echo '=== D. Belomor ==='
SELECT count(*) AS belomor_edges
FROM water.wg_edges
WHERE build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 9909116 = ANY (parent_relation_ids);

\echo '=== E. VB gap would_E1_connect ==='
WITH b AS (SELECT max(build_id) AS id FROM water.wg_build),
a AS (
  SELECT from_node_id, to_node_id FROM water.wg_edges, b
  WHERE build_id = b.id AND osm_id = 28433211
),
c AS (
  SELECT from_node_id, to_node_id FROM water.wg_edges, b
  WHERE build_id = b.id AND osm_id = 824398188
)
SELECT (
  a.from_node_id IN (c.from_node_id, c.to_node_id)
  OR a.to_node_id IN (c.from_node_id, c.to_node_id)
) AS would_E1_connect
FROM a, c;

\echo '=== F. Ladoga edge count ==='
SELECT count(*) AS ladoga_edges
FROM water.wg_edges
WHERE build_id = (SELECT max(build_id) FROM water.wg_build)
  AND 21149039 = ANY (parent_relation_ids);
