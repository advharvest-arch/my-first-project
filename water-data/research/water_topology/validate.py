"""Independent validation of a discovered water topology graph.

Does not trust edge.evidence blindly: node sets, edges and connector
geometry are recomputed from the OSM store. Research only — no DB/WRG.
"""

from __future__ import annotations

from collections import defaultdict, deque
from typing import Any

from shapely.geometry import LineString
from shapely.geometry.base import BaseGeometry

from .discover import (
    WaterGraph,
    edges_of,
    feature_key,
    geom_distance_m,
    parse_key,
)
from .osm_store import OsmStore
from .rings import reconstruct_relation_geometry
from .tags import is_area_water_tags


FOCUS_IDS = [
    ("relation", 399081, "Селигер seed"),
    ("relation", 1203668, "Полоновка"),
    ("way", 81753515, "Княжа area"),
    ("relation", 9617478, "Серемо"),
    ("relation", 9617480, "Глубокое r9617480"),
    ("relation", 9617479, "Мелкое"),
    ("relation", 18072605, "Княжка"),
    ("way", 1316976066, "Варварина протока"),
    ("relation", 18358803, "Святое"),
    ("way", 20542134, "Белое-южное"),
    ("way", 167688573, "canal"),
    ("relation", 399614, "Сиг"),
    ("way", 195929170, "Сиговка"),
    ("way", 30164445, "Рясивое"),
    ("relation", 1159264, "Ласцо"),
    ("way", 81323084, "Зуёвка / Ласцо connector"),
    ("relation", 17001378, "rel 17001378"),
    ("relation", 1236637, "Полонец"),
    ("way", 30196394, "Глубокое w30196394 (other)"),
]

NEARBY_FOCUS = [
    ("way", 119343953, "Садок"),
    ("way", 430378915, "w430378915"),
    ("relation", 16459681, "r16459681"),
    ("relation", 1729194, "Дивное"),
    ("relation", 6407846, "r6407846"),
]

ISLAND_FOCUS = [
    ("way", 1305535843, "island pond"),
    ("way", 1135420114, "island pond"),
    ("way", 20542134, "Белое-южное"),
    ("way", 49220130, "Чёрное"),
]


def _node_set(store: OsmStore, osm_type: str, osm_id: int) -> set[int]:
    return set(store.object_node_ids(osm_type, osm_id))


def _edge_set(store: OsmStore, osm_type: str, osm_id: int) -> set[tuple[int, int]]:
    if osm_type == "way":
        way = store.ways.get(osm_id)
        return edges_of(way.nds) if way else set()
    if osm_type == "relation":
        rel = store.relations.get(osm_id)
        if rel is None:
            return set()
        acc: set[tuple[int, int]] = set()
        for m in rel.members:
            if m.type == "way":
                way = store.ways.get(m.ref)
                if way:
                    acc |= edges_of(way.nds)
        return acc
    return set()


def _geom_for(store: OsmStore, osm_type: str, osm_id: int) -> BaseGeometry | None:
    if osm_type == "relation":
        geom, _meta = reconstruct_relation_geometry(store, osm_id)
        return geom
    if osm_type == "way":
        way = store.ways.get(osm_id)
        if way is None:
            return None
        coords = store.way_coords(way)
        if len(coords) < 2:
            return None
        closed = (len(way.nds) >= 4 and way.nds[0] == way.nds[-1]) or (
            len(coords) >= 4 and coords[0] == coords[-1]
        )
        if closed and is_area_water_tags(way.tags) and way.tags.get("waterway") is None:
            from shapely.geometry import Polygon

            ring = coords if coords[0] == coords[-1] else coords + [coords[0]]
            try:
                poly = Polygon(ring)
                if not poly.is_valid:
                    poly = poly.buffer(0)
                return poly
            except Exception:
                return LineString(coords)
        return LineString(coords)
    return None


def _label(graph: WaterGraph, key: str) -> str:
    node = graph.nodes.get(key)
    if node is None:
        return key
    if node.name:
        return f"{node.name} ({key})"
    return key


def _confirmed_adj(graph: WaterGraph) -> dict[str, list[tuple[str, Any]]]:
    adj: dict[str, list[tuple[str, Any]]] = defaultdict(list)
    for e in graph.confirmed_edges():
        adj[e.from_key].append((e.to_key, e))
        adj[e.to_key].append((e.from_key, e))
    return adj


