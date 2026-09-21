"""OSM water-model classes aligned with sea-map OSM Water Inspector.

Tag/role classification only. No proximity, names, bbox joins, or
polygon↔centerline inference.
"""

from __future__ import annotations

from typing import Literal

Kind = Literal["line", "polygon", "inner", "outer"]

LAYER_LAKE = "polygon-lake"
LAYER_RESERVOIR = "polygon-reservoir"
LAYER_RIVER_AREA = "polygon-river-area"
LAYER_CENTER_RIVER = "centerline-river"
LAYER_CENTER_CANAL = "centerline-canal"
LAYER_CENTER_STREAM = "centerline-stream"
LAYER_MP_OUTER = "mp-outer"
LAYER_MP_INNER = "mp-inner"
LAYER_WATERWAY_RELATION = "waterway-relation"
LAYER_OTHER = "other"

INSPECTOR_LAYER_TO_AUDIT = {
    "polygon-lake": LAYER_LAKE,
    "polygon-reservoir": LAYER_RESERVOIR,
    "polygon-river-area": LAYER_RIVER_AREA,
    "centerline-river": LAYER_CENTER_RIVER,
    "centerline-canal": LAYER_CENTER_CANAL,
    "centerline-stream": LAYER_CENTER_STREAM,
    "mp-outer": LAYER_MP_OUTER,
    "mp-inner": LAYER_MP_INNER,
    "centerline-other": LAYER_OTHER,
    "polygon-other": LAYER_OTHER,
}


def is_area_tags(tags: dict[str, str]) -> bool:
    """Same rules as Inspect `isAreaTags`."""
    if tags.get("natural") == "water":
        return True
    if tags.get("landuse") in ("reservoir", "basin"):
        return True
    if tags.get("waterway") == "riverbank":
        return True
    if tags.get("water") in ("lake", "reservoir", "pond", "river"):
        return not tags.get("waterway") or tags.get("waterway") == "riverbank"
    return False


def is_multipolygon_area(tags: dict[str, str]) -> bool:
    """Same rules as Inspect `isMultipolygonArea`."""
    if tags.get("type") == "waterway":
        return False
    return tags.get("type") in ("multipolygon", "water") or is_area_tags(tags)


def is_waterway_relation(tags: dict[str, str]) -> bool:
    """Same rules as Inspect `isWaterwayRelation`."""
    if tags.get("type") == "multipolygon":
        return False
    return tags.get("type") == "waterway" or tags.get("waterway") in ("river", "canal")


def classify_inspect_layer(tags: dict[str, str], kind: Kind) -> str:
    """Same rules as Inspect `classifyInspectLayer`, then mapped to audit labels."""
    if kind == "inner":
        layer = "mp-inner"
    elif kind == "outer":
        layer = "mp-outer"
    elif kind == "line":
        if tags.get("type") == "multipolygon" and is_area_tags(tags):
            layer = "mp-outer"
        else:
            w = tags.get("waterway") or ""
            if w in ("canal", "ship_canal"):
                layer = "centerline-canal"
            elif w in ("river", "fairway"):
                layer = "centerline-river"
            elif w in ("stream", "ditch", "drain"):
                layer = "centerline-stream"
            else:
                layer = "centerline-other"
    elif tags.get("water") == "reservoir" or tags.get("landuse") == "reservoir":
        layer = "polygon-reservoir"
    elif tags.get("water") == "river" or tags.get("waterway") == "riverbank":
        layer = "polygon-river-area"
    elif tags.get("water") == "lake" or tags.get("natural") == "water":
        layer = "polygon-lake"
    else:
        layer = "polygon-other"
    return INSPECTOR_LAYER_TO_AUDIT[layer]


def classify_relation_object(tags: dict[str, str]) -> str:
    if is_waterway_relation(tags):
        return LAYER_WATERWAY_RELATION
    if is_multipolygon_area(tags):
        return classify_inspect_layer(tags, "polygon")
    return LAYER_OTHER


def classify_member(
    *,
    role: str,
    member_tags: dict[str, str],
    relation_tags: dict[str, str],
) -> str:
    """Member class from OSM role + tags. Unclosed outer is still mp-outer."""
    if is_multipolygon_area(relation_tags):
        if role == "inner":
            return LAYER_MP_INNER
        if role in ("outer", ""):
            return LAYER_MP_OUTER
        # Unusual role on an area MP: still not a centerline unless waterway=* on the way.
        if member_tags.get("waterway"):
            return classify_inspect_layer(member_tags, "line")
        return LAYER_OTHER
    if is_waterway_relation(relation_tags):
        line_tags = member_tags if member_tags.get("waterway") else relation_tags
        return classify_inspect_layer(line_tags, "line")
    if role == "inner":
        return LAYER_MP_INNER
    if role == "outer":
        return LAYER_MP_OUTER
    return LAYER_OTHER


def classify_way_object(tags: dict[str, str], *, closed: bool) -> str:
    if is_area_tags(tags) and closed:
        return classify_inspect_layer(tags, "polygon")
    return classify_inspect_layer(tags, "line")


def way_is_closed(node_ids: list[int]) -> bool:
    return len(node_ids) >= 4 and node_ids[0] == node_ids[-1]


def way_geometry_type(tags: dict[str, str], node_ids: list[int]) -> str:
    if way_is_closed(node_ids) and is_area_tags(tags):
        return "Polygon"
    return "LineString"


def relation_geometry_type(tags: dict[str, str]) -> str:
    if tags.get("type") == "multipolygon" or is_multipolygon_area(tags):
        return "MultiPolygon"
    if is_waterway_relation(tags):
        return "GeometryCollection"
    return "GeometryCollection"


def member_geometry_type(
    *,
    role: str,
    relation_tags: dict[str, str],
    member_tags: dict[str, str],
    node_ids: list[int],
    member_type: str = "way",
) -> str:
    """Geometry of a declared relation member. No ring-joining across ways.

    Inspector draws MP outer members as LineString even when a way is closed:
    outer/inner are MP boundary fragments, not a centerline and not a
    reconstructed MultiPolygon on the member itself.
    """
    if member_type == "node":
        return "Point"
    if member_type == "relation":
        return relation_geometry_type(member_tags)
    if not node_ids:
        return "LineString"
    if len(node_ids) == 1:
        return "Point"
    closed = way_is_closed(node_ids)
    if is_multipolygon_area(relation_tags):
        if role == "inner":
            return "Polygon" if closed else "LineString"
        return "LineString"
    if is_waterway_relation(relation_tags):
        return "LineString"
    return way_geometry_type(member_tags, node_ids)


def count_member_roles(roles: list[str]) -> dict[str, object]:
    counts = {
        "outer": 0,
        "inner": 0,
        "main_stream": 0,
        "side_stream": 0,
        "other": 0,
        "other_roles": [],
    }
    other_roles: list[str] = counts["other_roles"]  # type: ignore[assignment]
    for raw in roles:
        role = raw or ""
        if role == "outer":
            counts["outer"] += 1
        elif role == "inner":
            counts["inner"] += 1
        elif role == "main_stream":
            counts["main_stream"] += 1
        elif role == "side_stream":
            counts["side_stream"] += 1
        else:
            counts["other"] += 1
            if role and role not in other_roles:
                other_roles.append(role)
    return counts
