-- E4.6 smoke: READ-ONLY invariants for E1 component PoC
\pset pager off

\echo '=== A. canonical (must stay 455001 / 199570 / 92) ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;

\echo '=== B. routing_segments presence ==='
SELECT count(*) AS segments FROM water.routing_segments;
SELECT count(*) AS endpoint_rows FROM (
  SELECT 1 FROM water.routing_segments WHERE start_point IS NOT NULL
  UNION ALL
  SELECT 1 FROM water.routing_segments WHERE end_point IS NOT NULL
) u;
SELECT count(*) FILTER (WHERE start_point IS NULL OR end_point IS NULL) AS missing_endpoints
FROM water.routing_segments;

\echo '=== C. unique exact endpoints (E1 key) ==='
SELECT count(*) AS unique_exact_endpoints FROM (
  SELECT DISTINCT
    round(ST_X(geom)::numeric, 7),
    round(ST_Y(geom)::numeric, 7)
  FROM (
    SELECT start_point AS geom FROM water.routing_segments
    UNION ALL
    SELECT end_point FROM water.routing_segments
  ) t
  WHERE geom IS NOT NULL
) u;

\echo '=== D. relation member segment counts ==='
SELECT 'belomor' AS rel, count(*) AS member_segments
FROM water.routing_segments
WHERE osm_type='way' AND 9909116 = ANY(parent_relation_ids)
UNION ALL
SELECT 'volga_baltic', count(*)
FROM water.routing_segments
WHERE osm_type='way' AND 16738852 = ANY(parent_relation_ids)
UNION ALL
SELECT 'ladoga', count(*)
FROM water.routing_segments
WHERE osm_type='way' AND 21149039 = ANY(parent_relation_ids);

\echo '=== E. VB gap ways exist as distinct segments ==='
SELECT osm_id, part_index, round(length_m::numeric,1) AS length_m
FROM water.routing_segments
WHERE osm_type='way' AND osm_id IN (28433211, 824398188)
ORDER BY osm_id;

\echo '=== F. VB gap NOT exact-E1 (would_E1_connect must be false) ==='
WITH a AS (
  SELECT start_point, end_point FROM water.routing_segments
  WHERE osm_type='way' AND osm_id=28433211 AND part_index=0
),
b AS (
  SELECT start_point, end_point FROM water.routing_segments
  WHERE osm_type='way' AND osm_id=824398188 AND part_index=0
)
SELECT
  (
    round(ST_X(a.start_point)::numeric,7) = round(ST_X(b.start_point)::numeric,7)
    AND round(ST_Y(a.start_point)::numeric,7) = round(ST_Y(b.start_point)::numeric,7)
  ) OR (
    round(ST_X(a.start_point)::numeric,7) = round(ST_X(b.end_point)::numeric,7)
    AND round(ST_Y(a.start_point)::numeric,7) = round(ST_Y(b.end_point)::numeric,7)
  ) OR (
    round(ST_X(a.end_point)::numeric,7) = round(ST_X(b.start_point)::numeric,7)
    AND round(ST_Y(a.end_point)::numeric,7) = round(ST_Y(b.start_point)::numeric,7)
  ) OR (
    round(ST_X(a.end_point)::numeric,7) = round(ST_X(b.end_point)::numeric,7)
    AND round(ST_Y(a.end_point)::numeric,7) = round(ST_Y(b.end_point)::numeric,7)
  ) AS would_E1_connect
FROM a, b;
