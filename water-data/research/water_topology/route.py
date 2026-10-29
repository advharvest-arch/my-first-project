"""End-to-end water route planner combining WaterFeatureGraph, CDT Navmesh, and Corridors.

Implements:
  1. Unified routing graph over CDT Navmesh triangles, SHARED_NODE / SHARED_WAY
     polygon boundary portals, and ENDPOINT_ON_POLYGON linear waterway corridors.
  2. A* shortest-path search across triangles, portals, and corridor centerlines.
  3. Simple Stupid Funnel (string-pulling) path smoothing inside each polygon's
     free-water triangle sleeve.
  4. Strict edge-case statuses: OK, OUTSIDE_WATER (no snapping from land), NO_PATH.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Point, Polygon
from shapely.geometry.base import BaseGeometry

from .build_corridors import CorridorNetwork, WaterwayCorridor, build_corridors
from .build_navmesh import DEFAULT_CRS, NavmeshTriangle, WaterNavmesh, build_navmesh_from_geometry
from .build_water_graph import (
    ENDPOINT_ON_POLYGON,
    SHARED_NODE,
    SHARED_WAY,
    WaterFeatureGraph,
    build_water_graph,
)
from .osm_store import OsmStore
from .rings import reconstruct_relation_geometry

STATUS_OK = "OK"
STATUS_OUTSIDE_WATER = "OUTSIDE_WATER"
STATUS_NO_PATH = "NO_PATH"

# Dual-graph cost: prefer high clearance from shore / island rings.
# factor(d) = 1 + K / (d + 1); K in the same units as d (metres in EPSG:32636).
CLEARANCE_K = 100.0
# Skip A* seed waypoints that hug the contour within this distance of the boundary.
OPEN_WATER_CLEARANCE_M = 75.0
# Last hop to B only: allow leftover that sits on the bank at B (not mid-chord capes).
GOAL_ENDPOINT_SLOP_M = 20.0


def _tri_area2(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    """Signed 2x triangle area (positive if a -> b -> c is counter-clockwise)."""
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _orient_portal(
    prev_pt: tuple[float, float],
    next_pt: tuple[float, float],
    p0: tuple[float, float],
    p1: tuple[float, float],
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Order portal endpoints (left, right) relative to travel direction prev_pt -> next_pt."""
    dx = next_pt[0] - prev_pt[0]
    dy = next_pt[1] - prev_pt[1]
    c0 = dx * (p0[1] - prev_pt[1]) - dy * (p0[0] - prev_pt[0])
    c1 = dx * (p1[1] - prev_pt[1]) - dy * (p1[0] - prev_pt[0])
    if c0 >= c1:
        return (p0, p1)
    return (p1, p0)


def funnel_smooth(
    start: tuple[float, float],
    goal: tuple[float, float],
    portals: list[tuple[tuple[float, float], tuple[float, float]]],
) -> list[tuple[float, float]]:
    """String-pulling / Simple Stupid Funnel algorithm through an ordered portal sleeve."""
    if not portals:
        return [start, goal] if start != goal else [start]

    pts_left: list[tuple[float, float]] = [start]
    pts_right: list[tuple[float, float]] = [start]
    for left, right in portals:
        pts_left.append(left)
        pts_right.append(right)
    pts_left.append(goal)
    pts_right.append(goal)

    out: list[tuple[float, float]] = [start]
    apex = start
    apex_idx = 0
    left_idx = 0
    right_idx = 0
    left_pt = start
    right_pt = start

    i = 1
    n = len(pts_left)
    while i < n:
        cur_left = pts_left[i]
        cur_right = pts_right[i]

        # Update right vertex
        if _tri_area2(apex, right_pt, cur_right) >= 0.0:
            if apex == right_pt or _tri_area2(apex, left_pt, cur_right) < 0.0:
                right_pt = cur_right
                right_idx = i
            else:
                if left_pt != out[-1]:
                    out.append(left_pt)
                apex = left_pt
                apex_idx = left_idx
                left_pt = apex
                right_pt = apex
                right_idx = apex_idx
                i = apex_idx + 1
                continue

        # Update left vertex
        if _tri_area2(apex, left_pt, cur_left) <= 0.0:
            if apex == left_pt or _tri_area2(apex, right_pt, cur_left) > 0.0:
                left_pt = cur_left
                left_idx = i
            else:
                if right_pt != out[-1]:
                    out.append(right_pt)
                apex = right_pt
                apex_idx = right_idx
                left_pt = apex
                right_pt = apex
                left_idx = apex_idx
                i = apex_idx + 1
                continue

        i += 1

    if out[-1] != goal:
        out.append(goal)
    return out


def has_line_of_sight(
    water: BaseGeometry,
    a: tuple[float, float],
    b: tuple[float, float],
) -> bool:
    """True iff the segment stays inside water (not land, not inner holes)."""
    if a == b:
        return True
    line = LineString([a, b])
    if line.length <= 0.0:
        return True
    # covers: interior + boundary; within alone rejects a line that kisses a shore.
    return bool(water.covers(line))


def _chord_crosses_hole(
    water: BaseGeometry,
    line: LineString,
) -> bool:
    """True if a→b actually enters an island interior (not a mere boundary kiss)."""
    for poly in _iter_polygons(water):
        for interior in poly.interiors:
            hole = Polygon(interior)
            if not hole.is_valid:
                hole = hole.buffer(0)
            if hole.is_empty:
                continue
            inter = line.intersection(hole)
            if inter.is_empty:
                continue
            gtype = getattr(inter, "geom_type", "")
            if gtype in ("Point", "MultiPoint"):
                continue
            return True
    return False


