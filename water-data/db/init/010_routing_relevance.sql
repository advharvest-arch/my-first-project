-- E4.1 — Routing relevance layer (READ-ONLY VIEW)
-- Classifies existing water.objects for future WaterGraph planning.
-- Does NOT mutate canonical data. Does NOT imply navigability.
-- Does NOT use proximity, name heuristics, stitching, or synthetic connections.
-- Classification is attribute/tag/type based only.

CREATE OR REPLACE VIEW water.routing_relevance AS
SELECT
    o.id,
    o.osm_type,
    o.osm_id,
    o.name,
    o.water_type,
    o.geometry,
    o.tags,
    cls.relevance,
    cls.relevance_reason,
    (o.osm_type = 'relation') AS is_relation,
    CASE WHEN o.osm_type = 'relation' THEN COALESCE(m.member_count, 0) ELSE NULL END
        AS member_count,
    CASE WHEN o.osm_type = 'relation' THEN COALESCE(m.present_member_count, 0) ELSE NULL END
        AS present_member_count,
    CASE
        WHEN o.geometry IS NULL THEN NULL
        ELSE GeometryType(o.geometry)
    END AS geometry_type,
    (o.geometry IS NOT NULL) AS has_geometry,
    CASE
        WHEN o.geometry IS NULL THEN NULL
        ELSE ST_IsValid(o.geometry)
    END AS is_valid_geometry
FROM water.objects o
LEFT JOIN (
    SELECT
        om.parent_osm_type,
        om.parent_osm_id,
        COUNT(*)::int AS member_count,
        COUNT(child.id)::int AS present_member_count
    FROM water.object_members om
    LEFT JOIN water.objects child
        ON child.osm_type = om.member_osm_type
       AND child.osm_id = om.member_osm_id
    GROUP BY om.parent_osm_type, om.parent_osm_id
) m ON o.osm_type = 'relation'
   AND m.parent_osm_type = o.osm_type
   AND m.parent_osm_id = o.osm_id
