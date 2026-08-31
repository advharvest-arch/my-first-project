-- E4.4 smoke: READ-ONLY topology inference diagnostics
-- Uses water.routing_segments only. No graph tables. No geometry writes.
\pset pager off

\echo '=== A. segment / endpoint inventory ==='
SELECT count(*) AS segments FROM water.routing_segments;

SELECT count(*) AS endpoint_rows FROM (
  SELECT start_point AS geom FROM water.routing_segments WHERE start_point IS NOT NULL
  UNION ALL
  SELECT end_point FROM water.routing_segments WHERE end_point IS NOT NULL
) u;

\echo '=== B. exact endpoint clusters ==='
CREATE TEMP TABLE e44_smoke_ep ON COMMIT DROP AS
SELECT
  (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
  geom,
  ST_Transform(geom, 3857) AS g3857
FROM (
  SELECT osm_type, osm_id, part_index, start_point AS geom FROM water.routing_segments
  UNION ALL
  SELECT osm_type, osm_id, part_index, end_point FROM water.routing_segments
) u
WHERE geom IS NOT NULL;

WITH cl AS (
  SELECT
    round(ST_X(geom)::numeric, 7) AS gx,
    round(ST_Y(geom)::numeric, 7) AS gy,
    count(DISTINCT seg_key) AS seg_degree
  FROM e44_smoke_ep
  GROUP BY 1, 2
)
SELECT
  count(*) AS unique_endpoints,
  count(*) FILTER (WHERE seg_degree >= 2) AS connected_clusters,
  count(*) FILTER (WHERE seg_degree = 1) AS isolated_endpoints,
  count(*) FILTER (WHERE seg_degree >= 3) AS junction_candidates
FROM cl;

\echo '=== C. degree distribution (exact) ==='
SELECT seg_degree AS degree, count(*) AS clusters
FROM (
  SELECT count(DISTINCT seg_key) AS seg_degree
  FROM e44_smoke_ep
  GROUP BY round(ST_X(geom)::numeric, 7), round(ST_Y(geom)::numeric, 7)
) t
GROUP BY 1 ORDER BY 1;

\echo '=== D. tolerance unique endpoint counts (SnapToGrid 3857 diagnostic) ==='
SELECT 1::int AS tol_m, count(*) AS unique_endpoints
FROM (
  SELECT DISTINCT ST_X(ST_SnapToGrid(g3857, 1)), ST_Y(ST_SnapToGrid(g3857, 1))
  FROM e44_smoke_ep
) t
UNION ALL
SELECT 5, count(*) FROM (
  SELECT DISTINCT ST_X(ST_SnapToGrid(g3857, 5)), ST_Y(ST_SnapToGrid(g3857, 5))
  FROM e44_smoke_ep
) t
UNION ALL
SELECT 10, count(*) FROM (
  SELECT DISTINCT ST_X(ST_SnapToGrid(g3857, 10)), ST_Y(ST_SnapToGrid(g3857, 10))
  FROM e44_smoke_ep
) t
ORDER BY 1;

\echo '=== E. VB gap fact (NOT stitched) ==='
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

\echo '=== F. relation segment presence ==='
SELECT 'belomor_rel_seg' AS chk, count(*) FROM water.routing_segments
WHERE osm_type='relation' AND osm_id=9909116
UNION ALL
SELECT 'belomor_members', count(*) FROM water.routing_segments
WHERE osm_type='way' AND 9909116 = ANY(parent_relation_ids)
UNION ALL
SELECT 'vb_rel_seg', count(*) FROM water.routing_segments
WHERE osm_type='relation' AND osm_id=16738852
UNION ALL
SELECT 'vb_members', count(*) FROM water.routing_segments
WHERE osm_type='way' AND 16738852 = ANY(parent_relation_ids)
UNION ALL
SELECT 'ladoga_rel_seg', count(*) FROM water.routing_segments
WHERE osm_type='relation' AND osm_id=21149039
UNION ALL
SELECT 'ladoga_members', count(*) FROM water.routing_segments
WHERE osm_type='way' AND 21149039 = ANY(parent_relation_ids);

\echo '=== G. canonical invariants ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;
