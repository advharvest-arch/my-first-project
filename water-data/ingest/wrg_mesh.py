#!/usr/bin/env python3
"""
WRG-002 — constrained triangulation mesh (Shapely CDT).

Offline-only geometry. PostGIS remains source of truth for water polygons;
this module triangulates already-dumped polygon parts and attaches portal points.
Does not create hubs, chords, or proximity edges. MultiPolygon parts stay separate.
"""

from __future__ import annotations

from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Any, Iterable

from shapely import GeometryCollection, LineString, Point, Polygon
from shapely import constrained_delaunay_triangles, from_wkb, unary_union
from shapely.errors import GEOSException
from shapely.prepared import prep
from shapely.strtree import STRtree

BUILDER_VERSION = "wrg-002-1"
CDT_SOURCE = "shapely.constrained_delaunay_triangles"


def _xy(coord: Any) -> tuple[float, float]:
    return (float(coord[0]) + 0.0, float(coord[1]) + 0.0)


def signed_area(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def triangle_polygon(
    a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]
) -> Polygon:
    return Polygon([a, b, c, a])


def canonical_ccw(v0: int, v1: int, v2: int) -> tuple[int, int, int]:
    vs = [v0, v1, v2]
    i = vs.index(min(vs))
    return (vs[i], vs[(i + 1) % 3], vs[(i + 2) % 3])


def ring_vertices(coords: Iterable[Any]) -> list[tuple[float, float]]:
    pts = [_xy(c) for c in coords]
    if len(pts) >= 2 and pts[0] == pts[-1]:
        pts = pts[:-1]
    out: list[tuple[float, float]] = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    if len(out) >= 2 and out[0] == out[-1]:
        out = out[:-1]
    return out


def polygon_from_wkb(wkb: bytes | memoryview | None) -> Polygon | None:
    if not wkb:
        return None
    geom = from_wkb(bytes(wkb))
    if geom is None or geom.is_empty:
        return None
    if geom.geom_type != "Polygon":
        return None
    return geom


def point_from_wkb(wkb: bytes | memoryview | None) -> tuple[float, float] | None:
    if not wkb:
        return None
    geom = from_wkb(bytes(wkb))
    if geom is None or geom.is_empty or geom.geom_type != "Point":
        return None
    return _xy(geom.coords[0])


@dataclass
class PortalIn:
    portal_id: int
    xy: tuple[float, float]
    edge_id: int | None = None
    evidence_kind: str | None = None


@dataclass
class PartIn:
    part: int
    polygon: Polygon
    input_npoints: int


@dataclass
class MeshVertex:
    vertex_id: int
    xy: tuple[float, float]
    kind: str
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class MeshTriangle:
    triangle_id: int
    v0: int
    v1: int
    v2: int
    evidence: dict[str, Any] = field(default_factory=dict)

    @property
    def verts(self) -> tuple[int, int, int]:
        return (self.v0, self.v1, self.v2)


@dataclass
class MeshAdjacency:
    triangle_id_a: int
    triangle_id_b: int
    edge_v0: int
    edge_v1: int


@dataclass
class PortalOut:
    portal_id: int
    part: int
    vertex_id: int
    attach_kind: str
    xy: tuple[float, float]
    evidence: dict[str, Any] = field(default_factory=dict)


@dataclass
class PartMesh:
    part: int
    vertices: list[MeshVertex]
    triangles: list[MeshTriangle]
    adjacency: list[MeshAdjacency]
    portals: list[PortalOut]
    diagnostics: dict[str, Any]


@dataclass
class AreaMesh:
    parts: list[PartMesh]
    portals: list[PortalOut]
    diagnostics: dict[str, Any]


def _input_vertices(polygon: Polygon) -> tuple[list[tuple[float, float]], list[str]]:
    xs: list[tuple[float, float]] = []
    kinds: list[str] = []
    seen: set[tuple[float, float]] = set()
    for p in ring_vertices(polygon.exterior.coords):
        if p in seen:
            continue
        seen.add(p)
        xs.append(p)
        kinds.append("boundary")
    for hole in polygon.interiors:
        for p in ring_vertices(hole.coords):
            if p in seen:
                continue
            seen.add(p)
            xs.append(p)
            kinds.append("hole")
    return xs, kinds


