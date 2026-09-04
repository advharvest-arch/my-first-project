#!/usr/bin/env python3
"""
AquaRoute WRG-004/005 — First Route MVP + funnel geometry.

Physical routing on the already-built unified WRG:
  E1 centerlines ∪ WRG-002 mesh traversal ∪ proven portal attachments.
WRG-005 post-process: A* vertex path → triangle corridor → string-pull.

Does not write wg_edges. Does not call production routing, BRouter,
measureWaterChain, Area-Bridge, sea, river_area, or any UI.

Bind rule: click stays the display/input coordinate. If the click ST_Covers a
mesh triangle / wrg_areas part, routing attaches to the closest existing
triangle edge (local stub, not a far CDT vertex or centroid). E1 within
BIND_MAX_M only when the click is not on mapped-lake land (holes and banks
are ENDPOINT_NOT_ON_WATER). No 3/10/25 km snap. No proximity topology edges.
Geometry starts/ends at the click when the stub is CoveredBy the same water part.

    python3 ingest/wrg_route.py A_LON A_LAT B_LON B_LAT
    python3 ingest/wrg_route.py --validate
    python3 ingest/wrg_route.py --stdio-json   # demo UI adapter (one JSON line in / out)
"""

from __future__ import annotations

import argparse
import heapq
import json
import os
import sys
import time
from dataclasses import dataclass, field
from math import asin, cos, radians, sin, sqrt
from pathlib import Path
from typing import Any, Hashable, Iterable

from shapely import LineString, Point, from_wkb
from shapely.ops import substring

from wrg_funnel import (
    LocalFrame,
    MeshPartIndex,
    funnel_debug,
    funnel_mesh_run,
    polyline_length_m,
)

ROUTER_VERSION = "wrg-005-3"
BIND_MAX_M = 25.0  # metres — not kilometres
EARTH_M = 6371000.0
ZERO_T = 1e-12
FUNNEL_COVER_MAX_M = 1.0
FUNNEL_ENDPOINT_MAX_M = 2.0

STATUS_ROUTE_FOUND = "ROUTE_FOUND"
STATUS_NO_WATER_CONNECTION = "NO_WATER_CONNECTION"
STATUS_ENDPOINT_NOT_ON_WATER = "ENDPOINT_NOT_ON_WATER"
STATUS_GEOMETRY_VALIDATION_FAILED = "GEOMETRY_VALIDATION_FAILED"

START: tuple[str, ...] = ("s",)
GOAL: tuple[str, ...] = ("g",)

# Known Kovzha / Belozersky attach points (WRG-002 existing_vertex).
# The 8961 m geodesic between them leaves Beloye (~743 m land). Forbidden as a hop.
KOVzHA_ATTACH = (37.3270442, 60.2490477)
BELOZERSKY_ATTACH = (37.2303366, 60.184603)
FORBIDDEN_CHORD_M = 8960.714

# Validation corpus (lon, lat). E1 starts, not lake attaches, for case 1
# so the path must be E1 → mesh → E1 rather than mesh-only.
VALIDATION_CASES: list[dict[str, Any]] = [
    {
        "id": "beloye_kovzha_belozersky",
        "name": "БЕЛОЕ: Ковжа edge 8039 → Белозерский edge 2228",
        "a": (37.15860787, 60.33563016),  # on Ковжа 8039, ~29 m from node 12244
        "b": (37.2263761, 60.2570485),  # Белозерский from_node 3432
        "expect": STATUS_ROUTE_FOUND,
        "expect_path_type": ("E1", "mesh", "E1"),
        "check_beloye_water": True,
        "forbid_chord": True,
    },
    {
        "id": "beloye_same_part",
        "name": "БЕЛОЕ: две точки внутри одной water part",
        "a": (37.5591499, 60.3253729),  # portal Водоба, in Beloye part 1
        "b": (37.3270442, 60.2490477),  # portal Ковжа attach, in lake
        "expect": STATUS_ROUTE_FOUND,
        "expect_path_type": ("mesh",),
        "check_beloye_water": True,
        "forbid_chord": False,
    },
    {
        "id": "vygozero_same_part",
        "name": "ВЫГОЗЕРО: две точки внутри одного part",
        "a": (34.3220777, 63.8827376),  # portal in Vygozero part 2 (north)
        "b": (34.245828, 63.8472787),  # portal in Vygozero part 2
        "expect": STATUS_ROUTE_FOUND,
        "expect_path_type": ("mesh",),
        "check_beloye_water": False,
        "forbid_chord": False,
    },
    {
        "id": "strelka_land_separation",
        "name": "STRELKA: близкие точки по разные стороны land separation",
        "a": (30.2091961, 59.9667554),  # Малая Нева mouth node 160400
        "b": (30.2773486, 59.9815368),  # Средняя Невка node 4769
        "expect": STATUS_NO_WATER_CONNECTION,
        "expect_path_type": None,
        "check_beloye_water": False,
        "forbid_chord": False,
    },
    {
        "id": "land_off_network",
        "name": "СУША: явная точка вне water network",
        "a": (30.2348444, 59.94200785),  # spit / city between Neva mouths
        "b": (30.2773486, 59.9815368),
        "expect": STATUS_ENDPOINT_NOT_ON_WATER,
        "expect_path_type": None,
        "check_beloye_water": False,
        "forbid_chord": False,
    },
]


