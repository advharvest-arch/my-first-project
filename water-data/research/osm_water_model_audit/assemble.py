"""Turn raw OSM JSON into audit records. Tag/role/id only."""

from __future__ import annotations

from typing import Any

from .classify import (
    classify_member,
    classify_relation_object,
    classify_way_object,
    count_member_roles,
    member_geometry_type,
    relation_geometry_type,
    way_geometry_type,
    way_is_closed,
)

FORBIDDEN_COMPUTED_KEYS = (
    "distance",
    "nearest",
    "knn",
    "dwithin",
    "st_dwithin",
    "centroid",
    "proximity",
    "same_river",
    "polygon_centerline",
    "belongs_to",
)


def _tags(el: dict[str, Any]) -> dict[str, str]:
    raw = el.get("tags") or {}
    return {str(k): str(v) for k, v in raw.items()}


def index_elements(elements: list[dict[str, Any]]) -> dict[tuple[str, int], dict[str, Any]]:
    out: dict[tuple[str, int], dict[str, Any]] = {}
    for el in elements:
        t = el.get("type")
        i = el.get("id")
        if t and i is not None:
            out[(str(t), int(i))] = el
    return out


def _memberships_for(
    osm_type: str,
    osm_id: int,
    indexed: dict[tuple[str, int], dict[str, Any]],
) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    seen: set[tuple[int, str]] = set()
    for (t, _i), el in indexed.items():
        if t != "relation":
            continue
        for mem in el.get("members") or []:
            if mem.get("type") == osm_type and int(mem.get("ref") or 0) == osm_id:
                rid = int(el["id"])
                role = str(mem.get("role") or "")
                key = (rid, role)
                if key in seen:
                    continue
                seen.add(key)
                found.append(
                    {
                        "relation_id": rid,
                        "role": role,
                        "relation_tags": _tags(el),
                    }
                )
    return found


def _member_record(
    mem: dict[str, Any],
    relation_tags: dict[str, str],
    indexed: dict[tuple[str, int], dict[str, Any]],
    parent_relation_id: int,
) -> dict[str, Any]:
    mtype = str(mem.get("type") or "way")
    mid = int(mem.get("ref") or 0)
    role = str(mem.get("role") or "")
    child = indexed.get((mtype, mid), {})
    tags = _tags(child)
    nodes = [int(n) for n in (child.get("nodes") or [])]
    geom = member_geometry_type(
        role=role,
        relation_tags=relation_tags,
        member_tags=tags,
        node_ids=nodes,
        member_type=mtype,
    )
    closed = way_is_closed(nodes) if mtype == "way" else False
    classification = classify_member(
        role=role,
        member_tags=tags,
        relation_tags=relation_tags,
    )
    rec: dict[str, Any] = {
        "osm_type": mtype,
        "osm_id": mid,
        "role": role,
        "tags": tags,
        "geometry_type": geom,
        "vertex_count": len(nodes) if mtype == "way" else None,
        "closed": closed if mtype == "way" else None,
        "open": (not closed) if mtype == "way" else None,
        "start_node_id": nodes[0] if nodes else None,
        "end_node_id": nodes[-1] if nodes else None,
        "classification": classification,
        "membership": [
            {
                "relation_id": parent_relation_id,
                "role": role,
                "relation_tags": relation_tags,
            }
        ],
    }
    extra = _memberships_for(mtype, mid, indexed)
    for item in extra:
        if item["relation_id"] == parent_relation_id and item["role"] == role:
            continue
        rec["membership"].append(item)
    return rec


