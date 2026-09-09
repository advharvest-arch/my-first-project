"""OSM water-feature classifiers for research topology discovery.

Tag predicates follow water-data/ingest/import_osm.py (is_water_tagged /
is_area_water_tags / pick_name) but this module does not import ingest:
import_osm.py pulls psycopg2 / pyosmium for the DB pipeline.

Discovery BFS expands only through area water and open waterways
(river|stream|canal). ditch/drain are classified but do not expand the graph.

Names are never a join key. Rules are tag-only and extensible via
register_area_rule / register_connector_value.
"""

from __future__ import annotations

from collections.abc import Callable

TagMap = dict[str, str]
TagRule = Callable[[TagMap], bool]

# Mirrors ingest.import_osm.WATERWAY_TYPES for the open-water subset.
CONNECTOR_WATERWAY_VALUES: set[str] = {"river", "stream", "canal"}
WEAK_WATERWAY_VALUES: set[str] = {"ditch", "drain"}

AREA_WATER_VALUES: set[str] = {"lake", "pond", "river", "reservoir", "basin", "riverbank"}

_AREA_RULES: list[TagRule] = []
_CONNECTOR_RULES: list[TagRule] = []


def register_area_rule(rule: TagRule) -> TagRule:
    _AREA_RULES.append(rule)
    return rule


def register_connector_rule(rule: TagRule) -> TagRule:
    _CONNECTOR_RULES.append(rule)
    return rule


def register_connector_value(value: str) -> None:
    CONNECTOR_WATERWAY_VALUES.add(value)


@register_area_rule
def _natural_water(tags: TagMap) -> bool:
    return tags.get("natural") == "water"


@register_area_rule
def _landuse_reservoir(tags: TagMap) -> bool:
    return tags.get("landuse") == "reservoir"


@register_area_rule
def _water_key_area(tags: TagMap) -> bool:
    return tags.get("water") in AREA_WATER_VALUES


@register_connector_rule
def _waterway_connector(tags: TagMap) -> bool:
    return tags.get("waterway") in CONNECTOR_WATERWAY_VALUES


@register_connector_rule
def _type_or_route_waterway(tags: TagMap) -> bool:
    return tags.get("type") == "waterway" or tags.get("route") == "waterway"


def is_area_water_tags(tags: TagMap) -> bool:
    """Same idea as ingest.import_osm.is_area_water_tags, plus registered rules."""
    if any(rule(tags) for rule in _AREA_RULES):
        return True
    if tags.get("type") == "multipolygon" and (
        tags.get("natural") == "water" or tags.get("water") in AREA_WATER_VALUES
    ):
        return True
    return False


def is_area_relation(tags: TagMap) -> bool:
    if tags.get("type") == "multipolygon" and is_area_water_tags(tags):
        return True
    if tags.get("type") == "multipolygon" and tags.get("natural") == "water":
        return True
    return False


def is_open_connector_tags(tags: TagMap) -> bool:
    return any(rule(tags) for rule in _CONNECTOR_RULES)


def is_weak_connector_tags(tags: TagMap) -> bool:
    return tags.get("waterway") in WEAK_WATERWAY_VALUES


def is_water_tagged(tags: TagMap) -> bool:
    """Broad water tag (ingest.import_osm.is_water_tagged analogue)."""
    if "waterway" in tags:
        return True
    if tags.get("natural") == "water":
        return True
    if tags.get("landuse") == "reservoir":
        return True
    if tags.get("type") == "waterway" or tags.get("route") == "waterway":
        return True
    if tags.get("type") == "multipolygon" and (
        tags.get("natural") == "water"
        or tags.get("water") in AREA_WATER_VALUES
        or tags.get("landuse") == "reservoir"
    ):
        return True
    return False


def pick_name(tags: TagMap) -> str | None:
    for key in ("name", "name:ru", "name:en", "alt_name"):
        if tags.get(key):
            return tags[key]
    return None


def feature_role(tags: TagMap) -> str | None:
    """Classify an OSM object as a discovery vertex/edge participant.

    Returns:
      area           — lake/pond/river-area/reservoir (WaterFeatureNode)
      waterway       — river/stream/canal (node + possible connector)
      waterway-weak  — ditch/drain (not used for BFS expansion)
      None           — not a water feature for this layer
    """
    if is_weak_connector_tags(tags) and not is_area_water_tags(tags):
        return "waterway-weak"
    if is_open_connector_tags(tags) and tags.get("waterway") in CONNECTOR_WATERWAY_VALUES:
        return "waterway"
    if is_open_connector_tags(tags) and not is_area_water_tags(tags):
        return "waterway"
    if is_area_water_tags(tags):
        return "area"
    return None
