-- E4.3 — Routing segment / endpoint inventory (READ-ONLY VIEW)
-- Linear geometry preparation for a future WaterGraph.
-- Source: water.routing_candidates.
--
-- Does NOT create graph nodes/edges.
-- Does NOT mutate objects / members / relevance / candidates.
-- Does NOT LineMerge MULTILINESTRING parts.
-- Does NOT stitch by proximity or name.
-- Does NOT imply navigability.
--
-- Segment geometry SoT for WaterGraph prep = candidate WAYS only.
-- Relation cached geometry is classified diagnostically but NOT expanded
-- into routing_segments (member ways are the authoritative linear source).

DROP VIEW IF EXISTS water.routing_segments;
DROP VIEW IF EXISTS water.routing_geometry_class;

-- Diagnostic geometry classification of all routing_candidates (data class only).
CREATE VIEW water.routing_geometry_class AS
SELECT
    c.id,
    c.osm_type,
    c.osm_id,
    c.name,
    c.water_type,
    c.relevance,
    c.candidate_category,
    c.geometry_type,
    c.has_geometry,
    CASE
        WHEN c.geometry_type = 'LINESTRING' THEN 'LINEAR_SEGMENT'
        WHEN c.geometry_type = 'MULTILINESTRING' THEN 'MULTILINE_PART'
        WHEN c.geometry_type IN ('POLYGON', 'MULTIPOLYGON') THEN 'AREA_NOT_SEGMENT'
        WHEN c.geometry_type = 'POINT' THEN 'POINT_NOT_SEGMENT'
        WHEN c.geometry IS NULL THEN 'NO_GEOMETRY'
        ELSE 'OTHER_NOT_SEGMENT'
    END AS geometry_class,
    -- True when this candidate identity can contribute rows to routing_segments
    (
        c.osm_type = 'way'
        AND c.geometry_type IN ('LINESTRING', 'MULTILINESTRING')
    ) AS is_segment_source
FROM water.routing_candidates c;

-- Linear segments + endpoints (ways only; no ST_LineMerge).
CREATE VIEW water.routing_segments AS
WITH linear_ways AS (
    SELECT
        c.id AS object_id,
        c.osm_type,
        c.osm_id,
        c.name,
        c.water_type,
        c.waterway,
        c.relevance,
        c.candidate_category AS category,
        c.is_high_relation_member AS is_relation_member,
        c.parent_relation_ids,
        c.parent_relation_count,
        c.geometry,
        c.geometry_type,
        c.is_valid_geometry
    FROM water.routing_candidates c
    WHERE c.osm_type = 'way'
      AND c.geometry IS NOT NULL
      AND c.geometry_type IN ('LINESTRING', 'MULTILINESTRING')
),
parts AS (
    -- LINESTRING: one segment, original geometry unchanged
    SELECT
        lw.object_id,
        lw.osm_type,
        lw.osm_id,
        0 AS part_index,
        lw.geometry AS segment_geom,
        'LINEAR_SEGMENT'::text AS segment_kind,
        lw.name,
        lw.water_type,
        lw.waterway,
        lw.relevance,
        lw.category,
        lw.is_relation_member,
        lw.parent_relation_ids,
        lw.parent_relation_count,
        lw.is_valid_geometry AS source_is_valid_geometry
    FROM linear_ways lw
    WHERE lw.geometry_type = 'LINESTRING'

    UNION ALL

    -- MULTILINESTRING: dump each part; do NOT LineMerge
    SELECT
        lw.object_id,
        lw.osm_type,
        lw.osm_id,
        (d.path)[1] - 1 AS part_index,
        d.geom AS segment_geom,
        'MULTILINE_PART'::text AS segment_kind,
        lw.name,
        lw.water_type,
        lw.waterway,
        lw.relevance,
        lw.category,
        lw.is_relation_member,
        lw.parent_relation_ids,
        lw.parent_relation_count,
        lw.is_valid_geometry AS source_is_valid_geometry
    FROM linear_ways lw
    CROSS JOIN LATERAL ST_Dump(lw.geometry) AS d
    WHERE lw.geometry_type = 'MULTILINESTRING'
)
SELECT
    p.object_id,
    p.osm_type,
    p.osm_id,
    p.part_index,
    p.segment_kind,
    p.category,
    p.relevance,
    p.water_type,
    p.waterway,
    p.name,
    p.is_relation_member,
    p.parent_relation_ids,
    p.parent_relation_count,
    p.segment_geom AS geometry,
    GeometryType(p.segment_geom) AS geometry_type,
    ST_StartPoint(p.segment_geom) AS start_point,
    ST_EndPoint(p.segment_geom) AS end_point,
    ST_NPoints(p.segment_geom) AS point_count,
    ST_Length(p.segment_geom::geography) AS length_m,
    (
        ST_StartPoint(p.segment_geom) IS NOT NULL
        AND ST_EndPoint(p.segment_geom) IS NOT NULL
    ) AS has_endpoints,
    ST_IsValid(p.segment_geom) AS is_valid_geometry,
    p.source_is_valid_geometry,
    (ST_Length(p.segment_geom::geography) = 0) AS is_zero_length
FROM parts p;