def assemble_object(
    osm_type: str,
    osm_id: int,
    elements: list[dict[str, Any]],
    *,
    seed_key: str = "",
    seed_label: str = "",
    fetch_source: str = "",
) -> dict[str, Any]:
    indexed = index_elements(elements)
    el = indexed.get((osm_type, osm_id))
    if el is None:
        return {
            "seed_key": seed_key,
            "seed_label": seed_label,
            "osm_type": osm_type,
            "osm_id": osm_id,
            "error": "not_found",
            "fetch_source": fetch_source,
            "tags": {},
            "geometry_type": None,
            "classification": None,
            "membership": [],
            "members": [],
        }

    tags = _tags(el)
    membership = _memberships_for(osm_type, osm_id, indexed)

    if osm_type == "way":
        nodes = [int(n) for n in (el.get("nodes") or [])]
        closed = way_is_closed(nodes)
        rec = {
            "seed_key": seed_key,
            "seed_label": seed_label,
            "osm_type": "way",
            "osm_id": osm_id,
            "tags": tags,
            "geometry_type": way_geometry_type(tags, nodes),
            "vertex_count": len(nodes),
            "closed": closed,
            "open": not closed,
            "start_node_id": nodes[0] if nodes else None,
            "end_node_id": nodes[-1] if nodes else None,
            "classification": classify_way_object(tags, closed=closed),
            "membership": membership,
            "members": None,
            "role_counts": None,
            "fetch_source": fetch_source,
        }
        return rec

    if osm_type == "node":
        return {
            "seed_key": seed_key,
            "seed_label": seed_label,
            "osm_type": "node",
            "osm_id": osm_id,
            "tags": tags,
            "geometry_type": "Point",
            "vertex_count": 1,
            "closed": None,
            "open": None,
            "start_node_id": osm_id,
            "end_node_id": osm_id,
            "classification": "other",
            "membership": membership,
            "members": None,
            "role_counts": None,
            "fetch_source": fetch_source,
        }

    members_in = el.get("members") or []
    member_recs = [_member_record(m, tags, indexed, osm_id) for m in members_in]
    roles = [str(m.get("role") or "") for m in members_in]
    return {
        "seed_key": seed_key,
        "seed_label": seed_label,
        "osm_type": "relation",
        "osm_id": osm_id,
        "tags": tags,
        "geometry_type": relation_geometry_type(tags),
        "vertex_count": None,
        "closed": None,
        "open": None,
        "start_node_id": None,
        "end_node_id": None,
        "classification": classify_relation_object(tags),
        "membership": membership,
        "members": member_recs,
        "role_counts": count_member_roles(roles),
        "member_count": len(member_recs),
        "fetch_source": fetch_source,
    }


def summarize_sample(objects: list[dict[str, Any]]) -> dict[str, Any]:
    """Counts over seeds + declared members. No inferred links."""
    seed_class: dict[str, int] = {}
    member_class: dict[str, int] = {}
    all_class: dict[str, int] = {}
    relations_with = {
        "outer": 0,
        "inner": 0,
        "main_stream": 0,
        "side_stream": 0,
    }
    untagged_outer_ways = 0
    inner_members = 0
    fetched = 0
    missing = 0

    def bump(bucket: dict[str, int], key: str | None) -> None:
        if not key:
            return
        bucket[key] = bucket.get(key, 0) + 1
        all_class[key] = all_class.get(key, 0) + 1

    for obj in objects:
        if obj.get("error"):
            missing += 1
            continue
        fetched += 1
        bump(seed_class, obj.get("classification"))
        rc = obj.get("role_counts") or {}
        if obj.get("osm_type") == "relation":
            for role in ("outer", "inner", "main_stream", "side_stream"):
                if int(rc.get(role) or 0) > 0:
                    relations_with[role] += 1
        for mem in obj.get("members") or []:
            bump(member_class, mem.get("classification"))
            if mem.get("classification") == "mp-inner" or mem.get("role") == "inner":
                inner_members += 1
            if mem.get("role") in ("outer", "") and mem.get("osm_type") == "way":
                if not (mem.get("tags") or {}):
                    untagged_outer_ways += 1

    return {
        "seed_count": len(objects),
        "fetched": fetched,
        "missing": missing,
        "by_seed_classification": seed_class,
        "by_member_classification": member_class,
        "by_classification_seeds_and_members": all_class,
        "relations_with_role": relations_with,
        "untagged_outer_ways": untagged_outer_ways,
        "inner_members": inner_members,
        "polygon_lake": seed_class.get("polygon-lake", 0),
        "polygon_reservoir": seed_class.get("polygon-reservoir", 0),
        "polygon_river_area": seed_class.get("polygon-river-area", 0),
        "centerline_river": all_class.get("centerline-river", 0),
        "centerline_canal": all_class.get("centerline-canal", 0),
        "centerline_stream": all_class.get("centerline-stream", 0),
        "mp_outer": all_class.get("mp-outer", 0),
        "mp_inner": all_class.get("mp-inner", 0),
        "waterway_relation": seed_class.get("waterway-relation", 0),
    }


def assert_no_computed_links(payload: Any, path: str = "root") -> None:
    if isinstance(payload, dict):
        for k, v in payload.items():
            lk = str(k).lower()
            for bad in FORBIDDEN_COMPUTED_KEYS:
                if bad in lk:
                    raise AssertionError(f"forbidden computed field {k} at {path}")
            assert_no_computed_links(v, f"{path}.{k}")
    elif isinstance(payload, list):
        for i, item in enumerate(payload):
            assert_no_computed_links(item, f"{path}[{i}]")
