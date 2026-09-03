#!/usr/bin/env python3
"""WRG-003 unified physical connectivity unit tests (no database, no routing)."""

from __future__ import annotations

import unittest

from wrg_unified import (
    BUILDER_VERSION,
    AttachmentIn,
    MeshTriangle,
    MeshVertexRef,
    compute_unified,
)


class WrgUnifiedTests(unittest.TestCase):
    def test_e1_path_preserved(self) -> None:
        res = compute_unified(
            e1_nodes=[1, 2, 3],
            e1_edges=[(1, 2), (2, 3)],
            mesh_vertices=[],
            triangles=[],
            attachments=[],
        )
        self.assertEqual(res.e1_component_of[1], res.e1_component_of[3])
        self.assertEqual(res.diagnostics["e1_components_before"], 1)
        self.assertEqual(res.diagnostics["e1_mesh_attachments"], 0)

    def test_mesh_bridges_two_e1_components(self) -> None:
        verts = [
            MeshVertexRef(10, 1, 0),
            MeshVertexRef(10, 1, 1),
            MeshVertexRef(10, 1, 2),
        ]
        tris = [MeshTriangle(10, 1, 0, 0, 1, 2)]
        atts = [
            AttachmentIn(1, 10, 1, 0, 100, 1, 2),
            AttachmentIn(2, 10, 1, 1, 200, 3, 4),
        ]
        res = compute_unified(
            e1_nodes=[1, 2, 3, 4],
            e1_edges=[(1, 2), (3, 4)],
            mesh_vertices=verts,
            triangles=tris,
            attachments=atts,
        )
        self.assertEqual(res.e1_component_of[1], res.e1_component_of[3])
        self.assertEqual(res.diagnostics["e1_components_before"], 2)
        self.assertEqual(res.diagnostics["merged_e1_components"], 1)
        self.assertEqual(res.diagnostics["mesh_components"], 1)

    def test_no_area_clique_without_portal(self) -> None:
        verts = [
            MeshVertexRef(10, 1, 0),
            MeshVertexRef(10, 1, 1),
            MeshVertexRef(10, 1, 2),
        ]
        tris = [MeshTriangle(10, 1, 0, 0, 1, 2)]
        res = compute_unified(
            e1_nodes=[1, 2, 3, 4],
            e1_edges=[(1, 2), (3, 4)],
            mesh_vertices=verts,
            triangles=tris,
            attachments=[],
        )
        self.assertNotEqual(res.e1_component_of[1], res.e1_component_of[3])
        self.assertEqual(res.diagnostics["merged_e1_components"], 0)

    def test_parts_not_mesh_joined(self) -> None:
        verts = [
            MeshVertexRef(10, 1, 0),
            MeshVertexRef(10, 1, 1),
            MeshVertexRef(10, 1, 2),
            MeshVertexRef(10, 2, 0),
            MeshVertexRef(10, 2, 1),
            MeshVertexRef(10, 2, 2),
        ]
        tris = [
            MeshTriangle(10, 1, 0, 0, 1, 2),
            MeshTriangle(10, 2, 0, 0, 1, 2),
        ]
        atts = [
            AttachmentIn(1, 10, 1, 0, 100, 1, 2),
            AttachmentIn(2, 10, 2, 0, 200, 3, 4),
        ]
        res = compute_unified(
            e1_nodes=[1, 2, 3, 4],
            e1_edges=[(1, 2), (3, 4)],
            mesh_vertices=verts,
            triangles=tris,
            attachments=atts,
        )
        self.assertNotEqual(res.e1_component_of[1], res.e1_component_of[3])
        self.assertEqual(res.diagnostics["cross_part_connections"], 0)
        self.assertEqual(res.diagnostics["mesh_components"], 2)

    def test_e1_may_join_parts_without_mesh_union(self) -> None:
        verts = [
            MeshVertexRef(10, 1, 0),
            MeshVertexRef(10, 1, 1),
            MeshVertexRef(10, 1, 2),
            MeshVertexRef(10, 2, 0),
            MeshVertexRef(10, 2, 1),
            MeshVertexRef(10, 2, 2),
        ]
        tris = [
            MeshTriangle(10, 1, 0, 0, 1, 2),
            MeshTriangle(10, 2, 0, 0, 1, 2),
        ]
        atts = [
            AttachmentIn(1, 10, 1, 0, 100, 1, 2),
            AttachmentIn(2, 10, 2, 0, 200, 2, 3),
        ]
        res = compute_unified(
            e1_nodes=[1, 2, 3],
            e1_edges=[(1, 2), (2, 3)],
            mesh_vertices=verts,
            triangles=tris,
            attachments=atts,
        )
        self.assertEqual(res.e1_component_of[1], res.e1_component_of[3])
        self.assertEqual(res.diagnostics["cross_part_connections"], 0)
        self.assertEqual(res.diagnostics["mesh_components"], 2)

    def test_three_portals_one_part(self) -> None:
        verts = [MeshVertexRef(1, 1, i) for i in range(4)]
        tris = [
            MeshTriangle(1, 1, 0, 0, 1, 2),
            MeshTriangle(1, 1, 1, 0, 2, 3),
        ]
        atts = [
            AttachmentIn(10, 1, 1, 0, 1, 10, 11),
            AttachmentIn(20, 1, 1, 1, 2, 20, 21),
            AttachmentIn(30, 1, 1, 3, 3, 30, 31),
        ]
        res = compute_unified(
            e1_nodes=[10, 11, 20, 21, 30, 31],
            e1_edges=[(10, 11), (20, 21), (30, 31)],
            mesh_vertices=verts,
            triangles=tris,
            attachments=atts,
        )
        cids = {res.e1_component_of[n] for n in (10, 20, 30)}
        self.assertEqual(len(cids), 1)

    def test_deterministic_ids(self) -> None:
        args = dict(
            e1_nodes=[9, 1, 5],
            e1_edges=[(1, 5)],
            mesh_vertices=[],
            triangles=[],
            attachments=[],
        )
        a = compute_unified(**args)
        b = compute_unified(**args)
        self.assertEqual(a.e1_component_of, b.e1_component_of)
        self.assertEqual(
            [c.physical_component_id for c in a.components],
            [c.physical_component_id for c in b.components],
        )

    def test_builder_version(self) -> None:
        self.assertEqual(BUILDER_VERSION, "wrg-003-1")


if __name__ == "__main__":
    unittest.main()
