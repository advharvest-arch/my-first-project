"""Build a production-independent WaterFeature graph from OSM evidence.

Connectivity is determined strictly from real OSM topology facts:
  - SHARED_NODE        shared OSM node IDs on feature boundaries
  - SHARED_WAY         shared OSM member way IDs between relations
  - RELATION_ROLE      outer/inner multipolygon roles in OSM relations
  - ENDPOINT_ON_POLYGON linear waterway endpoint node on polygon boundary

Proximity is never a connection. Names and object IDs are never hardcoded.
Intermediate water features are never skipped (e.g. Seliger — Knyazha — Seremo).
Deterministic output.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .osm_store import OsmStore
from .tags import feature_role, is_area_water_tags, is_open_connector_tags

SHARED_NODE = "SHARED_NODE"
SHARED_WAY = "SHARED_WAY"
RELATION_ROLE = "RELATION_ROLE"
ENDPOINT_ON_POLYGON = "ENDPOINT_ON_POLYGON"
# Alias kept for backwards-compatible imports in research tests.
WATERWAY_CONNECTOR = ENDPOINT_ON_POLYGON

ALLOWED_CONNECTION_TYPES = (
    SHARED_NODE,
    SHARED_WAY,
    RELATION_ROLE,
    ENDPOINT_ON_POLYGON,
)
CONFIRMED = set(ALLOWED_CONNECTION_TYPES)


def parse_seed(seed: Any) -> tuple[str, int]:
    if isinstance(seed, (tuple, list)) and len(seed) == 2:
        return str(seed[0]), int(seed[1])
    if isinstance(seed, dict):
        return str(seed["osm_type"]), int(seed["osm_id"])
    if isinstance(seed, str):
        raw = seed.strip().replace(" ", "")
        if "/" in raw:
            t, i = raw.split("/", 1)
            return t, int(i)
        if raw and raw[0] in "rwn" and raw[1:].isdigit():
            return {"r": "relation", "w": "way", "n": "node"}[raw[0]], int(raw[1:])
    raise ValueError(f"unsupported seed: {seed!r}")


def feature_key(osm_type: str, osm_id: int) -> str:
    return {"relation": "r", "way": "w", "node": "n"}[osm_type] + str(osm_id)


def _pair_key(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def _is_mp_boundary_way(store: OsmStore, way_id: int) -> bool:
    way = store.ways.get(way_id)
    if way is None:
        return False
    if feature_role(way.tags) in {"area", "waterway"}:
        return False
    for mem in store.memberships_of("way", way_id):
        rel = store.relations.get(mem["relation"])
        if rel is None:
            continue
        if (is_area_water_tags(rel.tags) or rel.tags.get("type") == "multipolygon") and mem[
            "role"
        ] in ("outer", "inner", ""):
            return True
    return False


def _is_vertex(store: OsmStore, osm_type: str, osm_id: int, *, seed: tuple[str, int]) -> bool:
    if (osm_type, osm_id) == seed:
        return True
    if osm_type == "relation":
        rel = store.relations.get(osm_id)
        if rel is None:
            return False
        role = feature_role(rel.tags)
        return role in {"area", "waterway"}
    if osm_type == "way":
        if _is_mp_boundary_way(store, osm_id):
            return False
        way = store.ways.get(osm_id)
        if way is None:
            return False
        return feature_role(way.tags) == "area"
    return False


def _relation_member_ways_by_role(
    store: OsmStore, osm_id: int, *, relation_role: str
) -> dict[int, str]:
    rel = store.relations.get(osm_id)
    if rel is None:
        return {}
    allowed_roles = (
        {"outer", "inner", ""}
        if relation_role == "area"
        else {"main_stream", "side_stream", ""}
    )
    out: dict[int, str] = {}
    for m in rel.members:
        if m.type != "way":
            continue
        r = m.role or ("outer" if relation_role == "area" else "main_stream")
        if (m.role or "") in allowed_roles:
            out[m.ref] = r
    return out


def _relation_nodes_from_ways(store: OsmStore, way_roles: dict[int, str]) -> set[int]:
    nodes: set[int] = set()
    for wid in way_roles:
        way = store.ways.get(wid)
        if way:
            nodes.update(way.nds)
    return nodes


@dataclass
class GraphEdge:
    from_key: str
    to_key: str
    connection_type: str
    evidence: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_key,
            "to": self.to_key,
            "connectionType": self.connection_type,
            "status": "confirmed",
            "evidence": self.evidence,
        }


@dataclass
class GraphNode:
    key: str
    osm_type: str
    osm_id: int
    tags: dict[str, str]
    hops_from_seed: int
    role: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "osmType": self.osm_type,
            "osmId": self.osm_id,
            "tags": self.tags,
            "role": self.role,
            "hopsFromSeed": self.hops_from_seed,
            "inConfirmedComponent": True,
        }


@dataclass
class WaterFeatureGraph:
    seed_key: str
    nodes: dict[str, GraphNode] = field(default_factory=dict)
    edges: list[GraphEdge] = field(default_factory=list)
    branches: list[dict[str, Any]] = field(default_factory=list)

    def node(self, osm_type: str, osm_id: int) -> GraphNode | None:
        return self.nodes.get(feature_key(osm_type, osm_id))

    def has_node(self, osm_type: str, osm_id: int) -> bool:
        return feature_key(osm_type, osm_id) in self.nodes

    def connected_pair(
        self,
        a: tuple[str, int],
        b: tuple[str, int],
        *,
        connection_type: str | None = None,
    ) -> GraphEdge | None:
        ka, kb = feature_key(*a), feature_key(*b)
        want = {ka, kb}
        for e in self.edges:
            if {e.from_key, e.to_key} == want:
                if connection_type is None or e.connection_type == connection_type:
                    return e
        return None

    def to_dict(self) -> dict[str, Any]:
        by_type: dict[str, int] = defaultdict(int)
        for e in self.edges:
            by_type[e.connection_type] += 1
        return {
            "seed": self.seed_key,
            "nodes": [n.to_dict() for n in sorted(self.nodes.values(), key=lambda n: n.key)],
            "edges": [e.to_dict() for e in self.edges],
            "branches": self.branches,
            "summary": {
                "nodeCount": len(self.nodes),
                "edgeCount": len(self.edges),
                "edgeTypes": sorted({e.connection_type for e in self.edges}),
                "edgeCountsByType": dict(sorted(by_type.items())),
            },
        }


def build_water_graph(seed: Any, store: OsmStore) -> WaterFeatureGraph:
    seed_type, seed_id = parse_seed(seed)
    seed_key = feature_key(seed_type, seed_id)
    seed_t = (seed_type, seed_id)

    vertices: dict[str, dict[str, Any]] = {}
    for rid, rel in sorted(store.relations.items()):
        if _is_vertex(store, "relation", rid, seed=seed_t):
            role = feature_role(rel.tags) or "area"
            way_roles = _relation_member_ways_by_role(store, rid, relation_role=role)
            nodes = _relation_nodes_from_ways(store, way_roles)
            if not nodes:
                nodes = set(store.object_node_ids("relation", rid))
            vertices[feature_key("relation", rid)] = {
                "osm_type": "relation",
                "osm_id": rid,
                "tags": dict(rel.tags),
                "role": role,
                "nodes": nodes,
                "ways": set(way_roles),
                "way_roles": way_roles,
            }
    for wid, way in sorted(store.ways.items()):
        if _is_vertex(store, "way", wid, seed=seed_t):
            vertices[feature_key("way", wid)] = {
                "osm_type": "way",
                "osm_id": wid,
                "tags": dict(way.tags),
                "role": feature_role(way.tags) or "area",
                "nodes": set(way.nds),
                "ways": {wid},
                "way_roles": {wid: "outer"},
            }
    if seed_key not in vertices:
        raise KeyError(f"seed {seed_type}/{seed_id} is not a water feature in the store")

    node_index: dict[int, set[str]] = defaultdict(set)
    node_way_role: dict[tuple[str, int], tuple[int, str]] = {}
    for key, obj in vertices.items():
        for nid in obj["nodes"]:
            node_index[nid].add(key)
        for wid, r in sorted(obj["way_roles"].items()):
            way = store.ways.get(wid)
            if not way:
                continue
            for nid in way.nds:
                if (key, nid) not in node_way_role:
                    node_way_role[(key, nid)] = (wid, r)

    raw_edges: dict[tuple[str, str, str], GraphEdge] = {}

    def add_edge(a: str, b: str, kind: str, evidence: dict[str, Any]) -> None:
        if a == b:
            return
        if kind not in CONFIRMED:
            raise ValueError(f"disallowed connection type: {kind}")
        if "osmId" not in evidence or not isinstance(evidence["osmId"], int):
            raise ValueError(f"edge {kind} missing integer osmId evidence")
        lo, hi = _pair_key(a, b)
        k = (lo, hi, kind)
        if k in raw_edges:
            return
        raw_edges[k] = GraphEdge(
            from_key=lo,
            to_key=hi,
            connection_type=kind,
            evidence=evidence,
        )

    area_set = {k for k, o in vertices.items() if o["role"] == "area" or k == seed_key}

    # 1. SHARED_NODE and 2. SHARED_WAY (+ 3. RELATION_ROLE on shared MP contour ways)
    keys = sorted(vertices)
    for i, a in enumerate(keys):
        oa = vertices[a]
        for b in keys[i + 1 :]:
            ob = vertices[b]
            shared_n = oa["nodes"] & ob["nodes"]
            if shared_n:
                # Do not allow a waterway relation to create a direct shortcut across
                # an intermediate polygon at a node shared by two polygons.
                if oa["role"] != ob["role"]:
                    valid_n = [
                        n
                        for n in sorted(shared_n)
                        if len(node_index[n] & area_set) <= 1
                    ]
                else:
                    valid_n = sorted(shared_n)
                if valid_n:
                    sample = valid_n[:12]
                    add_edge(
                        a,
                        b,
                        SHARED_NODE,
                        {
                            "osmId": sample[0],
                            "osmType": "node",
                            "sharedNodeIds": sample,
                            "sharedNodeCount": len(valid_n),
                        },
                    )
            shared_w = oa["ways"] & ob["ways"]
            if shared_w and oa["osm_type"] == "relation" and ob["osm_type"] == "relation":
                wid = min(shared_w)
                add_edge(
                    a,
                    b,
                    SHARED_WAY,
                    {
                        "osmId": wid,
                        "osmType": "way",
                        "sharedWayIds": sorted(shared_w)[:12],
                    },
                )
                role_a = oa["way_roles"].get(wid, "outer")
                role_b = ob["way_roles"].get(wid, "outer")
                if role_a in ("outer", "inner") and role_b in ("outer", "inner"):
                    add_edge(
                        a,
                        b,
                        RELATION_ROLE,
                        {
                            "osmId": wid,
                            "osmType": "way",
                            "role": role_a,
                            "peerRole": role_b,
                            "sharedWayIds": sorted(shared_w)[:12],
                        },
                    )

    # 3. RELATION_ROLE: direct member feature in a multipolygon / waterway relation
    for key, obj in vertices.items():
        if obj["osm_type"] != "relation":
            continue
        rel = store.relations[obj["osm_id"]]
        for mem in rel.members:
            child = feature_key(mem.type, mem.ref)
            if child in vertices:
                add_edge(
                    key,
                    child,
                    RELATION_ROLE,
                    {
                        "osmId": rel.osm_id,
                        "osmType": "relation",
                        "memberId": mem.ref,
                        "memberType": mem.type,
                        "role": mem.role or "outer",
                    },
                )

    # 4. ENDPOINT_ON_POLYGON: linear waterway endpoints on polygon boundaries
    for wid, way in sorted(store.ways.items()):
        if not is_open_connector_tags(way.tags) or feature_role(way.tags) != "waterway":
            continue
        if feature_key("way", wid) in vertices:
            continue
        if _is_mp_boundary_way(store, wid):
            continue
        nds = way.nds
        if len(nds) < 2:
            continue

        # 4a. Open waterway connecting two distinct water polygons without skipping intermediates
        touched = {k for nid in nds for k in node_index[nid] if k in area_set}
        end_nodes = (nds[0], nds[-1])
        end_touched = {k for nid in end_nodes for k in node_index[nid] if k in area_set}
        if len(touched) == 2 and end_touched:
            a, b = sorted(touched)
            na = set(nds) & vertices[a]["nodes"]
            nb = set(nds) & vertices[b]["nodes"]
            # Reject ways that only touch a single shared junction node between A and B
            if na and nb and not (na <= nb or nb <= na):
                end_a = [n for n in end_nodes if n in vertices[a]["nodes"]]
                end_b = [n for n in end_nodes if n in vertices[b]["nodes"]]
                ev_node = (end_a or end_b or sorted(na))[0]
                ev: dict[str, Any] = {
                    "osmId": wid,
                    "osmType": "way",
                    "nodeId": ev_node,
                    "startNodeId": nds[0],
                    "endNodeId": nds[-1],
                    "areaKeys": [a, b],
                }
                add_edge(a, b, ENDPOINT_ON_POLYGON, ev)
                # Record RELATION_ROLE when the endpoint lands on an inner/outer MP ring
                for ak, other_k, end_list in ((a, b, end_a), (b, a, end_b)):
                    if vertices[ak]["osm_type"] == "relation" and end_list:
                        mp_wid, mp_role = node_way_role.get((ak, end_list[0]), (0, ""))
                        if mp_wid and mp_role == "inner":
                            add_edge(
                                ak,
                                other_k,
                                RELATION_ROLE,
                                {
                                    "osmId": mp_wid,
                                    "osmType": "way",
                                    "relationId": vertices[ak]["osm_id"],
                                    "role": mp_role,
                                    "connectorWayId": wid,
                                    "nodeId": end_list[0],
                                },
                            )

        # 4b. Waterway relation whose member way endpoint lies on a polygon boundary
        parents = store.memberships_of("way", wid)
        ww_rels = [
            (feature_key("relation", m["relation"]), m["role"] or "main_stream")
            for m in parents
            if feature_key("relation", m["relation"]) in vertices
            and vertices[feature_key("relation", m["relation"])]["role"] == "waterway"
        ]
        for nid in end_nodes:
            polygon_hits = [ak for ak in sorted(node_index[nid]) if ak in area_set]
            # Do not attach across an ambiguous junction shared by multiple polygons
            if len(polygon_hits) != 1:
                continue
            ak = polygon_hits[0]
            for rk, mrole in ww_rels:
                if rk == ak:
                    continue
                mp_wid, mp_role = node_way_role.get((ak, nid), (0, ""))
                ev_rel: dict[str, Any] = {
                    "osmId": wid,
                    "osmType": "way",
                    "nodeId": nid,
                    "role": mrole,
                }
                if mp_wid:
                    ev_rel["polygonWayId"] = mp_wid
                    ev_rel["polygonRole"] = mp_role
                add_edge(rk, ak, ENDPOINT_ON_POLYGON, ev_rel)

    adj: dict[str, set[str]] = defaultdict(set)
    for e in raw_edges.values():
        adj[e.from_key].add(e.to_key)
        adj[e.to_key].add(e.from_key)

    dist = {seed_key: 0}
    bfs_parent: dict[str, str | None] = {seed_key: None}
    q: deque[str] = deque([seed_key])
    while q:
        u = q.popleft()
        for v in sorted(
            adj[u],
            key=lambda k: (0 if vertices[k]["role"] == "area" else 1, k),
        ):
            if v not in dist:
                dist[v] = dist[u] + 1
                bfs_parent[v] = u
                q.append(v)

    def path_of(key: str) -> list[str]:
        chain: list[str] = []
        cur: str | None = key
        seen: set[str] = set()
        while cur is not None and cur not in seen:
            chain.append(cur)
            seen.add(cur)
            cur = bfs_parent.get(cur)
        return list(reversed(chain))

    branches: list[dict[str, Any]] = []
    leaves = [
        k
        for k in dist
        if k != seed_key
        and not any(bfs_parent.get(c) == k for c in dist)
    ]
    for leaf in sorted(leaves, key=lambda k: (dist[k], k)):
        chain = path_of(leaf)
        branches.append(
            {
                "leaf": leaf,
                "hops": dist[leaf],
                "path": chain,
                "names": [vertices[k]["tags"].get("name") for k in chain],
            }
        )

    graph = WaterFeatureGraph(seed_key=seed_key, branches=branches)
    for key in sorted(dist):
        obj = vertices[key]
        graph.nodes[key] = GraphNode(
            key=key,
            osm_type=obj["osm_type"],
            osm_id=obj["osm_id"],
            tags=obj["tags"],
            hops_from_seed=dist[key],
            role=obj["role"],
        )
    for e in sorted(raw_edges.values(), key=lambda x: (x.connection_type, x.from_key, x.to_key)):
        if e.from_key in dist and e.to_key in dist:
            graph.edges.append(e)
    return graph


def main(argv: list[str] | None = None) -> int:
    from .dumps import load_compact_store
    from .export import update_discovery_outputs

    default_store = (
        Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "seliger_store.json.gz"
    )
    default_docs = Path(__file__).resolve().parents[2] / "docs"

    p = argparse.ArgumentParser(description="Build WaterFeature graph (OSM evidence only).")
    p.add_argument("--seed", default="relation/399081")
    p.add_argument("--store", default=str(default_store))
    p.add_argument("--out", help="Optional path to write standalone WaterFeatureGraph JSON")
    p.add_argument(
        "--out-dir",
        default=str(default_docs),
        help="Directory to update seliger-topology-discovery.{md,json,geojson}",
    )
    p.add_argument(
        "--no-update-docs",
        action="store_true",
        help="Skip updating seliger-topology-discovery.{md,json,geojson}",
    )
    args = p.parse_args(argv)

    store = load_compact_store(Path(args.store))
    graph = build_water_graph(args.seed, store)
    payload = graph.to_dict()
    if args.out:
        Path(args.out).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    if not args.no_update_docs and args.out_dir:
        update_discovery_outputs(
            graph,
            Path(args.out_dir),
            store=store,
        )
    print(json.dumps(payload["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if __package__ is None or __package__ == "":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from water_topology.build_water_graph import main as _main

        raise SystemExit(_main())
    raise SystemExit(main())
