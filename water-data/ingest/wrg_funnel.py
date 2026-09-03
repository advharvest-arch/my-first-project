#!/usr/bin/env python3
"""
WRG-005 — funnel / string-pulling on an A* triangle corridor.

Geometry only. Does not change the mesh graph, A* costs, binding, or
WRG-001/002/003 tables. Coordinates are converted to a local metric
frame before funnel math; results convert back to lon/lat.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from math import asin, cos, degrees, radians, sin, sqrt
from typing import Any

EARTH_M = 6371000.0
EPS_M = 1e-6
EPS_AREA = 1e-8


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = radians(a[0]), radians(a[1])
    lon2, lat2 = radians(b[0]), radians(b[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    h = sin(dlat / 2.0) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2.0) ** 2
    return 2.0 * EARTH_M * asin(min(1.0, sqrt(h)))


def canon_edge(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def triarea2(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    """CCW area*2: (b-a)×(c-a)."""
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def funnel_area2(a: tuple[float, float], b: tuple[float, float], c: tuple[float, float]) -> float:
    """Mikko/Recast triarea2: (c-a)×(b-a). Sign is opposite of CCW triarea2."""
    ax = b[0] - a[0]
    ay = b[1] - a[1]
    bx = c[0] - a[0]
    by = c[1] - a[1]
    return bx * ay - ax * by


def vequal(a: tuple[float, float], b: tuple[float, float], eps: float = EPS_M) -> bool:
    dx = a[0] - b[0]
    dy = a[1] - b[1]
    return dx * dx + dy * dy <= eps * eps


def polyline_length_m(coords: list[tuple[float, float]]) -> float:
    if len(coords) < 2:
        return 0.0
    return sum(haversine_m(coords[i], coords[i + 1]) for i in range(len(coords) - 1))


def dedupe_coords(coords: list[tuple[float, float]]) -> list[tuple[float, float]]:
    out: list[tuple[float, float]] = []
    for xy in coords:
        if not out or not vequal(out[-1], xy, eps=1e-9):
            out.append(xy)
    return out


@dataclass(frozen=True)
class LocalFrame:
    lon0: float
    lat0: float
    cos_lat: float

    @classmethod
    def from_points(cls, pts: list[tuple[float, float]]) -> LocalFrame:
        if not pts:
            return cls(0.0, 0.0, 1.0)
        lon0 = sum(p[0] for p in pts) / len(pts)
        lat0 = sum(p[1] for p in pts) / len(pts)
        return cls(lon0, lat0, cos(radians(lat0)))

    def to_xy(self, lon: float, lat: float) -> tuple[float, float]:
        x = radians(lon - self.lon0) * EARTH_M * self.cos_lat
        y = radians(lat - self.lat0) * EARTH_M
        return (x, y)

    def to_lonlat(self, x: float, y: float) -> tuple[float, float]:
        lon = self.lon0 + degrees(x / (EARTH_M * self.cos_lat)) if self.cos_lat else self.lon0
        lat = self.lat0 + degrees(y / EARTH_M)
        return (lon, lat)


@dataclass
class MeshPartIndex:
    """Triangles of one (area_id, part). Built from existing WRG-002 rows."""

    area_id: int
    part: int
    tris: dict[int, tuple[int, int, int]]
    xy: dict[int, tuple[float, float]]
    edge_tris: dict[tuple[int, int], list[int]] = field(default_factory=dict)
    dual: dict[int, list[tuple[int, int, int]]] = field(default_factory=dict)
    vert_tris: dict[int, list[int]] = field(default_factory=dict)

    @classmethod
    def from_triangles(
        cls,
        area_id: int,
        part: int,
        tris: dict[int, tuple[int, int, int]],
        xy: dict[int, tuple[float, float]],
    ) -> MeshPartIndex:
        idx = cls(area_id=area_id, part=part, tris=dict(tris), xy=dict(xy))
        edge_tris: dict[tuple[int, int], list[int]] = {}
        vert_tris: dict[int, list[int]] = {}
        for tid, (v0, v1, v2) in idx.tris.items():
            for v in (v0, v1, v2):
                vert_tris.setdefault(v, []).append(tid)
            for a, b in ((v0, v1), (v1, v2), (v2, v0)):
                edge_tris.setdefault(canon_edge(a, b), []).append(tid)
        dual: dict[int, list[tuple[int, int, int]]] = {tid: [] for tid in idx.tris}
        for (lo, hi), tlist in edge_tris.items():
            if len(tlist) != 2:
                continue
            a, b = tlist[0], tlist[1]
            dual[a].append((b, lo, hi))
            dual[b].append((a, lo, hi))
        for v, tlist in vert_tris.items():
            tlist.sort()
            vert_tris[v] = tlist
        idx.edge_tris = edge_tris
        idx.dual = dual
        idx.vert_tris = vert_tris
        return idx


@dataclass
class FunnelResult:
    ok: bool
    coords: list[tuple[float, float]] = field(default_factory=list)
    triangle_ids: list[int] = field(default_factory=list)
    n_portals: int = 0
    reason: str | None = None
    vertex_path_fallback: list[tuple[float, float]] = field(default_factory=list)


def triangle_centroid_xy(
    frame: LocalFrame, xy: dict[int, tuple[float, float]], v0: int, v1: int, v2: int
) -> tuple[float, float]:
    a, b, c = xy[v0], xy[v1], xy[v2]
    p0, p1, p2 = frame.to_xy(*a), frame.to_xy(*b), frame.to_xy(*c)
    return ((p0[0] + p1[0] + p2[0]) / 3.0, (p0[1] + p1[1] + p2[1]) / 3.0)


def orient_portal(
    frame: LocalFrame,
    index: MeshPartIndex,
    from_tid: int,
    edge_lo: int,
    edge_hi: int,
) -> tuple[tuple[float, float], tuple[float, float]]:
    """Return (left, right) in local XY, facing the portal from from_tid."""
    v0, v1, v2 = index.tris[from_tid]
    c = triangle_centroid_xy(frame, index.xy, v0, v1, v2)
    a = frame.to_xy(*index.xy[edge_lo])
    b = frame.to_xy(*index.xy[edge_hi])
    mid = ((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5)
    look = (mid[0] - c[0], mid[1] - c[1])
    left_dir = (-look[1], look[0])
    va = (a[0] - mid[0], a[1] - mid[1])
    if va[0] * left_dir[0] + va[1] * left_dir[1] >= 0.0:
        return a, b
    return b, a


def pick_triangle(
    index: MeshPartIndex, vid: int | None, hint: int | None
) -> int | None:
    if hint is not None and hint in index.tris:
        return hint
    if vid is None:
        return None
    tlist = index.vert_tris.get(vid) or []
    return tlist[0] if tlist else None


def corridor_triangle_ids(
    index: MeshPartIndex,
    path_vids: list[int],
    start_tid: int,
    end_tid: int,
) -> list[int] | None:
    allowed: set[int] = {start_tid, end_tid}
    for vid in path_vids:
        allowed.update(index.vert_tris.get(vid, ()))
    for a, b in zip(path_vids, path_vids[1:]):
        allowed.update(index.edge_tris.get(canon_edge(a, b), ()))
    if start_tid not in index.tris or end_tid not in index.tris:
        return None
    if start_tid == end_tid:
        return [start_tid]
    prev: dict[int, int | None] = {start_tid: None}
    q = [start_tid]
    qi = 0
    while qi < len(q):
        u = q[qi]
        qi += 1
        if u == end_tid:
            break
        for nbr, _lo, _hi in index.dual.get(u, ()):
            if nbr not in allowed or nbr in prev:
                continue
            prev[nbr] = u
            q.append(nbr)
    if end_tid not in prev:
        return None
    out = [end_tid]
    cur: int | None = end_tid
    guard = 0
    while cur != start_tid:
        cur = prev.get(cur)
        if cur is None:
            return None
        out.append(cur)
        guard += 1
        if guard > len(prev) + 2:
            return None
    out.reverse()
    return out


def shared_edge(index: MeshPartIndex, ta: int, tb: int) -> tuple[int, int] | None:
    for nbr, lo, hi in index.dual.get(ta, ()):
        if nbr == tb:
            return lo, hi
    return None


def string_pull(
    start: tuple[float, float],
    portals: list[tuple[tuple[float, float], tuple[float, float]]],
    end: tuple[float, float],
) -> list[tuple[float, float]]:
    """Simple stupid funnel (Mikko Mononen) in local metres. portals are (left, right)."""
    pts: list[tuple[tuple[float, float], tuple[float, float]]] = (
        [(start, start)] + list(portals) + [(end, end)]
    )
    portal_apex = pts[0][0]
    portal_left = pts[0][0]
    portal_right = pts[0][1]
    apex_i = 0
    left_i = 0
    right_i = 0
    out = [portal_apex]
    i = 1
    n = len(pts)
    steps = 0
    limit = max(8, n * n + 8)
    while i < n:
        steps += 1
        if steps > limit:
            break
        left, right = pts[i]
        if funnel_area2(portal_apex, portal_right, right) <= EPS_AREA:
            if vequal(portal_apex, portal_right) or funnel_area2(portal_apex, portal_left, right) > EPS_AREA:
                portal_right = right
                right_i = i
            else:
                if not vequal(out[-1], portal_left):
                    out.append(portal_left)
                portal_apex = portal_left
                apex_i = left_i
                portal_left = portal_apex
                portal_right = portal_apex
                left_i = apex_i
                right_i = apex_i
                i = apex_i + 1
                continue
        if funnel_area2(portal_apex, portal_left, left) >= -EPS_AREA:
            if vequal(portal_apex, portal_left) or funnel_area2(portal_apex, portal_right, left) < -EPS_AREA:
                portal_left = left
                left_i = i
            else:
                if not vequal(out[-1], portal_right):
                    out.append(portal_right)
                portal_apex = portal_right
                apex_i = right_i
                portal_left = portal_apex
                portal_right = portal_apex
                left_i = apex_i
                right_i = apex_i
                i = apex_i + 1
                continue
        i += 1
    last = pts[-1][1]
    if not vequal(out[-1], last):
        out.append(last)
    return dedupe_coords(out)


def vertex_path_coords(
    index: MeshPartIndex,
    path_vids: list[int],
    start_xy: tuple[float, float],
    end_xy: tuple[float, float],
) -> list[tuple[float, float]]:
    coords: list[tuple[float, float]] = [start_xy]
    for vid in path_vids:
        xy = index.xy.get(vid)
        if xy is None:
            continue
        if not coords or (abs(coords[-1][0] - xy[0]) > 1e-12 or abs(coords[-1][1] - xy[1]) > 1e-12):
            coords.append(xy)
    if abs(coords[-1][0] - end_xy[0]) > 1e-12 or abs(coords[-1][1] - end_xy[1]) > 1e-12:
        coords.append(end_xy)
    return coords


def funnel_mesh_run(
    index: MeshPartIndex,
    path_vids: list[int],
    start_xy: tuple[float, float],
    end_xy: tuple[float, float],
    start_triangle_id: int | None,
    end_triangle_id: int | None,
) -> FunnelResult:
    fallback = vertex_path_coords(index, path_vids, start_xy, end_xy)
    if len(path_vids) < 1:
        return FunnelResult(ok=False, reason="empty_vertex_path", vertex_path_fallback=fallback)
    start_tid = pick_triangle(index, path_vids[0], start_triangle_id)
    end_tid = pick_triangle(index, path_vids[-1], end_triangle_id)
    if start_tid is None or end_tid is None:
        return FunnelResult(ok=False, reason="no_start_or_end_triangle", vertex_path_fallback=fallback)
    tri_ids = corridor_triangle_ids(index, path_vids, start_tid, end_tid)
    if not tri_ids:
        return FunnelResult(ok=False, reason="corridor_unreachable", vertex_path_fallback=fallback)

    sample_pts = [start_xy, end_xy]
    for vid in path_vids[:8] + path_vids[-8:]:
        if vid in index.xy:
            sample_pts.append(index.xy[vid])
    frame = LocalFrame.from_points(sample_pts)

    portals: list[tuple[tuple[float, float], tuple[float, float]]] = []
    for ta, tb in zip(tri_ids, tri_ids[1:]):
        edge = shared_edge(index, ta, tb)
        if edge is None:
            return FunnelResult(
                ok=False,
                reason="missing_shared_edge",
                triangle_ids=tri_ids,
                vertex_path_fallback=fallback,
            )
        lo, hi = edge
        if lo == hi:
            continue
        portals.append(orient_portal(frame, index, ta, lo, hi))

    pulled = string_pull(frame.to_xy(*start_xy), portals, frame.to_xy(*end_xy))
    coords = [frame.to_lonlat(x, y) for x, y in pulled]
    coords = dedupe_coords(coords)
    if len(coords) < 2:
        coords = [start_xy, end_xy]
    return FunnelResult(
        ok=True,
        coords=coords,
        triangle_ids=tri_ids,
        n_portals=len(portals),
        vertex_path_fallback=fallback,
    )


def funnel_debug(result: FunnelResult) -> dict[str, Any]:
    return {
        "ok": result.ok,
        "reason": result.reason,
        "n_coords": len(result.coords),
        "n_triangles": len(result.triangle_ids),
        "n_portals": result.n_portals,
        "funnel_length_m": round(polyline_length_m(result.coords), 3) if result.coords else None,
        "vertex_path_length_m": round(polyline_length_m(result.vertex_path_fallback), 3)
        if result.vertex_path_fallback
        else None,
    }