def shortest_path(
    graph: WaterGraph, src: str, dst: str, *, types: set[str] | None = None
) -> tuple[list[str], list[Any]] | None:
    """Shortest hop path on confirmed edges. Returns (nodes, edges)."""
    if src == dst:
        return [src], []
    adj: dict[str, list[tuple[str, Any]]] = defaultdict(list)
    for e in graph.confirmed_edges():
        if types is not None and e.connection_type not in types:
            continue
        adj[e.from_key].append((e.to_key, e))
        adj[e.to_key].append((e.from_key, e))
    prev: dict[str, tuple[str, Any] | None] = {src: None}
    q = deque([src])
    while q:
        u = q.popleft()
        for v, e in adj[u]:
            if v in prev:
                continue
            prev[v] = (u, e)
            if v == dst:
                q.clear()
                break
            q.append(v)
    if dst not in prev:
        return None
    nodes = [dst]
    edges = []
    cur = dst
    while prev[cur] is not None:
        u, e = prev[cur]
        edges.append(e)
        nodes.append(u)
        cur = u
    nodes.reverse()
    edges.reverse()
    return nodes, edges


def validate_direct_edge(store: OsmStore, edge) -> dict[str, Any]:
    a_t, a_id = parse_key(edge.from_key)
    b_t, b_id = parse_key(edge.to_key)
    na, nb = _node_set(store, a_t, a_id), _node_set(store, b_t, b_id)
    ea, eb = _edge_set(store, a_t, a_id), _edge_set(store, b_t, b_id)
    shared_n = na & nb
    shared_e = ea & eb
    claimed = set(edge.evidence.get("sharedNodes") or [])
    claimed_ok = bool(claimed) and claimed <= shared_n
    valid = bool(shared_n) or bool(shared_e)
    reasons = []
    if not valid:
        reasons.append("no shared OSM node and no shared OSM edge recomputed from store")
    if edge.evidence.get("sharedNodeCount", 0) and not shared_n:
        reasons.append("evidence.sharedNodeCount disagrees with store")
    if claimed and not claimed_ok:
        reasons.append("evidence.sharedNodes are not a subset of actual shared nodes")
    if not claimed and shared_n:
        reasons.append("evidence omitted shared node ids")
    return {
        "from": edge.from_key,
        "to": edge.to_key,
        "connectionType": edge.connection_type,
        "sharedNodeCount": len(shared_n),
        "sharedEdgeCount": len(shared_e),
        "sharedNodes": sorted(shared_n)[:16],
        "sharedEdges": [list(e) for e in sorted(shared_e)[:8]],
        "claimedSharedNodes": sorted(claimed),
        "evidence": edge.evidence,
        "valid": valid and (claimed_ok or not claimed),
        "reasons": reasons,
    }


def _connector_touches_area(
    store: OsmStore,
    connector_key: str,
    area_key: str,
) -> dict[str, Any]:
    c_t, c_id = parse_key(connector_key)
    a_t, a_id = parse_key(area_key)
    c_nodes = _node_set(store, c_t, c_id)
    a_nodes = _node_set(store, a_t, a_id)
    shared = c_nodes & a_nodes
    c_geom = _geom_for(store, c_t, c_id)
    a_geom = _geom_for(store, a_t, a_id)
    dist = geom_distance_m(c_geom, a_geom) if c_geom is not None and a_geom is not None else None
    intersects = False
    if c_geom is not None and a_geom is not None:
        try:
            intersects = bool(c_geom.intersects(a_geom) or c_geom.touches(a_geom))
        except Exception:
            intersects = False
    endpoints: list[int] = []
    if c_t == "way" and c_id in store.ways:
        nds = store.ways[c_id].nds
        if nds:
            endpoints = [nds[0], nds[-1]]
    endpoint_on_area = [n for n in endpoints if n in a_nodes]
    return {
        "sharedNodeCount": len(shared),
        "sharedNodes": sorted(shared)[:12],
        "distanceM": dist,
        "intersectsGeometry": intersects,
        "endpointNodeIds": endpoints,
        "endpointOnArea": endpoint_on_area,
        "touchesByNode": bool(shared),
        "touchesByGeometry": bool(intersects or (dist is not None and dist == 0)),
    }