def _cdt_triangles(polygon: Polygon) -> tuple[list[tuple[tuple[float, float], ...]], int]:
    rejected = 0
    try:
        raw = constrained_delaunay_triangles(polygon)
    except GEOSException:
        return [], -1
    geoms: list[Any]
    if raw is None or raw.is_empty:
        geoms = []
    elif isinstance(raw, GeometryCollection):
        geoms = list(raw.geoms)
    else:
        geoms = [raw]
    prepared = prep(polygon)
    out: list[tuple[tuple[float, float], ...]] = []
    for g in geoms:
        if g is None or g.is_empty or g.geom_type != "Polygon":
            rejected += 1
            continue
        coords = ring_vertices(g.exterior.coords)
        if len(coords) != 3:
            rejected += 1
            continue
        a, b, c = coords
        area = signed_area(a, b, c)
        if area == 0.0:
            rejected += 1
            continue
        if area < 0:
            a, b, c = a, c, b
        tri = triangle_polygon(a, b, c)
        if tri.area <= 0 or tri.is_empty:
            rejected += 1
            continue
        if not prepared.covers(tri):
            rejected += 1
            continue
        out.append((a, b, c))
    return out, rejected


class _LiveMesh:
    def __init__(
        self,
        vertices: list[tuple[float, float]],
        kinds: list[str],
        triangles: list[tuple[int, int, int]],
    ) -> None:
        self.vertices = list(vertices)
        self.kinds = list(kinds)
        self.index = {p: i for i, p in enumerate(self.vertices)}
        self.triangles: list[tuple[int, int, int] | None] = list(triangles)
        self._locate_cache: (
            tuple[STRtree, list[tuple[int, tuple[int, int, int], Polygon]]] | None
        ) = None

    def add_vertex(self, p: tuple[float, float], kind: str) -> int:
        existing = self.index.get(p)
        if existing is not None:
            return existing
        vid = len(self.vertices)
        self.vertices.append(p)
        self.kinds.append(kind)
        self.index[p] = vid
        return vid

    def _replace(self, old_idx: int, new_tris: list[tuple[int, int, int]]) -> None:
        self.triangles[old_idx] = None
        self.triangles.extend(new_tris)
        self._locate_cache = None

    def _orient(self, v0: int, v1: int, v2: int) -> tuple[int, int, int] | None:
        a, b, c = self.vertices[v0], self.vertices[v1], self.vertices[v2]
        area = signed_area(a, b, c)
        if area == 0.0:
            return None
        if area < 0:
            v0, v1, v2 = v0, v2, v1
        return (v0, v1, v2)

    def live_triangles(self) -> list[tuple[int, int, int]]:
        return [t for t in self.triangles if t is not None]

    def triangle_poly(self, tri: tuple[int, int, int]) -> Polygon:
        a, b, c = (self.vertices[i] for i in tri)
        return triangle_polygon(a, b, c)

    def locate(self, p: tuple[float, float]) -> tuple[str, Any]:
        if p in self.index:
            return "vertex", self.index[p]
        pt = Point(p)
        if self._locate_cache is None:
            live: list[tuple[int, tuple[int, int, int], Polygon]] = []
            polys: list[Polygon] = []
            for i, tri in enumerate(self.triangles):
                if tri is None:
                    continue
                poly = self.triangle_poly(tri)
                live.append((i, tri, poly))
                polys.append(poly)
            if not live:
                return "none", None
            self._locate_cache = (STRtree(polys), live)
        tree, live = self._locate_cache
        for j in tree.query(pt):
            i, tri, poly = live[int(j)]
            if not poly.covers(pt):
                continue
            v0, v1, v2 = tri
            for a, b in ((v0, v1), (v1, v2), (v2, v0)):
                if LineString([self.vertices[a], self.vertices[b]]).covers(pt):
                    return "edge", (i, a, b)
            return "interior", (i, tri)
        return "none", None

    def split_interior(
        self, tri_idx: int, tri: tuple[int, int, int], p: tuple[float, float]
    ) -> int:
        vid = self.add_vertex(p, "portal_steiner")
        v0, v1, v2 = tri
        new = []
        for a, b in ((v0, v1), (v1, v2), (v2, v0)):
            oriented = self._orient(vid, a, b)
            if oriented is None:
                continue
            new.append(oriented)
        self._replace(tri_idx, new)
        return vid

    def split_edge(self, edge: tuple[int, int], p: tuple[float, float]) -> int:
        ea, eb = edge
        vid = self.add_vertex(p, "portal_steiner")
        key = frozenset((ea, eb))
        targets: list[tuple[int, tuple[int, int, int]]] = []
        for i, tri in enumerate(self.triangles):
            if tri is None:
                continue
            edges = (
                frozenset((tri[0], tri[1])),
                frozenset((tri[1], tri[2])),
                frozenset((tri[2], tri[0])),
            )
            if key in edges:
                targets.append((i, tri))
        for i, tri in targets:
            opp = [v for v in tri if v not in (ea, eb)]
            if len(opp) != 1:
                self.triangles[i] = None
                continue
            o = opp[0]
            new = []
            for a, b in ((ea, vid), (vid, eb)):
                oriented = self._orient(o, a, b)
                if oriented is not None:
                    new.append(oriented)
            self._replace(i, new)
        return vid


