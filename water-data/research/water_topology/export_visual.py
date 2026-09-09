"""Frontend-friendly GeoJSON for ?seligerTopologyDebug=1.

Reads the PR #86 discovery JSON/GeoJSON as-is. Does not re-run discovery
and does not invent connections.

DIRECT_OSM is never drawn as an A–B line: only shared OSM node markers
from edge.evidence.sharedNodes. WATERWAY_CONNECTOR is the actual connector
way geometry.
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from pyproj import Geod
from shapely.geometry import shape

from .discover import feature_key, parse_key
from .dumps import load_compact_store
from .osm_store import OsmStore

GEOD = Geod(ellps="WGS84")

# Disputed / branch objects from assignments №2–№3. Labels are display-only.
FOCUS: tuple[tuple[str, int, str], ...] = (
    ("relation", 399081, "Селигер r399081"),
    ("relation", 1203668, "Полоновка r1203668"),
    ("way", 81753515, "Княжа w81753515"),
    ("relation", 9617478, "Серемо r9617478"),
    ("relation", 9617480, "Глубокое r9617480"),
    ("way", 30196394, "Глубокое w30196394"),
    ("relation", 9617479, "Мелкое r9617479"),
    ("relation", 18072605, "Княжка r18072605"),
    ("relation", 18358803, "Святое r18358803"),
    ("way", 1316976066, "Варварина протока w1316976066"),
    ("way", 20542134, "Белое-южное w20542134"),
    ("way", 167688573, "канал w167688573"),
    ("relation", 399614, "Сиг r399614"),
    ("way", 30164445, "Рясивое w30164445"),
    ("relation", 1159264, "Ласцо r1159264"),
    ("relation", 17001378, "r17001378"),
    ("relation", 1236637, "Полонец r1236637"),
    ("way", 119343953, "Садок w119343953"),
    ("way", 1305535843, "Фомичев / w1305535843"),
    ("way", 1135420114, "w1135420114"),
    ("way", 49220130, "Чёрное w49220130"),
    ("relation", 1729194, "Дивное r1729194"),
    ("way", 430378915, "w430378915"),
    ("relation", 16459681, "r16459681"),
)


def _centroid(geom: dict[str, Any]) -> list[float] | None:
    gtype = geom.get("type")
    coords = geom.get("coordinates")
    if not coords:
        return None
    if gtype == "Point":
        return [float(coords[0]), float(coords[1])]
    if gtype == "LineString":
        mid = coords[len(coords) // 2]
        return [float(mid[0]), float(mid[1])]
    if gtype == "MultiLineString":
        line = coords[0]
        mid = line[len(line) // 2]
        return [float(mid[0]), float(mid[1])]
    if gtype == "Polygon":
        ring = coords[0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return [sum(xs) / len(xs), sum(ys) / len(ys)]
    if gtype == "MultiPolygon":
        ring = coords[0][0]
        xs = [p[0] for p in ring]
        ys = [p[1] for p in ring]
        return [sum(xs) / len(xs), sum(ys) / len(ys)]
    return None


def _measure(geom: dict[str, Any] | None) -> tuple[float | None, float | None]:
    if not geom:
        return None, None
    try:
        g = shape(geom)
        if g.is_empty:
            return None, None
        area = None
        length = None
        if g.geom_type in {"Polygon", "MultiPolygon"}:
            a, _ = GEOD.geometry_area_perimeter(g)
            area = abs(float(a))
        if g.geom_type in {"LineString", "MultiLineString"}:
            length = abs(float(GEOD.geometry_length(g)))
        return area, length
    except Exception:
        return None, None


def _ring_polygon(ring: list[list[float]]) -> dict[str, Any]:
    coords = ring if ring[0] == ring[-1] else [*ring, ring[0]]
    return {"type": "Polygon", "coordinates": [coords]}


def _feature(geom: dict[str, Any], *, layer: str, **props: Any) -> dict[str, Any]:
    return {"type": "Feature", "geometry": geom, "properties": {"layer": layer, **props}}


def _load_json(path: Path) -> Any:
    return __import__("json").loads(path.read_text(encoding="utf-8"))


def _way_geom(store: OsmStore, way_id: int) -> dict[str, Any] | None:
    way = store.ways.get(way_id)
    if way is None:
        return None
    coords = [[lon, lat] for lon, lat in store.way_coords(way)]
    if len(coords) < 2:
        return None
    return {"type": "LineString", "coordinates": coords}


def _index_geojson(geo: dict[str, Any]) -> dict[str, dict[str, Any]]:
    by_key: dict[str, dict[str, Any]] = {}
    for feat in geo.get("features") or []:
        props = feat.get("properties") or {}
        key = props.get("key")
        if not key:
            osm_type = props.get("osmType")
            osm_id = props.get("osmId")
            if osm_type and osm_id is not None:
                key = feature_key(str(osm_type), int(osm_id))
        if key:
            by_key[str(key)] = feat
    return by_key


def _status_of(
    *,
    osm_id: int,
    in_confirmed: bool,
    island_ids: set[int],
    nearby_ids: set[int],
) -> str:
    if in_confirmed:
        return "confirmed"
    if osm_id in island_ids:
        return "island-water"
    if osm_id in nearby_ids:
        return "nearby"
    return "other"


def _water_props(
    node: dict[str, Any] | None,
    *,
    osm_type: str | None,
    osm_id: int,
    extra: dict[str, Any] | None = None,
    island_ids: set[int],
    nearby_ids: set[int],
    geom: dict[str, Any] | None = None,
) -> dict[str, Any]:
    node = node or {}
    tags = node.get("tags") or (extra or {}).get("tags") or {}
    island = node.get("island") or {}
    in_confirmed = bool(node.get("inConfirmedComponent"))
    area_m2, length_m = _measure(node.get("geometry") or geom)
    parent_ways = island.get("parentIslandWayIds") or []
    return {
        "name": node.get("name") or (extra or {}).get("name") or "",
        "osm_type": node.get("osmType") or osm_type,
        "osm_id": int(node.get("osmId") or osm_id),
        "key": node.get("key") or (
            feature_key(str(osm_type), int(osm_id)) if osm_type else None
        ),
        "tags": tags,
        "area_m2": area_m2,
        "length_m": length_m,
        "relation_membership": node.get("relationMembership") or [],
        "status": _status_of(
            osm_id=int(node.get("osmId") or osm_id),
            in_confirmed=in_confirmed,
            island_ids=island_ids,
            nearby_ids=nearby_ids,
        ),
        "bfs_hops": node.get("hopsFromSeed"),
        "parent_island_way_ids": parent_ways,
        "island": bool(island),
        "role": node.get("role") or (extra or {}).get("role"),
        "in_confirmed_component": in_confirmed,
    }


def build_visual_geojson(
    *,
    discovery_json: dict[str, Any],
    discovery_geojson: dict[str, Any],
    store: OsmStore,
) -> dict[str, Any]:
    features: list[dict[str, Any]] = []
    geo_by_key = _index_geojson(discovery_geojson)
    nodes_by_key = {n["key"]: n for n in discovery_json.get("nodes") or [] if n.get("key")}
    nearby_ids = {
        int(row["osmId"])
        for row in discovery_json.get("nearby") or []
        if row.get("osmId") is not None
    }
    island_ids = {
        int(row["osmId"])
        for row in discovery_json.get("islandWater") or []
        if row.get("osmId") is not None
    }
    confirmed_ids = {
        int(n["osmId"])
        for n in discovery_json.get("nodes") or []
        if n.get("inConfirmedComponent")
    }

    seed_count = 0
    inner_count = 0
    skipped_fake_direct = 0
    emitted_water: set[str] = set()

    for feat in discovery_geojson.get("features") or []:
        props = feat.get("properties") or {}
        layer = props.get("layer")
        geom = feat.get("geometry") or {}
        if layer == "confirmed-connection":
            # PR #86 research GeoJSON draws centroid–centroid lines. Do not
            # copy them: DIRECT_OSM is shared-node identity, not a drawn edge.
            skipped_fake_direct += 1
            continue
        if layer == "connector-way":
            continue

        osm_id = int(props["osmId"]) if props.get("osmId") is not None else 0
        osm_type = props.get("osmType")
        key = props.get("key") or (
            feature_key(str(osm_type), osm_id) if osm_type and osm_id else ""
        )
        node = nodes_by_key.get(key)
        common = _water_props(
            node,
            osm_type=osm_type,
            osm_id=osm_id,
            extra=props,
            island_ids=island_ids,
            nearby_ids=nearby_ids,
            geom=geom,
        )

        if layer == "water-area" and geom.get("type") == "Polygon":
            seed_count += 1
            part = props.get("partIndex")
            seed_props = {
                **common,
                "name": common["name"] or "Селигер",
                "status": "confirmed",
                "bfs_hops": 0,
                "in_confirmed_component": True,
            }
            features.append(
                _feature(
                    geom,
                    layer="seed-outer",
                    seed_part=part,
                    **seed_props,
                )
            )
            rings = geom.get("coordinates") or []
            for hole in rings[1:]:
                inner_count += 1
                features.append(
                    _feature(
                        _ring_polygon(hole),
                        layer="osm-contour-inner",
                        seed_part=part,
                        inner_index=inner_count,
                        name="",
                        osm_type="relation",
                        osm_id=399081,
                        key="r399081",
                        status="inner-ring",
                        relation_membership=[{"relation": 399081, "role": "inner"}],
                    )
                )
            outer = rings[0] if rings else None
            if outer:
                features.append(
                    _feature(
                        {"type": "LineString", "coordinates": outer},
                        layer="osm-contour-outer",
                        seed_part=part,
                        name=common["name"] or "Селигер",
                        osm_type="relation",
                        osm_id=399081,
                        key="r399081",
                        status="confirmed",
                    )
                )
            continue

        if layer == "water-feature":
            viz = "confirmed-feature"
            features.append(_feature(geom, layer=viz, **common))
            if key:
                emitted_water.add(key)
            continue

        if layer == "waterway":
            viz = (
                "nearby-candidate"
                if osm_id in nearby_ids
                else "confirmed-waterway"
                if osm_id in confirmed_ids
                else "waterway"
            )
            features.append(_feature(geom, layer=viz, **common))
            if key:
                emitted_water.add(key)
            continue

        if layer == "island-water":
            if key in emitted_water:
                continue
            features.append(_feature(geom, layer="island-water", **common))
            if key:
                emitted_water.add(key)
            continue

        if layer == "nearby-candidate":
            if key in emitted_water:
                continue
            features.append(_feature(geom, layer="nearby-candidate", **common))
            if key:
                emitted_water.add(key)
            continue

        if layer == "portage-candidate":
            features.append(
                _feature(
                    geom,
                    layer="portage-candidate",
                    connection_type=props.get("connectionType") or "PORTAGE_CANDIDATE",
                    from_key=props.get("from"),
                    to_key=props.get("to"),
                    evidence=props.get("evidence") or {},
                    status=props.get("status") or "candidate",
                    name=props.get("name") or "",
                )
            )
            continue

        if layer == "uncertain-connection":
            features.append(
                _feature(
                    geom,
                    layer="uncertain-connection",
                    connection_type=props.get("connectionType") or "UNCERTAIN",
                    from_key=props.get("from"),
                    to_key=props.get("to"),
                    evidence=props.get("evidence") or {},
                    status=props.get("status") or "candidate",
                    name=props.get("name") or "",
                )
            )

    def _endpoint_name(key: str) -> str:
        node = nodes_by_key.get(key) or {}
        name = node.get("name")
        return f"{name} ({key})" if name else key

    def _shared_ids(evidence: dict[str, Any], *keys: str) -> list[int]:
        out: list[int] = []
        for k in keys:
            for item in evidence.get(k) or []:
                try:
                    out.append(int(item))
                except (TypeError, ValueError):
                    continue
        return out

    connector_count = 0
    for edge in discovery_json.get("edges") or []:
        if edge.get("status") != "confirmed":
            continue
        if edge.get("connectionType") != "WATERWAY_CONNECTOR":
            continue
        connectors = edge.get("connectors") or []
        connector_id = int(connectors[0]["osmId"]) if connectors else 0
        connector_key = (
            connectors[0].get("key")
            if connectors
            else (edge.get("evidence") or {}).get("connector")
        )
        geom = None
        src = geo_by_key.get(str(connector_key or ""))
        if src and src.get("geometry"):
            geom = src["geometry"]
        elif connector_id:
            geom = _way_geom(store, connector_id)
        if geom is None:
            continue
        from_key = edge.get("from")
        to_key = edge.get("to")
        evidence = edge.get("evidence") or {}
        connector_count += 1
        features.append(
            _feature(
                geom,
                layer="waterway-connector",
                connection_type="WATERWAY_CONNECTOR",
                from_key=from_key,
                to_key=to_key,
                from_name=_endpoint_name(from_key),
                to_name=_endpoint_name(to_key),
                connector_osm_id=connector_id,
                connector_key=connector_key,
                shared_node_ids=_shared_ids(
                    evidence, "sharedNodesWithFrom", "sharedNodesWithTo", "sharedNodes"
                ),
                shared_edge_ids=_shared_ids(evidence, "sharedEdges"),
                evidence=evidence,
                status="confirmed",
                name=f"WATERWAY_CONNECTOR w{connector_id}",
            )
        )

    node_incidents: dict[int, list[dict[str, Any]]] = defaultdict(list)
    for edge in discovery_json.get("edges") or []:
        if edge.get("status") != "confirmed":
            continue
        if edge.get("connectionType") != "DIRECT_OSM":
            continue
        evidence = edge.get("evidence") or {}
        payload = {
            "from_key": edge.get("from"),
            "to_key": edge.get("to"),
            "from_name": _endpoint_name(edge.get("from")),
            "to_name": _endpoint_name(edge.get("to")),
            "shared_node_ids": _shared_ids(evidence, "sharedNodes"),
            "shared_edge_ids": _shared_ids(evidence, "sharedEdges"),
            "evidence": evidence,
            "status": "confirmed",
            "connection_type": "DIRECT_OSM",
        }
        for nid in payload["shared_node_ids"]:
            node_incidents[nid].append(payload)

    missing_shared_nodes = 0
    for nid, incidents in node_incidents.items():
        pt = store.nodes.get(nid)
        if pt is None:
            missing_shared_nodes += 1
            continue
        first = incidents[0]
        features.append(
            _feature(
                {"type": "Point", "coordinates": [pt[0], pt[1]]},
                layer="direct-osm-node",
                connection_type="DIRECT_OSM",
                osm_id=nid,
                osm_type="node",
                name=f"shared OSM node {nid}",
                shared_node_ids=[nid],
                shared_edge_ids=first.get("shared_edge_ids") or [],
                connector_osm_id=None,
                from_key=first["from_key"],
                to_key=first["to_key"],
                from_name=first["from_name"],
                to_name=first["to_name"],
                evidence=first["evidence"],
                status="confirmed",
                incident_count=len(incidents),
                incidents=incidents[:12],
            )
        )

    placed_focus: list[str] = []
    missing_focus: list[str] = []
    for osm_type, osm_id, label in FOCUS:
        key = feature_key(osm_type, osm_id)
        src = geo_by_key.get(key)
        geom = src.get("geometry") if src else None
        if geom is None and osm_type == "way":
            geom = _way_geom(store, osm_id)
        if geom is None:
            node = nodes_by_key.get(key)
            if node and node.get("geometry"):
                geom = node["geometry"]
        if geom is None:
            missing_focus.append(key)
            continue
        pt = _centroid(geom)
        if pt is None:
            missing_focus.append(key)
            continue
        node = nodes_by_key.get(key) or {}
        features.append(
            _feature(
                {"type": "Point", "coordinates": pt},
                layer="focus-label",
                osm_id=osm_id,
                osm_type=osm_type,
                key=key,
                name=label if label else node.get("name") or key,
                status=_status_of(
                    osm_id=osm_id,
                    in_confirmed=bool(node.get("inConfirmedComponent"))
                    or key == discovery_json.get("seed", {}).get("key"),
                    island_ids=island_ids,
                    nearby_ids=nearby_ids,
                ),
                bfs_hops=0 if key == discovery_json.get("seed", {}).get("key") else node.get("hopsFromSeed"),
                parent_island_way_ids=(node.get("island") or {}).get("parentIslandWayIds") or [],
            )
        )
        placed_focus.append(key)

    seed = discovery_json.get("seed") or {}
    summary = discovery_json.get("summary") or {}
    return {
        "type": "FeatureCollection",
        "name": "seliger-topology-debug",
        "properties": {
            "source": "PR #86 seliger-topology-discovery.json/.geojson (no rediscovery)",
            "seed_osm_id": seed.get("osmId") or 399081,
            "seed_outers": seed_count,
            "inner_polygons": inner_count,
            "confirmed_features": len(confirmed_ids),
            "confirmed_edges": summary.get("confirmedConnectionCount"),
            "waterway_connector_features": connector_count,
            "skipped_centroid_connection_lines": skipped_fake_direct,
            "missing_shared_node_coords": missing_shared_nodes,
            "focus_labels_placed": placed_focus,
            "focus_labels_missing": missing_focus,
            "summary": {
                "confirmedComponentSize": summary.get("confirmedComponentSize"),
                "directOsmCount": summary.get("directOsmCount"),
                "waterwayConnectorCount": summary.get("waterwayConnectorCount"),
            },
        },
        "features": features,
    }


def write_visual_geojson(
    *,
    discovery_json_path: Path,
    discovery_geojson_path: Path,
    store_path: Path,
    out_path: Path,
) -> dict[str, Any]:
    store = load_compact_store(store_path)
    collection = build_visual_geojson(
        discovery_json=_load_json(discovery_json_path),
        discovery_geojson=_load_json(discovery_geojson_path),
        store=store,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    import json

    out_path.write_text(
        json.dumps(collection, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    return collection.get("properties") or {}
