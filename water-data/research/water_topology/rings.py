"""Assemble multipolygon rings by OSM node-id chaining only.

Ported from the Seliger reconstruction script (/tmp/seliger-osm/reconstruct_seliger.py):
ways are joined only when endpoint node ids match. No distance snap, no names.

Outer rings stay separate polygons (MultiPolygon parts). They are never unioned
just because they share a name.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from shapely.geometry import MultiPolygon, Point, Polygon

from .osm_store import OsmStore, WayRec


def as_closed_coords(nodes: dict[int, tuple[float, float]], nds: list[int]) -> list[tuple[float, float]]:
    coords = [(nodes[n][0], nodes[n][1]) for n in nds if n in nodes]
    if len(coords) < 3:
        return coords
    if coords[0] != coords[-1]:
        coords.append(coords[0])
    return coords


def assemble_rings(
    way_ids: list[int],
    ways: dict[int, WayRec],
    nodes: dict[int, tuple[float, float]],
    role: str,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], dict[str, Any]]:
    """Chain ways into closed rings using endpoint node ids only."""
    issues: list[dict[str, Any]] = []
    rings: list[dict[str, Any]] = []
    missing_ways = [wid for wid in way_ids if wid not in ways]
    missing_nodes = []
    for wid in way_ids:
        way = ways.get(wid)
        if way is None:
            continue
        for nid in way.nds:
            if nid not in nodes:
                missing_nodes.append((wid, nid))
    if missing_ways:
        issues.append({"kind": "missing_way", "role": role, "ids": missing_ways})
    if missing_nodes:
        issues.append(
            {
                "kind": "missing_node",
                "role": role,
                "count": len(missing_nodes),
                "sample": missing_nodes[:10],
            }
        )

    present = [wid for wid in way_ids if wid in ways]
    closed_ids: list[int] = []
    open_ids: list[int] = []
    for wid in present:
        nds = ways[wid].nds
        if len(nds) < 2:
            issues.append({"kind": "too_few_nodes", "role": role, "way": wid, "n": len(nds)})
            continue
        if nds[0] == nds[-1]:
            if len(nds) < 4:
                issues.append({"kind": "degenerate_closed_way", "role": role, "way": wid, "n": len(nds)})
            closed_ids.append(wid)
        else:
            open_ids.append(wid)

    used_ways: set[int] = set()
    for wid in closed_ids:
        rings.append(
            {
                "way_ids": [wid],
                "node_ids": list(ways[wid].nds),
                "closed_by": "single_closed_way",
                "role": role,
                "closed": True,
            }
        )
        used_ways.add(wid)

    inc: dict[int, list[int]] = defaultdict(list)
    for wid in open_ids:
        nds = ways[wid].nds
        a, b = nds[0], nds[-1]
        inc[a].append(wid)
        inc[b].append(wid)

    degree = {nid: len(wids) for nid, wids in inc.items()}
    odd = {nid: d for nid, d in degree.items() if d != 2}
    if odd:
        issues.append(
            {
                "kind": "endpoint_degree_not_2",
                "role": role,
                "count_nodes": len(odd),
                "sample": sorted(odd.items(), key=lambda x: -x[1])[:20],
            }
        )

    unused = set(open_ids)
    while unused:
        start_wid = min(unused)
        unused.remove(start_wid)
        nds0 = list(ways[start_wid].nds)
        chain_ways = [start_wid]
        chain_nds = nds0
        stuck = False
        steps = 0
        max_steps = len(open_ids) + 5
        while chain_nds[0] != chain_nds[-1] and steps < max_steps:
            steps += 1
            progressed = False
            for end_is_tail in (True, False):
                end = chain_nds[-1] if end_is_tail else chain_nds[0]
                cands = [wid for wid in inc.get(end, []) if wid in unused]
                if len(cands) == 0:
                    continue
                if len(cands) > 1:
                    issues.append(
                        {
                            "kind": "ambiguous_endpoint",
                            "role": role,
                            "node": end,
                            "candidates": sorted(cands),
                            "chain_start_way": start_wid,
                        }
                    )
                    stuck = True
                    break
                wid = cands[0]
                wnds = list(ways[wid].nds)
                unused.remove(wid)
                chain_ways.append(wid)
                if end_is_tail:
                    if wnds[0] == end:
                        chain_nds = chain_nds + wnds[1:]
                    elif wnds[-1] == end:
                        chain_nds = chain_nds + list(reversed(wnds))[1:]
                    else:
                        issues.append(
                            {"kind": "endpoint_mismatch", "role": role, "way": wid, "node": end}
                        )
                        stuck = True
                        break
                else:
                    if wnds[-1] == end:
                        chain_nds = wnds[:-1] + chain_nds
                    elif wnds[0] == end:
                        chain_nds = list(reversed(wnds))[:-1] + chain_nds
                    else:
                        issues.append(
                            {"kind": "endpoint_mismatch", "role": role, "way": wid, "node": end}
                        )
                        stuck = True
                        break
                progressed = True
                break
            if stuck:
                break
            if not progressed:
                break
        used_ways.update(chain_ways)
        closed = chain_nds[0] == chain_nds[-1] and len(chain_nds) >= 4
        rings.append(
            {
                "way_ids": chain_ways,
                "node_ids": chain_nds,
                "closed_by": "endpoint_node_id_chain" if closed else "UNCLOSED",
                "role": role,
                "closed": closed,
            }
        )
        if not closed:
            issues.append(
                {
                    "kind": "unclosed_ring",
                    "role": role,
                    "ways": chain_ways,
                    "start_node": chain_nds[0],
                    "end_node": chain_nds[-1],
                    "n_nodes": len(chain_nds),
                }
            )

    unused_after = [wid for wid in present if wid not in used_ways]
    if unused_after:
        issues.append({"kind": "unused_ways", "role": role, "ids": unused_after})

    stats = {
        "member_ways": len(way_ids),
        "unique_member_ways": len(set(way_ids)),
        "present_ways": len(present),
        "closed_single_ways": len(closed_ids),
        "open_ways": len(open_ids),
        "assembled_rings": len(rings),
        "closed_rings": sum(1 for r in rings if r.get("closed")),
        "used_ways": len(used_ways),
    }
    return rings, issues, stats


def _polygon_from_nds(nodes: dict[int, tuple[float, float]], nds: list[int]) -> Polygon | None:
    coords = as_closed_coords(nodes, nds)
    if len(coords) < 4:
        return None
    try:
        poly = Polygon(coords)
        if not poly.is_valid:
            poly = poly.buffer(0)
        if poly.is_empty:
            return None
        if poly.geom_type == "MultiPolygon":
            return max(poly.geoms, key=lambda g: g.area)
        if poly.geom_type == "Polygon":
            return poly
    except Exception:
        return None
    return None


def assign_inners(
    outer_rings: list[dict[str, Any]],
    inner_rings: list[dict[str, Any]],
    nodes: dict[int, tuple[float, float]],
) -> tuple[dict[int, list[int]], list[dict[str, Any]]]:
    """Assign each closed inner ring to at most one outer. No name matching."""
    issues: list[dict[str, Any]] = []
    assignments: dict[int, list[int]] = {i: [] for i in range(len(outer_rings))}
    outer_polys: list[Polygon | None] = []
    outer_node_sets: list[set[int]] = []
    for o in outer_rings:
        outer_node_sets.append(set(o["node_ids"]))
        outer_polys.append(_polygon_from_nds(nodes, o["node_ids"]))

    for ii, inner in enumerate(inner_rings):
        nds = inner["node_ids"]
        hits: list[int] = []
        for oi, _outer in enumerate(outer_rings):
            poly = outer_polys[oi]
            if poly is None:
                continue
            sample = None
            for nid in nds:
                if nid in outer_node_sets[oi]:
                    continue
                if nid not in nodes:
                    continue
                sample = nodes[nid]
                break
            if sample is None:
                ip = _polygon_from_nds(nodes, nds)
                if ip is None:
                    continue
                if poly.contains(ip) or poly.covers(ip):
                    hits.append(oi)
                continue
            if poly.covers(Point(sample[0], sample[1])):
                hits.append(oi)
        if len(hits) == 1:
            assignments[hits[0]].append(ii)
        elif len(hits) == 0:
            issues.append(
                {"kind": "inner_not_inside_any_outer", "inner_index": ii, "ways": inner["way_ids"]}
            )
        else:
            issues.append(
                {
                    "kind": "inner_inside_multiple_outers",
                    "inner_index": ii,
                    "outers": hits,
                    "ways": inner["way_ids"],
                }
            )
    return assignments, issues


def rings_to_multipolygon(
    outer_rings: list[dict[str, Any]],
    inner_rings: list[dict[str, Any]],
    assignments: dict[int, list[int]],
    nodes: dict[int, tuple[float, float]],
) -> tuple[MultiPolygon | Polygon | None, int]:
    """Build a MultiPolygon that keeps each outer as its own part (no dissolve)."""
    parts: list[Polygon] = []
    for oi, outer in enumerate(outer_rings):
        if not outer.get("closed", True):
            continue
        shell = as_closed_coords(nodes, outer["node_ids"])
        if len(shell) < 4:
            continue
        holes = []
        for ii in assignments.get(oi, []):
            inner = inner_rings[ii]
            if not inner.get("closed", True):
                continue
            hole = as_closed_coords(nodes, inner["node_ids"])
            if len(hole) >= 4:
                holes.append(hole)
        try:
            poly = Polygon(shell, holes)
            if not poly.is_valid:
                poly = poly.buffer(0)
            if poly.is_empty:
                continue
            if poly.geom_type == "Polygon":
                parts.append(poly)
            elif poly.geom_type == "MultiPolygon":
                parts.extend(list(poly.geoms))
        except Exception:
            continue
    if not parts:
        return None, 0
    if len(parts) == 1:
        return parts[0], 1
    return MultiPolygon(parts), len(parts)


def reconstruct_relation_geometry(store: OsmStore, relation_id: int):
    """Reconstruct a water relation as separate outer polygons + island inners."""
    rel = store.relations.get(relation_id)
    if rel is None:
        return None, {"error": "missing_relation"}
    outer_ids = [m.ref for m in rel.members if m.type == "way" and (m.role or "outer") == "outer"]
    inner_ids = [m.ref for m in rel.members if m.type == "way" and m.role == "inner"]
    if not outer_ids and rel.members:
        outer_ids = [m.ref for m in rel.members if m.type == "way" and m.role not in {"inner"}]
    outer_rings, outer_issues, outer_stats = assemble_rings(outer_ids, store.ways, store.nodes, "outer")
    inner_rings, inner_issues, inner_stats = assemble_rings(inner_ids, store.ways, store.nodes, "inner")
    assignments, assign_issues = assign_inners(outer_rings, inner_rings, store.nodes)
    geom, part_count = rings_to_multipolygon(outer_rings, inner_rings, assignments, store.nodes)
    island_polys: list[dict[str, Any]] = []
    for ii, inner in enumerate(inner_rings):
        poly = _polygon_from_nds(store.nodes, inner["node_ids"])
        if poly is None:
            continue
        parent_outer = None
        for oi, inn_list in assignments.items():
            if ii in inn_list:
                parent_outer = oi
                break
        island_polys.append(
            {
                "inner_index": ii,
                "way_ids": list(inner["way_ids"]),
                "parent_outer_index": parent_outer,
                "poly": poly,
            }
        )
    meta = {
        "outer_stats": outer_stats,
        "inner_stats": inner_stats,
        "issues": outer_issues + inner_issues + assign_issues,
        "outer_part_count": part_count,
        "outer_rings": outer_rings,
        "inner_rings": inner_rings,
        "assignments": {str(k): v for k, v in assignments.items()},
        "island_polys": island_polys,
    }
    return geom, meta
