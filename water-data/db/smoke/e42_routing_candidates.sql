-- E4.2 smoke: routing candidates VIEW inventory (READ-ONLY)
\pset pager off

\echo '=== A. total candidates ==='
SELECT count(*) AS candidates FROM water.routing_candidates;

\echo '=== B. by candidate_category ==='
SELECT candidate_category, count(*) AS n
FROM water.routing_candidates
GROUP BY 1 ORDER BY 2 DESC;

\echo '=== C. by relevance ==='
SELECT relevance, count(*) AS n
FROM water.routing_candidates
GROUP BY 1 ORDER BY 1;

\echo '=== D. by geometry_type ==='
SELECT COALESCE(geometry_type, '(null)') AS geometry_type, count(*) AS n
FROM water.routing_candidates
GROUP BY 1 ORDER BY 2 DESC;

\echo '=== E. no geometry / multi-source / identity dups ==='
SELECT
  count(*) FILTER (WHERE NOT has_geometry) AS no_geometry,
  count(*) FILTER (WHERE is_multi_source) AS multi_source,
  count(*) FILTER (WHERE is_high_relation_member) AS high_relation_members
FROM water.routing_candidates;

SELECT count(*) AS duplicate_identities FROM (
  SELECT osm_type, osm_id
  FROM water.routing_candidates
  GROUP BY 1, 2
  HAVING count(*) > 1
) d;

\echo '=== F. HIGH waterway / lake relation members (Belomor, VB, Ladoga) ==='
SELECT osm_type, osm_id, name, candidate_category, relevance,
       member_count, present_member_count, geometry_type
FROM water.routing_candidates
WHERE osm_type = 'relation'
  AND osm_id IN (9909116, 16738852, 21149039)
ORDER BY osm_id;

SELECT rel, member_ways FROM (
  SELECT 'belomor_9909116'::text AS rel,
         count(*)::bigint AS member_ways
  FROM water.routing_candidates
  WHERE osm_type = 'way' AND 9909116 = ANY (parent_relation_ids)
  UNION ALL
  SELECT 'volga_baltic_16738852',
         count(*)
  FROM water.routing_candidates
  WHERE osm_type = 'way' AND 16738852 = ANY (parent_relation_ids)
  UNION ALL
  SELECT 'ladoga_21149039',
         count(*)
  FROM water.routing_candidates
  WHERE osm_type = 'way' AND 21149039 = ANY (parent_relation_ids)
) t;

\echo '=== G. sample Belomor member ways (not a continuity check) ==='
SELECT c.osm_type, c.osm_id, left(COALESCE(c.name, ''), 40) AS name,
       c.waterway, c.relevance, c.candidate_category
FROM water.routing_candidates c
WHERE c.osm_type = 'way' AND 9909116 = ANY (c.parent_relation_ids)
ORDER BY c.osm_id
LIMIT 5;

\echo '=== H. canonical invariants (must be unchanged) ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;