CROSS JOIN LATERAL (
    SELECT
        CASE
            -- Structures (routing topology candidates; not navigability)
            WHEN COALESCE(o.tags->>'waterway', '') IN ('lock_gate', 'lock')
              OR COALESCE(o.tags->>'lock', '') IN ('yes', 'true', '1')
              OR lower(COALESCE(o.water_type, '')) LIKE '%lock%'
                THEN 'HIGH'
            WHEN COALESCE(o.tags->>'waterway', '') = 'dam'
              OR COALESCE(o.tags->>'water', '') = 'dam'
              OR lower(COALESCE(o.water_type, '')) LIKE '%dam%'
                THEN 'HIGH'
            WHEN COALESCE(o.tags->>'waterway', '') = 'weir'
              OR lower(COALESCE(o.water_type, '')) LIKE '%weir%'
                THEN 'HIGH'
            WHEN COALESCE(o.tags->>'waterway', '') = 'waterfall'
                THEN 'HIGH'

            -- Primary linear waterways
            WHEN COALESCE(o.tags->>'waterway', '') IN (
                    'river', 'canal', 'fairway', 'link', 'tidal_channel'
                 )
                THEN 'HIGH'

            -- Lakes / reservoirs via explicit tags or water_type
            WHEN COALESCE(o.tags->>'water', '') IN ('lake', 'reservoir')
                THEN 'HIGH'
            WHEN COALESCE(o.tags->>'landuse', '') = 'reservoir'
                THEN 'HIGH'
            WHEN COALESCE(o.water_type, '') IN ('lake', 'reservoir')
                THEN 'HIGH'
            WHEN COALESCE(o.tags->>'natural', '') = 'water'
             AND COALESCE(o.tags->>'water', '') IN ('lake', 'reservoir')
                THEN 'HIGH'

            -- Waterway relations (type=waterway) — structural SoT parents
            WHEN o.osm_type = 'relation'
             AND COALESCE(o.tags->>'type', '') = 'waterway'
                THEN 'HIGH'

            -- Streams
            WHEN COALESCE(o.tags->>'waterway', '') = 'stream'
                THEN 'MEDIUM'

            -- River areas (areal river representation)
            WHEN COALESCE(o.tags->>'water', '') = 'river'
              OR COALESCE(o.water_type, '') = 'river_area'
                THEN 'MEDIUM'

            -- route=waterway relations (not type=waterway)
            WHEN o.osm_type = 'relation'
             AND COALESCE(o.tags->>'route', '') = 'waterway'
                THEN 'MEDIUM'

            -- Water-related amenity / service features
            WHEN COALESCE(o.tags->>'amenity', '') IN (
                    'fuel', 'boat_rental', 'boat_storage', 'ferry_terminal'
                 )
              OR COALESCE(o.tags->>'leisure', '') IN ('marina', 'slipway')
              OR COALESCE(o.tags->>'man_made', '') IN ('pier', 'quay', 'breakwater')
              OR COALESCE(o.tags->>'waterway', '') IN (
                    'fuel', 'boatyard', 'dock', 'access_point', 'milestone'
                 )
                THEN 'MEDIUM'

            -- Minor linear / collateral water
            WHEN COALESCE(o.tags->>'waterway', '') IN (
                    'ditch', 'drain', 'flowline', 'brook', 'rapids', 'fish_pass'
                 )
                THEN 'LOW'
            WHEN COALESCE(o.tags->>'water', '') IN (
                    'pond', 'oxbow', 'moat', 'reflecting_pool', 'wastewater', 'basin'
                 )
              OR COALESCE(o.water_type, '') IN ('pond', 'oxbow')
                THEN 'LOW'

            -- Remaining natural=water without lake/reservoir signal
            WHEN COALESCE(o.tags->>'natural', '') = 'water'
                THEN 'LOW'

            ELSE 'IGNORE'
        END AS relevance,
        CASE
            WHEN COALESCE(o.tags->>'waterway', '') IN ('lock_gate', 'lock')
              OR COALESCE(o.tags->>'lock', '') IN ('yes', 'true', '1')
              OR lower(COALESCE(o.water_type, '')) LIKE '%lock%'
                THEN 'structure:lock'
            WHEN COALESCE(o.tags->>'waterway', '') = 'dam'
              OR COALESCE(o.tags->>'water', '') = 'dam'
              OR lower(COALESCE(o.water_type, '')) LIKE '%dam%'
                THEN 'structure:dam'
            WHEN COALESCE(o.tags->>'waterway', '') = 'weir'
              OR lower(COALESCE(o.water_type, '')) LIKE '%weir%'
                THEN 'structure:weir'
            WHEN COALESCE(o.tags->>'waterway', '') = 'waterfall'
                THEN 'structure:waterfall'
            WHEN COALESCE(o.tags->>'waterway', '') IN (
                    'river', 'canal', 'fairway', 'link', 'tidal_channel'
                 )
                THEN 'waterway:' || (o.tags->>'waterway')
            WHEN COALESCE(o.tags->>'water', '') IN ('lake', 'reservoir')
                THEN 'water:' || (o.tags->>'water')
            WHEN COALESCE(o.tags->>'landuse', '') = 'reservoir'
                THEN 'landuse:reservoir'
            WHEN COALESCE(o.water_type, '') IN ('lake', 'reservoir')
                THEN 'water_type:' || o.water_type
            WHEN COALESCE(o.tags->>'natural', '') = 'water'
             AND COALESCE(o.tags->>'water', '') IN ('lake', 'reservoir')
                THEN 'natural=water + water=lake|reservoir'
            WHEN o.osm_type = 'relation'
             AND COALESCE(o.tags->>'type', '') = 'waterway'
                THEN 'relation type=waterway'
            WHEN COALESCE(o.tags->>'waterway', '') = 'stream'
                THEN 'waterway:stream'
            WHEN COALESCE(o.tags->>'water', '') = 'river'
              OR COALESCE(o.water_type, '') = 'river_area'
                THEN 'river_area / water=river'
            WHEN o.osm_type = 'relation'
             AND COALESCE(o.tags->>'route', '') = 'waterway'
                THEN 'relation route=waterway'
            WHEN COALESCE(o.tags->>'amenity', '') <> ''
              OR COALESCE(o.tags->>'leisure', '') <> ''
              OR COALESCE(o.tags->>'man_made', '') <> ''
              OR COALESCE(o.tags->>'waterway', '') IN (
                    'fuel', 'boatyard', 'dock', 'access_point', 'milestone'
                 )
                THEN 'water amenity/service'
            WHEN COALESCE(o.tags->>'waterway', '') IN (
                    'ditch', 'drain', 'flowline', 'brook', 'rapids', 'fish_pass'
                 )
                THEN 'minor waterway:' || (o.tags->>'waterway')
            WHEN COALESCE(o.tags->>'water', '') IN (
                    'pond', 'oxbow', 'moat', 'reflecting_pool', 'wastewater', 'basin'
                 )
              OR COALESCE(o.water_type, '') IN ('pond', 'oxbow')
                THEN 'minor water body'
            WHEN COALESCE(o.tags->>'natural', '') = 'water'
                THEN 'natural=water (non lake/reservoir)'
            ELSE 'no routing-relevant tags'
        END AS relevance_reason
) cls;
