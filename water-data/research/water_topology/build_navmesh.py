"""Build Constrained Delaunay Triangulation (CDT) navmesh and dual graph.

Uses existing polygon geometry (outer shells and inner holes) reconstructed
from OsmStore or passed directly as Shapely Polygon/MultiPolygon.
Builds:
  1. CDT triangles strictly inside water polygons (excluding inner island holes)
  2. Dual graph over triangles sharing an interior mesh edge, with Euclidean /
     projected edge weights for pathfinding.
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
from shapely.geometry import MultiPolygon, Point, Polygon
from shapely.geometry.base import BaseGeometry

from .osm_store import OsmStore
from .rings import reconstruct_relation_geometry

DEFAULT_CRS = "EPSG:32636"


def _round_pt(pt: tuple[float, float], digits: int = 9) -> tuple[float, float]:
    return (round(float(pt[0]), digits), round(float(pt[1]), digits))


def _edge_key(
    a: tuple[float, float], b: tuple[float, float], digits: int = 9
) -> tuple[tuple[float, float], tuple[float, float]]:
    ra, rb = _round_pt(a, digits), _round_pt(b, digits)
    return (ra, rb) if ra <= rb else (rb, ra)


@dataclass
class NavmeshTriangle:
    tri_id: int
    part_index: int
    vertices: tuple[tuple[float, float], tuple[float, float], tuple[float, float]]
    centroid: tuple[float, float]
    area: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "triId": self.tri_id,
            "partIndex": self.part_index,
            "vertices": [list(v) for v in self.vertices],
            "centroid": list(self.centroid),
            "area": self.area,
        }


@dataclass
class DualEdge:
    from_tri: int
    to_tri: int
    portal: tuple[tuple[float, float], tuple[float, float]]
    weight: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "from": self.from_tri,
            "to": self.to_tri,
            "portal": [list(self.portal[0]), list(self.portal[1])],
            "weight": self.weight,
        }


@dataclass
class WaterNavmesh:
    feature_key: str
    crs: str
    part_count: int
    hole_count: int
    triangles: list[NavmeshTriangle] = field(default_factory=list)
    dual_edges: list[DualEdge] = field(default_factory=list)
    adjacency: dict[int, list[tuple[int, float]]] = field(default_factory=dict)

    def find_triangle(self, x: float, y: float) -> int | None:
        pt = Point(x, y)
        for t in self.triangles:
            poly = Polygon(t.vertices)
            if poly.covers(pt):
                return t.tri_id
        return None

    def shortest_triangle_path(self, start_tri: int, goal_tri: int) -> list[int] | None:
        if start_tri == goal_tri:
            return [start_tri] if 0 <= start_tri < len(self.triangles) else None
        gx, gy = self.triangles[goal_tri].centroid
        open_heap: list[tuple[float, float, int]] = [(0.0, 0.0, start_tri)]
        came_from: dict[int, int] = {}
        g_score: dict[int, float] = {start_tri: 0.0}
        while open_heap:
            _f, g, cur = heapq.heappop(open_heap)
            if cur == goal_tri:
                path = [cur]
                while cur in came_from:
                    cur = came_from[cur]
                    path.append(cur)
                path.reverse()
                return path
            if g > g_score.get(cur, math.inf):
                continue
            for nbr, w in self.adjacency.get(cur, ()):
                ng = g + w
                if ng < g_score.get(nbr, math.inf):
                    g_score[nbr] = ng
                    came_from[nbr] = cur
                    nx, ny = self.triangles[nbr].centroid
                    h = math.hypot(nx - gx, ny - gy)
                    heapq.heappush(open_heap, (ng + h, ng, nbr))
        return None

    def to_dict(self) -> dict[str, Any]:
        return {
            "featureKey": self.feature_key,
            "crs": self.crs,
            "summary": {
                "partCount": self.part_count,
                "holeCount": self.hole_count,
                "triangleCount": len(self.triangles),
                "dualEdgeCount": len(self.dual_edges),
            },
            "triangles": [t.to_dict() for t in self.triangles],
            "dualEdges": [e.to_dict() for e in self.dual_edges],
        }


def _extract_polygons(geom: BaseGeometry) -> list[Polygon]:
    if geom is None or geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", ()) if isinstance(g, Polygon)]


def build_navmesh_from_geometry(
    geom: BaseGeometry,
    *,
    feature_key: str = "r399081",
    crs: str = DEFAULT_CRS,
    project_from_wgs84: bool = False,
    simplify_tolerance: float = 0.0,
) -> WaterNavmesh:
    """Triangulate Polygon/MultiPolygon with CDT and build its triangle dual graph."""
    work_geom = geom
    if project_from_wgs84:
        transformer = Transformer.from_crs("EPSG:4326", crs, always_xy=True)
        work_geom = shapely.transform(
            work_geom,
            lambda coords: list(zip(*transformer.transform(coords[:, 0], coords[:, 1]))),
        )

    raw_parts = _extract_polygons(work_geom)
    parts: list[Polygon] = []
    hole_count = 0
    for poly in raw_parts:
        p = poly.simplify(simplify_tolerance, preserve_topology=True) if simplify_tolerance > 0 else poly
        if not p.is_valid:
            p = p.buffer(0)
        for sub in _extract_polygons(p):
            if not sub.is_empty and sub.area > 0:
                parts.append(sub)
                hole_count += len(sub.interiors)

    triangles: list[NavmeshTriangle] = []
    edge_to_tris: dict[tuple[tuple[float, float], tuple[float, float]], list[int]] = defaultdict(list)
    digits = 3 if project_from_wgs84 else 9

    for part_idx, poly in enumerate(parts):
        cdt_collection = shapely.constrained_delaunay_triangles(poly)
        for tri_geom in getattr(cdt_collection, "geoms", ()):
            if not isinstance(tri_geom, Polygon) or tri_geom.is_empty:
                continue
            coords = list(tri_geom.exterior.coords)
            if len(coords) < 4:
                continue
            v0 = (float(coords[0][0]), float(coords[0][1]))
            v1 = (float(coords[1][0]), float(coords[1][1]))
            v2 = (float(coords[2][0]), float(coords[2][1]))
            cx = (v0[0] + v1[0] + v2[0]) / 3.0
            cy = (v0[1] + v1[1] + v2[1]) / 3.0
            area = float(tri_geom.area)
            if area <= 0.0:
                continue
            # Ensure triangle interior is inside the water polygon (not inside a hole)
            if not poly.covers(Point(cx, cy)):
                continue
            tri_id = len(triangles)
            tri = NavmeshTriangle(
                tri_id=tri_id,
                part_index=part_idx,
                vertices=(v0, v1, v2),
                centroid=(cx, cy),
                area=area,
            )
            triangles.append(tri)
            for a, b in ((v0, v1), (v1, v2), (v2, v0)):
                edge_to_tris[_edge_key(a, b, digits)].append(tri_id)

    dual_edges: list[DualEdge] = []
    adjacency: dict[int, list[tuple[int, float]]] = defaultdict(list)
    seen_pairs: set[tuple[int, int]] = set()

    for portal, tri_ids in sorted(edge_to_tris.items(), key=lambda x: x[0]):
        if len(tri_ids) != 2:
            continue
        t_a, t_b = sorted(tri_ids)
        if t_a == t_b or (t_a, t_b) in seen_pairs:
            continue
        seen_pairs.add((t_a, t_b))
        ca = triangles[t_a].centroid
        cb = triangles[t_b].centroid
        w = math.hypot(ca[0] - cb[0], ca[1] - cb[1])
        dual_edges.append(
            DualEdge(
                from_tri=t_a,
                to_tri=t_b,
                portal=portal,
                weight=w,
            )
        )
        adjacency[t_a].append((t_b, w))
        adjacency[t_b].append((t_a, w))

    dual_edges.sort(key=lambda e: (e.from_tri, e.to_tri))
    for k in adjacency:
        adjacency[k].sort(key=lambda x: x[0])

    return WaterNavmesh(
        feature_key=feature_key,
        crs=crs if project_from_wgs84 else "EPSG:4326",
        part_count=len(parts),
        hole_count=hole_count,
        triangles=triangles,
        dual_edges=dual_edges,
        adjacency=dict(adjacency),
    )


def build_seliger_navmesh(
    store: OsmStore,
    relation_id: int = 399081,
    *,
    project_to_utm: bool = True,
    crs: str = DEFAULT_CRS,
) -> WaterNavmesh:
    """Reconstruct relation/399081 geometry from OsmStore and build its CDT navmesh."""
    geom, _meta = reconstruct_relation_geometry(store, relation_id)
    if geom is None or geom.is_empty:
        raise ValueError(f"failed to reconstruct geometry for relation/{relation_id}")
    return build_navmesh_from_geometry(
        geom,
        feature_key=f"r{relation_id}",
        crs=crs,
        project_from_wgs84=project_to_utm,
    )


def main(argv: list[str] | None = None) -> int:
    from .dumps import load_compact_store

    default_store = (
        Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "seliger_store.json.gz"
    )
    p = argparse.ArgumentParser(description="Build CDT navmesh and dual graph for Seliger.")
    p.add_argument("--relation-id", type=int, default=399081)
    p.add_argument("--store", default=str(default_store))
    p.add_argument("--wgs84", action="store_true", help="Triangulate in lon/lat instead of UTM")
    p.add_argument("--out", help="Optional path to write navmesh JSON")
    args = p.parse_args(argv)

    store = load_compact_store(Path(args.store))
    mesh = build_seliger_navmesh(
        store,
        relation_id=args.relation_id,
        project_to_utm=not args.wgs84,
    )
    payload = mesh.to_dict()
    if args.out:
        Path(args.out).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(payload["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if __package__ is None or __package__ == "":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from water_topology.build_navmesh import main as _main

        raise SystemExit(_main())
    raise SystemExit(main())
