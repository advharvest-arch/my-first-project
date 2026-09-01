-- E4.5 smoke: topology rules measured facts (READ-ONLY)
\pset pager off

\echo '=== A. canonical ==='
SELECT (SELECT count(*) FROM water.objects) AS objects,
       (SELECT count(*) FROM water.object_members) AS members,
       (SELECT count(*) FROM water.object_conflicts) AS conflicts;

\echo '=== B. segments / endpoints ==='
SELECT count(*) AS segments FROM water.routing_segments;
SELECT count(*) AS endpoint_rows FROM (
  SELECT start_point FROM water.routing_segments WHERE start_point IS NOT NULL
  UNION ALL
  SELECT end_point FROM water.routing_segments WHERE end_point IS NOT NULL
) u;

\echo '=== C. exact connectivity summary ==='
CREATE TEMP TABLE e45_smoke_ep AS
SELECT
  (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
  geom,
  ST_Transform(geom, 3857) AS g3857
FROM (
  SELECT osm_type, osm_id, part_index, start_point AS geom FROM water.routing_segments
  UNION ALL
  SELECT osm_type, osm_id, part_index, end_point FROM water.routing_segments
) u WHERE geom IS NOT NULL;

WITH cl AS (
  SELECT count(DISTINCT seg_key) AS deg
  FROM e45_smoke_ep
  GROUP BY round(ST_X(geom)::numeric, 7), round(ST_Y(geom)::numeric, 7)
)
SELECT
  count(*) AS unique_endpoints,
  count(*) FILTER (WHERE deg >= 2) AS connected_clusters,
  count(*) FILTER (WHERE deg = 1) AS isolated_endpoints,
  count(*) FILTER (WHERE deg >= 3) AS junction_candidates
FROM cl;

\echo '=== D. tag inventory (candidates) ==='
SELECT
  count(*) FILTER (
    WHERE tags ? 'bridge' AND COALESCE(tags->>'bridge','') NOT IN ('','no')
  ) AS bridge,
  count(*) FILTER (
    WHERE tags ? 'tunnel' AND COALESCE(tags->>'tunnel','') NOT IN ('','no')
  ) AS tunnel,
  count(*) FILTER (WHERE COALESCE(tags->>'tunnel','') = 'culvert') AS culvert,
  count(*) FILTER (
    WHERE tags->>'waterway' IN ('lock_gate','lock')
       OR tags->>'lock' IN ('yes','true','1')
  ) AS lock_signal,
  count(*) FILTER (WHERE tags->>'waterway' IN ('dam','weir')) AS dam_weir,
  count(*) FILTER (WHERE tags ? 'oneway') AS oneway
FROM water.routing_candidates;

\echo '=== E. VB gap must stay unresolved ==='
SELECT round(
  least(
    ST_Distance(a.end_point::geography, b.start_point::geography),
    ST_Distance(a.end_point::geography, b.end_point::geography),
    ST_Distance(a.start_point::geography, b.start_point::geography),
    ST_Distance(a.start_point::geography, b.end_point::geography)
  )::numeric / 1000, 3
) AS vb_gap_km_unresolved
FROM water.routing_segments a
JOIN water.routing_segments b ON TRUE
WHERE a.osm_type='way' AND a.osm_id=28433211 AND a.part_index=0
  AND b.osm_type='way' AND b.osm_id=824398188 AND b.part_index=0;

\echo '=== F. relation segment policy ==='
SELECT 'belomor_members' AS chk, count(*) FROM water.routing_segments
WHERE osm_type='way' AND 9909116 = ANY(parent_relation_ids)
UNION ALL
SELECT 'belomor_rel_seg', count(*) FROM water.routing_segments
WHERE osm_type='relation' AND osm_id=9909116
UNION ALL
SELECT 'ladoga_members', count(*) FROM water.routing_segments
WHERE osm_type='way' AND 21149039 = ANY(parent_relation_ids)
UNION ALL
SELECT 'ladoga_rel_seg', count(*) FROM water.routing_segments
WHERE osm_type='relation' AND osm_id=21149039;
