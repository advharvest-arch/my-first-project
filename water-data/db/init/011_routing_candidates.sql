-- E4.2 — Routing candidate extract (READ-ONLY VIEW)
-- Selects WaterGraph *candidates* from water.routing_relevance + object_members.
-- Does NOT mutate canonical data. Does NOT imply navigability.
-- Does NOT copy/synthesize geometry; rows reference water.objects identity.
-- Does NOT use proximity, name similarity, or stitching.
-- Dedup identity = (osm_type, osm_id) only (no geometry dedup).
--
-- Inclusion:
--   HIGH_DIRECT      — relevance = HIGH
--   MEDIUM_WATERWAY  — relevance = MEDIUM and stream / river_area / water=river
--   RELATION_MEMBER  — way members of HIGH relations that are:
--                        type=waterway  OR  lake/reservoir (open-water parents)
--                      (member rings of lakes are NOT centerlines)
--   DUPLICATE_SOURCE — identity matched more than one of the above paths

DROP VIEW IF EXISTS water.routing_candidates;

CREATE VIEW water.routing_candidates AS
WITH high_relations AS (
    -- Parent relations whose members are pulled into the candidate set
    SELECT r.osm_type, r.osm_id
    FROM water.routing_relevance r
    WHERE r.relevance = 'HIGH'
      AND r.osm_type = 'relation'
      AND (
            COALESCE(r.tags->>'type', '') = 'waterway'
         OR COALESCE(r.tags->>'water', '') IN ('lake', 'reservoir')
         OR COALESCE(r.water_type, '') IN ('lake', 'reservoir')
         OR COALESCE(r.tags->>'landuse', '') = 'reservoir'
      )
),
high_direct AS (
    SELECT
        r.osm_type,
        r.osm_id,
        'HIGH_DIRECT'::text AS src
    FROM water.routing_relevance r
    WHERE r.relevance = 'HIGH'
),
medium_waterway AS (
    SELECT
        r.osm_type,
        r.osm_id,
        'MEDIUM_WATERWAY'::text AS src
    FROM water.routing_relevance r
    WHERE r.relevance = 'MEDIUM'
      AND (
            COALESCE(r.tags->>'waterway', '') = 'stream'
         OR COALESCE(r.tags->>'water', '') = 'river'
         OR COALESCE(r.water_type, '') = 'river_area'
      )
),
relation_member AS (
    SELECT DISTINCT
        om.member_osm_type AS osm_type,
        om.member_osm_id AS osm_id,
        'RELATION_MEMBER'::text AS src
    FROM high_relations hr
    JOIN water.object_members om
      ON om.parent_osm_type = hr.osm_type
     AND om.parent_osm_id = hr.osm_id
    JOIN water.objects child
      ON child.osm_type = om.member_osm_type
     AND child.osm_id = om.member_osm_id
    WHERE om.member_osm_type = 'way'
),
sources AS (
    SELECT * FROM high_direct
    UNION ALL
    SELECT * FROM medium_waterway
    UNION ALL
    SELECT * FROM relation_member
),
by_identity AS (
    SELECT
        s.osm_type,
        s.osm_id,
        array_agg(DISTINCT s.src ORDER BY s.src) AS candidate_sources,
        count(DISTINCT s.src)::int AS source_count
    FROM sources s
    GROUP BY s.osm_type, s.osm_id
),
member_parents AS (
    SELECT
        om.member_osm_type AS osm_type,
        om.member_osm_id AS osm_id,
        array_agg(DISTINCT om.parent_osm_id ORDER BY om.parent_osm_id)
            AS parent_relation_ids,
        count(DISTINCT om.parent_osm_id)::int AS parent_relation_count
    FROM high_relations hr
    JOIN water.object_members om
      ON om.parent_osm_type = hr.osm_type
     AND om.parent_osm_id = hr.osm_id
    WHERE om.member_osm_type = 'way'
    GROUP BY om.member_osm_type, om.member_osm_id
)
SELECT
    o.id,
    o.osm_type,
    o.osm_id,
    o.name,
    o.water_type,
    o.geometry,
    o.tags,
    rr.relevance,
    rr.relevance_reason,
    o.tags->>'waterway' AS waterway,
    o.tags->>'natural' AS natural,
    o.tags->>'water' AS water,
    CASE
        WHEN b.source_count > 1 THEN 'DUPLICATE_SOURCE'
        ELSE b.candidate_sources[1]
    END AS candidate_category,
    b.candidate_sources,
    (b.source_count > 1) AS is_multi_source,
    (o.osm_type = 'relation') AS is_relation,
    CASE
        WHEN o.osm_type = 'relation' THEN rr.member_count
        ELSE NULL
    END AS member_count,
    CASE
        WHEN o.osm_type = 'relation' THEN rr.present_member_count
        ELSE NULL
    END AS present_member_count,
    mp.parent_relation_ids,
    COALESCE(mp.parent_relation_count, 0) AS parent_relation_count,
    (mp.parent_relation_ids IS NOT NULL) AS is_high_relation_member,
    CASE
        WHEN o.geometry IS NULL THEN NULL
        ELSE GeometryType(o.geometry)
    END AS geometry_type,
    (o.geometry IS NOT NULL) AS has_geometry,
    CASE
        WHEN o.geometry IS NULL THEN NULL
        ELSE ST_IsValid(o.geometry)
    END AS is_valid_geometry
FROM by_identity b
JOIN water.objects o
  ON o.osm_type = b.osm_type
 AND o.osm_id = b.osm_id
JOIN water.routing_relevance rr
  ON rr.osm_type = b.osm_type
 AND rr.osm_id = b.osm_id
LEFT JOIN member_parents mp
  ON mp.osm_type = b.osm_type
 AND mp.osm_id = b.osm_id;