def _leftover_is_only_goal_endpoint_slop(
    leftover: BaseGeometry,
    goal: tuple[float, float],
    slop_m: float,
) -> bool:
    """True iff every land clip of the chord is a short nick at B (bank), not a mid-route cape."""
    if leftover is None or leftover.is_empty:
        return True
    geoms = leftover.geoms if hasattr(leftover, "geoms") else (leftover,)
    goal_pt = Point(goal)
    for g in geoms:
        if g.is_empty:
            continue
        if float(g.length) > slop_m:
            return False
        if goal_pt.distance(g) > slop_m:
            return False
    return True


def has_open_goal_los(
    water: BaseGeometry,
    a: tuple[float, float],
    b: tuple[float, float],
    endpoint_slop_m: float = GOAL_ENDPOINT_SLOP_M,
) -> bool:
    """Straight shot to B only if the chord stays in water.

    Any outer-shore crossing is an obstacle (even 1 m), except a leftover of at
    most ``endpoint_slop_m`` (20 m) that sits on the bank at B. Inner holes always
    block, with no slop.
    """
    if a == b:
        return True
    line = LineString([a, b])
    if line.length <= 0.0:
        return True
    if water.covers(line):
        return True
    if _chord_crosses_hole(water, line):
        return False
    leftover = line.difference(water)
    if leftover.is_empty:
        return True
    return _leftover_is_only_goal_endpoint_slop(leftover, b, endpoint_slop_m)


