-- E4.1 smoke: routing relevance VIEW inventory (READ-ONLY)
\pset pager off

\echo '=== A. VIEW exists ==='
SELECT COUNT(*) AS view_rows FROM water.routing_relevance;

\echo '=== B. relevance | object_count ==='
SELECT relevance, count(*) AS object_count
FROM water.routing_relevance
GROUP BY 1 ORDER BY 1;

\echo '=== C. relevance | geometry_type | count ==='
SELECT relevance, COALESCE(geometry_type, '(null)') AS geometry_type, count(*) AS n
FROM water.routing_relevance
GROUP BY 1, 2 ORDER BY 1, 3 DESC;

\echo '=== D. relevance | waterway | count (top per bucket) ==='
SELECT relevance, COALESCE(tags->>'waterway', '(none)') AS waterway, count(*) AS n
FROM water.routing_relevance
GROUP BY 1, 2
HAVING count(*) >= 10
ORDER BY 1, 3 DESC;

\echo '=== E. HIGH routing-focused inventory ==='
SELECT category, count(*) AS n FROM (
  SELECT CASE
    WHEN COALESCE(tags->>'waterway','') = 'river' OR water_type = 'river' THEN 'rivers'
    WHEN COALESCE(tags->>'waterway','') = 'canal' OR water_type = 'canal' THEN 'canals'
    WHEN COALESCE(tags->>'waterway','') = 'fairway' THEN 'fairways'
    WHEN COALESCE(tags->>'waterway','') = 'link' THEN 'links'
    WHEN COALESCE(tags->>'water','') = 'lake' OR water_type = 'lake' THEN 'lakes'
    WHEN COALESCE(tags->>'water','') = 'reservoir'
      OR tags->>'landuse' = 'reservoir'
      OR water_type = 'reservoir' THEN 'reservoirs'
    WHEN COALESCE(tags->>'waterway','') IN ('lock_gate','lock')
      OR tags->>'lock' IN ('yes','true','1')
      OR lower(COALESCE(water_type,'')) LIKE '%lock%' THEN 'locks'
    WHEN COALESCE(tags->>'waterway','') = 'dam'
      OR tags->>'water' = 'dam'
      OR lower(COALESCE(water_type,'')) LIKE '%dam%' THEN 'dams'
    WHEN COALESCE(tags->>'waterway','') = 'weir'
      OR lower(COALESCE(water_type,'')) LIKE '%weir%' THEN 'weirs'
    WHEN osm_type = 'relation' AND tags->>'type' = 'waterway' THEN 'waterway_relations'
    ELSE 'other_HIGH'
  END AS category
  FROM water.routing_relevance WHERE relevance = 'HIGH'
) t GROUP BY 1 ORDER BY 2 DESC;

\echo '=== F. Important examples ==='
SELECT osm_type, osm_id, name, water_type, relevance, relevance_reason,
       member_count, present_member_count, geometry_type
FROM water.routing_relevance
WHERE (osm_type, osm_id) IN (
  ('relation', 9909116),
  ('relation', 16738852),
  ('relation', 21149039)
)
ORDER BY osm_id;

\echo '=== G. Negative QA: way ditch/drain/stream ==='
SELECT tags->>'waterway' AS waterway, relevance, count(*) AS n
FROM water.routing_relevance
WHERE osm_type = 'way' AND tags->>'waterway' IN ('ditch', 'drain', 'stream')
GROUP BY 1, 2 ORDER BY 1, 2;

\echo '=== H. Canonical invariants (must match pre-E4.1) ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;
