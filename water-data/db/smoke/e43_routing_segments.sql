-- E4.3 smoke: routing segments / endpoints (READ-ONLY)
\pset pager off

\echo '=== A. geometry class (candidates) ==='
SELECT geometry_class, count(*) AS n
FROM water.routing_geometry_class
GROUP BY 1 ORDER BY 2 DESC;

SELECT count(*) FILTER (WHERE is_segment_source) AS segment_source_ways
FROM water.routing_geometry_class;

\echo '=== B. segments ==='
SELECT count(*) AS segments FROM water.routing_segments;
SELECT segment_kind, count(*) AS n FROM water.routing_segments GROUP BY 1 ORDER BY 1;
SELECT geometry_type, count(*) AS n FROM water.routing_segments GROUP BY 1;

\echo '=== C. QA flags ==='
SELECT
  count(*) FILTER (WHERE NOT has_endpoints) AS no_endpoints,
  count(*) FILTER (WHERE NOT is_valid_geometry) AS invalid_geom,
  count(*) FILTER (WHERE is_zero_length) AS zero_length,
  count(*) FILTER (WHERE is_relation_member) AS relation_member_segments
FROM water.routing_segments;

SELECT count(*) AS duplicate_osm_part FROM (
  SELECT osm_type, osm_id, part_index
  FROM water.routing_segments
  GROUP BY 1, 2, 3
  HAVING count(*) > 1
) d;

\echo '=== D. length distribution ==='
SELECT
  count(*) AS n,
  round(min(length_m)::numeric, 2) AS min_m,
  round(percentile_cont(0.5) WITHIN GROUP (ORDER BY length_m)::numeric, 2) AS p50_m,
  round(percentile_cont(0.9) WITHIN GROUP (ORDER BY length_m)::numeric, 2) AS p90_m,
  round(max(length_m)::numeric, 2) AS max_m,
  round((sum(length_m) / 1000.0)::numeric, 1) AS total_km
FROM water.routing_segments;

SELECT bucket, count(*) AS n FROM (
  SELECT CASE
    WHEN length_m < 10 THEN '0-10m'
    WHEN length_m < 100 THEN '10-100m'
    WHEN length_m < 1000 THEN '100m-1km'
    WHEN length_m < 10000 THEN '1-10km'
    ELSE '10km+'
  END AS bucket,
  CASE
    WHEN length_m < 10 THEN 1
    WHEN length_m < 100 THEN 2
    WHEN length_m < 1000 THEN 3
    WHEN length_m < 10000 THEN 4
    ELSE 5
  END AS ord
  FROM water.routing_segments
) t GROUP BY bucket, ord ORDER BY ord;

\echo '=== E. Belomor / Volga-Baltic / Ladoga ==='
SELECT 'belomor_relation_segments' AS chk,
       count(*) FROM water.routing_segments
WHERE osm_type = 'relation' AND osm_id = 9909116
UNION ALL
SELECT 'belomor_member_segments', count(*)
FROM water.routing_segments
WHERE osm_type = 'way' AND 9909116 = ANY (parent_relation_ids)
UNION ALL
SELECT 'vb_relation_segments', count(*)
FROM water.routing_segments
WHERE osm_type = 'relation' AND osm_id = 16738852
UNION ALL
SELECT 'vb_member_segments', count(*)
FROM water.routing_segments
WHERE osm_type = 'way' AND 16738852 = ANY (parent_relation_ids)
UNION ALL
SELECT 'ladoga_relation_segments', count(*)
FROM water.routing_segments
WHERE osm_type = 'relation' AND osm_id = 21149039
UNION ALL
SELECT 'ladoga_member_segments', count(*)
FROM water.routing_segments
WHERE osm_type = 'way' AND 21149039 = ANY (parent_relation_ids);

-- Gap 53→54 diagnostic only (NOT a synthetic edge)
SELECT round(
  least(
    ST_Distance(a.end_point::geography, b.start_point::geography),
    ST_Distance(a.end_point::geography, b.end_point::geography),
    ST_Distance(a.start_point::geography, b.start_point::geography),
    ST_Distance(a.start_point::geography, b.end_point::geography)
  )::numeric / 1000, 3
) AS vb_gap_53_54_min_endpoint_km
FROM water.routing_segments a
JOIN water.routing_segments b ON TRUE
WHERE a.osm_type = 'way' AND a.osm_id = 28433211 AND a.part_index = 0
  AND b.osm_type = 'way' AND b.osm_id = 824398188 AND b.part_index = 0;

\echo '=== F. canonical invariants ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;
