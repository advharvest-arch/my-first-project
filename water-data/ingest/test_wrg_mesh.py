#!/usr/bin/env python3
"""WRG-002 constrained mesh unit tests (no database, no routing)."""

from __future__ import annotations

import unittest

from shapely import Polygon

from wrg_mesh import (
    BUILDER_VERSION,
    PartIn,
    PortalIn,
    build_area_mesh,
    first_hole_crossing_pair,
    mesh_edge_exists,
    vertex_connected,
)


def _npoints(poly: Polygon) -> int:
    n = len(poly.exterior.coords)
    for r in poly.interiors:
        n += len(r.coords)
    return n


class WrgMeshTests(unittest.TestCase):
    def test_simple_polygon_cdt_covered(self) -> None:
        poly = Polygon([(0, 0), (4, 0), (4, 3), (0, 3), (0, 0)])
        mesh = build_area_mesh(
            [PartIn(part=1, polygon=poly, input_npoints=_npoints(poly))],
            [],
        )
        self.assertEqual(mesh.diagnostics["parts"], 1)
        self.assertGreaterEqual(mesh.diagnostics["triangles"], 2)
        self.assertTrue(
            mesh.diagnostics["geometry_validation"]["all_triangles_covered_by_part"]
        )
        self.assertTrue(mesh.diagnostics["geometry_validation"]["no_triangle_in_hole"])
        self.assertEqual(mesh.diagnostics["rejected_degenerate_triangles"], 0)
        pm = mesh.parts[0]
        ids = [(t.v0, t.v1, t.v2) for t in pm.triangles]
        self.assertEqual(ids, sorted(ids))
        for t in pm.triangles:
            self.assertEqual(t.v0, min(t.v0, t.v1, t.v2))

    def test_hole_has_no_land_triangle(self) -> None:
        outer = [(0, 0), (10, 0), (10, 10), (0, 10), (0, 0)]
        hole = [(4, 4), (6, 4), (6, 6), (4, 6), (4, 4)]
        poly = Polygon(outer, [hole])
        hp = Polygon(hole)
        mesh = build_area_mesh(
            [PartIn(part=1, polygon=poly, input_npoints=_npoints(poly))],
            [],
        )
        self.assertGreater(mesh.diagnostics["triangles"], 0)
        self.assertTrue(mesh.diagnostics["geometry_validation"]["no_triangle_in_hole"])
        for t in mesh.parts[0].triangles:
            a = mesh.parts[0].vertices[t.v0].xy
            b = mesh.parts[0].vertices[t.v1].xy
            c = mesh.parts[0].vertices[t.v2].xy
            tri = Polygon([a, b, c, a])
            self.assertTrue(poly.covers(tri))
            self.assertFalse(hp.contains(tri.representative_point()))

    def test_multipolygon_parts_never_join(self) -> None:
        a = Polygon([(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)])
        b = Polygon([(5, 5), (6, 5), (6, 6), (5, 6), (5, 5)])
        mesh = build_area_mesh(
            [
                PartIn(part=1, polygon=a, input_npoints=_npoints(a)),
                PartIn(part=2, polygon=b, input_npoints=_npoints(b)),
            ],
            [
                PortalIn(portal_id=1, xy=(0.2, 0.2)),
                PortalIn(portal_id=2, xy=(5.2, 5.2)),
            ],
        )
        self.assertEqual(mesh.diagnostics["parts_meshed"], 2)
        self.assertTrue(mesh.diagnostics["geometry_validation"]["parts_never_joined"])
        p1 = next(p for p in mesh.portals if p.portal_id == 1)
        p2 = next(p for p in mesh.portals if p.portal_id == 2)
        self.assertEqual(p1.part, 1)
        self.assertEqual(p2.part, 2)
        self.assertNotEqual(p1.part, p2.part)

    def test_three_portals_connected_simple_lake(self) -> None:
        poly = Polygon([(0, 0), (8, 0), (8, 5), (0, 5), (0, 0)])
        portals = [
            PortalIn(portal_id=10, xy=(1, 1)),
            PortalIn(portal_id=20, xy=(7, 1)),
            PortalIn(portal_id=30, xy=(4, 4)),
        ]
        mesh = build_area_mesh(
            [PartIn(part=1, polygon=poly, input_npoints=_npoints(poly))],
            portals,
        )
        self.assertEqual(len(mesh.portals), 3)
        pm = mesh.parts[0]
        for i, a in enumerate(pm.portals):
            for b in pm.portals[i + 1 :]:
                self.assertTrue(vertex_connected(pm.triangles, a.vertex_id, b.vertex_id))

    def test_hole_crossing_chord_is_not_mesh_edge(self) -> None:
        outer = [(0, 0), (12, 0), (12, 6), (0, 6), (0, 0)]
        hole = [(5, 2), (7, 2), (7, 4), (5, 4), (5, 2)]
        poly = Polygon(outer, [hole])
        portals = [
            PortalIn(portal_id=1, xy=(1, 3)),
            PortalIn(portal_id=2, xy=(11, 3)),
        ]
        mesh = build_area_mesh(
            [PartIn(part=1, polygon=poly, input_npoints=_npoints(poly))],
            portals,
        )
        pm = mesh.parts[0]
        pair = first_hole_crossing_pair(poly, pm.portals)
        self.assertIsNotNone(pair)
        a = next(p for p in pm.portals if p.portal_id == 1)
        b = next(p for p in pm.portals if p.portal_id == 2)
        self.assertTrue(vertex_connected(pm.triangles, a.vertex_id, b.vertex_id))
        self.assertFalse(mesh_edge_exists(pm.triangles, a.vertex_id, b.vertex_id))

    def test_deterministic_repeat(self) -> None:
        poly = Polygon([(0, 0), (5, 0), (6, 4), (1, 5), (0, 0)])
        portals = [PortalIn(portal_id=3, xy=(2, 1)), PortalIn(portal_id=1, xy=(4, 2))]
        parts = [PartIn(part=1, polygon=poly, input_npoints=_npoints(poly))]
        m1 = build_area_mesh(parts, portals)
        m2 = build_area_mesh(parts, portals)
        t1 = [(t.triangle_id, t.v0, t.v1, t.v2) for t in m1.parts[0].triangles]
        t2 = [(t.triangle_id, t.v0, t.v1, t.v2) for t in m2.parts[0].triangles]
        self.assertEqual(t1, t2)
        self.assertEqual(
            [(p.portal_id, p.vertex_id, p.attach_kind) for p in m1.portals],
            [(p.portal_id, p.vertex_id, p.attach_kind) for p in m2.portals],
        )

    def test_uncovered_portal_rejected(self) -> None:
        poly = Polygon([(0, 0), (2, 0), (2, 2), (0, 2), (0, 0)])
        mesh = build_area_mesh(
            [PartIn(part=1, polygon=poly, input_npoints=_npoints(poly))],
            [PortalIn(portal_id=9, xy=(50, 50))],
        )
        self.assertEqual(mesh.diagnostics["portals_attached"], 0)
        self.assertEqual(mesh.diagnostics["portals_uncovered"], 1)
        self.assertEqual(mesh.diagnostics["uncovered_portal_ids"], [9])

    def test_builder_version(self) -> None:
        self.assertEqual(BUILDER_VERSION, "wrg-002-1")


if __name__ == "__main__":
    unittest.main()