def default_dsn() -> str:
    host = os.environ.get("WATER_DB_HOST", "127.0.0.1")
    port = os.environ.get("WATER_DB_PORT", "5433")
    db = os.environ.get("WATER_DB_NAME", "aquaroute_water")
    user = os.environ.get("WATER_DB_USER", "aquaroute")
    password = os.environ.get(
        "WATER_DB_PASSWORD",
        os.environ.get("POSTGRES_PASSWORD", "change_me_local_only"),
    )
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if password in ("change_me_local_only", "") and env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("POSTGRES_PASSWORD="):
                password = line.split("=", 1)[1].strip()
                break
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def haversine_m(
    a: tuple[float, float], b: tuple[float, float]
) -> float:
    lon1, lat1 = radians(a[0]), radians(a[1])
    lon2, lat2 = radians(b[0]), radians(b[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    h = sin(dlat / 2.0) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2.0) ** 2
    return 2.0 * EARTH_M * asin(min(1.0, sqrt(h)))


def xy_close(
    a: tuple[float, float], b: tuple[float, float], max_m: float = 1e-3
) -> bool:
    return haversine_m(a, b) <= max_m


def closest_point_on_segment(
    p: tuple[float, float],
    a: tuple[float, float],
    b: tuple[float, float],
) -> tuple[tuple[float, float], float, float]:
    """Closest point on segment ab to p in a local metric frame. t in [0, 1]."""
    frame = LocalFrame.from_points([p, a, b])
    px, py = frame.to_xy(*p)
    ax, ay = frame.to_xy(*a)
    bx, by = frame.to_xy(*b)
    vx, vy = bx - ax, by - ay
    len2 = vx * vx + vy * vy
    if len2 <= 1e-18:
        return a, 0.0, haversine_m(p, a)
    t = ((px - ax) * vx + (py - ay) * vy) / len2
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    qx, qy = ax + t * vx, ay + t * vy
    q = frame.to_lonlat(qx, qy)
    return q, t, haversine_m(p, q)


def splice_line_endpoints(
    line: LineString | None,
    start_xy: tuple[float, float],
    end_xy: tuple[float, float],
) -> LineString:
    """Prepend/append geometric endpoints. Does not add graph edges."""
    coords: list[tuple[float, float]] = []
    if line is not None and not line.is_empty:
        coords = [(float(x), float(y)) for x, y in line.coords]
    if not coords:
        coords = [start_xy, end_xy]
    else:
        if not xy_close(coords[0], start_xy, FUNNEL_ENDPOINT_MAX_M):
            coords = [start_xy] + coords
        elif not xy_close(coords[0], start_xy, 1e-6):
            coords[0] = start_xy
        if not xy_close(coords[-1], end_xy, FUNNEL_ENDPOINT_MAX_M):
            coords = coords + [end_xy]
        elif not xy_close(coords[-1], end_xy, 1e-6):
            coords[-1] = end_xy
    if len(coords) < 2:
        coords = [start_xy, end_xy]
    return LineString(coords)


def e1_node(node_id: int) -> tuple[str, int]:
    return ("e", int(node_id))


def mesh_node(area_id: int, part: int, vertex_id: int) -> tuple[str, int, int, int]:
    return ("m", int(area_id), int(part), int(vertex_id))


def layer_of(node: Hashable) -> str | None:
    if not node or not isinstance(node, tuple):
        return None
    if node[0] == "e":
        return "E1"
    if node[0] == "m":
        return "mesh"
    return None


def compress_layers(nodes: Iterable[Hashable]) -> tuple[str, ...]:
    out: list[str] = []
    for n in nodes:
        layer = layer_of(n)
        if layer is None:
            continue
        if not out or out[-1] != layer:
            out.append(layer)
    return tuple(out)


def count_e1_mesh_transitions(path_type: tuple[str, ...]) -> int:
    n = 0
    for a, b in zip(path_type, path_type[1:]):
        if {a, b} == {"E1", "mesh"}:
            n += 1
    return n


@dataclass(frozen=True)
class Via:
    kind: str
    edge_id: int | None = None
    t0: float = 0.0
    t1: float = 0.0


VIA_MESH = Via("mesh")


@dataclass
class Binding:
    kind: str  # 'mesh' | 'e1'
    lon: float
    lat: float
    dist_m: float
    area_id: int | None = None
    part: int | None = None
    vertex_id: int | None = None
    triangle_id: int | None = None
    edge_id: int | None = None
    from_node_id: int | None = None
    to_node_id: int | None = None
    t: float | None = None
    length_m: float | None = None
    snap_lon: float | None = None
    snap_lat: float | None = None
    edge_v0: int | None = None
    edge_v1: int | None = None
    physical_component_id: int | None = None

    def as_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {
            "kind": self.kind,
            "input": [self.lon, self.lat],
            "dist_m": round(self.dist_m, 3),
            "physical_component_id": self.physical_component_id,
        }
        if self.kind == "mesh":
            d.update(
                {
                    "area_id": self.area_id,
                    "part": self.part,
                    "vertex_id": self.vertex_id,
                    "triangle_id": self.triangle_id,
                    "edge_v0": self.edge_v0,
                    "edge_v1": self.edge_v1,
                    "snap": [self.snap_lon, self.snap_lat],
                    "bind": "covering_triangle_closest_edge",
                }
            )
        else:
            d.update(
                {
                    "edge_id": self.edge_id,
                    "from_node_id": self.from_node_id,
                    "to_node_id": self.to_node_id,
                    "t": None if self.t is None else round(self.t, 8),
                    "length_m": None if self.length_m is None else round(self.length_m, 3),
                    "snap": [self.snap_lon, self.snap_lat],
                }
            )
        return d


@dataclass
class RouteResult:
    status: str
    bind_a: Binding | None
    bind_b: Binding | None
    component_a: int | None = None
    component_b: int | None = None
    path_nodes: list[Hashable] = field(default_factory=list)
    path_type: tuple[str, ...] = ()
    hop_kinds: list[str] = field(default_factory=list)
    e1_hops: int = 0
    mesh_hops: int = 0
    portal_hops: int = 0
    e1_mesh_transitions: int = 0
    distance_m: float | None = None
    geometry: LineString | None = None
    mesh_lines: list[LineString] = field(default_factory=list)
    mesh_max_seg_m: float | None = None
    geometry_validation: dict[str, Any] = field(default_factory=dict)
    runtime_ms: float = 0.0
    bind_ms: float = 0.0
    search_ms: float = 0.0
    geometry_ms: float = 0.0
    detail: str | None = None
    astar_distance_m: float | None = None

    def as_dict(self, include_coords: bool = True) -> dict[str, Any]:
        geom = None
        if self.geometry is not None and not self.geometry.is_empty:
            geom = json.loads(json.dumps(self.geometry.__geo_interface__))
            if not include_coords:
                geom = {
                    "type": geom.get("type"),
                    "n_coords": len(self.geometry.coords),
                }
        return {
            "status": self.status,
            "router_version": ROUTER_VERSION,
            "bind_max_m": BIND_MAX_M,
            "bind_a": None if self.bind_a is None else self.bind_a.as_dict(),
            "bind_b": None if self.bind_b is None else self.bind_b.as_dict(),
            "component_a": self.component_a,
            "component_b": self.component_b,
            "path_node_count": len(self.path_nodes),
            "path_edge_count": max(0, len(self.path_nodes) - 1),
            "path_type": list(self.path_type),
            "e1_hops": self.e1_hops,
            "mesh_hops": self.mesh_hops,
            "portal_hops": self.portal_hops,
            "e1_mesh_transitions": self.e1_mesh_transitions,
            "distance_m": None if self.distance_m is None else round(self.distance_m, 3),
            "mesh_max_seg_m": None
            if self.mesh_max_seg_m is None
            else round(self.mesh_max_seg_m, 3),
            "geometry": geom,
            "geometry_validation": self.geometry_validation,
            "runtime_ms": round(self.runtime_ms, 1),
            "bind_ms": round(self.bind_ms, 1),
            "search_ms": round(self.search_ms, 1),
            "geometry_ms": round(self.geometry_ms, 1),
            "detail": self.detail,
        }


def astar(
    adj: dict[Hashable, list[tuple[Hashable, float, Via]]],
    start: Hashable,
    goal: Hashable,
    heuristic,
) -> tuple[list[tuple[Hashable, Via | None]] | None, float | None]:
    """Return [(node, via_from_parent), ...] and g(goal), or (None, None)."""
    inf = float("inf")
    gscore: dict[Hashable, float] = {start: 0.0}
    prev: dict[Hashable, tuple[Hashable, Via]] = {}
    closed: set[Hashable] = set()
    pq: list[tuple[float, int, float, Hashable]] = []
    seq = 0
    heapq.heappush(pq, (heuristic(start), seq, 0.0, start))
    while pq:
        _f, _s, g, u = heapq.heappop(pq)
        if u in closed:
            continue
        closed.add(u)
        if u == goal:
            nodes_rev: list[Hashable] = [u]
            vias_rev: list[Via] = []
            cur: Hashable = u
            while cur in prev:
                p, via = prev[cur]
                nodes_rev.append(p)
                vias_rev.append(via)
                cur = p
            nodes_rev.reverse()
            vias_rev.reverse()
            path = [(nodes_rev[0], None)]
            for node, via in zip(nodes_rev[1:], vias_rev):
                path.append((node, via))
            return path, g
        if g > gscore.get(u, inf) + 1e-9:
            continue
        for v, cost, via in adj.get(u, ()):
            ng = g + cost
            if ng + 1e-12 < gscore.get(v, inf):
                gscore[v] = ng
                prev[v] = (u, via)
                seq += 1
                heapq.heappush(pq, (ng + heuristic(v), seq, ng, v))
    return None, None


def concat_lines(parts: list[LineString]) -> LineString | None:
    coords: list[tuple[float, float]] = []
    for line in parts:
        if line is None or line.is_empty:
            continue
        if line.geom_type == "Point":
            xy = (float(line.x), float(line.y))
            if not coords or coords[-1] != xy:
                coords.append(xy)
            continue
        cs = [(float(x), float(y)) for x, y in line.coords]
        if len(cs) < 2:
            if cs and (not coords or coords[-1] != cs[0]):
                coords.append(cs[0])
            continue
        if not coords:
            coords.extend(cs)
            continue
        if coords[-1] == cs[0]:
            coords.extend(cs[1:])
        elif coords[-1] == cs[-1]:
            coords.extend(cs[-2::-1])
        elif coords[0] == cs[0]:
            coords = list(reversed(coords))
            coords.extend(cs[1:])
        elif coords[0] == cs[-1]:
            coords = list(reversed(coords))
            coords.extend(cs[-2::-1])
        else:
            coords.extend(cs)
    if len(coords) < 2:
        if len(coords) == 1:
            return LineString([coords[0], coords[0]])
        return None
    return LineString(coords)


def looks_like_forbidden_chord(
    coords: list[tuple[float, float]], distance_m: float | None
) -> bool:
    if distance_m is not None and len(coords) <= 2 and 8000.0 < distance_m < 10000.0:
        return True
    att = {
        (round(KOVzHA_ATTACH[0], 5), round(KOVzHA_ATTACH[1], 5)),
        (round(BELOZERSKY_ATTACH[0], 5), round(BELOZERSKY_ATTACH[1], 5)),
    }
    for i in range(len(coords) - 1):
        a = (round(coords[i][0], 5), round(coords[i][1], 5))
        b = (round(coords[i + 1][0], 5), round(coords[i + 1][1], 5))
        if a in att and b in att and a != b:
            if haversine_m(coords[i], coords[i + 1]) > 5000.0:
                return True
    return False


class WrgRouter:
    """In-memory A* over E1 + mesh + along-edge portal hops. Loaded once."""

    def __init__(self, conn: Any, wrg_build_id: int | None = None) -> None:
        self.conn = conn
        self.wrg_build_id = wrg_build_id or self._latest_build()
        self.adj: dict[Hashable, list[tuple[Hashable, float, Via]]] = {}
        self.coords: dict[Hashable, tuple[float, float]] = {}
        self.edge_wkb: dict[int, bytes] = {}
        self.load_ms = 0.0
        self.stats: dict[str, Any] = {}
        self._part_index: dict[tuple[int, int], MeshPartIndex] = {}
        self._load_graph()

    def _latest_build(self) -> int:
        cur = self.conn.cursor()
        cur.execute("SELECT max(wrg_build_id) FROM water.wrg_build")
        row = cur.fetchone()
        if not row or row[0] is None:
            raise RuntimeError("no water.wrg_build row")
        return int(row[0])

    def _load_graph(self) -> None:
        t0 = time.perf_counter()
        cur = self.conn.cursor()
        adj: dict[Hashable, list[tuple[Hashable, float, Via]]] = {}
        coords: dict[Hashable, tuple[float, float]] = {}

        cur.execute("SELECT node_id, ST_X(geom), ST_Y(geom) FROM water.wg_nodes")
        for node_id, x, y in cur:
            coords[e1_node(int(node_id))] = (float(x), float(y))
        n_e1_nodes = len(coords)

        cur.execute(
            """
            SELECT edge_id, from_node_id, to_node_id, length_m, ST_AsBinary(geom)
            FROM water.wg_edges
            """
        )
        n_e1_edges = 0
        for edge_id, frm, to, length_m, geom in cur:
            n_e1_edges += 1
            u, v = e1_node(int(frm)), e1_node(int(to))
            cost = float(length_m)
            eid = int(edge_id)
            if isinstance(geom, str):
                self.edge_wkb[eid] = bytes.fromhex(geom)
            else:
                self.edge_wkb[eid] = bytes(geom)
            adj.setdefault(u, []).append((v, cost, Via("e1", eid, 0.0, 1.0)))
            adj.setdefault(v, []).append((u, cost, Via("e1", eid, 1.0, 0.0)))

        cur.execute(
            """
            SELECT area_id, part, vertex_id, ST_X(geom), ST_Y(geom)
            FROM water.wrg_mesh_vertices
            WHERE wrg_build_id = %s
            """,
            (self.wrg_build_id,),
        )
        n_mesh_verts = 0
        for area_id, part, vertex_id, x, y in cur:
            n_mesh_verts += 1
            coords[mesh_node(int(area_id), int(part), int(vertex_id))] = (
                float(x),
                float(y),
            )

        cur.execute(
            """
            SELECT area_id, part, v0, v1, v2
            FROM water.wrg_mesh_triangles
            WHERE wrg_build_id = %s
            """,
            (self.wrg_build_id,),
        )
        seen_mesh: set[tuple[int, int, int, int]] = set()
        n_mesh_edges = 0
        for area_id, part, v0, v1, v2 in cur:
            aid, pt = int(area_id), int(part)
            for a, b in ((int(v0), int(v1)), (int(v1), int(v2)), (int(v2), int(v0))):
                lo, hi = (a, b) if a < b else (b, a)
                key = (aid, pt, lo, hi)
                if key in seen_mesh:
                    continue
                seen_mesh.add(key)
                na, nb = mesh_node(aid, pt, a), mesh_node(aid, pt, b)
                ca, cb = coords.get(na), coords.get(nb)
                if ca is None or cb is None:
                    continue
                cost = haversine_m(ca, cb)
                adj.setdefault(na, []).append((nb, cost, VIA_MESH))
                adj.setdefault(nb, []).append((na, cost, VIA_MESH))
                n_mesh_edges += 1

        cur.execute(
            """
            SELECT mp.area_id, mp.part, mp.vertex_id,
                   wp.edge_id, wp.from_node_id, wp.to_node_id, e.length_m,
                   ST_LineLocatePoint(e.geom, mp.attach_geom) AS t
            FROM water.wrg_mesh_portals mp
            JOIN water.wrg_portals wp
              ON wp.wrg_build_id = mp.wrg_build_id AND wp.portal_id = mp.portal_id
            JOIN water.wg_edges e ON e.edge_id = wp.edge_id
            WHERE mp.wrg_build_id = %s
            """,
            (self.wrg_build_id,),
        )
        n_portals = 0
        for area_id, part, vertex_id, edge_id, frm, to, length_m, t in cur:
            n_portals += 1
            m = mesh_node(int(area_id), int(part), int(vertex_id))
            nf, nt = e1_node(int(frm)), e1_node(int(to))
            eid = int(edge_id)
            tt = float(t)
            L = float(length_m)
            cost_from = max(0.0, tt * L)
            cost_to = max(0.0, (1.0 - tt) * L)
            via_to_from = Via("portal", eid, tt, 0.0)
            via_to_to = Via("portal", eid, tt, 1.0)
            via_from_m = Via("portal", eid, 0.0, tt)
            via_to_m = Via("portal", eid, 1.0, tt)
            adj.setdefault(m, []).append((nf, cost_from, via_to_from))
            adj.setdefault(nf, []).append((m, cost_from, via_from_m))
            adj.setdefault(m, []).append((nt, cost_to, via_to_to))
            adj.setdefault(nt, []).append((m, cost_to, via_to_m))

        self.adj = adj
        self.coords = coords
        self.load_ms = (time.perf_counter() - t0) * 1000.0
        self.stats = {
            "wrg_build_id": self.wrg_build_id,
            "e1_nodes": n_e1_nodes,
            "e1_edges": n_e1_edges,
            "mesh_vertices": n_mesh_verts,
            "mesh_edges": n_mesh_edges,
            "portals": n_portals,
            "adj_nodes": len(adj),
            "load_ms": round(self.load_ms, 1),
        }

    def _component_e1(self, node_id: int) -> int | None:
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT physical_component_id
            FROM water.wrg_unified_e1_node
            WHERE wrg_build_id = %s AND node_id = %s
            """,
            (self.wrg_build_id, int(node_id)),
        )
        row = cur.fetchone()
        return None if row is None else int(row[0])

    def _component_mesh(self, area_id: int, part: int, vertex_id: int) -> int | None:
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT physical_component_id
            FROM water.wrg_unified_mesh_vertex
            WHERE wrg_build_id = %s AND area_id = %s AND part = %s AND vertex_id = %s
            """,
            (self.wrg_build_id, int(area_id), int(part), int(vertex_id)),
        )
        row = cur.fetchone()
        return None if row is None else int(row[0])

    def _binding_from_mesh_triangle(
        self,
        lon_f: float,
        lat_f: float,
        area_id: int,
        part: int,
        triangle_id: int,
        v0: int,
        v1: int,
        v2: int,
    ) -> Binding | None:
        """Click stays. Graph attach is the closest existing triangle edge, not a far vertex."""
        q = (lon_f, lat_f)
        verts: list[tuple[int, tuple[float, float]]] = []
        for vid in (v0, v1, v2):
            xy = self.coords.get(mesh_node(area_id, part, vid))
            if xy is not None:
                verts.append((vid, xy))
        if len(verts) < 2:
            return None
        best_d = float("inf")
        best_attach: tuple[float, float] | None = None
        best_edge: tuple[int, int] | None = None
        n = len(verts)
        for i in range(n):
            for j in range(i + 1, n):
                lo_id, lo_xy = verts[i]
                hi_id, hi_xy = verts[j]
                attach, _t, d = closest_point_on_segment(q, lo_xy, hi_xy)
                edge = (lo_id, hi_id) if lo_id <= hi_id else (hi_id, lo_id)
                if d < best_d or (
                    abs(d - best_d) < 1e-9
                    and (best_edge is None or edge < best_edge)
                ):
                    best_d = d
                    best_attach = attach
                    best_edge = edge
        if best_attach is None or best_edge is None:
            return None
        e0, e1 = best_edge
        e0_xy = self.coords.get(mesh_node(area_id, part, e0))
        e1_xy = self.coords.get(mesh_node(area_id, part, e1))
        if e0_xy is None or e1_xy is None:
            return None
        d0 = haversine_m(q, e0_xy)
        d1 = haversine_m(q, e1_xy)
        closer = e0 if d0 < d1 or (abs(d0 - d1) < 1e-9 and e0 < e1) else e1
        cid = self._component_mesh(area_id, part, closer)
        return Binding(
            kind="mesh",
            lon=lon_f,
            lat=lat_f,
            dist_m=best_d,
            area_id=area_id,
            part=part,
            vertex_id=closer,
            triangle_id=triangle_id,
            snap_lon=best_attach[0],
            snap_lat=best_attach[1],
            edge_v0=e0,
            edge_v1=e1,
            physical_component_id=cid,
        )

    def _click_on_land_near_mapped_water(self, lon_f: float, lat_f: float) -> bool:
        """True on a mapped-lake bank: close to wrg_areas but not covered. Not a river E1 bind."""
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT 1
            FROM water.wrg_areas a
            WHERE a.wrg_build_id = %s
              AND a.geom && ST_Expand(ST_SetSRID(ST_MakePoint(%s, %s), 4326), 0.001)
              AND NOT ST_Covers(
                    a.geom,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                  )
              AND ST_DWithin(
                    a.geom::geography,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography,
                    %s
                  )
            LIMIT 1
            """,
            (
                self.wrg_build_id,
                lon_f,
                lat_f,
                lon_f,
                lat_f,
                lon_f,
                lat_f,
                BIND_MAX_M,
            ),
        )
        return cur.fetchone() is not None

    def _click_in_water_hole(self, lon_f: float, lat_f: float) -> bool:
        """True when the click is land inside a wrg_areas ring (island / hole)."""
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT 1
            FROM water.wrg_areas a
            CROSS JOIN LATERAL ST_Dump(a.geom) d
            WHERE a.wrg_build_id = %s
              AND a.geom && ST_SetSRID(ST_MakePoint(%s, %s), 4326)
              AND ST_Contains(
                    ST_MakePolygon(ST_ExteriorRing(d.geom)),
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                  )
              AND NOT ST_Covers(
                    d.geom,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                  )
            LIMIT 1
            """,
            (self.wrg_build_id, lon_f, lat_f, lon_f, lat_f, lon_f, lat_f),
        )
        return cur.fetchone() is not None

    def _replace_mesh_run_line(
        self,
        run: dict[str, Any],
        mesh_runs: list[dict[str, Any]],
        geom_parts: list[LineString],
        new_line: LineString,
    ) -> None:
        i = int(run["part_index"])
        n = int(run["n_parts"])
        geom_parts[i : i + n] = [new_line]
        delta = n - 1
        run["n_parts"] = 1
        if delta:
            for other in mesh_runs:
                if other is not run and int(other["part_index"]) > i:
                    other["part_index"] = int(other["part_index"]) - delta

    def _attach_click_endpoints(
        self, geometry: LineString | None, ba: Binding, bb: Binding
    ) -> LineString | None:
        """Keep the line at the user click when the stub is CoveredBy the bind part."""
        if geometry is None or geometry.is_empty:
            return geometry
        geom = geometry
        if ba.kind == "mesh" and ba.area_id is not None and ba.part is not None:
            click = (float(ba.lon), float(ba.lat))
            first = (float(geom.coords[0][0]), float(geom.coords[0][1]))
            if not xy_close(click, first, FUNNEL_ENDPOINT_MAX_M):
                stub = LineString([click, first])
                leftover = self._line_leftover_m(stub, int(ba.area_id), int(ba.part))
                if leftover is not None and leftover <= FUNNEL_COVER_MAX_M:
                    geom = LineString(
                        [click] + [(float(x), float(y)) for x, y in geom.coords]
                    )
        if bb.kind == "mesh" and bb.area_id is not None and bb.part is not None:
            click = (float(bb.lon), float(bb.lat))
            last = (float(geom.coords[-1][0]), float(geom.coords[-1][1]))
            if not xy_close(click, last, FUNNEL_ENDPOINT_MAX_M):
                stub = LineString([last, click])
                leftover = self._line_leftover_m(stub, int(bb.area_id), int(bb.part))
                if leftover is not None and leftover <= FUNNEL_COVER_MAX_M:
                    geom = LineString(
                        [(float(x), float(y)) for x, y in geom.coords] + [click]
                    )
        return geom

    def bind(self, lon: float, lat: float) -> Binding | None:
        cur = self.conn.cursor()
        lon_f, lat_f = float(lon), float(lat)
        cur.execute(
            """
            SELECT t.area_id, t.part, t.triangle_id, t.v0, t.v1, t.v2
            FROM water.wrg_mesh_triangles t
            WHERE t.wrg_build_id = %s
              AND ST_Covers(
                    t.geom,
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                  )
            ORDER BY t.area_id, t.part, t.triangle_id
            LIMIT 1
            """,
            (self.wrg_build_id, lon_f, lat_f),
        )
        tri = cur.fetchone()
        if tri is not None:
            bound = self._binding_from_mesh_triangle(
                lon_f,
                lat_f,
                int(tri[0]),
                int(tri[1]),
                int(tri[2]),
                int(tri[3]),
                int(tri[4]),
                int(tri[5]),
            )
            if bound is not None:
                return bound

        cur.execute(
            """
            SELECT a.area_id, n AS part
            FROM water.wrg_areas a
            JOIN LATERAL generate_series(1, GREATEST(ST_NumGeometries(a.geom), 1)) n ON TRUE
            WHERE a.wrg_build_id = %s
              AND a.geom && ST_SetSRID(ST_MakePoint(%s, %s), 4326)
              AND ST_Covers(
                    ST_GeometryN(a.geom, n),
                    ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                  )
              AND EXISTS (
                    SELECT 1 FROM water.wrg_mesh_vertices v
                    WHERE v.wrg_build_id = a.wrg_build_id
                      AND v.area_id = a.area_id
                      AND v.part = n
                  )
            ORDER BY a.area_id, n
            LIMIT 1
            """,
            (self.wrg_build_id, lon_f, lat_f, lon_f, lat_f),
        )
        cover = cur.fetchone()
        if cover is not None:
            area_id, part = int(cover[0]), int(cover[1])
            # Nearest covering-part triangle (not nearest vertex of the whole part).
            cur.execute(
                """
                SELECT triangle_id, v0, v1, v2
                FROM water.wrg_mesh_triangles
                WHERE wrg_build_id = %s AND area_id = %s AND part = %s
                ORDER BY geom <-> ST_SetSRID(ST_MakePoint(%s, %s), 4326),
                         triangle_id
                LIMIT 1
                """,
                (self.wrg_build_id, area_id, part, lon_f, lat_f),
            )
            trow = cur.fetchone()
            if trow is not None:
                bound = self._binding_from_mesh_triangle(
                    lon_f,
                    lat_f,
                    area_id,
                    part,
                    int(trow[0]),
                    int(trow[1]),
                    int(trow[2]),
                    int(trow[3]),
                )
                if bound is not None:
                    return bound

        # Island / hole: honest ENDPOINT_NOT_ON_WATER. Do not E1-steal across land.
        if self._click_in_water_hole(lon_f, lat_f):
            return None
        # Lake bank: inside 25 m of mapped water but not on it. Do not turn land into water.
        if self._click_on_land_near_mapped_water(lon_f, lat_f):
            return None

        # Strict E1 bind: metres, bbox-limited. Not the production 3/10/25 km snap.
        expand_deg = 0.001  # ~111 m latitude; still filtered by BIND_MAX_M
        cur.execute(
            """
            SELECT e.edge_id, e.from_node_id, e.to_node_id, e.length_m,
                   ST_Distance(
                     e.geom::geography,
                     ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                   ) AS dist_m,
                   ST_LineLocatePoint(
                     e.geom,
                     ST_SetSRID(ST_MakePoint(%s, %s), 4326)
                   ) AS t,
                   ST_X(ST_ClosestPoint(e.geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326))),
                   ST_Y(ST_ClosestPoint(e.geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)))
            FROM water.wg_edges e
            WHERE e.geom && ST_Expand(ST_SetSRID(ST_MakePoint(%s, %s), 4326), %s)
            ORDER BY dist_m ASC, e.edge_id ASC
            LIMIT 8
            """,
            (
                lon_f,
                lat_f,
                lon_f,
                lat_f,
                lon_f,
                lat_f,
                lon_f,
                lat_f,
                lon_f,
                lat_f,
                expand_deg,
            ),
        )
        for row in cur.fetchall():
            dist_m = float(row[4])
            if dist_m > BIND_MAX_M:
                continue
            from_id, to_id = int(row[1]), int(row[2])
            cid = self._component_e1(from_id)
            return Binding(
                kind="e1",
                lon=lon_f,
                lat=lat_f,
                dist_m=dist_m,
                edge_id=int(row[0]),
                from_node_id=from_id,
                to_node_id=to_id,
                t=float(row[5]),
                length_m=float(row[3]),
                snap_lon=float(row[6]),
                snap_lat=float(row[7]),
                physical_component_id=cid,
            )
        return None

    def _edge_substring(self, edge_id: int, t0: float, t1: float) -> LineString | None:
        wkb = self.edge_wkb.get(int(edge_id))
        if wkb is None:
            return None
        geom = from_wkb(bytes(wkb))
        if abs(t1 - t0) < ZERO_T:
            return None
        sub = substring(geom, float(t0), float(t1), normalized=True)
        if sub is None or sub.is_empty:
            return None
        if sub.geom_type == "Point":
            return None
        return sub

    def _same_edge_route(self, a: Binding, b: Binding) -> RouteResult | None:
        if a.kind != "e1" or b.kind != "e1":
            return None
        if a.edge_id is None or a.edge_id != b.edge_id:
            return None
        t0, t1 = float(a.t or 0.0), float(b.t or 0.0)
        L = float(a.length_m or 0.0)
        geom = self._edge_substring(int(a.edge_id), t0, t1)
        dist = abs(t1 - t0) * L
        nodes: list[Hashable] = [e1_node(int(a.from_node_id or 0))]
        if abs(t0) > ZERO_T and abs(t0 - 1.0) > ZERO_T:
            nodes = [e1_node(int(a.from_node_id or 0)), e1_node(int(a.to_node_id or 0))]
        return RouteResult(
            status=STATUS_ROUTE_FOUND,
            bind_a=a,
            bind_b=b,
            component_a=a.physical_component_id,
            component_b=b.physical_component_id,
            path_nodes=nodes,
            path_type=("E1",),
            hop_kinds=["e1"],
            e1_hops=1,
            distance_m=dist,
            geometry=geom
            if geom is not None
            else LineString(
                [
                    (a.snap_lon or a.lon, a.snap_lat or a.lat),
                    (b.snap_lon or b.lon, b.snap_lat or b.lat),
                ]
            ),
            detail="same_e1_edge",
        )

    def route(self, a_lon: float, a_lat: float, b_lon: float, b_lat: float) -> RouteResult:
        t_all = time.perf_counter()
        t_bind = time.perf_counter()
        ba = self.bind(a_lon, a_lat)
        bb = self.bind(b_lon, b_lat)
        bind_ms = (time.perf_counter() - t_bind) * 1000.0
        if ba is None or bb is None:
            return RouteResult(
                status=STATUS_ENDPOINT_NOT_ON_WATER,
                bind_a=ba,
                bind_b=bb,
                component_a=None if ba is None else ba.physical_component_id,
                component_b=None if bb is None else bb.physical_component_id,
                bind_ms=bind_ms,
                runtime_ms=(time.perf_counter() - t_all) * 1000.0,
                detail="unbound_endpoint",
            )
        ca, cb = ba.physical_component_id, bb.physical_component_id
        if ca is None or cb is None or ca != cb:
            return RouteResult(
                status=STATUS_NO_WATER_CONNECTION,
                bind_a=ba,
                bind_b=bb,
                component_a=ca,
                component_b=cb,
                bind_ms=bind_ms,
                runtime_ms=(time.perf_counter() - t_all) * 1000.0,
                detail="distinct_physical_component",
            )

        same = self._same_edge_route(ba, bb)
        if same is not None:
            same.bind_ms = bind_ms
            same.runtime_ms = (time.perf_counter() - t_all) * 1000.0
            same.geometry_validation = self._local_geom_validation(same)
            return same

        if (
            ba.kind == "mesh"
            and bb.kind == "mesh"
            and ba.area_id == bb.area_id
            and ba.part == bb.part
            and ba.triangle_id is not None
            and ba.triangle_id == bb.triangle_id
        ):
            geom, dist = self._same_mesh_vertex_geometry(ba, bb)
            res = RouteResult(
                status=STATUS_ROUTE_FOUND,
                bind_a=ba,
                bind_b=bb,
                component_a=ca,
                component_b=cb,
                path_nodes=[mesh_node(int(ba.area_id or 0), int(ba.part or 0), int(ba.vertex_id or 0))],
                path_type=("mesh",),
                mesh_hops=1 if dist > FUNNEL_ENDPOINT_MAX_M else 0,
                distance_m=dist,
                geometry=geom,
                mesh_lines=[] if geom is None else [geom],
                bind_ms=bind_ms,
                runtime_ms=(time.perf_counter() - t_all) * 1000.0,
                detail="same_mesh_triangle",
            )
            res.geometry_validation = self._local_geom_validation(res)
            return res

        dest_xy = (float(bb.lon), float(bb.lat))

        def heuristic(node: Hashable) -> float:
            if node == GOAL or node == START:
                return 0.0
            xy = self.coords.get(node)
            if xy is None:
                return 0.0
            return haversine_m(xy, dest_xy)

        # Temporary START/GOAL — never persisted as topology.
        self.adj.pop(START, None)
        self.adj.pop(GOAL, None)
        self.adj[START] = []
        # Do not append START/GOAL onto existing neighbor lists without cleanup.
        start_links: list[tuple[Hashable, float, Via]] = []
        goal_rev: list[tuple[Hashable, Via, float]] = []

        def link_start(node: Hashable, cost: float, via: Via) -> None:
            start_links.append((node, cost, via))

        def link_goal(node: Hashable, cost: float, via: Via) -> None:
            goal_rev.append((node, via, cost))

        if ba.kind == "mesh":
            vids = {int(ba.vertex_id or 0)}
            if ba.edge_v0 is not None:
                vids.add(int(ba.edge_v0))
            if ba.edge_v1 is not None:
                vids.add(int(ba.edge_v1))
            for vid in sorted(vids):
                n = mesh_node(int(ba.area_id or 0), int(ba.part or 0), vid)
                if n in self.adj or n in self.coords:
                    link_start(n, 0.0, Via("start_stub"))
        else:
            L = float(ba.length_m or 0.0)
            t = float(ba.t or 0.0)
            eid = int(ba.edge_id or 0)
            link_start(e1_node(int(ba.from_node_id or 0)), t * L, Via("start_stub", eid, t, 0.0))
            link_start(e1_node(int(ba.to_node_id or 0)), (1.0 - t) * L, Via("start_stub", eid, t, 1.0))

        if bb.kind == "mesh":
            vids = {int(bb.vertex_id or 0)}
            if bb.edge_v0 is not None:
                vids.add(int(bb.edge_v0))
            if bb.edge_v1 is not None:
                vids.add(int(bb.edge_v1))
            for vid in sorted(vids):
                n = mesh_node(int(bb.area_id or 0), int(bb.part or 0), vid)
                if n in self.adj or n in self.coords:
                    link_goal(n, 0.0, Via("goal_stub"))
        else:
            L = float(bb.length_m or 0.0)
            t = float(bb.t or 0.0)
            eid = int(bb.edge_id or 0)
            link_goal(e1_node(int(bb.from_node_id or 0)), t * L, Via("goal_stub", eid, 0.0, t))
            link_goal(e1_node(int(bb.to_node_id or 0)), (1.0 - t) * L, Via("goal_stub", eid, 1.0, t))

        self.adj[START] = start_links
        self.adj[GOAL] = []
        goal_added: list[Hashable] = []
        for node, via, cost in goal_rev:
            self.adj.setdefault(node, []).append((GOAL, cost, via))
            goal_added.append(node)

        t_search = time.perf_counter()
        try:
            path, dist = astar(self.adj, START, GOAL, heuristic)
        finally:
            for node in goal_added:
                self.adj[node] = [x for x in self.adj[node] if x[0] != GOAL]
            self.adj.pop(START, None)
            self.adj.pop(GOAL, None)
        search_ms = (time.perf_counter() - t_search) * 1000.0

        if path is None or dist is None:
            return RouteResult(
                status=STATUS_NO_WATER_CONNECTION,
                bind_a=ba,
                bind_b=bb,
                component_a=ca,
                component_b=cb,
                bind_ms=bind_ms,
                search_ms=search_ms,
                runtime_ms=(time.perf_counter() - t_all) * 1000.0,
                detail="same_component_no_path",
            )

        nodes = [n for n, _via in path if n not in (START, GOAL)]
        geom_parts: list[LineString] = []
        mesh_lines: list[LineString] = []
        hop_kinds: list[str] = []
        mesh_runs: list[dict[str, Any]] = []
        run: dict[str, Any] | None = None
        mesh_max = 0.0
        prev_node: Hashable | None = None

        def flush_run() -> None:
            nonlocal run
            if run is not None:
                mesh_runs.append(run)
                run = None

        for node, via in path[1:]:
            if via is None:
                if node not in (START, GOAL):
                    prev_node = node
                continue
            kind = via.kind
            if kind in ("start_stub", "goal_stub"):
                flush_run()
                if via.edge_id is not None:
                    sub = self._edge_substring(via.edge_id, via.t0, via.t1)
                    if sub is not None:
                        geom_parts.append(sub)
                        hop_kinds.append("e1")
                prev_node = node if node not in (START, GOAL) else prev_node
                continue
            if kind == "e1" and via.edge_id is not None:
                flush_run()
                sub = self._edge_substring(via.edge_id, via.t0, via.t1)
                if sub is not None:
                    geom_parts.append(sub)
                hop_kinds.append("e1")
            elif kind == "portal" and via.edge_id is not None:
                flush_run()
                sub = self._edge_substring(via.edge_id, via.t0, via.t1)
                if sub is not None:
                    geom_parts.append(sub)
                hop_kinds.append("portal")
            elif kind == "mesh" and prev_node is not None and node not in (START, GOAL):
                ca_xy = self.coords.get(prev_node)
                cb_xy = self.coords.get(node)
                if ca_xy is not None and cb_xy is not None and ca_xy != cb_xy:
                    ln = LineString([ca_xy, cb_xy])
                    if (
                        run is None
                        and isinstance(prev_node, tuple)
                        and prev_node[0] == "m"
                        and isinstance(node, tuple)
                        and node[0] == "m"
                    ):
                        run = {
                            "area_id": int(node[1]),
                            "part": int(node[2]),
                            "vids": [int(prev_node[3]), int(node[3])],
                            "start_xy": ca_xy,
                            "end_xy": cb_xy,
                            "part_index": len(geom_parts),
                            "n_parts": 1,
                        }
                    elif (
                        run is not None
                        and isinstance(node, tuple)
                        and node[0] == "m"
                        and int(node[1]) == run["area_id"]
                        and int(node[2]) == run["part"]
                    ):
                        run["vids"].append(int(node[3]))
                        run["end_xy"] = cb_xy
                        run["n_parts"] += 1
                    else:
                        flush_run()
                    geom_parts.append(ln)
                    mesh_lines.append(ln)
                    mesh_max = max(mesh_max, haversine_m(ca_xy, cb_xy))
                hop_kinds.append("mesh")
            else:
                flush_run()
            if node not in (START, GOAL):
                prev_node = node
        flush_run()

        t_geom = time.perf_counter()
        funnel_meta: dict[str, Any] = {
            "geometry_source": "mesh_vertex",
            "astar_distance_m": round(float(dist), 3),
        }
        vertex_mesh_lines = list(mesh_lines)
        vertex_distance_m = (
            polyline_length_m(
                [(float(x), float(y)) for line in mesh_lines for x, y in line.coords]
            )
            if mesh_lines
            else 0.0
        )
        funnel_meta["vertex_mesh_distance_m"] = round(vertex_distance_m, 3)
        funnel_meta["vertex_mesh_n_coords"] = (
            sum(len(line.coords) for line in mesh_lines) if mesh_lines else 0
        )

        geom_status = STATUS_ROUTE_FOUND
        geom_detail: str | None = None
        if mesh_runs:
            applied, ferr, extra = self._apply_funnel(ba, bb, mesh_runs, geom_parts)
            funnel_meta.update(extra)
            if ferr == "geometry_validation_failed":
                geom_status = STATUS_GEOMETRY_VALIDATION_FAILED
                geom_detail = "funnel_and_vertex_path_invalid"
            elif applied:
                mesh_lines = []
                for run in mesh_runs:
                    i = int(run["part_index"])
                    n = int(run["n_parts"])
                    mesh_lines.extend(geom_parts[i : i + n])
                mesh_max = 0.0
                for ln in mesh_lines:
                    cs = list(ln.coords)
                    for i in range(len(cs) - 1):
                        mesh_max = max(
                            mesh_max,
                            haversine_m(
                                (float(cs[i][0]), float(cs[i][1])),
                                (float(cs[i + 1][0]), float(cs[i + 1][1])),
                            ),
                        )
            else:
                mesh_lines = vertex_mesh_lines

        geometry_ms = (time.perf_counter() - t_geom) * 1000.0
        geometry = self._attach_click_endpoints(concat_lines(geom_parts), ba, bb)
        path_type = compress_layers(nodes)
        if funnel_meta.get("geometry_source") == "funnel":
            funnel_mesh = 0.0
            for run_info in funnel_meta.get("funnel_runs") or []:
                if run_info.get("used") == "funnel" and run_info.get("funnel_length_m") is not None:
                    funnel_mesh += float(run_info["funnel_length_m"])
                elif run_info.get("vertex_path_length_m") is not None:
                    funnel_mesh += float(run_info["vertex_path_length_m"])
            vmesh = float(funnel_meta.get("vertex_mesh_distance_m") or 0.0)
            distance_m = float(dist) - vmesh + funnel_mesh
        else:
            distance_m = float(dist)
        res = RouteResult(
            status=geom_status,
            bind_a=ba,
            bind_b=bb,
            component_a=ca,
            component_b=cb,
            path_nodes=nodes,
            path_type=path_type,
            hop_kinds=hop_kinds,
            e1_hops=sum(1 for k in hop_kinds if k == "e1"),
            mesh_hops=sum(1 for k in hop_kinds if k == "mesh"),
            portal_hops=sum(1 for k in hop_kinds if k == "portal"),
            e1_mesh_transitions=count_e1_mesh_transitions(path_type),
            distance_m=distance_m,
            astar_distance_m=float(dist),
            geometry=geometry,
            mesh_lines=mesh_lines,
            mesh_max_seg_m=mesh_max if mesh_lines else None,
            bind_ms=bind_ms,
            search_ms=search_ms,
            geometry_ms=geometry_ms,
            runtime_ms=(time.perf_counter() - t_all) * 1000.0,
            detail=geom_detail,
        )
        res.geometry_validation = {**self._local_geom_validation(res), **funnel_meta}
        return res

    def _mesh_part_index(self, area_id: int, part: int) -> MeshPartIndex:
        key = (int(area_id), int(part))
        cached = self._part_index.get(key)
        if cached is not None:
            return cached
        cur = self.conn.cursor()
        cur.execute(
            """
            SELECT triangle_id, v0, v1, v2
            FROM water.wrg_mesh_triangles
            WHERE wrg_build_id = %s AND area_id = %s AND part = %s
            """,
            (self.wrg_build_id, key[0], key[1]),
        )
        tris: dict[int, tuple[int, int, int]] = {}
        vids: set[int] = set()
        for triangle_id, v0, v1, v2 in cur:
            tid = int(triangle_id)
            vv = (int(v0), int(v1), int(v2))
            tris[tid] = vv
            vids.update(vv)
        xy: dict[int, tuple[float, float]] = {}
        for vid in vids:
            c = self.coords.get(mesh_node(key[0], key[1], vid))
            if c is not None:
                xy[vid] = c
        idx = MeshPartIndex.from_triangles(key[0], key[1], tris, xy)
        self._part_index[key] = idx
        return idx

    def _line_leftover_m(
        self, line: LineString, area_id: int, part: int
    ) -> float | None:
        if line is None or line.is_empty:
            return None
        cur = self.conn.cursor()
        # ST_Covers first: ST_Difference on axis-aligned 4326 chords can
        # return the whole line even when the polygon covers it.
        cur.execute(
            """
            SELECT
              CASE
                WHEN ST_Covers(
                       ST_GeometryN(a.geom, %s),
                       ST_SetSRID(ST_GeomFromWKB(%s), 4326)
                     )
                THEN 0::double precision
                ELSE ST_Length(
                       ST_Difference(
                         ST_SetSRID(ST_GeomFromWKB(%s), 4326),
                         ST_GeometryN(a.geom, %s)
                       )::geography
                     )
              END AS leftover_m
            FROM water.wrg_areas a
            WHERE a.wrg_build_id = %s AND a.area_id = %s
            """,
            (
                int(part),
                bytes(line.wkb),
                bytes(line.wkb),
                int(part),
                self.wrg_build_id,
                int(area_id),
            ),
        )
        row = cur.fetchone()
        if row is None or row[0] is None:
            return None
        return float(row[0])

    def _line_ok(
        self,
        line: LineString,
        area_id: int,
        part: int,
        start_xy: tuple[float, float],
        end_xy: tuple[float, float],
    ) -> tuple[bool, dict[str, Any]]:
        info: dict[str, Any] = {
            "is_valid": bool(line is not None and line.is_valid and not line.is_empty),
            "leftover_m": None,
            "covered_by_part": False,
            "start_err_m": None,
            "end_err_m": None,
        }
        if line is None or line.is_empty or not line.is_valid:
            return False, info
        coords = [(float(x), float(y)) for x, y in line.coords]
        if len(coords) < 2:
            return False, info
        info["start_err_m"] = round(haversine_m(coords[0], start_xy), 3)
        info["end_err_m"] = round(haversine_m(coords[-1], end_xy), 3)
        leftover = self._line_leftover_m(line, area_id, part)
        info["leftover_m"] = None if leftover is None else round(leftover, 3)
        info["covered_by_part"] = bool(
            leftover is not None and leftover <= FUNNEL_COVER_MAX_M
        )
        ok = (
            info["is_valid"]
            and info["covered_by_part"]
            and info["start_err_m"] <= FUNNEL_ENDPOINT_MAX_M
            and info["end_err_m"] <= FUNNEL_ENDPOINT_MAX_M
        )
        return ok, info

    def _funnel_endpoints(
        self,
        ba: Binding,
        bb: Binding,
        run: dict[str, Any],
        is_first: bool,
        is_last: bool,
    ) -> tuple[tuple[float, float], tuple[float, float], int | None, int | None]:
        start_xy = run["start_xy"]
        end_xy = run["end_xy"]
        start_tid = None
        end_tid = None
        if (
            is_first
            and ba.kind == "mesh"
            and ba.area_id == run["area_id"]
            and ba.part == run["part"]
        ):
            start_xy = (float(ba.lon), float(ba.lat))
            start_tid = ba.triangle_id
        if (
            is_last
            and bb.kind == "mesh"
            and bb.area_id == run["area_id"]
            and bb.part == run["part"]
        ):
            end_xy = (float(bb.lon), float(bb.lat))
            end_tid = bb.triangle_id
        return start_xy, end_xy, start_tid, end_tid

    def _same_mesh_vertex_geometry(
        self, ba: Binding, bb: Binding
    ) -> tuple[LineString, float]:
        """Two clicks that bind to the same vertex: keep the clicks, never collapse to the node."""
        start = (float(ba.lon), float(ba.lat))
        end = (float(bb.lon), float(bb.lat))
        snap = (
            float(ba.snap_lon if ba.snap_lon is not None else ba.lon),
            float(ba.snap_lat if ba.snap_lat is not None else ba.lat),
        )
        area_id, part = int(ba.area_id or 0), int(ba.part or 0)
        if ba.triangle_id is not None and ba.triangle_id == bb.triangle_id:
            # CDT triangle is water; lon/lat chord stays in the triangle if both
            # clicks were ST_Covers'd. Do not collapse to the shared vertex.
            return LineString([start, end]), haversine_m(start, end)
        direct = LineString([start, end])
        ok_direct, _ = self._line_ok(direct, area_id, part, start, end)
        if ok_direct:
            return direct, haversine_m(start, end)
        via_coords = [start]
        if not xy_close(start, snap, FUNNEL_ENDPOINT_MAX_M):
            via_coords.append(snap)
        if not xy_close(via_coords[-1], end, FUNNEL_ENDPOINT_MAX_M):
            via_coords.append(end)
        if len(via_coords) < 2:
            via_coords = [start, end]
        via = LineString(via_coords)
        return via, polyline_length_m([(float(x), float(y)) for x, y in via.coords])

    def _apply_funnel(
        self,
        ba: Binding,
        bb: Binding,
        mesh_runs: list[dict[str, Any]],
        geom_parts: list[LineString],
    ) -> tuple[bool, str | None, dict[str, Any]]:
        extra: dict[str, Any] = {"funnel_runs": []}
        any_applied = False
        for ri, run in enumerate(reversed(mesh_runs)):
            orig_i = len(mesh_runs) - 1 - ri
            i = int(run["part_index"])
            n = int(run["n_parts"])
            vertex_line = concat_lines(geom_parts[i : i + n])
            start_xy, end_xy, start_tid, end_tid = self._funnel_endpoints(
                ba, bb, run, orig_i == 0, orig_i == len(mesh_runs) - 1
            )
            index = self._mesh_part_index(int(run["area_id"]), int(run["part"]))
            pulled = funnel_mesh_run(
                index,
                list(run["vids"]),
                start_xy,
                end_xy,
                start_tid,
                end_tid,
            )
            run_info: dict[str, Any] = {
                "area_id": run["area_id"],
                "part": run["part"],
                **funnel_debug(pulled),
            }
            funnel_line = None
            if pulled.ok and len(pulled.coords) >= 2:
                funnel_line = LineString(pulled.coords)
            funnel_ok, funnel_val = False, {}
            if funnel_line is not None:
                funnel_ok, funnel_val = self._line_ok(
                    funnel_line,
                    int(run["area_id"]),
                    int(run["part"]),
                    start_xy,
                    end_xy,
                )
            run_info["funnel_validation"] = funnel_val
            vertex_ok, vertex_val = False, {}
            if vertex_line is not None:
                vertex_ok, vertex_val = self._line_ok(
                    vertex_line,
                    int(run["area_id"]),
                    int(run["part"]),
                    run["start_xy"],
                    run["end_xy"],
                )
            run_info["vertex_validation"] = vertex_val
            if funnel_ok and funnel_line is not None:
                flen = polyline_length_m(
                    [(float(x), float(y)) for x, y in funnel_line.coords]
                )
                # Compare against the vertex path with the same click endpoints.
                # The raw A* polyline omits click→vertex stubs, so a correct
                # click-to-click funnel was previously rejected as "longer".
                comparable = pulled.vertex_path_fallback or [
                    (float(x), float(y)) for x, y in (vertex_line.coords if vertex_line else [])
                ]
                vlen = polyline_length_m(comparable) if comparable else 0.0
                run_info["vertex_path_with_endpoints_m"] = round(vlen, 3)
                if vlen > 0.0 and flen > vlen + FUNNEL_COVER_MAX_M:
                    funnel_ok = False
                    run_info["funnel_rejected"] = "longer_than_vertex_path"
            if funnel_ok and funnel_line is not None:
                self._replace_mesh_run_line(run, mesh_runs, geom_parts, funnel_line)
                any_applied = True
                extra["geometry_source"] = "funnel"
                run_info["used"] = "funnel"
            elif vertex_ok and vertex_line is not None:
                stubbed = splice_line_endpoints(vertex_line, start_xy, end_xy)
                ok_s, val_s = self._line_ok(
                    stubbed,
                    int(run["area_id"]),
                    int(run["part"]),
                    start_xy,
                    end_xy,
                )
                run_info["endpoint_splice_validation"] = val_s
                self._replace_mesh_run_line(
                    run, mesh_runs, geom_parts, stubbed if ok_s else vertex_line
                )
                run_info["used"] = "mesh_vertex_fallback"
                extra.setdefault("geometry_source", "mesh_vertex_fallback")
            else:
                extra["funnel_runs"].append(run_info)
                extra["geometry_source"] = "invalid"
                return False, "geometry_validation_failed", extra
            extra["funnel_runs"].append(run_info)
        if any_applied and extra.get("geometry_source") != "mesh_vertex_fallback":
            extra["geometry_source"] = "funnel"
        elif not any_applied:
            extra["geometry_source"] = extra.get(
                "geometry_source", "mesh_vertex_fallback"
            )
        return any_applied, None, extra

    def _local_geom_validation(self, res: RouteResult) -> dict[str, Any]:
        g = res.geometry
        coords: list[tuple[float, float]] = []
        if g is not None and not g.is_empty and g.geom_type == "LineString":
            coords = [(float(x), float(y)) for x, y in g.coords]
        forbidden = looks_like_forbidden_chord(coords, res.distance_m)
        return {
            "is_valid": bool(g is not None and g.is_valid and not g.is_empty),
            "geom_type": None if g is None else g.geom_type,
            "n_coords": len(coords),
            "forbidden_chord": forbidden,
            "is_straight_ab": len(coords) <= 2 and (res.distance_m or 0) > 1000,
        }

    def validate_mesh_in_area(
        self, res: RouteResult, osm_id: int | None = None
    ) -> dict[str, Any]:
        """PostGIS: mesh hops CoveredBy the water part they traverse."""
        out: dict[str, Any] = {
            "mesh_hops": res.mesh_hops,
            "mesh_leftover_m": None,
            "mesh_covered": None,
            "osm_id": osm_id,
        }
        if not res.mesh_lines:
            out["mesh_covered"] = True
            out["mesh_leftover_m"] = 0.0
            return out
        from shapely import MultiLineString

        mls = MultiLineString(res.mesh_lines)
        wkb = mls.wkb
        cur = self.conn.cursor()
        area_id = None
        part = None
        if res.bind_a and res.bind_a.kind == "mesh":
            area_id, part = res.bind_a.area_id, res.bind_a.part
        if area_id is None:
            for n in res.path_nodes:
                if isinstance(n, tuple) and n[0] == "m":
                    area_id, part = int(n[1]), int(n[2])
                    break
        if osm_id is not None:
            cur.execute(
                """
                SELECT area_id FROM water.wrg_areas
                WHERE wrg_build_id = %s AND osm_id = %s
                """,
                (self.wrg_build_id, int(osm_id)),
            )
            row = cur.fetchone()
            if row:
                area_id = int(row[0])
        if area_id is None or part is None:
            out["mesh_covered"] = False
            out["detail"] = "no_area_part"
            return out
        cur.execute(
            """
            SELECT
              CASE
                WHEN ST_Covers(
                       ST_GeometryN(a.geom, %s),
                       ST_SetSRID(ST_GeomFromWKB(%s), 4326)
                     )
                THEN 0::double precision
                ELSE ST_Length(
                       ST_Difference(
                         ST_SetSRID(ST_GeomFromWKB(%s), 4326),
                         ST_GeometryN(a.geom, %s)
                       )::geography
                     )
              END AS leftover_m
            FROM water.wrg_areas a
            WHERE a.wrg_build_id = %s AND a.area_id = %s
            """,
            (
                int(part),
                bytes(wkb),
                bytes(wkb),
                int(part),
                self.wrg_build_id,
                int(area_id),
            ),
        )
        row = cur.fetchone()
        leftover = None if row is None or row[0] is None else float(row[0])
        out["mesh_leftover_m"] = leftover
        out["mesh_covered"] = bool(leftover is not None and leftover <= 1.0)
        out["area_id"] = area_id
        out["part"] = part
        return out