def validate_waterway_connector(store: OsmStore, graph: WaterGraph, edge) -> dict[str, Any]:
    connectors = edge.connectors or []
    conn_keys = []
    for c in connectors:
        if c.get("key"):
            conn_keys.append(c["key"])
        else:
            conn_keys.append(feature_key(c["osmType"], int(c["osmId"])))
    if edge.evidence.get("connector") and edge.evidence["connector"] not in conn_keys:
        conn_keys.append(edge.evidence["connector"])

    reasons = []
    if not conn_keys:
        reasons.append("WATERWAY_CONNECTOR has no connector OSM id")

    per_connector = []
    ok_any = False
    for ck in conn_keys:
        touch_a = _connector_touches_area(store, ck, edge.from_key)
        touch_b = _connector_touches_area(store, ck, edge.to_key)
        node_ok = touch_a["touchesByNode"] and touch_b["touchesByNode"]
        geom_ok = touch_a["touchesByGeometry"] and touch_b["touchesByGeometry"]
        intermediates = _areas_between_on_connector(store, graph, ck, edge.from_key, edge.to_key)
        # Proof: OSM node identity on the connector with BOTH ends.
        # Geometry is a cross-check; proximity without nodes is NOT proof.
        # A third area on the same way means this pair would skip it.
        valid_here = node_ok and not intermediates
        if not node_ok:
            reasons.append(f"{ck} does not share OSM nodes with both ends")
        if intermediates:
            reasons.append(
                f"{ck} also touches {intermediates}; A—B WATERWAY_CONNECTOR would skip them"
            )
        if node_ok and not geom_ok:
            reasons.append(
                f"{ck} shares nodes with both ends but reconstructed geometry "
                "does not touch one or both areas (reconstruction gap, not proximity join)"
            )
        if valid_here:
            ok_any = True
        per_connector.append(
            {
                "connector": ck,
                "touchA": touch_a,
                "touchB": touch_b,
                "validNodeIdentity": node_ok,
                "geometryCrossCheck": geom_ok,
                "intermediateAreasOnConnector": intermediates,
            }
        )

    suspicious = []
    for rec in per_connector:
        if rec["intermediateAreasOnConnector"]:
            suspicious.append(
                {
                    "reason": "WATERWAY_CONNECTOR skips intermediate area(s) on the same way",
                    "connector": rec["connector"],
                    "skipped": rec["intermediateAreasOnConnector"],
                }
            )
        if rec["validNodeIdentity"] and not rec["geometryCrossCheck"]:
            suspicious.append(
                {
                    "reason": "shared OSM nodes (proof) but reconstructed geometries do not touch",
                    "connector": rec["connector"],
                    "note": "node identity stands; geometry miss is a reconstruction cross-check, not proximity",
                }
            )
        ta, tb = rec["touchA"], rec["touchB"]
        # Nearby-only: geometry close but no shared nodes
        for label, t in (("A", ta), ("B", tb)):
            d = t.get("distanceM")
            if not t["touchesByNode"] and d is not None and 0 < d <= 100:
                reasons.append(
                    f"connector near {label} ({d:.1f} m) without shared OSM node — proximity is not a connection"
                )

    return {
        "from": edge.from_key,
        "to": edge.to_key,
        "connectionType": edge.connection_type,
        "connectors": conn_keys,
        "evidence": edge.evidence,
        "perConnector": per_connector,
        "valid": ok_any and not any(
            "does not share OSM nodes" in r
            or "has no connector" in r
            or "proximity is not" in r
            or "would skip them" in r
            for r in reasons
        ),
        "reasons": reasons,
        "suspicious": suspicious,
    }


def _areas_between_on_connector(
    store: OsmStore, graph: WaterGraph, connector_key: str, a_key: str, b_key: str
) -> list[str]:
    """Confirmed areas other than A/B that also share OSM nodes with the connector."""
    c_t, c_id = parse_key(connector_key)
    c_nodes = _node_set(store, c_t, c_id)
    if not c_nodes:
        return []
    skipped = []
    for node in graph.nodes.values():
        if not node.in_confirmed_component:
            continue
        if node.role not in {"area", "seed"}:
            continue
        if node.key in {a_key, b_key, connector_key}:
            continue
        t, i = parse_key(node.key)
        if c_nodes & _node_set(store, t, i):
            skipped.append(node.key)
    return sorted(set(skipped))


# Documented over-generation in PR #85 (pairwise WATERWAY_CONNECTOR clique).
PR85_SKIP_EDGES = [
    {
        "from": "r399081",
        "to": "r9617478",
        "connectionType": "WATERWAY_CONNECTOR",
        "connector": "w32487176",
        "why": (
            "PR #85 emitted Seliger—Sereymo via the Knyazha axis way 32487176. "
            "The way shares endpoint 220277673 with Seliger and endpoint 952397092 "
            "with Sereymo, so node identity is real; but area w81753515 (Княжа) "
            "shares both endpoints and occupies the whole way. The pair skipped Knyazha."
        ),
        "createdBy": "clique of all confirmed areas sharing nodes with a waterway",
        "shouldBe": (
            "no area–area WATERWAY_CONNECTOR when ≥3 areas touch the way; "
            "chain is r399081 —DIRECT_OSM— w81753515 —DIRECT_OSM— r9617478 "
            "(river w32487176 remains a vertex)"
        ),
    },
    {
        "from": "r399081",
        "to": "w81753515",
        "connectionType": "WATERWAY_CONNECTOR",
        "connector": "w32487176",
        "why": "same clique; Sereymo is a third area on the way",
        "createdBy": "clique of all confirmed areas sharing nodes with a waterway",
        "shouldBe": "DIRECT_OSM Seliger—Knyazha is sufficient; do not pair via the 3-area axis",
    },
    {
        "from": "r9617478",
        "to": "w81753515",
        "connectionType": "WATERWAY_CONNECTOR",
        "connector": "w32487176",
        "why": "same clique; Seliger is a third area on the way",
        "createdBy": "clique of all confirmed areas sharing nodes with a waterway",
        "shouldBe": "DIRECT_OSM Knyazha—Sereymo is sufficient",
    },
]