def _finalize_part(
    part: int,
    mesh: _LiveMesh,
    polygon: Polygon,
    attached: list[tuple[PortalIn, int, str]],
    cdt_rejected: int,
    attach_rejected: int,
) -> PartMesh:
    degenerate = cdt_rejected
    prepared = prep(polygon)
    accepted: list[tuple[int, int, int]] = []
    for tri in mesh.live_triangles():
        v0, v1, v2 = tri
        a, b, c = mesh.vertices[v0], mesh.vertices[v1], mesh.vertices[v2]
        area = signed_area(a, b, c)
        if area == 0.0:
            degenerate += 1
            continue
        if area < 0:
            v0, v1, v2 = v0, v2, v1
            a, b, c = mesh.vertices[v0], mesh.vertices[v1], mesh.vertices[v2]
        poly = triangle_polygon(a, b, c)
        if poly.area <= 0 or not prepared.covers(poly):
            degenerate += 1
            continue
        accepted.append(canonical_ccw(v0, v1, v2))

    accepted.sort()
    triangles = [
        MeshTriangle(triangle_id=i, v0=t[0], v1=t[1], v2=t[2])
        for i, t in enumerate(accepted)
    ]
    edge_map: dict[tuple[int, int], list[int]] = defaultdict(list)
    for t in triangles:
        for a, b in ((t.v0, t.v1), (t.v1, t.v2), (t.v2, t.v0)):
            lo, hi = (a, b) if a < b else (b, a)
            edge_map[(lo, hi)].append(t.triangle_id)
    adjacency: list[MeshAdjacency] = []
    for (lo, hi), tids in edge_map.items():
        uniq = sorted(set(tids))
        for i, a in enumerate(uniq):
            for b in uniq[i + 1 :]:
                adjacency.append(
                    MeshAdjacency(
                        triangle_id_a=a, triangle_id_b=b, edge_v0=lo, edge_v1=hi
                    )
                )
    adjacency.sort(key=lambda x: (x.triangle_id_a, x.triangle_id_b, x.edge_v0, x.edge_v1))

    vertices = [
        MeshVertex(vertex_id=i, xy=xy, kind=kind)
        for i, (xy, kind) in enumerate(zip(mesh.vertices, mesh.kinds))
    ]
    portals = [
        PortalOut(
            portal_id=p.portal_id,
            part=part,
            vertex_id=vid,
            attach_kind=kind,
            xy=p.xy,
            evidence={
                "builder_version": BUILDER_VERSION,
                "edge_id": p.edge_id,
                "evidence_kind": p.evidence_kind,
            },
        )
        for p, vid, kind in attached
    ]
    hole_hits = 0
    covered = 0
    hole_tree = None
    hole_geoms: list[Polygon] = []
    if polygon.interiors:
        hole_geoms = [Polygon(r) for r in polygon.interiors if len(r.coords) >= 4]
        hole_geoms = [h for h in hole_geoms if not h.is_empty]
        if hole_geoms:
            hole_tree = STRtree(hole_geoms)
    for t in triangles:
        poly = triangle_polygon(
            vertices[t.v0].xy, vertices[t.v1].xy, vertices[t.v2].xy
        )
        if prepared.covers(poly):
            covered += 1
        if hole_tree is not None:
            rp = poly.representative_point()
            for j in hole_tree.query(rp):
                hp = hole_geoms[int(j)]
                if hp.covers(rp) and not hp.touches(rp):
                    hole_hits += 1
                    break

    diagnostics = {
        "part": part,
        "input_vertices": None,
        "output_vertices": len(vertices),
        "triangles": len(triangles),
        "adjacency_edges": len(adjacency),
        "portals_attached": len(portals),
        "rejected_degenerate_triangles": degenerate,
        "attach_rejected": attach_rejected,
        "geometry_validation": {
            "all_triangles_covered_by_part": covered == len(triangles),
            "no_triangle_in_hole": hole_hits == 0,
            "covered_count": covered,
            "hole_hits": hole_hits,
            "triangle_count": len(triangles),
        },
        "cdt_source": CDT_SOURCE,
        "builder_version": BUILDER_VERSION,
    }
    return PartMesh(
        part=part,
        vertices=vertices,
        triangles=triangles,
        adjacency=adjacency,
        portals=portals,
        diagnostics=diagnostics,
    )