def format_case_text(case: dict[str, Any], res: RouteResult) -> str:
    ba, bb = res.bind_a, res.bind_b
    lines = [
        f"=== {case['name']} ===",
        f"input A: {case['a'][0]:.8f} {case['a'][1]:.8f}",
        f"input B: {case['b'][0]:.8f} {case['b'][1]:.8f}",
        f"binding A: {None if ba is None else ba.as_dict()}",
        f"binding B: {None if bb is None else bb.as_dict()}",
        f"status: {res.status} (expect {case['expect']})",
        f"physical_component_ids: {res.component_a} / {res.component_b}",
        f"path_nodes: {len(res.path_nodes)}  path_edges: {max(0, len(res.path_nodes)-1)}",
        f"path_type: {' → '.join(res.path_type) if res.path_type else '—'}",
        f"E1↔mesh transitions: {res.e1_mesh_transitions}  "
        f"(e1_hops={res.e1_hops} mesh_hops={res.mesh_hops} portal_hops={res.portal_hops})",
        f"distance_m: {None if res.distance_m is None else round(res.distance_m, 3)}",
        f"geometry_validation: {res.geometry_validation}",
        f"runtime_ms: bind={res.bind_ms:.1f} search={res.search_ms:.1f} total={res.runtime_ms:.1f}",
    ]
    return "\n".join(lines)