def validate_graph(graph: WaterGraph, store: OsmStore) -> dict[str, Any]:
    direct = [e for e in graph.confirmed_edges() if e.connection_type == "DIRECT_OSM"]
    connectors = [
        e for e in graph.confirmed_edges() if e.connection_type == "WATERWAY_CONNECTOR"
    ]
    direct_reports = [validate_direct_edge(store, e) for e in direct]
    connector_reports = [validate_waterway_connector(store, graph, e) for e in connectors]
    invalid_direct = [r for r in direct_reports if not r["valid"]]
    invalid_ww = [r for r in connector_reports if not r["valid"]]

    suspicious: list[dict[str, Any]] = []
    for r in connector_reports:
        for s in r.get("suspicious") or []:
            suspicious.append(
                {
                    "from": r["from"],
                    "to": r["to"],
                    "connectionType": "WATERWAY_CONNECTOR",
                    **s,
                }
            )
        # redundant shortcut: both ends also have DIRECT_OSM to the same connector
        for ck in r.get("connectors") or []:
            e_ac = graph.connected_pair(parse_key(r["from"]), parse_key(ck), confirmed=True)
            e_bc = graph.connected_pair(parse_key(r["to"]), parse_key(ck), confirmed=True)
            if e_ac and e_bc and e_ac.connection_type == "DIRECT_OSM" and e_bc.connection_type == "DIRECT_OSM":
                # Not invalid: this is the explicit A—connector—B record the caller asked to keep.
                # Flag only if the shortcut hides the connector (no connector field).
                if not r.get("connectors"):
                    suspicious.append(
                        {
                            "from": r["from"],
                            "to": r["to"],
                            "reason": "area–area shortcut without connector id",
                            "via": ck,
                        }
                    )

    # BFS shortest paths for every confirmed node
    seed = graph.seed_key
    bfs_paths = []
    missing_path = []
    for node in sorted(graph.nodes.values(), key=lambda n: (n.hops_from_seed or 0, n.key)):
        if not node.in_confirmed_component:
            continue
        sp = shortest_path(graph, seed, node.key)
        if sp is None:
            missing_path.append(node.key)
            continue
        nodes, edges = sp
        hops = []
        for i, e in enumerate(edges):
            hops.append(
                {
                    "from": nodes[i],
                    "to": nodes[i + 1],
                    "connectionType": e.connection_type,
                    "connectors": e.connectors,
                    "evidence": e.evidence,
                }
            )
        bfs_paths.append(
            {
                "node": node.key,
                "name": node.name,
                "hops": len(edges),
                "path": nodes,
                "steps": hops,
            }
        )

    # Focus objects
    def focus_row(osm_type: str, osm_id: int, label: str) -> dict[str, Any]:
        key = feature_key(osm_type, osm_id)
        node = graph.nodes.get(key)
        sp = shortest_path(graph, seed, key) if node and node.in_confirmed_component else None
        sp_direct = (
            shortest_path(graph, seed, key, types={"DIRECT_OSM"})
            if node and node.in_confirmed_component
            else None
        )
        return {
            "label": label,
            "key": key,
            "present": node is not None,
            "inConfirmedComponent": bool(node and node.in_confirmed_component),
            "hopsFromSeed": None if node is None else node.hops_from_seed,
            "role": None if node is None else node.role,
            "island": None if node is None else node.island,
            "shortestPath": None
            if sp is None
            else {
                "nodes": sp[0],
                "steps": [
                    {
                        "from": sp[0][i],
                        "to": sp[0][i + 1],
                        "connectionType": e.connection_type,
                        "connectors": e.connectors,
                        "evidence": e.evidence,
                    }
                    for i, e in enumerate(sp[1])
                ],
            },
            "shortestPathDirectOsm": None
            if sp_direct is None
            else {
                "nodes": sp_direct[0],
                "steps": [
                    {
                        "from": sp_direct[0][i],
                        "to": sp_direct[0][i + 1],
                        "connectionType": e.connection_type,
                        "connectors": e.connectors,
                        "evidence": e.evidence,
                    }
                    for i, e in enumerate(sp_direct[1])
                ],
            },
        }

    island_rows = []
    for osm_type, osm_id, label in ISLAND_FOCUS:
        node = graph.nodes.get(feature_key(osm_type, osm_id))
        rec = focus_row(osm_type, osm_id, label)
        rec["islandRecord"] = next(
            (r for r in graph.island_water if r["osmId"] == osm_id), None
        )
        if node and node.in_confirmed_component:
            island = node.island or {}
            if island.get("separateObject") or (
                not island.get("directTopologyToParent") and not island.get("hasWaterwayConnector")
            ):
                rec["invalidBfsMembership"] = True
                rec["invalidWhy"] = (
                    "island water is in confirmed BFS but has no OSM topology/connector to parent"
                )
        island_rows.append(rec)

    nearby_rows = []
    for osm_type, osm_id, label in NEARBY_FOCUS:
        rec = focus_row(osm_type, osm_id, label)
        rec["nearbyRecord"] = next((r for r in graph.nearby if r["osmId"] == osm_id), None)
        if rec["inConfirmedComponent"]:
            rec["invalidBfsMembership"] = True
            rec["invalidWhy"] = "nearby-focus object is in confirmed BFS; proximity must not admit it"
        nearby_rows.append(rec)

    polonets = focus_row("relation", 1236637, "Полонец")
    polonets["nearbyRecord"] = next((r for r in graph.nearby if r["osmId"] == 1236637), None)
    if polonets["inConfirmedComponent"]:
        polonets["invalidBfsMembership"] = True
        polonets["invalidWhy"] = "Полонец has no confirmed OSM/waterway path to seed"

    # two Glubokoe
    g1 = graph.nodes.get("r9617480")
    g2 = graph.nodes.get("w30196394")
    duplicate_name = {
        "glubokoeRelation": None
        if g1 is None
        else {
            "key": g1.key,
            "inConfirmedComponent": g1.in_confirmed_component,
            "hopsFromSeed": g1.hops_from_seed,
            "name": g1.name,
        },
        "glubokoeWay": None
        if g2 is None
        else {
            "key": g2.key,
            "inConfirmedComponent": g2.in_confirmed_component,
            "hopsFromSeed": g2.hops_from_seed,
            "name": g2.name,
        },
        "sameVertex": False,
        "bothConfirmed": bool(
            g1 and g1.in_confirmed_component and g2 and g2.in_confirmed_component
        ),
    }

    invalid_island_bfs = [r for r in island_rows if r.get("invalidBfsMembership")]
    invalid_nearby_bfs = [r for r in nearby_rows if r.get("invalidBfsMembership")]

    still_present = []
    for finding in PR85_SKIP_EDGES:
        present = False
        for e in graph.confirmed_edges():
            if e.connection_type != "WATERWAY_CONNECTOR":
                continue
            if {e.from_key, e.to_key} != {finding["from"], finding["to"]}:
                continue
            if any(
                (c.get("key") == finding["connector"])
                or (c.get("osmType") == "way" and c.get("osmId") == int(finding["connector"][1:]))
                for c in (e.connectors or [])
            ):
                present = True
                break
        still_present.append({**finding, "stillPresent": present})

    return {
        "seed": graph.seed,
        "summary": {
            **graph.summary,
            "directOsmChecked": len(direct_reports),
            "waterwayConnectorChecked": len(connector_reports),
            "invalidDirectCount": len(invalid_direct),
            "invalidWaterwayConnectorCount": len(invalid_ww),
            "suspiciousCount": len(suspicious),
            "confirmedNodesMissingPath": len(missing_path),
        },
        "invalid_direct_connections": invalid_direct,
        "invalid_waterway_connectors": invalid_ww,
        "suspicious_connections": suspicious,
        "confirmed_connections": {
            "directOsm": direct_reports,
            "waterwayConnector": connector_reports,
        },
        "confirmed_component": {
            "size": graph.summary.get("confirmedComponentSize"),
            "missingShortestPath": missing_path,
            "shortestPaths": bfs_paths,
        },
        "nearby_candidates": nearby_rows,
        "focus": [focus_row(*row) for row in FOCUS_IDS],
        "island": island_rows,
        "nearbyFocus": nearby_rows,
        "polonets": polonets,
        "duplicateName": duplicate_name,
        "invalidIslandBfs": invalid_island_bfs,
        "invalidNearbyBfs": invalid_nearby_bfs,
        "algorithmFindings": still_present,
    }


