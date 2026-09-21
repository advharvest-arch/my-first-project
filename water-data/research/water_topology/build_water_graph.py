"""Build a production-independent WaterFeature graph from OSM evidence.

Vertices are water areas and waterway relations. Open OSM ways are
topology evidence only (not routing vertices). Proximity is never an edge.
Names are never a join key. Deterministic output.
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
WATERWAY_CONNECTOR = "WATERWAY_CONNECTOR"
CONFIRMED = {SHARED_NODE, SHARED_WAY, RELATION_ROLE, ENDPOINT_ON_POLYGON, WATERWAY_CONNECTOR}


def parse_seed(seed: Any) -> tuple[str, int]:
    if isinstance(seed, (tuple, list)) and len(seed) == 2:
        return str(seed[0]), int(seed[1])
    if isinstance(seed, str):
        raw = seed.strip().replace(" ", "")
        if "/" in raw:
            t, i = raw.split("/", 1)
            return t, int(i)
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


def _member_way_ids(store: OsmStore, osm_id: int) -> set[int]:
    rel = store.relations.get(osm_id)
    if rel is None:
        return set()
    return {m.ref for m in rel.members if m.type == "way"}


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

    def node(self, osm_type: str, osm_id: int) -> GraphNode | None:
        return self.nodes.get(feature_key(osm_type, osm_id))

    def has_node(self, osm_type: str, osm_id: int) -> bool:
        return feature_key(osm_type, osm_id) in self.nodes

    def connected_pair(self, a: tuple[str, int], b: tuple[str, int]) -> GraphEdge | None:
        ka, kb = feature_key(*a), feature_key(*b)
        want = {ka, kb}
        for e in self.edges:
            if {e.from_key, e.to_key} == want:
                return e
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "seed": self.seed_key,
            "nodes": [n.to_dict() for n in sorted(self.nodes.values(), key=lambda n: n.key)],
            "edges": [e.to_dict() for e in self.edges],
            "summary": {
                "nodeCount": len(self.nodes),
                "edgeCount": len(self.edges),
                "edgeTypes": sorted({e.connection_type for e in self.edges}),
            },
        }


def build_water_graph(seed: Any, store: OsmStore) -> WaterFeatureGraph:
    seed_type, seed_id = parse_seed(seed)
    seed_key = feature_key(seed_type, seed_id)
    seed_t = (seed_type, seed_id)

    vertices: dict[str, dict[str, Any]] = {}
    for rid, rel in store.relations.items():
        if _is_vertex(store, "relation", rid, seed=seed_t):
            vertices[feature_key("relation", rid)] = {
                "osm_type": "relation",
                "osm_id": rid,
                "tags": dict(rel.tags),
                "role": feature_role(rel.tags) or "area",
                "nodes": set(store.object_node_ids("relation", rid)),
                "ways": _member_way_ids(store, rid),
            }
    for wid, way in store.ways.items():
        if _is_vertex(store, "way", wid, seed=seed_t):
            vertices[feature_key("way", wid)] = {
                "osm_type": "way",
                "osm_id": wid,
                "tags": dict(way.tags),
                "role": feature_role(way.tags) or "area",
                "nodes": set(way.nds),
                "ways": {wid},
            }
    if seed_key not in vertices:
        raise KeyError(f"seed {seed_type}/{seed_id} is not a water feature in the store")

    node_index: dict[int, set[str]] = defaultdict(set)
    way_index: dict[int, set[str]] = defaultdict(set)
    for key, obj in vertices.items():
        for nid in obj["nodes"]:
            node_index[nid].add(key)
        for wid in obj["ways"]:
            way_index[wid].add(key)

    raw_edges: dict[tuple[str, str, str], GraphEdge] = {}

    def add_edge(a: str, b: str, kind: str, evidence: dict[str, Any]) -> None:
        if a == b:
            return
        if "osmId" not in evidence:
            raise ValueError(f"edge {kind} missing osmId evidence")
        lo, hi = _pair_key(a, b)
        k = (lo, hi, kind)
        if k in raw_edges:
            return
        raw_edges[k] = GraphEdge(from_key=lo, to_key=hi, connection_type=kind, evidence=evidence)

    keys = sorted(vertices)
    for i, a in enumerate(keys):
        oa = vertices[a]
        for b in keys[i + 1 :]:
            ob = vertices[b]
            shared_n = oa["nodes"] & ob["nodes"]
            if shared_n:
                sample = sorted(shared_n)[:12]
                add_edge(
                    a,
                    b,
                    SHARED_NODE,
                    {"osmId": sample[0], "osmType": "node", "sharedNodeIds": sample, "sharedNodeCount": len(shared_n)},
                )
            shared_w = oa["ways"] & ob["ways"]
            if shared_w and oa["osm_type"] == "relation" and ob["osm_type"] == "relation":
                wid = min(shared_w)
                add_edge(a, b, SHARED_WAY, {"osmId": wid, "osmType": "way", "sharedWayIds": sorted(shared_w)[:12]})

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
                    {"osmId": rel.osm_id, "osmType": "relation", "memberId": mem.ref, "memberType": mem.type, "role": mem.role},
                )

    area_keys = [k for k, o in vertices.items() if o["role"] == "area" or k == seed_key]
    area_set = set(area_keys)

    for wid, way in store.ways.items():
        if not is_open_connector_tags(way.tags) or feature_role(way.tags) != "waterway":
            continue
        if feature_key("way", wid) in vertices:
            continue
        if _is_mp_boundary_way(store, wid):
            continue
        nds = way.nds
        if not nds:
            continue
        touched = {k for nid in nds for k in node_index[nid] if k in area_set}
        if len(touched) == 2:
            a, b = sorted(touched)
            add_edge(
                a,
                b,
                WATERWAY_CONNECTOR,
                {"osmId": wid, "osmType": "way", "areaKeys": [a, b]},
            )
        ends = {nds[0], nds[-1]}
        parents = store.memberships_of("way", wid)
        ww_rels = [
            feature_key("relation", m["relation"])
            for m in parents
            if feature_key("relation", m["relation"]) in vertices
            and vertices[feature_key("relation", m["relation"])]["role"] == "waterway"
        ]
        for nid in ends:
            for ak in node_index[nid]:
                if ak not in area_set:
                    continue
                for rk in ww_rels:
                    if rk == ak:
                        continue
                    add_edge(
                        rk,
                        ak,
                        ENDPOINT_ON_POLYGON,
                        {"osmId": wid, "osmType": "way", "nodeId": nid, "role": next(p["role"] for p in parents if feature_key("relation", p["relation"]) == rk)},
                    )

    adj: dict[str, set[str]] = defaultdict(set)
    for e in raw_edges.values():
        adj[e.from_key].add(e.to_key)
        adj[e.to_key].add(e.from_key)

    dist = {seed_key: 0}
    q: deque[str] = deque([seed_key])
    while q:
        u = q.popleft()
        for v in sorted(adj[u]):
            if v not in dist:
                dist[v] = dist[u] + 1
                q.append(v)

    graph = WaterFeatureGraph(seed_key=seed_key)
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

    p = argparse.ArgumentParser(description="Build WaterFeature graph (OSM evidence only).")
    p.add_argument("--seed", default="relation/399081")
    p.add_argument("--store", required=True)
    p.add_argument("--out")
    args = p.parse_args(argv)
    graph = build_water_graph(args.seed, load_compact_store(Path(args.store)))
    payload = graph.to_dict()
    if args.out:
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if __package__ is None or __package__ == "":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from water_topology.build_water_graph import main as _main

        raise SystemExit(_main())
    raise SystemExit(main())