def run_validation(router: WrgRouter) -> dict[str, Any]:
    reports = []
    all_ok = True
    for case in VALIDATION_CASES:
        t0 = time.perf_counter()
        res = router.route(case["a"][0], case["a"][1], case["b"][0], case["b"][1])
        ok = res.status == case["expect"]
        reasons: list[str] = []
        if not ok:
            reasons.append(f"status {res.status} != {case['expect']}")
        expected_pt = case.get("expect_path_type")
        if expected_pt and res.status == STATUS_ROUTE_FOUND:
            if tuple(res.path_type) != tuple(expected_pt):
                ok = False
                reasons.append(f"path_type {res.path_type} != {expected_pt}")
        if case.get("forbid_chord") and res.status == STATUS_ROUTE_FOUND:
            gv = res.geometry_validation
            if gv.get("forbidden_chord") or gv.get("is_straight_ab"):
                ok = False
                reasons.append("forbidden Kovzha–Belozersky land chord")
            if res.mesh_hops < 1:
                ok = False
                reasons.append("expected mesh traversal")
            water = router.validate_mesh_in_area(res, osm_id=1603199)
            res.geometry_validation = {**gv, **water}
            leftover = water.get("mesh_leftover_m")
            if leftover is not None and leftover > 1.0:
                ok = False
                reasons.append(f"mesh leftover {leftover:.1f} m outside Beloye")
        elif case.get("check_beloye_water") and res.status == STATUS_ROUTE_FOUND:
            water = router.validate_mesh_in_area(res, osm_id=1603199)
            res.geometry_validation = {**res.geometry_validation, **water}
            leftover = water.get("mesh_leftover_m")
            if leftover is not None and leftover > 1.0:
                ok = False
                reasons.append(f"mesh leftover {leftover:.1f} m outside water")
        elif res.status == STATUS_ROUTE_FOUND and res.mesh_hops:
            # Vygozero etc.: cover by the bind part.
            water = router.validate_mesh_in_area(res)
            res.geometry_validation = {**res.geometry_validation, **water}
        elapsed = (time.perf_counter() - t0) * 1000.0
        text = format_case_text(case, res)
        print(text)
        print(f"ok: {ok}  case_ms: {elapsed:.1f}" + (f"  reasons: {reasons}" if reasons else ""))
        print()
        all_ok = all_ok and ok
        payload = res.as_dict(include_coords=False)
        payload["ok"] = ok
        payload["reasons"] = reasons
        payload["case_id"] = case["id"]
        payload["case_name"] = case["name"]
        payload["input_a"] = list(case["a"])
        payload["input_b"] = list(case["b"])
        reports.append(payload)
    return {
        "router_version": ROUTER_VERSION,
        "bind_max_m": BIND_MAX_M,
        "graph": router.stats,
        "all_ok": all_ok,
        "cases": reports,
        "limits": [
            "MVP A→B only; no A→B→C, no UI, no production wiring",
            "WRG-005 funnel on A* triangle corridor; vertex path kept as fallback",
            "unmeshed lakes without E1 within 25 m → ENDPOINT_NOT_ON_WATER",
            "portal hop uses along-edge distance, never a geodesic chord to far E1 ends",
            "no new topology edges stored",
            "geometry validation failure is not NO_WATER_CONNECTION",
        ],
    }