def build_part_mesh(
    part: PartIn, portals: list[PortalIn]
) -> tuple[PartMesh | None, dict[str, Any]]:
    polygon = part.polygon
    if polygon is None or polygon.is_empty:
        return None, {
            "part": part.part,
            "error": "empty_polygon",
            "rejected_degenerate_triangles": 0,
        }
    verts, kinds = _input_vertices(polygon)
    cdt, cdt_rejected = _cdt_triangles(polygon)
    if cdt_rejected < 0:
        return None, {
            "part": part.part,
            "error": "cdt_failed",
            "rejected_degenerate_triangles": 0,
            "input_vertices": part.input_npoints,
        }
    index = {p: i for i, p in enumerate(verts)}
    tri_ids: list[tuple[int, int, int]] = []
    extra_reject = 0
    for a, b, c in cdt:
        try:
            ia, ib, ic = index[a], index[b], index[c]
        except KeyError:
            extra_reject += 1
            continue
        oriented = (ia, ib, ic)
        if signed_area(verts[ia], verts[ib], verts[ic]) < 0:
            oriented = (ia, ic, ib)
        if oriented[0] == oriented[1] or oriented[1] == oriented[2] or oriented[2] == oriented[0]:
            extra_reject += 1
            continue
        tri_ids.append(oriented)
    mesh = _LiveMesh(verts, kinds, tri_ids)
    attached: list[tuple[PortalIn, int, str]] = []
    attach_rejected = 0
    for portal in sorted(portals, key=lambda p: p.portal_id):
        kind, loc = mesh.locate(portal.xy)
        if kind == "vertex":
            attached.append((portal, int(loc), "existing_vertex"))
        elif kind == "edge":
            _tri_idx, ea, eb = loc
            vid = mesh.split_edge((ea, eb), portal.xy)
            attached.append((portal, vid, "edge_split"))
        elif kind == "interior":
            tri_idx, tri = loc
            vid = mesh.split_interior(int(tri_idx), tri, portal.xy)
            attached.append((portal, vid, "interior_split"))
        else:
            attach_rejected += 1
    result = _finalize_part(
        part.part,
        mesh,
        polygon,
        attached,
        cdt_rejected + extra_reject,
        attach_rejected,
    )
    result.diagnostics["input_vertices"] = part.input_npoints
    result.diagnostics["ring_vertices"] = len(verts)
    return result, result.diagnostics


def assign_portals_to_parts(
    parts: list[PartIn], portals: list[PortalIn]
) -> tuple[dict[int, list[PortalIn]], list[PortalIn]]:
    by_part: dict[int, list[PortalIn]] = {p.part: [] for p in parts}
    rejected: list[PortalIn] = []
    ordered_parts = sorted(parts, key=lambda p: p.part)
    for portal in portals:
        pt = Point(portal.xy)
        hit: int | None = None
        for part in ordered_parts:
            if part.polygon.covers(pt):
                hit = part.part
                break
        if hit is None:
            rejected.append(portal)
        else:
            by_part[hit].append(portal)
    return by_part, rejected