def los_string_pull(
    water: BaseGeometry,
    pts: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Greedy LOS shortcut: from each kept point jump to the farthest visible later point."""
    if len(pts) <= 2:
        return pts
    out: list[tuple[float, float]] = [pts[0]]
    i = 0
    n = len(pts)
    while i < n - 1:
        j = n - 1
        while j > i + 1 and not has_line_of_sight(water, pts[i], pts[j]):
            j -= 1
        out.append(pts[j])
        i = j
    return out


def _iter_polygons(geom: BaseGeometry):
    if geom is None or geom.is_empty:
        return
    if isinstance(geom, Polygon):
        yield geom
        return
    for g in getattr(geom, "geoms", ()):
        if isinstance(g, Polygon) and not g.is_empty:
            yield g


def _pt_key(p: tuple[float, float]) -> tuple[float, float]:
    return (round(float(p[0]), 3), round(float(p[1]), 3))


def _ring_coords(coords) -> list[tuple[float, float]]:
    pts = [(float(x), float(y)) for x, y in coords]
    if len(pts) >= 2 and pts[0] == pts[-1]:
        pts = pts[:-1]
    return pts


def _obstacle_rings(water: BaseGeometry) -> list[tuple[str, list[tuple[float, float]]]]:
    """Outer shells and inner island holes as (kind, vertices) rings."""
    rings: list[tuple[str, list[tuple[float, float]]]] = []
    for poly in _iter_polygons(water):
        outer = _ring_coords(poly.exterior.coords)
        if len(outer) >= 3:
            rings.append(("shell", outer))
        for interior in poly.interiors:
            verts = _ring_coords(interior.coords)
            if len(verts) >= 3:
                rings.append(("hole", verts))
    return rings


def _dist_to_segment_line(
    origin: tuple[float, float],
    goal: tuple[float, float],
    p: tuple[float, float],
) -> float:
    dx = goal[0] - origin[0]
    dy = goal[1] - origin[1]
    denom = math.hypot(dx, dy)
    if denom <= 1e-12:
        return math.hypot(p[0] - origin[0], p[1] - origin[1])
    return abs(dx * (p[1] - origin[1]) - dy * (p[0] - origin[0])) / denom


def _forward_progress(
    origin: tuple[float, float],
    goal: tuple[float, float],
    p: tuple[float, float],
) -> bool:
    return (p[0] - origin[0]) * (goal[0] - origin[0]) + (p[1] - origin[1]) * (
        goal[1] - origin[1]
    ) > 0.0


def _is_local_tangent(
    origin: tuple[float, float],
    prev: tuple[float, float],
    vertex: tuple[float, float],
    nxt: tuple[float, float],
) -> bool:
    """True if both ring neighbours sit on one side of origin→vertex (supporting vertex)."""
    c_prev = _tri_area2(origin, vertex, prev)
    c_next = _tri_area2(origin, vertex, nxt)
    return c_prev * c_next >= 0.0 and not (c_prev == 0.0 and c_next == 0.0)


def _homotopy_side(
    seed: list[tuple[float, float]],
    origin: tuple[float, float],
    goal: tuple[float, float],
) -> int:
    """+1 if the A* seed first leaves origin→goal to the left, -1 to the right, 0 unknown."""
    dx = goal[0] - origin[0]
    dy = goal[1] - origin[1]
    span = math.hypot(dx, dy) or 1.0
    for p in seed:
        cross = dx * (p[1] - origin[1]) - dy * (p[0] - origin[0])
        if abs(cross) / span > 5.0:
            return 1 if cross > 0.0 else -1
    return 0


def _first_blocking_ring(
    rings: list[tuple[str, list[tuple[float, float]]]],
    origin: tuple[float, float],
    goal: tuple[float, float],
    water: BaseGeometry,
    seed_line: LineString | None,
    seed_max_dist: float = 500.0,
) -> tuple[str, list[tuple[float, float]], BaseGeometry | None] | None:
    """Nearest obstacle ring the chord cuts: island hole or outer-shore cape."""
    line = LineString([origin, goal])
    if water.covers(line):
        return None
    origin_pt = Point(origin)
    leftover = line.difference(water)
    best: tuple[str, list[tuple[float, float]], BaseGeometry | None] | None = None
    best_d = math.inf
    for kind, verts in rings:
        ring_ls = LineString(verts + [verts[0]]) if len(verts) >= 2 else None
        if kind == "hole":
            poly = Polygon(verts)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            inter = line.intersection(poly)
            if inter.is_empty or getattr(inter, "geom_type", "") in ("Point", "MultiPoint"):
                continue
            if seed_line is not None and seed_line.distance(poly) > seed_max_dist:
                continue
            d = origin_pt.distance(inter)
            focus = inter
        else:
            if leftover is None or leftover.is_empty or ring_ls is None:
                continue
            if leftover.distance(ring_ls) > 2.0:
                continue
            d = origin_pt.distance(leftover)
            focus = leftover
        if d < best_d:
            best_d = d
            best = (kind, verts, focus)
    return best


def _pick_tangent_vertex(
    verts: list[tuple[float, float]],
    origin: tuple[float, float],
    goal: tuple[float, float],
    water: BaseGeometry,
    side: int,
    used: set[tuple[float, float]],
    focus: BaseGeometry | None = None,
    focus_max_dist: float = 500.0,
) -> tuple[float, float] | None:
    """Supporting vertex of the blocking ring, on the A* side.

    Only true supporting vertices (both neighbours on one side of origin→vertex).
    Prefer a vertex from which the goal is an open-water shot.
    """
    if has_open_goal_los(water, origin, goal):
        return None
    n = len(verts)
    cands: list[tuple[tuple[float, float], float, float, bool]] = []
    for i, v in enumerate(verts):
        key = _pt_key(v)
        if key in used or key == _pt_key(origin):
            continue
        if focus is not None and focus.distance(Point(v)) > focus_max_dist:
            continue
        if not _forward_progress(origin, goal, v):
            continue
        if not _is_local_tangent(origin, verts[(i - 1) % n], v, verts[(i + 1) % n]):
            continue
        if not has_line_of_sight(water, origin, v):
            continue
        cross = _tri_area2(origin, goal, v)
        dist_line = _dist_to_segment_line(origin, goal, v)
        sees_goal = has_open_goal_los(water, v, goal)
        cands.append((v, cross, dist_line, sees_goal))
    if not cands:
        return None
    if side != 0:
        matching = [c for c in cands if (c[1] > 0.0) == (side > 0)]
        if matching:
            cands = matching
    # Prefer a vertex that already sees B; then the grazing contact (closest to chord).
    cands.sort(key=lambda c: (0 if c[3] else 1, c[2]))
    return cands[0][0]


def _farthest_visible_point(
    water: BaseGeometry,
    origin: tuple[float, float],
    pts: list[tuple[float, float]],
) -> tuple[float, float] | None:
    origin_key = _pt_key(origin)
    goal = pts[-1] if pts else origin
    hug: tuple[float, float] | None = None
    for p in reversed(pts):
        if _pt_key(p) == origin_key:
            continue
        if not has_line_of_sight(water, origin, p):
            continue
        if _pt_key(p) == _pt_key(goal):
            return p
        if Point(p).distance(water.boundary) < OPEN_WATER_CLEARANCE_M:
            if hug is None:
                hug = p
            continue
        return p
    return hug


def vertex_string_pull(
    water: BaseGeometry,
    pts: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """Global rubber-band: walk supporting (tangent) vertices of blocking islands toward the goal.

    A* polyline is kept only as a homotopy hint (which side of an island) and as a
    fallback when the chord leaves the current water body (corridors / other lakes).
    """
    if len(pts) <= 2:
        return pts
    goal = pts[-1]
    rings = _obstacle_rings(water)
    seed_line = LineString(pts) if len(pts) >= 2 else None
    out: list[tuple[float, float]] = [pts[0]]
    current = pts[0]
    used: set[tuple[float, float]] = {_pt_key(current)}
    for _ in range(128):
        # Direct shot to B only when the chord is in water (endpoint slop at B).
        if has_open_goal_los(water, current, goal):
            if _pt_key(out[-1]) != _pt_key(goal):
                out.append(goal)
            return out
        blocked = _first_blocking_ring(rings, current, goal, water, seed_line)
        advanced = False
        if blocked is not None:
            _kind, ring, focus = blocked
            side = _homotopy_side(pts, current, goal)
            v = _pick_tangent_vertex(ring, current, goal, water, side, used, focus=focus)
            if v is not None:
                used.add(_pt_key(v))
                if _pt_key(out[-1]) != _pt_key(v):
                    out.append(v)
                current = v
                advanced = True
        if not advanced:
            nxt = _farthest_visible_point(water, current, pts)
            if nxt is None or _pt_key(nxt) == _pt_key(current):
                break
            if _pt_key(out[-1]) != _pt_key(nxt):
                out.append(nxt)
            current = nxt
            used.add(_pt_key(current))
            if _pt_key(current) == _pt_key(goal):
                return out
    if _pt_key(out[-1]) != _pt_key(goal):
        if has_open_goal_los(water, current, goal):
            out.append(goal)
            return out
        rest = los_string_pull(water, [current, *pts])
        for p in rest[1:]:
            if _pt_key(out[-1]) != _pt_key(p):
                out.append(p)
    return out


def _feature_geometry(store: OsmStore, osm_type: str, osm_id: int) -> Polygon | shapely.MultiPolygon | None:
    if osm_type == "relation":
        geom, _ = reconstruct_relation_geometry(store, osm_id)
        return geom
    if osm_type == "way":
        way = store.ways.get(osm_id)
        if way is None:
            return None
        coords = store.way_coords(way)
        if len(coords) < 4:
            return None
        if coords[0] != coords[-1]:
            coords = [*coords, coords[0]]
        poly = Polygon(coords)
        return poly if poly.is_valid else poly.buffer(0)
    return None


@dataclass
class RouteResult:
    status: str
    coordinates_xy: list[tuple[float, float]] = field(default_factory=list)
    coordinates_lonlat: list[tuple[float, float]] = field(default_factory=list)
    length_m: float = 0.0
    visited_features: list[str] = field(default_factory=list)
    visited_corridors: list[str] = field(default_factory=list)
    visited_triangles: list[tuple[str, int]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "lengthM": self.length_m,
            "visitedFeatures": self.visited_features,
            "visitedCorridors": self.visited_corridors,
            "visitedTriangles": [[k, i] for k, i in self.visited_triangles],
            "pointCount": len(self.coordinates_lonlat or self.coordinates_xy),
            "coordinatesLonLat": [list(p) for p in self.coordinates_lonlat],
            "coordinatesXY": [list(p) for p in self.coordinates_xy],
        }


class UnifiedWaterRouter:
    """Unified router over WaterFeatureGraph, per-area CDT Navmeshes, and Corridors."""

    def __init__(
        self,
        store: OsmStore,
        water_graph: WaterFeatureGraph,
        *,
        navmeshes: dict[str, WaterNavmesh] | None = None,
        corridors: CorridorNetwork | None = None,
        crs: str = DEFAULT_CRS,
        project_from_wgs84: bool = True,
    ) -> None:
        self.store = store
        self.water_graph = water_graph
        self.crs = crs if project_from_wgs84 else "EPSG:4326"
        self.project_from_wgs84 = project_from_wgs84
        self._fwd = (
            Transformer.from_crs("EPSG:4326", crs, always_xy=True) if project_from_wgs84 else None
        )
        self._inv = (
            Transformer.from_crs(crs, "EPSG:4326", always_xy=True) if project_from_wgs84 else None
        )

        # Build or register CDT navmeshes for area features in the graph
        self.navmeshes: dict[str, WaterNavmesh] = dict(navmeshes or {})
        self.area_polygons: dict[str, BaseGeometry] = {}
        for key, node in sorted(self.water_graph.nodes.items()):
            if node.role != "area":
                continue
            geom = _feature_geometry(store, node.osm_type, node.osm_id)
            if geom is None or geom.is_empty:
                continue
            proj = self._project_geom(geom)
            if not proj.is_valid:
                proj = proj.buffer(0)
            self.area_polygons[key] = proj
            if key not in self.navmeshes:
                self.navmeshes[key] = build_navmesh_from_geometry(
                    geom,
                    feature_key=key,
                    crs=crs,
                    project_from_wgs84=project_from_wgs84,
                )

        if corridors is None:
            self.corridors = build_corridors(
                store,
                water_graph,
                navmeshes=self.navmeshes,
                crs=crs,
                project_from_wgs84=project_from_wgs84,
            )
        else:
            self.corridors = corridors

        # Unified routing graph:
        #   node id -> (x, y, feature_key)
        #   state keys:
        #     ("tri", area_key, tri_id)
        #     ("osm_node", node_id)
        #     ("corr_end", corr_key, idx)
        self.state_xy: dict[tuple[Any, ...], tuple[float, float]] = {}
        self.adj: dict[tuple[Any, ...], list[tuple[tuple[Any, ...], float, dict[str, Any]]]] = (
            defaultdict(list)
        )
        self.portal_lookup: dict[
            tuple[str, int, int], tuple[tuple[float, float], tuple[float, float]]
        ] = {}
        self._build_unified_graph()

    def project_pt(self, lon: float, lat: float) -> tuple[float, float]:
        if self._fwd is None:
            return (float(lon), float(lat))
        x, y = self._fwd.transform(lon, lat)
        return (float(x), float(y))

    def unproject_pt(self, x: float, y: float) -> tuple[float, float]:
        if self._inv is None:
            return (float(x), float(y))
        lon, lat = self._inv.transform(x, y)
        return (float(lon), float(lat))

    def _project_geom(self, geom: BaseGeometry) -> BaseGeometry:
        if self._fwd is None:
            return geom
        return shapely.transform(
            geom,
            lambda coords: list(zip(*self._fwd.transform(coords[:, 0], coords[:, 1]))),
        )

    def _water_union(self) -> BaseGeometry | None:
        geoms: list[BaseGeometry] = [
            g for g in self.area_polygons.values() if g is not None and not g.is_empty
        ]
        for corr in self.corridors.corridors.values():
            buf = getattr(corr, "buffer_polygon", None)
            if buf is not None and not buf.is_empty:
                geoms.append(buf)
        if not geoms:
            return None
        merged = geoms[0] if len(geoms) == 1 else shapely.union_all(geoms)
        if not merged.is_valid:
            merged = merged.buffer(0)
        return merged

    def _add_undirected(
        self,
        u: tuple[Any, ...],
        v: tuple[Any, ...],
        w: float,
        meta: dict[str, Any],
    ) -> None:
        self.adj[u].append((v, w, meta))
        self.adj[v].append((u, w, meta))

    def _triangle_clearance(self, area_key: str, centroid: tuple[float, float]) -> float:
        """Metres (or CRS units) from triangle centroid to nearest water boundary or hole."""
        water = self.area_polygons.get(area_key)
        if water is None or water.is_empty:
            return 0.0
        return float(Point(centroid).distance(water.boundary))

    @staticmethod
    def _clearance_factor(clearance: float) -> float:
        return 1.0 + CLEARANCE_K / (clearance + 1.0)

    def _find_boundary_triangle(self, area_key: str, x: float, y: float) -> int | None:
        mesh = self.navmeshes.get(area_key)
        if mesh is None:
            return None
        tid = mesh.find_triangle(x, y)
        if tid is not None:
            return tid
        pt = shapely.Point(x, y)
        best_id: int | None = None
        best_d = math.inf
        for t in mesh.triangles:
            d = float(Polygon(t.vertices).distance(pt))
            if d <= 1e-2 and d < best_d:
                best_d = d
                best_id = t.tri_id
        return best_id

    def _build_unified_graph(self) -> None:
        # 1. Intra-navmesh dual graph edges
        for area_key, mesh in sorted(self.navmeshes.items()):
            for t in mesh.triangles:
                self.state_xy[("tri", area_key, t.tri_id)] = t.centroid
            clearance = {
                t.tri_id: self._triangle_clearance(area_key, t.centroid) for t in mesh.triangles
            }
            for de in mesh.dual_edges:
                u = ("tri", area_key, de.from_tri)
                v = ("tri", area_key, de.to_tri)
                self.portal_lookup[(area_key, de.from_tri, de.to_tri)] = de.portal
                self.portal_lookup[(area_key, de.to_tri, de.from_tri)] = de.portal
                fa = self._clearance_factor(clearance.get(de.from_tri, 0.0))
                fb = self._clearance_factor(clearance.get(de.to_tri, 0.0))
                w = de.weight * 0.5 * (fa + fb)
                self._add_undirected(
                    u,
                    v,
                    w,
                    {"kind": "navmesh_dual", "areaKey": area_key, "portal": de.portal},
                )

        # 2. Cross-feature SHARED_NODE and SHARED_WAY boundary transitions
        for edge in self.water_graph.edges:
            if edge.connection_type == SHARED_NODE:
                node_ids = edge.evidence.get("sharedNodeIds") or [edge.evidence["osmId"]]
                for nid in node_ids:
                    if nid not in self.store.nodes:
                        continue
                    xy = self.project_pt(*self.store.nodes[nid])
                    p_state = ("osm_node", int(nid))
                    self.state_xy[p_state] = xy
                    for ak in (edge.from_key, edge.to_key):
                        tid = self._find_boundary_triangle(ak, xy[0], xy[1])
                        if tid is not None:
                            t_state = ("tri", ak, tid)
                            cx, cy = self.state_xy[t_state]
                            w = math.hypot(cx - xy[0], cy - xy[1])
                            self._add_undirected(
                                t_state,
                                p_state,
                                w,
                                {"kind": "shared_node_portal", "areaKey": ak, "nodeId": int(nid)},
                            )
            elif edge.connection_type == SHARED_WAY:
                way_ids = edge.evidence.get("sharedWayIds") or [edge.evidence["osmId"]]
                for wid in way_ids:
                    way = self.store.ways.get(int(wid))
                    if not way:
                        continue
                    for nid in way.nds:
                        if nid not in self.store.nodes:
                            continue
                        xy = self.project_pt(*self.store.nodes[nid])
                        p_state = ("osm_node", int(nid))
                        self.state_xy[p_state] = xy
                        for ak in (edge.from_key, edge.to_key):
                            tid = self._find_boundary_triangle(ak, xy[0], xy[1])
                            if tid is not None:
                                t_state = ("tri", ak, tid)
                                cx, cy = self.state_xy[t_state]
                                w = math.hypot(cx - xy[0], cy - xy[1])
                                self._add_undirected(
                                    t_state,
                                    p_state,
                                    w,
                                    {"kind": "shared_way_portal", "areaKey": ak, "wayId": int(wid), "nodeId": int(nid)},
                                )

        # 3. Corridor segments and ENDPOINT_ON_POLYGON bindings
        for corr_key, corr in sorted(self.corridors.corridors.items()):
            coords = corr.centerline_coords
            if len(coords) < 2:
                continue
            s0 = ("corr_end", corr_key, 0)
            s1 = ("corr_end", corr_key, 1)
            self.state_xy[s0] = coords[0]
            self.state_xy[s1] = coords[-1]
            self._add_undirected(
                s0,
                s1,
                corr.length_m,
                {"kind": "corridor", "corridorKey": corr_key, "wayId": corr.osm_id},
            )
            for portal in corr.portals:
                tid = portal.navmesh_triangle_id
                if tid is None:
                    tid = self._find_boundary_triangle(portal.area_key, portal.xy[0], portal.xy[1])
                if tid is None:
                    continue
                t_state = ("tri", portal.area_key, tid)
                cx, cy = self.state_xy[t_state]
                p_state = ("osm_node", int(portal.node_id))
                self.state_xy[p_state] = portal.xy
                # Link triangle <-> endpoint node <-> closest corridor end
                w_tri = math.hypot(cx - portal.xy[0], cy - portal.xy[1])
                self._add_undirected(
                    t_state,
                    p_state,
                    w_tri,
                    {
                        "kind": "corridor_portal",
                        "areaKey": portal.area_key,
                        "corridorKey": corr_key,
                        "nodeId": int(portal.node_id),
                    },
                )
                d0 = math.hypot(coords[0][0] - portal.xy[0], coords[0][1] - portal.xy[1])
                d1 = math.hypot(coords[-1][0] - portal.xy[0], coords[-1][1] - portal.xy[1])
                end_state = s0 if d0 <= d1 else s1
                self._add_undirected(
                    p_state,
                    end_state,
                    min(d0, d1),
                    {"kind": "corridor_attach", "corridorKey": corr_key, "nodeId": int(portal.node_id)},
                )

    def locate_water_point(
        self, x: float, y: float
    ) -> tuple[str, str, int | None] | None:
        """Locate (x, y) strictly inside a Navmesh triangle or a Corridor buffer.

        Returns:
          - ("navmesh", area_key, tri_id)
          - ("corridor", corridor_key, None)
          - None if the point is outside water (never snaps from land).
        """
        for area_key, mesh in sorted(self.navmeshes.items()):
            tid = mesh.find_triangle(x, y)
            if tid is not None:
                return ("navmesh", area_key, tid)
        pt = shapely.Point(x, y)
        for corr_key, corr in sorted(self.corridors.corridors.items()):
            if corr.buffer_polygon.covers(pt):
                return ("corridor", corr_key, None)
        return None

    def _smooth_sleeve(
        self,
        area_key: str,
        tri_ids: list[int],
        entry_pt: tuple[float, float],
        exit_pt: tuple[float, float],
    ) -> list[tuple[float, float]]:
        if len(tri_ids) <= 1:
            return [entry_pt, exit_pt] if entry_pt != exit_pt else [entry_pt]
        mesh = self.navmeshes[area_key]
        water = self.area_polygons.get(area_key)
        if water is not None:
            if has_line_of_sight(water, entry_pt, exit_pt):
                return [entry_pt, exit_pt] if entry_pt != exit_pt else [entry_pt]
            waypoints: list[tuple[float, float]] = [entry_pt]
            for tid in tri_ids:
                c = mesh.triangles[tid].centroid
                if math.hypot(c[0] - waypoints[-1][0], c[1] - waypoints[-1][1]) > 1e-6:
                    waypoints.append(c)
            if math.hypot(exit_pt[0] - waypoints[-1][0], exit_pt[1] - waypoints[-1][1]) > 1e-6:
                waypoints.append(exit_pt)
            shortcut = los_string_pull(water, waypoints)
            if len(shortcut) >= 2:
                return shortcut
        portals: list[tuple[tuple[float, float], tuple[float, float]]] = []
        for a_id, b_id in zip(tri_ids, tri_ids[1:]):
            raw_portal = self.portal_lookup.get((area_key, a_id, b_id))
            if raw_portal is None:
                continue
            ca = mesh.triangles[a_id].centroid
            cb = mesh.triangles[b_id].centroid
            portals.append(_orient_portal(ca, cb, raw_portal[0], raw_portal[1]))
        return funnel_smooth(entry_pt, exit_pt, portals)

    def route_xy(
        self,
        start_xy: tuple[float, float],
        goal_xy: tuple[float, float],
    ) -> RouteResult:
        """Route between two projected (x, y) coordinates."""
        loc_start = self.locate_water_point(start_xy[0], start_xy[1])
        loc_goal = self.locate_water_point(goal_xy[0], goal_xy[1])
        if loc_start is None or loc_goal is None:
            return RouteResult(status=STATUS_OUTSIDE_WATER)

        # Trivial same-triangle case
        if loc_start[0] == "navmesh" and loc_goal[0] == "navmesh":
            if loc_start[1] == loc_goal[1] and loc_start[2] == loc_goal[2]:
                pts = [start_xy, goal_xy] if start_xy != goal_xy else [start_xy]
                lonlat = [self.unproject_pt(p[0], p[1]) for p in pts]
                dist = math.hypot(goal_xy[0] - start_xy[0], goal_xy[1] - start_xy[1])
                return RouteResult(
                    status=STATUS_OK,
                    coordinates_xy=pts,
                    coordinates_lonlat=lonlat,
                    length_m=dist,
                    visited_features=[loc_start[1]],
                )

        start_states: list[tuple[tuple[Any, ...], float]] = []
        goal_states: dict[tuple[Any, ...], float] = {}

        def _attach_endpoint(loc: tuple[str, str, int | None], pt: tuple[float, float], is_start: bool) -> None:
            kind, key, tid = loc
            if kind == "navmesh" and tid is not None:
                st = ("tri", key, tid)
                cx, cy = self.state_xy[st]
                d = math.hypot(cx - pt[0], cy - pt[1])
                if is_start:
                    start_states.append((st, d))
                else:
                    goal_states[st] = d
            elif kind == "corridor":
                for idx in (0, 1):
                    st = ("corr_end", key, idx)
                    if st in self.state_xy:
                        cx, cy = self.state_xy[st]
                        d = math.hypot(cx - pt[0], cy - pt[1])
                        if is_start:
                            start_states.append((st, d))
                        else:
                            goal_states[st] = d

        _attach_endpoint(loc_start, start_xy, True)
        _attach_endpoint(loc_goal, goal_xy, False)

        # A* search over the unified graph
        open_heap: list[tuple[float, float, int, tuple[Any, ...]]] = []
        came_from: dict[tuple[Any, ...], tuple[Any, ...]] = {}
        g_score: dict[tuple[Any, ...], float] = {}
        counter = 0

        for st, d0 in start_states:
            g_score[st] = d0
            sx, sy = self.state_xy[st]
            h = math.hypot(sx - goal_xy[0], sy - goal_xy[1])
            heapq.heappush(open_heap, (d0 + h, d0, counter, st))
            counter += 1

        best_goal_state: tuple[Any, ...] | None = None
        best_total = math.inf

        while open_heap:
            f, g, _c, cur = heapq.heappop(open_heap)
            if f >= best_total:
                break
            if cur in goal_states:
                total = g + goal_states[cur]
                if total < best_total:
                    best_total = total
                    best_goal_state = cur
            if g > g_score.get(cur, math.inf):
                continue
            for nbr, w, _meta in self.adj.get(cur, ()):
                ng = g + w
                if ng < g_score.get(nbr, math.inf):
                    g_score[nbr] = ng
                    came_from[nbr] = cur
                    nx, ny = self.state_xy[nbr]
                    h = math.hypot(nx - goal_xy[0], ny - goal_xy[1])
                    heapq.heappush(open_heap, (ng + h, ng, counter, nbr))
                    counter += 1

        if best_goal_state is None:
            return RouteResult(status=STATUS_NO_PATH)

        state_chain: list[tuple[Any, ...]] = [best_goal_state]
        cur_st = best_goal_state
        while cur_st in came_from:
            cur_st = came_from[cur_st]
            state_chain.append(cur_st)
        state_chain.reverse()

        # Reconstruct smoothed trajectory: funnel-smooth each contiguous Navmesh triangle run,
        # and trace centerline coordinates along any Corridor segment.
        coords_xy: list[tuple[float, float]] = [start_xy]
        visited_features: list[str] = []
        visited_corridors: list[str] = []
        visited_triangles: list[tuple[str, int]] = []

        def _append_pts(pts: list[tuple[float, float]]) -> None:
            for p in pts:
                if not coords_xy or math.hypot(p[0] - coords_xy[-1][0], p[1] - coords_xy[-1][1]) > 1e-6:
                    coords_xy.append(p)

        idx = 0
        m = len(state_chain)
        while idx < m:
            st = state_chain[idx]
            if st[0] == "tri":
                area_key = str(st[1])
                if area_key not in visited_features:
                    visited_features.append(area_key)
                run_tris: list[int] = [int(st[2])]
                j = idx + 1
                while j < m and state_chain[j][0] == "tri" and state_chain[j][1] == area_key:
                    run_tris.append(int(state_chain[j][2]))
                    j += 1
                for tid in run_tris:
                    visited_triangles.append((area_key, tid))
                entry_pt = coords_xy[-1]
                exit_pt = self.state_xy[state_chain[j]] if j < m else goal_xy
                smoothed = self._smooth_sleeve(area_key, run_tris, entry_pt, exit_pt)
                _append_pts(smoothed)
                idx = j
            elif st[0] == "osm_node":
                _append_pts([self.state_xy[st]])
                idx += 1
            elif st[0] == "corr_end":
                corr_key = str(st[1])
                if corr_key not in visited_corridors:
                    visited_corridors.append(corr_key)
                corr = self.corridors.corridors[corr_key]
                if idx + 1 < m and state_chain[idx + 1][0] == "corr_end" and state_chain[idx + 1][1] == corr_key:
                    c_pts = list(corr.centerline_coords)
                    if int(st[2]) == 1:
                        c_pts.reverse()
                    _append_pts(c_pts)
                    idx += 2
                else:
                    _append_pts([self.state_xy[st]])
                    idx += 1
            else:
                idx += 1

        _append_pts([goal_xy])

        # Global vertex string-pull: taut path on island-ring vertices (tangents),
        # not on A* triangle centroids.
        water_all = self._water_union()
        if water_all is not None and len(coords_xy) >= 3:
            coords_xy = vertex_string_pull(water_all, coords_xy)

        length_m = 0.0
        for a, b in zip(coords_xy, coords_xy[1:]):
            length_m += math.hypot(b[0] - a[0], b[1] - a[1])
        coords_lonlat = [self.unproject_pt(p[0], p[1]) for p in coords_xy]

        return RouteResult(
            status=STATUS_OK,
            coordinates_xy=coords_xy,
            coordinates_lonlat=coords_lonlat,
            length_m=length_m,
            visited_features=visited_features,
            visited_corridors=visited_corridors,
            visited_triangles=visited_triangles,
        )

    def route_lonlat(
        self,
        start_lonlat: tuple[float, float],
        goal_lonlat: tuple[float, float],
    ) -> RouteResult:
        """Route between two (lon, lat) coordinates in WGS84."""
        s_xy = self.project_pt(start_lonlat[0], start_lonlat[1])
        g_xy = self.project_pt(goal_lonlat[0], goal_lonlat[1])
        return self.route_xy(s_xy, g_xy)


def build_seliger_demo_routes_geojson(router: UnifiedWaterRouter) -> dict[str, Any]:
    """Build a GeoJSON FeatureCollection of reference A* routes for ?waterRouter=1."""
    mesh_sel = router.navmeshes["r399081"]
    south_tris = [t for t in mesh_sel.triangles if t.part_index == 0]
    north_tris = [t for t in mesh_sel.triangles if t.part_index == 1]

    cases = [
        (
            "south-to-north",
            "Селигер Юг → Полоновка → Селигер Север",
            south_tris[0].centroid,
            north_tris[0].centroid,
            "#ef4444",
        ),
        (
            "around-khachin",
            "Обход острова Хачин (внутри Селигера)",
            south_tris[50].centroid,
            south_tris[len(south_tris) // 2].centroid,
            "#0ea5e9",
        ),
        (
            "seliger-knyazha-seremo",
            "Селигер → Княжа → Серемо",
            south_tris[10].centroid,
            router.navmeshes["r9617478"].triangles[0].centroid,
            "#16a34a",
        ),
        (
            "seliger-to-knyazhka",
            "Селигер → Княжа → Серемо → Глубокое → Мелкое → Княжка",
            south_tris[10].centroid,
            router.navmeshes["r18072605"].triangles[0].centroid,
            "#9333ea",
        ),
        (
            "seliger-canal-beloe",
            "Селигер → канал w167688573 → Белое-южное (о. Хачин)",
            south_tris[0].centroid,
            router.navmeshes["w20542134"].triangles[0].centroid,
            "#f59e0b",
        ),
        (
            "seliger-sigovka-sig",
            "Селигер → р. Сиговка → оз. Сиг",
            south_tris[0].centroid,
            router.navmeshes["r399614"].triangles[0].centroid,
            "#ec4899",
        ),
    ]

    features: list[dict[str, Any]] = []
    for route_id, label, s_xy, g_xy, color in cases:
        res = router.route_xy(s_xy, g_xy)
        if res.status != STATUS_OK or len(res.coordinates_lonlat) < 2:
            continue
        coords = [[lon, lat] for lon, lat in res.coordinates_lonlat]
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "water-route",
                    "routeId": route_id,
                    "label": label,
                    "status": res.status,
                    "lengthM": round(res.length_m, 1),
                    "visitedFeatures": res.visited_features,
                    "visitedCorridors": res.visited_corridors,
                    "pointCount": len(coords),
                    "color": color,
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": coords,
                },
            }
        )
        for end_kind, pt in (("start", coords[0]), ("goal", coords[-1])):
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "water-route-endpoint",
                        "endpointRole": end_kind,
                        "routeId": route_id,
                        "label": f"{label} ({end_kind})",
                        "color": color,
                    },
                    "geometry": {
                        "type": "Point",
                        "coordinates": pt,
                    },
                }
            )

    return {
        "type": "FeatureCollection",
        "properties": {
            "seed": "r399081",
            "routeCount": sum(
                1 for f in features if f["properties"].get("kind") == "water-route"
            ),
        },
        "features": features,
    }


def main(argv: list[str] | None = None) -> int:
    from .dumps import load_compact_store

    default_store = (
        Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "seliger_store.json.gz"
    )
    p = argparse.ArgumentParser(description="End-to-end water route planner (Navmesh + Corridors).")
    p.add_argument("--seed", default="relation/399081")
    p.add_argument("--store", default=str(default_store))
    p.add_argument("--from-lonlat", help="lon,lat start coordinate")
    p.add_argument("--to-lonlat", help="lon,lat goal coordinate")
    p.add_argument("--out", help="Optional path to write route JSON")
    p.add_argument(
        "--geojson-out",
        help="Optional path to write demo routes GeoJSON for ?waterRouter=1",
    )
    args = p.parse_args(argv)

    store = load_compact_store(Path(args.store))
    wgraph = build_water_graph(args.seed, store)
    router = UnifiedWaterRouter(store, wgraph)

    if args.geojson_out:
        fc = build_seliger_demo_routes_geojson(router)
        Path(args.geojson_out).write_text(
            json.dumps(fc, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    if args.from_lonlat and args.to_lonlat:
        s_lon, s_lat = (float(x) for x in args.from_lonlat.split(","))
        g_lon, g_lat = (float(x) for x in args.to_lonlat.split(","))
        res = router.route_lonlat((s_lon, s_lat), (g_lon, g_lat))
    else:
        # Default smoke route inside Seliger r399081 -> Knyazha w81753515 -> Seremo r9617478
        t_sel = router.navmeshes["r399081"].triangles[0].centroid
        t_ser = router.navmeshes["r9617478"].triangles[0].centroid
        res = router.route_xy(t_sel, t_ser)

    payload = res.to_dict()
    if args.out:
        Path(args.out).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(
        json.dumps(
            {
                "status": payload["status"],
                "lengthM": round(payload["lengthM"], 2),
                "visitedFeatures": payload["visitedFeatures"],
                "visitedCorridors": payload["visitedCorridors"],
                "pointCount": payload["pointCount"],
            },
            ensure_ascii=False,
        )
    )
    return 0 if res.status == STATUS_OK else 1


if __name__ == "__main__":
    if __package__ is None or __package__ == "":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from water_topology.route import main as _main

        raise SystemExit(_main())
    raise SystemExit(main())
