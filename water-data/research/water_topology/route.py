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
from .build_navmesh import (
    DEFAULT_CRS,
    NavmeshTriangle,
    WaterNavmesh,
    build_navmesh_from_geometry,
    _edge_key,
)
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

# Dual-graph penalty for CDT triangles hugging islands / narrow passages.
NARROW_ISLAND_DIST_M = 75.0
NARROW_WEIGHT_FACTOR = 2.0


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

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "lengthM": self.length_m,
            "visitedFeatures": self.visited_features,
            "visitedCorridors": self.visited_corridors,
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

    def _add_undirected(
        self,
        u: tuple[Any, ...],
        v: tuple[Any, ...],
        w: float,
        meta: dict[str, Any],
    ) -> None:
        self.adj[u].append((v, w, meta))
        self.adj[v].append((u, w, meta))

    def _hole_polygons(self, water: BaseGeometry) -> list[Polygon]:
        parts: list[Polygon] = []
        if isinstance(water, Polygon):
            parts = [water]
        else:
            parts = [g for g in getattr(water, "geoms", ()) if isinstance(g, Polygon)]
        holes: list[Polygon] = []
        for poly in parts:
            for ring in poly.interiors:
                if len(ring.coords) >= 4:
                    hole = Polygon(ring)
                    if not hole.is_empty:
                        holes.append(hole)
        return holes

    def _narrow_triangle_ids(self, area_key: str, mesh: WaterNavmesh) -> set[int]:
        """Triangles that share an edge with an inner island, or sit within 75 m of one."""
        water = self.area_polygons.get(area_key)
        if water is None:
            return set()
        holes = self._hole_polygons(water)
        if not holes:
            return set()
        digits = 3 if self.project_from_wgs84 else 9
        inner_edges: set[tuple[tuple[float, float], tuple[float, float]]] = set()
        for hole in holes:
            coords = list(hole.exterior.coords)
            for a, b in zip(coords, coords[1:]):
                inner_edges.add(_edge_key((float(a[0]), float(a[1])), (float(b[0]), float(b[1])), digits))
        holes_union = shapely.union_all(holes) if len(holes) > 1 else holes[0]
        dist_limit = NARROW_ISLAND_DIST_M if self.project_from_wgs84 else 0.0
        narrow: set[int] = set()
        for t in mesh.triangles:
            v0, v1, v2 = t.vertices
            if (
                _edge_key(v0, v1, digits) in inner_edges
                or _edge_key(v1, v2, digits) in inner_edges
                or _edge_key(v2, v0, digits) in inner_edges
            ):
                narrow.add(t.tri_id)
                continue
            if dist_limit > 0.0 and Point(t.centroid).distance(holes_union) < dist_limit:
                narrow.add(t.tri_id)
        return narrow

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
            narrow = self._narrow_triangle_ids(area_key, mesh)
            for de in mesh.dual_edges:
                u = ("tri", area_key, de.from_tri)
                v = ("tri", area_key, de.to_tri)
                self.portal_lookup[(area_key, de.from_tri, de.to_tri)] = de.portal
                self.portal_lookup[(area_key, de.to_tri, de.from_tri)] = de.portal
                w = de.weight
                if de.from_tri in narrow or de.to_tri in narrow:
                    w *= NARROW_WEIGHT_FACTOR
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