def vertex_connected(
    triangles: list[MeshTriangle], start: int, goal: int
) -> bool:
    if start == goal:
        return True
    adj: dict[int, set[int]] = defaultdict(set)
    for t in triangles:
        for a, b in ((t.v0, t.v1), (t.v1, t.v2), (t.v2, t.v0)):
            adj[a].add(b)
            adj[b].add(a)
    seen = {start}
    q = deque([start])
    while q:
        u = q.popleft()
        for v in adj[u]:
            if v in seen:
                continue
            if v == goal:
                return True
            seen.add(v)
            q.append(v)
    return False


def mesh_edge_exists(
    triangles: list[MeshTriangle], a: int, b: int
) -> bool:
    key = frozenset((a, b))
    for t in triangles:
        for u, v in ((t.v0, t.v1), (t.v1, t.v2), (t.v2, t.v0)):
            if frozenset((u, v)) == key:
                return True
    return False


def first_hole_crossing_pair(
    polygon: Polygon, portals: list[PortalOut]
) -> dict[str, Any] | None:
    holes = [Polygon(r) for r in polygon.interiors if len(r.coords) >= 4]
    holes = [h for h in holes if not h.is_empty]
    if not holes or len(portals) < 2:
        return None
    holes.sort(key=lambda h: h.area, reverse=True)
    ordered = sorted(portals, key=lambda p: p.portal_id)
    if len(ordered) <= 120:
        union = unary_union(holes)
        for i, a in enumerate(ordered):
            for b in ordered[i + 1 :]:
                line = LineString([a.xy, b.xy])
                if line.intersects(union) and not line.touches(union):
                    return {
                        "portal_id_a": a.portal_id,
                        "portal_id_b": b.portal_id,
                        "chord_crosses_hole": True,
                    }
        return None
    for hole in holes[:80]:
        minx, _miny, maxx, _maxy = hole.bounds
        left = [p for p in ordered if p.xy[0] < minx]
        right = [p for p in ordered if p.xy[0] > maxx]
        for a in left[:40]:
            for b in right[:40]:
                line = LineString([a.xy, b.xy])
                if line.intersects(hole) and not line.touches(hole):
                    return {
                        "portal_id_a": a.portal_id,
                        "portal_id_b": b.portal_id,
                        "chord_crosses_hole": True,
                    }
    return None


def build_area_mesh(parts: list[PartIn], portals: list[PortalIn]) -> AreaMesh:
    by_part, uncovered = assign_portals_to_parts(parts, portals)
    part_meshes: list[PartMesh] = []
    all_portals: list[PortalOut] = []
    part_diags: list[dict[str, Any]] = []
    for part in sorted(parts, key=lambda p: p.part):
        mesh, diag = build_part_mesh(part, by_part.get(part.part, []))
        if mesh is None:
            part_diags.append(diag)
            continue
        part_meshes.append(mesh)
        all_portals.extend(mesh.portals)
        part_diags.append(mesh.diagnostics)

    geom_ok = all(
        d.get("geometry_validation", {}).get("all_triangles_covered_by_part") is True
        and d.get("geometry_validation", {}).get("no_triangle_in_hole") is True
        for d in part_diags
        if "geometry_validation" in d
    )
    diagnostics = {
        "parts": len(parts),
        "parts_meshed": len(part_meshes),
        "input_vertices": sum(p.input_npoints for p in parts),
        "output_vertices": sum(len(p.vertices) for p in part_meshes),
        "triangles": sum(len(p.triangles) for p in part_meshes),
        "adjacency_edges": sum(len(p.adjacency) for p in part_meshes),
        "portals_attached": len(all_portals),
        "portals_uncovered": len(uncovered),
        "rejected_degenerate_triangles": sum(
            int(d.get("rejected_degenerate_triangles") or 0) for d in part_diags
        ),
        "geometry_validation": {
            "all_triangles_covered_by_part": geom_ok,
            "no_triangle_in_hole": geom_ok,
            "parts_never_joined": True,
        },
        "part_diagnostics": part_diags,
        "uncovered_portal_ids": [p.portal_id for p in uncovered],
        "builder_version": BUILDER_VERSION,
        "cdt_source": CDT_SOURCE,
    }
    return AreaMesh(parts=part_meshes, portals=all_portals, diagnostics=diagnostics)
