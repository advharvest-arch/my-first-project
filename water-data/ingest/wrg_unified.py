#!/usr/bin/env python3
"""
WRG-003 — unified physical connectivity (offline, no routing).

Union-find:
  E1 nodes along wg_edges
  ∪ mesh vertices along triangle sides (same area part only)
  ∪ portal attachment: mesh vertex ↔ E1 edge endpoints

Does not clique-join an area. Does not join MultiPolygon parts.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Hashable, Iterable

BUILDER_VERSION = "wrg-003-1"
INF_NODE = 2**63 - 1
INF_PART = 2**31 - 1


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[Hashable, Hashable] = {}
        self.rank: dict[Hashable, int] = {}

    def add(self, x: Hashable) -> None:
        if x not in self.parent:
            self.parent[x] = x
            self.rank[x] = 0

    def find(self, x: Hashable) -> Hashable:
        self.add(x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: Hashable, b: Hashable) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            self.parent[ra] = rb
        elif self.rank[ra] > self.rank[rb]:
            self.parent[rb] = ra
        else:
            self.parent[rb] = ra
            self.rank[ra] += 1

    def count_roots(self, members: Iterable[Hashable]) -> int:
        return len({self.find(x) for x in members})


def e1_key(node_id: int) -> tuple[str, int]:
    return ("e", int(node_id))


def mesh_key(area_id: int, part: int, vertex_id: int) -> tuple[str, int, int, int]:
    return ("m", int(area_id), int(part), int(vertex_id))


@dataclass(frozen=True)
class MeshTriangle:
    area_id: int
    part: int
    triangle_id: int
    v0: int
    v1: int
    v2: int


@dataclass(frozen=True)
class MeshVertexRef:
    area_id: int
    part: int
    vertex_id: int


@dataclass(frozen=True)
class AttachmentIn:
    portal_id: int
    area_id: int
    part: int
    vertex_id: int
    edge_id: int
    from_node_id: int
    to_node_id: int


@dataclass
class ComponentRec:
    physical_component_id: int
    e1_nodes: list[int]
    mesh_vertices: list[MeshVertexRef]
    attachments: list[int]
    min_e1_node_id: int | None
    min_area_id: int | None
    min_part: int | None
    min_vertex_id: int | None


@dataclass
class UnifiedResult:
    components: list[ComponentRec]
    e1_component_of: dict[int, int]
    mesh_component_of: dict[tuple[int, int, int], int]
    attachments: list[AttachmentIn]
    triangle_of_vertex: dict[tuple[int, int, int], int]
    diagnostics: dict[str, Any] = field(default_factory=dict)


def _incident_triangle(
    triangles: list[MeshTriangle],
) -> dict[tuple[int, int, int], int]:
    hit: dict[tuple[int, int, int], int] = {}
    for t in triangles:
        for v in (t.v0, t.v1, t.v2):
            key = (t.area_id, t.part, v)
            prev = hit.get(key)
            if prev is None or t.triangle_id < prev:
                hit[key] = t.triangle_id
    return hit


def compute_e1_components(
    nodes: Iterable[int], edges: Iterable[tuple[int, int]]
) -> tuple[UnionFind, int]:
    uf = UnionFind()
    node_list = list(nodes)
    for n in node_list:
        uf.add(e1_key(n))
    for a, b in edges:
        uf.union(e1_key(a), e1_key(b))
    return uf, uf.count_roots(e1_key(n) for n in node_list)


def compute_mesh_components(
    vertices: Iterable[MeshVertexRef], triangles: Iterable[MeshTriangle]
) -> tuple[UnionFind, int, int, dict[tuple[int, int], set[Hashable]]]:
    uf = UnionFind()
    verts = list(vertices)
    for v in verts:
        uf.add(mesh_key(v.area_id, v.part, v.vertex_id))
    cross_part = 0
    for t in triangles:
        k0 = mesh_key(t.area_id, t.part, t.v0)
        k1 = mesh_key(t.area_id, t.part, t.v1)
        k2 = mesh_key(t.area_id, t.part, t.v2)
        uf.union(k0, k1)
        uf.union(k1, k2)
        uf.union(k2, k0)
    # Cross-part would require an explicit union of different parts; we never do that.
    roots = {uf.find(mesh_key(v.area_id, v.part, v.vertex_id)) for v in verts}
    part_roots: dict[tuple[int, int], set[Hashable]] = defaultdict(set)
    for v in verts:
        part_roots[(v.area_id, v.part)].add(
            uf.find(mesh_key(v.area_id, v.part, v.vertex_id))
        )
    shared = 0
    root_to_parts: dict[Hashable, set[tuple[int, int]]] = defaultdict(set)
    for (area_id, part), rs in part_roots.items():
        for r in rs:
            root_to_parts[r].add((area_id, part))
    for parts in root_to_parts.values():
        areas: dict[int, set[int]] = defaultdict(set)
        for area_id, part in parts:
            areas[area_id].add(part)
        for ps in areas.values():
            if len(ps) > 1:
                shared += 1
    return uf, len(roots), shared + cross_part, part_roots


def compute_unified(
    e1_nodes: list[int],
    e1_edges: list[tuple[int, int]],
    mesh_vertices: list[MeshVertexRef],
    triangles: list[MeshTriangle],
    attachments: list[AttachmentIn],
) -> UnifiedResult:
    e1_uf, e1_before = compute_e1_components(e1_nodes, e1_edges)
    mesh_uf, mesh_comps, cross_part, part_roots = compute_mesh_components(
        mesh_vertices, triangles
    )
    del mesh_uf

    uf = UnionFind()
    for n in e1_nodes:
        uf.add(e1_key(n))
    for v in mesh_vertices:
        uf.add(mesh_key(v.area_id, v.part, v.vertex_id))
    for a, b in e1_edges:
        uf.union(e1_key(a), e1_key(b))
    for t in triangles:
        k0 = mesh_key(t.area_id, t.part, t.v0)
        k1 = mesh_key(t.area_id, t.part, t.v1)
        k2 = mesh_key(t.area_id, t.part, t.v2)
        uf.union(k0, k1)
        uf.union(k1, k2)
        uf.union(k2, k0)
    for att in attachments:
        mk = mesh_key(att.area_id, att.part, att.vertex_id)
        uf.union(mk, e1_key(att.from_node_id))
        uf.union(mk, e1_key(att.to_node_id))

    tri_of = _incident_triangle(triangles)

    groups: dict[Hashable, dict[str, list[Any]]] = defaultdict(
        lambda: {"e1": [], "mesh": [], "att": []}
    )
    for n in e1_nodes:
        groups[uf.find(e1_key(n))]["e1"].append(n)
    for v in mesh_vertices:
        groups[uf.find(mesh_key(v.area_id, v.part, v.vertex_id))]["mesh"].append(v)
    for att in attachments:
        groups[uf.find(mesh_key(att.area_id, att.part, att.vertex_id))]["att"].append(
            att.portal_id
        )

    def sort_key(item: tuple[Hashable, dict[str, list[Any]]]) -> tuple:
        _root, g = item
        e1s: list[int] = g["e1"]
        meshes: list[MeshVertexRef] = g["mesh"]
        min_e1 = min(e1s) if e1s else INF_NODE
        if meshes:
            m0 = min(meshes, key=lambda x: (x.area_id, x.part, x.vertex_id))
            min_a, min_p, min_v = m0.area_id, m0.part, m0.vertex_id
        else:
            min_a, min_p, min_v = INF_NODE, INF_PART, INF_PART
        return (min_e1, min_a, min_p, min_v, str(_root))

    ordered = sorted(groups.items(), key=sort_key)
    components: list[ComponentRec] = []
    e1_of: dict[int, int] = {}
    mesh_of: dict[tuple[int, int, int], int] = {}
    for cid, (_root, g) in enumerate(ordered):
        e1s = sorted(int(x) for x in g["e1"])
        meshes = sorted(g["mesh"], key=lambda x: (x.area_id, x.part, x.vertex_id))
        atts = sorted(int(x) for x in g["att"])
        min_e1 = e1s[0] if e1s else None
        if meshes:
            min_a, min_p, min_v = (
                meshes[0].area_id,
                meshes[0].part,
                meshes[0].vertex_id,
            )
        else:
            min_a = min_p = min_v = None
        rec = ComponentRec(
            physical_component_id=cid,
            e1_nodes=e1s,
            mesh_vertices=meshes,
            attachments=atts,
            min_e1_node_id=min_e1,
            min_area_id=min_a,
            min_part=min_p,
            min_vertex_id=min_v,
        )
        components.append(rec)
        for n in e1s:
            e1_of[n] = cid
        for v in meshes:
            mesh_of[(v.area_id, v.part, v.vertex_id)] = cid

    # Merged E1: in each unified component, how many distinct E1-only roots fused.
    merged = 0
    e1_roots_in_unified: dict[int, set[Hashable]] = defaultdict(set)
    for n in e1_nodes:
        cid = e1_of[n]
        e1_roots_in_unified[cid].add(e1_uf.find(e1_key(n)))
    for roots in e1_roots_in_unified.values():
        if len(roots) > 1:
            merged += len(roots) - 1

    part_keys = {(v.area_id, v.part) for v in mesh_vertices}
    mesh_cc_per_part = [
        {
            "area_id": area_id,
            "part": part,
            "mesh_only_components": len(roots),
        }
        for (area_id, part), roots in sorted(part_roots.items())
    ]
    diagnostics = {
        "builder_version": BUILDER_VERSION,
        "e1_components_before": e1_before,
        "mesh_components": mesh_comps,
        "unified_components_after": len(components),
        "e1_mesh_attachments": len(attachments),
        "merged_e1_components": merged,
        "cross_part_connections": cross_part,
        "meshed_area_parts": len(part_keys),
        "e1_node_count": len(e1_nodes),
        "mesh_vertex_count": len(mesh_vertices),
        "triangle_count": len(triangles),
        "mesh_cc_per_part": mesh_cc_per_part,
    }
    return UnifiedResult(
        components=components,
        e1_component_of=e1_of,
        mesh_component_of=mesh_of,
        attachments=list(attachments),
        triangle_of_vertex=tri_of,
        diagnostics=diagnostics,
    )
