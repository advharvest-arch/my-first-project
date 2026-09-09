"""discover_water_graph: seed → OSM topology / waterway connectors → research graph.

Layers (must not be mixed):
  A DIRECT_OSM          confirmed (shared OSM node/edge)
  B WATERWAY_CONNECTOR  confirmed (open waterway shares nodes with both ends)
  C GEOMETRY_CONTACT    candidate only (shapely touch/intersect, no OSM node)
  D NEARBY_CANDIDATE    candidate only (proximity; not a connection)
  PORTAGE_CANDIDATE     candidate only (0 < d ≤ portage_m, no water path)

BFS expands only through A and B. Names are never used as a join key.
Does not write DB / WRG / seligerDebug and does not set navigability.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any

from pyproj import Geod
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, mapping
from shapely.geometry.base import BaseGeometry
from shapely.ops import nearest_points
from shapely.strtree import STRtree

from .osm_store import OsmStore, WayRec
from .rings import reconstruct_relation_geometry
from .tags import feature_role, is_area_water_tags, pick_name

GEOD = Geod(ellps="WGS84")

CONFIRMED_TYPES = {"DIRECT_OSM", "WATERWAY_CONNECTOR"}
CANDIDATE_TYPES = {"GEOMETRY_CONTACT", "NEARBY_CANDIDATE", "PORTAGE_CANDIDATE"}


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
        if raw[0] in "rwn" and raw[1:].isdigit():
            return {"r": "relation", "w": "way", "n": "node"}[raw[0]], int(raw[1:])
        if raw.isdigit():
            return "relation", int(raw)
    raise ValueError(f"unsupported seed: {seed!r}")


def feature_key(osm_type: str, osm_id: int) -> str:
    prefix = {"relation": "r", "way": "w", "node": "n"}[osm_type]
    return f"{prefix}{osm_id}"


def parse_key(key: str) -> tuple[str, int]:
    return {"r": "relation", "w": "way", "n": "node"}[key[0]], int(key[1:])


def edges_of(nds: list[int]) -> set[tuple[int, int]]:
    out: set[tuple[int, int]] = set()
    for a, b in zip(nds, nds[1:]):
        if a == b:
            continue
        out.add((a, b) if a < b else (b, a))
    return out


def geodesic_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    _, _, d = GEOD.inv(a[0], a[1], b[0], b[1])
    return abs(d)


def geom_distance_m(a: BaseGeometry, b: BaseGeometry) -> float | None:
    if a is None or b is None or a.is_empty or b.is_empty:
        return None
    try:
        if a.intersects(b):
            return 0.0
        p1, p2 = nearest_points(a, b)
        return geodesic_m((p1.x, p1.y), (p2.x, p2.y))
    except Exception:
        return None


def meters_to_deg(meters: float) -> float:
    return (meters / 111_000.0) * 1.6


def geom_to_json(geom: BaseGeometry | None) -> dict[str, Any] | None:
    if geom is None or geom.is_empty:
        return None
    return mapping(geom)


def bbox_of_geom(geom: BaseGeometry | None) -> list[float] | None:
    if geom is None or geom.is_empty:
        return None
    minx, miny, maxx, maxy = geom.bounds
    return [minx, miny, maxx, maxy]


@dataclass
class WaterFeatureNode:
    key: str
    osm_type: str
    osm_id: int
    name: str | None
    tags: dict[str, str]
    role: str
    geometry: dict[str, Any] | None
    bbox: list[float] | None
    relation_membership: list[dict[str, Any]]
    outer_part_count: int | None = None
    node_count: int = 0
    hops_from_seed: int | None = None
    island: dict[str, Any] | None = None
    in_confirmed_component: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "osmType": self.osm_type,
            "osmId": self.osm_id,
            "name": self.name,
            "tags": self.tags,
            "role": self.role,
            "geometry": self.geometry,
            "bbox": self.bbox,
            "relationMembership": self.relation_membership,
            "outerPartCount": self.outer_part_count,
            "nodeCount": self.node_count,
            "hopsFromSeed": self.hops_from_seed,
            "island": self.island,
            "inConfirmedComponent": self.in_confirmed_component,
        }


@dataclass
class WaterConnectionEdge:
    from_key: str
    to_key: str
    connection_type: str
    status: str
    connectors: list[dict[str, Any]] = field(default_factory=list)
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_key,
            "to": self.to_key,
            "connectionType": self.connection_type,
            "status": self.status,
            "connectors": self.connectors,
            "evidence": self.evidence,
        }


@dataclass
class WaterGraph:
    seed_key: str
    seed: dict[str, Any]
    nodes: dict[str, WaterFeatureNode]
    edges: list[WaterConnectionEdge]
    nearby: list[dict[str, Any]]
    island_water: list[dict[str, Any]]
    uncertain: list[dict[str, Any]]
    branches: list[dict[str, Any]]
    summary: dict[str, Any]
    notes: list[str] = field(default_factory=list)

    def node(self, osm_type: str, osm_id: int) -> WaterFeatureNode | None:
        return self.nodes.get(feature_key(osm_type, osm_id))

    def has_node(self, osm_type: str, osm_id: int) -> bool:
        return feature_key(osm_type, osm_id) in self.nodes

    def confirmed_edges(self) -> list[WaterConnectionEdge]:
        return [e for e in self.edges if e.status == "confirmed"]

    def candidate_edges(self) -> list[WaterConnectionEdge]:
        return [e for e in self.edges if e.status == "candidate"]

    def connected_pair(self, a: tuple[str, int], b: tuple[str, int], *, confirmed: bool = True):
        ka, kb = feature_key(*a), feature_key(*b)
        pool = self.confirmed_edges() if confirmed else self.edges
        for e in pool:
            if {e.from_key, e.to_key} == {ka, kb}:
                return e
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "seed": self.seed,
            "summary": self.summary,
            "nodes": [n.to_dict() for n in self.nodes.values()],
            "edges": [e.to_dict() for e in self.edges],
            "nearby": self.nearby,
            "islandWater": self.island_water,
            "uncertain": self.uncertain,
            "branches": self.branches,
            "notes": self.notes,
        }


def _way_geom(store: OsmStore, way: WayRec) -> BaseGeometry | None:
    coords = store.way_coords(way)
    if len(coords) < 2:
        return None
    closed = (len(way.nds) >= 4 and way.nds[0] == way.nds[-1]) or (
        len(coords) >= 4 and coords[0] == coords[-1]
    )
    if closed and is_area_water_tags(way.tags) and way.tags.get("waterway") is None:
        ring = coords if coords[0] == coords[-1] else coords + [coords[0]]
        try:
            poly = Polygon(ring)
            if not poly.is_valid:
                poly = poly.buffer(0)
            return poly
        except Exception:
            return LineString(coords)
    return LineString(coords)


def _object_edges(store: OsmStore, osm_type: str, osm_id: int) -> set[tuple[int, int]]:
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


def _seed_member_way_ids(store: OsmStore, osm_type: str, osm_id: int) -> set[int]:
    if osm_type != "relation":
        return set()
    rel = store.relations.get(osm_id)
    if rel is None:
        return set()
    return {m.ref for m in rel.members if m.type == "way"}


def _iter_candidate_objects(store: OsmStore, seed_type: str, seed_id: int):
    member_ways = _seed_member_way_ids(store, seed_type, seed_id)
    yield seed_type, seed_id, store.relations[seed_id].tags if seed_type == "relation" else (
        store.ways[seed_id].tags if seed_type == "way" else {}
    )
    for wid, way in store.ways.items():
        if seed_type == "way" and wid == seed_id:
            continue
        if wid in member_ways:
            # Geometry members of the seed relation are not separate water features
            # unless they carry their own water tags *and* are not just the shore.
            role = feature_role(way.tags)
            if role not in {"area", "waterway"}:
                continue
        role = feature_role(way.tags)
        if role in {"area", "waterway", "waterway-weak"}:
            yield "way", wid, way.tags
    for rid, rel in store.relations.items():
        if seed_type == "relation" and rid == seed_id:
            continue
        role = feature_role(rel.tags)
        if role in {"area", "waterway", "waterway-weak"}:
            yield "relation", rid, rel.tags


def discover_water_graph(
    seed: Any,
    store: OsmStore,
    *,
    nearby_m: float = 250.0,
    portage_m: float = 100.0,
    isolated_scan_m: float = 5000.0,
) -> WaterGraph:
    """Build a research water topology graph from a seed OSM object.

    `store` must already contain the seed /full dump plus surrounding water
    features and waterways. Fetching is a separate step (see fetch.py / dumps.py).
    """
    seed_type, seed_id = parse_seed(seed)
    seed_key = feature_key(seed_type, seed_id)
    if seed_type == "relation" and seed_id not in store.relations:
        raise KeyError(f"seed relation {seed_id} is not in the OSM store")
    if seed_type == "way" and seed_id not in store.ways:
        raise KeyError(f"seed way {seed_id} is not in the OSM store")

    notes: list[str] = [
        "Research topology discovery only. Not a production WaterSystem.",
        "Names are never used as a join or discovery key.",
        "BFS expands only through DIRECT_OSM and WATERWAY_CONNECTOR.",
        "GEOMETRY_CONTACT / NEARBY / PORTAGE are candidates, not confirmed water connections.",
        "Navigability is not evaluated.",
    ]

    objects: dict[str, dict[str, Any]] = {}
    geoms: dict[str, BaseGeometry] = {}
    island_index_parts: list[dict[str, Any]] = []

    def add_object(osm_type: str, osm_id: int, tags: dict[str, str], *, is_seed: bool = False) -> str:
        key = feature_key(osm_type, osm_id)
        if key in objects:
            return key
        role = "seed" if is_seed else (feature_role(tags) or "area")
        nds = store.object_node_ids(osm_type, osm_id)
        es = _object_edges(store, osm_type, osm_id)
        geom = None
        outer_parts = None
        recon_meta = None
        if osm_type == "relation":
            geom, recon_meta = reconstruct_relation_geometry(store, osm_id)
            if recon_meta:
                outer_parts = recon_meta.get("outer_part_count")
                for island in recon_meta.get("island_polys") or []:
                    island_index_parts.append(
                        {
                            "parent_key": key,
                            "way_ids": island["way_ids"],
                            "parent_outer_index": island["parent_outer_index"],
                            "poly": island["poly"],
                        }
                    )
        elif osm_type == "way":
            geom = _way_geom(store, store.ways[osm_id])
        objects[key] = {
            "osm_type": osm_type,
            "osm_id": osm_id,
            "tags": dict(tags),
            "role": role if not is_seed else (feature_role(tags) or "area"),
            "is_seed": is_seed,
            "nodes": set(nds),
            "edges": es,
            "outer_part_count": outer_parts,
            "recon_meta": recon_meta,
        }
        if geom is not None and not geom.is_empty:
            geoms[key] = geom
        return key

    seed_tags = (
        store.relations[seed_id].tags
        if seed_type == "relation"
        else store.ways[seed_id].tags
    )
    add_object(seed_type, seed_id, seed_tags, is_seed=True)

    for osm_type, osm_id, tags in _iter_candidate_objects(store, seed_type, seed_id):
        role = feature_role(tags)
        if role == "waterway-weak":
            continue
        add_object(osm_type, osm_id, tags)

    # --- A/B: node-identity adjacency (no distance) ---
    node_to_keys: dict[int, set[str]] = defaultdict(set)
    for key, obj in objects.items():
        for nid in obj["nodes"]:
            node_to_keys[nid].add(key)

    shared_nodes: dict[str, dict[str, set[int]]] = defaultdict(lambda: defaultdict(set))
    shared_edges: dict[str, dict[str, set[tuple[int, int]]]] = defaultdict(lambda: defaultdict(set))
    adj: dict[str, set[str]] = defaultdict(set)
    for key, obj in objects.items():
        neigh: set[str] = set()
        for nid in obj["nodes"]:
            neigh |= node_to_keys[nid]
        neigh.discard(key)
        for other in neigh:
            inter_n = obj["nodes"] & objects[other]["nodes"]
            if not inter_n:
                continue
            adj[key].add(other)
            shared_nodes[key][other] = inter_n
            inter_e = obj["edges"] & objects[other]["edges"]
            if inter_e:
                shared_edges[key][other] = inter_e

    def is_area_obj(key: str) -> bool:
        role = objects[key]["role"]
        return role in {"area", "seed"} or objects[key]["is_seed"]

    def is_waterway_obj(key: str) -> bool:
        return objects[key]["role"] == "waterway"

    # BFS through areas + open waterways only
    dist = {seed_key: 0}
    bfs_parent: dict[str, str | None] = {seed_key: None}
    q: deque[str] = deque([seed_key])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if objects[v]["role"] == "waterway-weak":
                continue
            if v not in dist:
                dist[v] = dist[u] + 1
                bfs_parent[v] = u
                q.append(v)

    confirmed_keys = set(dist)

    edge_map: dict[tuple[str, str, str], WaterConnectionEdge] = {}

    def add_edge(
        a: str,
        b: str,
        connection_type: str,
        status: str,
        *,
        connectors: list[dict[str, Any]] | None = None,
        evidence: dict[str, Any] | None = None,
    ) -> None:
        lo, hi = (a, b) if a < b else (b, a)
        k = (lo, hi, connection_type)
        if k in edge_map:
            if evidence:
                edge_map[k].evidence.update(evidence)
            return
        edge_map[k] = WaterConnectionEdge(
            from_key=lo,
            to_key=hi,
            connection_type=connection_type,
            status=status,
            connectors=list(connectors or []),
            evidence=dict(evidence or {}),
        )

    # A. DIRECT_OSM between any two BFS-reached features that share nodes
    for a in confirmed_keys:
        for b in adj[a]:
            if b not in confirmed_keys or a >= b:
                continue
            inter_n = shared_nodes[a][b]
            inter_e = shared_edges[a].get(b, set())
            sample = sorted(inter_n)[:12]
            add_edge(
                a,
                b,
                "DIRECT_OSM",
                "confirmed",
                evidence={
                    "sharedNodeCount": len(inter_n),
                    "sharedEdgeCount": len(inter_e),
                    "sharedNodes": sample,
                    "why": (
                        f"{a} and {b} share OSM node "
                        + (", ".join(str(n) for n in sample[:3]) or "ids")
                    ),
                },
            )

    # B. WATERWAY_CONNECTOR: area — area via a waterway that touches both
    for ck, cobj in objects.items():
        if not is_waterway_obj(ck):
            continue
        if ck not in confirmed_keys:
            continue
        area_ends = [n for n in adj[ck] if is_area_obj(n) and n in confirmed_keys]
        for i, a in enumerate(area_ends):
            for b in area_ends[i + 1 :]:
                add_edge(
                    a,
                    b,
                    "WATERWAY_CONNECTOR",
                    "confirmed",
                    connectors=[{"osmType": cobj["osm_type"], "osmId": cobj["osm_id"], "key": ck}],
                    evidence={
                        "connector": ck,
                        "sharedNodesWithFrom": sorted(shared_nodes[ck][a])[:8],
                        "sharedNodesWithTo": sorted(shared_nodes[ck][b])[:8],
                        "why": f"{a} and {b} share no requirement of a common node; "
                        f"open waterway {ck} shares OSM nodes with both",
                    },
                )

    # Spatial index of area geometries for C/D/islands (not N×N of all objects)
    area_keys = [k for k, o in objects.items() if is_area_obj(k) and k in geoms]
    area_geoms = [geoms[k] for k in area_keys]
    tree = STRtree(area_geoms) if area_geoms else None

    seed_geom = geoms.get(seed_key)

    def query_areas(geom: BaseGeometry, buffer_m: float) -> list[str]:
        if tree is None or geom is None or geom.is_empty:
            return []
        env = geom.buffer(meters_to_deg(buffer_m))
        hits: list[str] = []
        for idx in tree.query(env):
            key = area_keys[int(idx)]
            hits.append(key)
        return hits

    # Islands first: water areas whose representative point is inside an inner ring
    island_rows: list[dict[str, Any]] = []
    island_keys: set[str] = set()
    island_polys = [p["poly"] for p in island_index_parts]
    island_tree = STRtree(island_polys) if island_polys else None

    for key, obj in objects.items():
        if not is_area_obj(key) or key == seed_key:
            continue
        geom = geoms.get(key)
        if geom is None or island_tree is None:
            continue
        try:
            pt = geom.representative_point()
        except Exception:
            continue
        parents = []
        for idx in island_tree.query(pt):
            info = island_index_parts[int(idx)]
            try:
                if info["poly"].covers(pt) or info["poly"].contains(pt):
                    parents.append(info)
            except Exception:
                continue
        if not parents:
            continue
        island_parent = parents[0]
        has_direct = bool(obj["nodes"] & objects[island_parent["parent_key"]]["nodes"])
        has_connector = any(is_waterway_obj(nbr) and nbr in confirmed_keys for nbr in adj[key])
        island_info = {
            "parentIslandWayIds": island_parent["way_ids"],
            "parentWaterFeature": island_parent["parent_key"],
            "parentOuterIndex": island_parent["parent_outer_index"],
            "osmMembership": store.memberships_of(obj["osm_type"], obj["osm_id"]),
            "directTopologyToParent": has_direct,
            "hasWaterwayConnector": has_connector,
            "separateObject": not (has_direct or has_connector or key in confirmed_keys),
        }
        objects[key]["island"] = island_info
        island_keys.add(key)
        island_rows.append(
            {
                "key": key,
                "osmType": obj["osm_type"],
                "osmId": obj["osm_id"],
                "name": pick_name(obj["tags"]),
                **island_info,
                "inConfirmedComponent": key in confirmed_keys,
            }
        )

    # C. GEOMETRY_CONTACT: only around the seed, bbox-filtered, not confirmed
    if seed_geom is not None:
        for other in query_areas(seed_geom, nearby_m):
            if other == seed_key or other in confirmed_keys:
                continue
            og = geoms.get(other)
            if og is None:
                continue
            try:
                intersects = bool(seed_geom.intersects(og))
                touches = bool(seed_geom.touches(og))
            except Exception:
                touches, intersects = False, False
            if not intersects:
                continue
            d = geom_distance_m(seed_geom, og)
            add_edge(
                seed_key,
                other,
                "GEOMETRY_CONTACT",
                "candidate",
                evidence={
                    "distanceM": d,
                    "touches": touches,
                    "intersects": intersects,
                    "why": "geometries touch or intersect; no shared OSM node in this store",
                    "sharedNodeCount": len(objects[other]["nodes"] & objects[seed_key]["nodes"]),
                },
            )

    # D. NEARBY + PORTAGE vs seed, bbox/STRtree filtered. Island ponds are not portages.
    nearby_rows: list[dict[str, Any]] = []
    if seed_geom is not None:
        scan_keys = query_areas(seed_geom, isolated_scan_m)
        for other in scan_keys:
            if other == seed_key:
                continue
            og = geoms.get(other)
            d = geom_distance_m(seed_geom, og) if og is not None else None
            in_comp = other in confirmed_keys
            geom_rel = "unknown"
            if og is not None:
                try:
                    if other in island_keys:
                        geom_rel = "inside_island"
                    elif seed_geom.intersects(og) and not seed_geom.touches(og):
                        geom_rel = "intersects"
                    elif seed_geom.touches(og) or (d == 0):
                        geom_rel = "touches"
                    else:
                        geom_rel = "disjoint"
                except Exception:
                    geom_rel = "unknown"
            if in_comp:
                continue
            reason = "proximity only; no confirmed OSM water path from seed"
            ctype = None
            if other in island_keys:
                ctype = "NEARBY_CANDIDATE"
                reason = "inside island/inner geometry of a water feature; not a waterway connection"
            elif d is not None and 0 < d <= portage_m:
                ctype = "PORTAGE_CANDIDATE"
                reason = "proximity only; gap ≤ portage threshold; not a proven portage"
            elif d is not None and d <= nearby_m:
                ctype = "NEARBY_CANDIDATE"
            elif d is not None and d <= isolated_scan_m:
                ctype = "NEARBY_CANDIDATE"
                reason = "in seed scan radius; no confirmed OSM water path"
            if ctype is None:
                continue
            add_edge(
                seed_key,
                other,
                ctype,
                "candidate",
                evidence={
                    "distanceM": d,
                    "geometryRelation": geom_rel,
                    "why": reason,
                },
            )
            nearby_rows.append(
                {
                    "key": other,
                    "osmType": objects[other]["osm_type"],
                    "osmId": objects[other]["osm_id"],
                    "name": pick_name(objects[other]["tags"]),
                    "distanceM": d,
                    "geometryRelation": geom_rel,
                    "candidateReason": reason,
                    "connectionType": ctype,
                    "inConfirmedComponent": False,
                }
            )

    # Incomplete geometry → UNCERTAIN (do not claim isolation)
    uncertain_rows: list[dict[str, Any]] = []
    for e in edge_map.values():
        if e.connection_type in {"GEOMETRY_CONTACT", "NEARBY_CANDIDATE", "PORTAGE_CANDIDATE"}:
            uncertain_rows.append(
                {
                    "kind": e.connection_type,
                    "from": e.from_key,
                    "to": e.to_key,
                    "status": "UNCERTAIN",
                    "evidence": e.evidence,
                }
            )
    for row in island_rows:
        if row.get("separateObject") and not row.get("inConfirmedComponent"):
            uncertain_rows.append(
                {
                    "kind": "ISLAND_WATER_NO_CONNECTOR",
                    "from": row["parentWaterFeature"],
                    "to": row["key"],
                    "status": "UNCERTAIN",
                    "evidence": {
                        "parentIslandWayIds": row["parentIslandWayIds"],
                        "why": "water feature sits inside an inner/island ring; no OSM node "
                        "or waterway connector to the parent water body",
                    },
                }
            )
    for key, obj in objects.items():
        if key not in confirmed_keys:
            continue
        if obj["osm_type"] == "way":
            way = store.ways[obj["osm_id"]]
            missing = [n for n in way.nds if n not in store.nodes]
            if missing:
                uncertain_rows.append(
                    {
                        "kind": "MISSING_NODES",
                        "from": key,
                        "to": None,
                        "status": "UNCERTAIN",
                        "evidence": {
                            "missingNodeCount": len(missing),
                            "why": "incomplete way geometry in store",
                        },
                    }
                )

    # Materialize nodes: seed + confirmed component + nearby + island waters
    keep_keys = set(confirmed_keys)
    keep_keys.update(r["key"] for r in nearby_rows)
    keep_keys.update(r["key"] for r in island_rows)

    nodes_out: dict[str, WaterFeatureNode] = {}
    for key in keep_keys:
        obj = objects[key]
        geom = geoms.get(key)
        nodes_out[key] = WaterFeatureNode(
            key=key,
            osm_type=obj["osm_type"],
            osm_id=obj["osm_id"],
            name=pick_name(obj["tags"]),
            tags=obj["tags"],
            role="seed" if obj["is_seed"] else obj["role"],
            geometry=geom_to_json(geom),
            bbox=bbox_of_geom(geom),
            relation_membership=store.memberships_of(obj["osm_type"], obj["osm_id"]),
            outer_part_count=obj.get("outer_part_count"),
            node_count=len(obj["nodes"]),
            hops_from_seed=dist.get(key),
            island=obj.get("island"),
            in_confirmed_component=key in confirmed_keys,
        )

    # BFS branches (tree via parent pointers; areas highlighted)
    def path_of(key: str) -> list[str]:
        p: list[str] = []
        cur: str | None = key
        seen: set[str] = set()
        while cur is not None and cur not in seen:
            p.append(cur)
            seen.add(cur)
            cur = bfs_parent.get(cur)
        return list(reversed(p))

    branches: list[dict[str, Any]] = []
    leaves = [
        k
        for k in confirmed_keys
        if is_area_obj(k) and k != seed_key and not any(
            bfs_parent.get(c) == k and is_area_obj(c) for c in confirmed_keys
        )
    ]
    for leaf in sorted(leaves, key=lambda k: (dist.get(k) or 0, k)):
        chain = path_of(leaf)
        branches.append(
            {
                "leaf": leaf,
                "hops": dist.get(leaf),
                "path": chain,
                "names": [pick_name(objects[k]["tags"]) for k in chain],
            }
        )

    edges_out = list(edge_map.values())
    edges_out.sort(key=lambda e: (e.status, e.connection_type, e.from_key, e.to_key))
    nearby_rows.sort(key=lambda r: (r.get("distanceM") is None, r.get("distanceM") or 0, r["key"]))
    island_rows.sort(key=lambda r: r["key"])

    seed_meta = {
        "osmType": seed_type,
        "osmId": seed_id,
        "key": seed_key,
        "name": pick_name(seed_tags),
        "tags": seed_tags,
        "outerPartCount": objects[seed_key].get("outer_part_count"),
        "nodeCount": len(objects[seed_key]["nodes"]),
        "bbox": bbox_of_geom(seed_geom),
        "sources": list(store.sources),
    }
    if objects[seed_key].get("recon_meta"):
        meta = objects[seed_key]["recon_meta"]
        seed_meta["ringAssembly"] = {
            "outerStats": meta.get("outer_stats"),
            "innerStats": meta.get("inner_stats"),
            "issueCount": len(meta.get("issues") or []),
        }

    confirmed = [e for e in edges_out if e.status == "confirmed"]
    candidates = [e for e in edges_out if e.status == "candidate"]
    summary = {
        "waterFeatureCount": sum(1 for n in nodes_out.values() if n.role in {"area", "seed", "waterway"}),
        "areaFeatureCount": sum(1 for n in nodes_out.values() if n.role in {"area", "seed"}),
        "waterwayFeatureCount": sum(1 for n in nodes_out.values() if n.role == "waterway"),
        "confirmedComponentSize": len(confirmed_keys),
        "confirmedConnectionCount": len(confirmed),
        "candidateConnectionCount": len(candidates),
        "nearbyCandidateCount": len(nearby_rows),
        "islandWaterCount": len(island_rows),
        "uncertainCount": len(uncertain_rows),
        "directOsmCount": sum(1 for e in confirmed if e.connection_type == "DIRECT_OSM"),
        "waterwayConnectorCount": sum(1 for e in confirmed if e.connection_type == "WATERWAY_CONNECTOR"),
        "storeWays": len(store.ways),
        "storeRelations": len(store.relations),
        "storeNodes": len(store.nodes),
    }

    return WaterGraph(
        seed_key=seed_key,
        seed=seed_meta,
        nodes=nodes_out,
        edges=edges_out,
        nearby=nearby_rows,
        island_water=island_rows,
        uncertain=uncertain_rows,
        branches=branches,
        summary=summary,
        notes=notes,
    )


discoverWaterGraph = discover_water_graph