def _path_md(sp: dict[str, Any] | None) -> str:
    if not sp:
        return "_not in confirmed component / no path_"
    lines = []
    nodes = sp["nodes"]
    if not sp["steps"]:
        return f"`{nodes[0]}` (seed)"
    for step in sp["steps"]:
        conn = ""
        if step.get("connectors"):
            ids = ", ".join(
                c.get("key") or f"{c.get('osmType')}/{c.get('osmId')}" for c in step["connectors"]
            )
            conn = f" connector={ids}"
        ev = step.get("evidence") or {}
        why = []
        if ev.get("sharedNodeCount"):
            why.append(f"sharedNodes={ev['sharedNodeCount']} ids={ev.get('sharedNodes', [])[:4]}")
        if ev.get("connector"):
            why.append(f"via {ev['connector']}")
        lines.append(
            f"- `{step['from']}` → `{step['to']}` **{step['connectionType']}**{conn}  \n"
            f"  evidence: {'; '.join(why) or ev}"
        )
    return "\n".join(lines)


def validation_to_markdown(report: dict[str, Any], graph: WaterGraph) -> str:
    s = report["summary"]
    lines: list[str] = []
    lines.append("# Seliger topology graph validation")
    lines.append("")
    lines.append("Исследовательская проверка PR #85. **БД, WRG, seligerDebug не изменялись.**")
    lines.append("Evidence каждого confirmed edge пересчитан из OSM store (node id / edge id),")
    lines.append("а не принят на слово из `edge.evidence`.")
    lines.append("")
    lines.append("## 1. Summary")
    lines.append("")
    lines.append(f"- DIRECT_OSM checked: **{s['directOsmChecked']}**")
    lines.append(f"- WATERWAY_CONNECTOR checked: **{s['waterwayConnectorChecked']}**")
    lines.append(f"- INVALID_DIRECT_CONNECTIONS: **{s['invalidDirectCount']}**")
    lines.append(f"- INVALID_WATERWAY_CONNECTORS: **{s['invalidWaterwayConnectorCount']}**")
    lines.append(f"- suspicious: **{s['suspiciousCount']}**")
    lines.append(f"- confirmed component: **{s.get('confirmedComponentSize')}**")
    lines.append(f"- confirmed nodes with no shortest path: **{s['confirmedNodesMissingPath']}**")
    lines.append("")
    lines.append("## 2. Direct OSM validation")
    lines.append("")
    if s["invalidDirectCount"] == 0:
        lines.append("Все DIRECT_OSM имеют хотя бы один shared OSM node или shared OSM edge,")
        lines.append("пересчитанный из store. Claimed `sharedNodes` ⊆ фактического пересечения.")
    else:
        lines.append("Найдены INVALID_DIRECT_CONNECTIONS:")
        for r in report["invalid_direct_connections"]:
            lines.append(f"- `{r['from']}` — `{r['to']}`: {r['reasons']}")
    lines.append("")
    lines.append("Полный перечень DIRECT_OSM — в JSON (`confirmed_connections.directOsm`).")
    lines.append("")
    lines.append("## 3. Waterway connector validation")
    lines.append("")
    lines.append("| A | connector | B | nodes A | nodes B | geom A | geom B | skipped | valid |")
    lines.append("|---|---|---|---:|---:|---|---|---|---|")
    for r in report["confirmed_connections"]["waterwayConnector"]:
        for rec in r["perConnector"]:
            ta, tb = rec["touchA"], rec["touchB"]
            skipped = ",".join(rec["intermediateAreasOnConnector"]) or "—"
            lines.append(
                f"| `{r['from']}` | `{rec['connector']}` | `{r['to']}` | "
                f"{ta['sharedNodeCount']} | {tb['sharedNodeCount']} | "
                f"{ta['touchesByGeometry']} | {tb['touchesByGeometry']} | "
                f"{skipped} | {r['valid']} |"
            )
    lines.append("")
    if s["invalidWaterwayConnectorCount"] == 0:
        lines.append("INVALID_WATERWAY_CONNECTORS: **0**. Каждый connector делит OSM node и с A, и с B.")
        lines.append("Proximity без shared node не использовалась как доказательство.")
    else:
        for r in report["invalid_waterway_connectors"]:
            lines.append(f"- `{r['from']}` — `{r['to']}`: {r['reasons']}")
    lines.append("")
    lines.append("## 4. BFS validation")
    lines.append("")
    lines.append("Кратчайший путь по confirmed edges (DIRECT_OSM ∪ WATERWAY_CONNECTOR).")
    lines.append("Каждый hop имеет type + evidence. Скрытых переходов нет: если ребра нет в графе,")
    lines.append("пути нет.")
    lines.append("")
    for row in report["focus"]:
        if not row["inConfirmedComponent"]:
            continue
        lines.append(f"### `{row['key']}` {row['label']}")
        lines.append("")
        lines.append(f"hopsFromSeed (discovery) = {row['hopsFromSeed']}; "
                     f"shortest confirmed path length = "
                     f"{0 if not row['shortestPath'] else len(row['shortestPath']['steps'])}")
        lines.append("")
        lines.append(_path_md(row["shortestPath"]))
        lines.append("")
        lines.append("DIRECT_OSM-only path (connector remains a vertex, no area–area shortcut):")
        lines.append("")
        lines.append(_path_md(row.get("shortestPathDirectOsm")))
        lines.append("")
    lines.append("Полные пути всех узлов компонента — JSON `confirmed_component.shortestPaths`.")
    lines.append("")
    lines.append("## 5. Island validation")
    lines.append("")
    lines.append("| object | parent island | direct topology | connector | in BFS | ok |")
    lines.append("|---|---|---|---|---|---|")
    for r in report["island"]:
        rec = r.get("islandRecord") or {}
        parent = rec.get("parentIslandWayIds")
        direct = rec.get("directTopologyToParent")
        conn = rec.get("hasWaterwayConnector")
        ok = not r.get("invalidBfsMembership")
        lines.append(
            f"| `{r['key']}` {r['label']} | {parent} | {direct} | {conn} | "
            f"{r['inConfirmedComponent']} | {ok} |"
        )
    lines.append("")
    lines.append("Островная вода без connector/shared node **не** должна быть в confirmed BFS.")
    if report["invalidIslandBfs"]:
        lines.append("**Нарушения:**")
        for r in report["invalidIslandBfs"]:
            lines.append(f"- `{r['key']}`: {r.get('invalidWhy')}")
    else:
        lines.append("Нарушений нет.")
    lines.append("")
    lines.append("## 6. Nearby validation")
    lines.append("")
    lines.append("| object | in BFS | nearby listed | distance m | ok |")
    lines.append("|---|---|---|---:|---|")
    for r in report["nearbyFocus"]:
        nr = r.get("nearbyRecord") or {}
        lines.append(
            f"| `{r['key']}` {r['label']} | {r['inConfirmedComponent']} | "
            f"{nr.get('connectionType')} | {nr.get('distanceM')} | "
            f"{not r.get('invalidBfsMembership')} |"
        )
    lines.append("")
    if report["invalidNearbyBfs"]:
        lines.append("**Нарушения:** proximity попала в BFS.")
    else:
        lines.append("Ни один nearby-focus объект не входит в confirmed BFS.")
    lines.append("")
    lines.append("## 7. Polonets validation")
    lines.append("")
    p = report["polonets"]
    lines.append(f"- present: {p['present']}")
    lines.append(f"- inConfirmedComponent: **{p['inConfirmedComponent']}**")
    lines.append(f"- nearby: {p.get('nearbyRecord')}")
    if p.get("invalidBfsMembership"):
        lines.append(f"- INVALID: {p.get('invalidWhy')}")
    else:
        lines.append("- Полонец вне confirmed component; сохранён как nearby/external finding.")
    lines.append("")
    lines.append("## 8. Duplicate-name validation")
    lines.append("")
    d = report["duplicateName"]
    lines.append(f"- Глубокое relation `r9617480`: {d['glubokoeRelation']}")
    lines.append(f"- Глубокое way `w30196394`: {d['glubokoeWay']}")
    lines.append(f"- sameVertex: {d['sameVertex']}")
    lines.append(f"- both in confirmed component: {d['bothConfirmed']}")
    lines.append("Имена не являются ключом: объекты с одним name остаются разными вершинами.")
    lines.append("")
    lines.append("## 9. Invalid edges")
    lines.append("")
    lines.append(f"- INVALID_DIRECT_CONNECTIONS ({s['invalidDirectCount']}):")
    if not report["invalid_direct_connections"]:
        lines.append("  - *(empty, expected)*")
    else:
        for r in report["invalid_direct_connections"]:
            lines.append(f"  - `{r['from']}` — `{r['to']}`: {r['reasons']}")
    lines.append(f"- INVALID_WATERWAY_CONNECTORS ({s['invalidWaterwayConnectorCount']}):")
    if not report["invalid_waterway_connectors"]:
        lines.append("  - *(empty)*")
    else:
        for r in report["invalid_waterway_connectors"]:
            lines.append(f"  - `{r['from']}` — `{r['to']}`: {r['reasons']}")
    lines.append("")
    lines.append("## 10. Suspicious edges")
    lines.append("")
    lines.append("### PR #85 finding (documented before the fix)")
    lines.append("")
    lines.append("Алгоритм WATERWAY_CONNECTOR строил клику всех confirmed areas,")
    lines.append("делящих node с одним waterway. Way **32487176** (ось Княжи) касается")
    lines.append("трёх площадей: Селигер, Княжа `w81753515`, Серемо `r9617478`.")
    lines.append("Поэтому PR #85 создавал area–area ребро Селигер—Серемо и прятал Княжу.")
    lines.append("")
    lines.append("| from | to | connector | still present after fix |")
    lines.append("|---|---|---|---|")
    for finding in report.get("algorithmFindings") or []:
        lines.append(
            f"| `{finding['from']}` | `{finding['to']}` | `{finding['connector']}` | "
            f"**{finding['stillPresent']}** |"
        )
    lines.append("")
    for finding in report.get("algorithmFindings") or []:
        lines.append(f"- `{finding['from']}` — `{finding['to']}`: {finding['why']}")
        lines.append(f"  createdBy: {finding['createdBy']}")
        lines.append(f"  shouldBe: {finding['shouldBe']}")
    lines.append("")
    lines.append("Исправление: WATERWAY_CONNECTOR только если на connector ровно **две**")
    lines.append("confirmed area. Иначе connector остаётся вершиной, цепочка идёт через неё")
    lines.append("и через промежуточные площади по DIRECT_OSM.")
    lines.append("")
    if not report["suspicious_connections"]:
        lines.append("После исправления текущий граф не содержит skip-клик.")
    else:
        for srow in report["suspicious_connections"]:
            lines.append(
                f"- `{srow['from']}` — `{srow['to']}` via `{srow.get('connector')}`: "
                f"{srow.get('reason')}; skipped={srow.get('skipped')}"
            )
    lines.append("")
    lines.append("## 11. Final conclusion")
    lines.append("")
    ok = (
        s["invalidDirectCount"] == 0
        and s["invalidWaterwayConnectorCount"] == 0
        and not report["invalidIslandBfs"]
        and not report["invalidNearbyBfs"]
        and not p.get("invalidBfsMembership")
        and s["confirmedNodesMissingPath"] == 0
    )
    if ok:
        lines.append("Confirmed graph отвечает на вопрос «почему A связан с B» для каждого ребра:")
        lines.append("DIRECT_OSM → конкретные shared node/edge ids; WATERWAY_CONNECTOR → OSM id")
        lines.append("connector + shared nodes с обоими концами. Proximity и островная вода без")
        lines.append("connector в BFS не входят. Полонец снаружи компонента.")
    else:
        lines.append("**Есть ошибки алгоритма** — см. §9 и invalid* списки. Исправлять только")
        lines.append("после фиксации конкретного ребра и правила, которым оно было создано.")
    if report["suspicious_connections"]:
        lines.append("")
        lines.append(f"Suspicious (не invalid): {s['suspiciousCount']}.")
        lines.append("Сейчас это geometry cross-check (shared OSM node есть, shapely-полигон")
        lines.append("seed не пересекает линию connector — типично endpoint на inner ring).")
        lines.append("Это не proximity-join и не скрытый skip.")
    lines.append("")
    return "\n".join(lines)


def write_validation_outputs(
    report: dict[str, Any],
    graph: WaterGraph,
    out_dir,
    *,
    stem: str = "seliger-topology-validation",
) -> dict[str, Any]:
    import json
    from pathlib import Path

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{stem}.json"
    md_path = out_dir / f"{stem}.md"
    slim = {
        "invalid_direct_connections": report["invalid_direct_connections"],
        "invalid_waterway_connectors": report["invalid_waterway_connectors"],
        "suspicious_connections": report["suspicious_connections"],
        "confirmed_connections": report["confirmed_connections"],
        "confirmed_component": report["confirmed_component"],
        "nearby_candidates": report["nearby_candidates"],
        "summary": report["summary"],
        "focus": report["focus"],
        "island": report["island"],
        "polonets": report["polonets"],
        "duplicateName": report["duplicateName"],
        "algorithmFindings": report["algorithmFindings"],
    }
    json_path.write_text(json.dumps(slim, ensure_ascii=False, indent=2), encoding="utf-8")
    md_path.write_text(validation_to_markdown(report, graph), encoding="utf-8")
    return {"json": json_path, "md": md_path}