def serve_stdio_json(dsn: str, wrg_build_id: int | None) -> int:
    """One JSON object per stdin line → one JSON object on stdout. Demo UI only."""
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        router = WrgRouter(conn, wrg_build_id)
        print(
            f"graph load {router.load_ms:.0f} ms  "
            f"e1_edges={router.stats['e1_edges']}  "
            f"mesh_edges={router.stats['mesh_edges']}  "
            f"portals={router.stats['portals']}",
            file=sys.stderr,
        )
        sys.stdout.write(
            json.dumps({"ready": True, "graph": router.stats}, ensure_ascii=False) + "\n"
        )
        sys.stdout.flush()
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                sys.stdout.write(
                    json.dumps({"status": "BAD_REQUEST", "detail": str(exc)}) + "\n"
                )
                sys.stdout.flush()
                continue
            if req.get("cmd") == "ping":
                sys.stdout.write(json.dumps({"ok": True, "ready": True}) + "\n")
                sys.stdout.flush()
                continue
            res = router.route(
                float(req["a_lon"]),
                float(req["a_lat"]),
                float(req["b_lon"]),
                float(req["b_lat"]),
            )
            sys.stdout.write(
                json.dumps(res.as_dict(include_coords=True), ensure_ascii=False) + "\n"
            )
            sys.stdout.flush()
        return 0
    finally:
        conn.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="WRG-004/005 first-route MVP + funnel (A→B)")
    parser.add_argument("coords", nargs="*", type=float, help="A_LON A_LAT B_LON B_LAT")
    parser.add_argument("--validate", action="store_true", help="run the 5 WRG-004 cases")
    parser.add_argument(
        "--stdio-json",
        action="store_true",
        help="demo adapter: JSON lines on stdin/stdout (does not change routing)",
    )
    parser.add_argument("--dsn", default=None)
    parser.add_argument("--wrg-build-id", type=int, default=None)
    parser.add_argument("--json-out", type=Path, default=None)
    parser.add_argument("--no-geometry-coords", action="store_true")
    args = parser.parse_args()
    if not args.validate and not args.stdio_json and len(args.coords) != 4:
        parser.error("need A_LON A_LAT B_LON B_LAT, or --validate / --stdio-json")

    import psycopg2

    dsn = args.dsn or default_dsn()
    if args.stdio_json:
        return serve_stdio_json(dsn, args.wrg_build_id)
    conn = psycopg2.connect(dsn)
    try:
        router = WrgRouter(conn, args.wrg_build_id)
        print(
            f"graph load {router.load_ms:.0f} ms  "
            f"e1_edges={router.stats['e1_edges']}  "
            f"mesh_edges={router.stats['mesh_edges']}  "
            f"portals={router.stats['portals']}",
            file=sys.stderr,
        )
        if args.validate:
            report = run_validation(router)
            text = json.dumps(report, indent=2, ensure_ascii=False)
            if args.json_out:
                args.json_out.parent.mkdir(parents=True, exist_ok=True)
                args.json_out.write_text(text + "\n", encoding="utf-8")
            return 0 if report["all_ok"] else 2
        res = router.route(args.coords[0], args.coords[1], args.coords[2], args.coords[3])
        if res.status == STATUS_ROUTE_FOUND and res.mesh_hops:
            water = router.validate_mesh_in_area(res)
            res.geometry_validation = {**res.geometry_validation, **water}
        payload = res.as_dict(include_coords=not args.no_geometry_coords)
        text = json.dumps(payload, indent=2, ensure_ascii=False)
        print(text)
        if args.json_out:
            args.json_out.parent.mkdir(parents=True, exist_ok=True)
            args.json_out.write_text(text + "\n", encoding="utf-8")
        return 0 if res.status == STATUS_ROUTE_FOUND else 2
    finally:
        conn.close()


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
