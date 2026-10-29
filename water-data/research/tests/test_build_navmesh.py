"""Tests for CDT navmesh and triangle dual graph (build_navmesh.py)."""

from __future__ import annotations

import unittest
from pathlib import Path

from shapely.geometry import Point, Polygon

from water_topology.build_navmesh import (
    build_navmesh_from_geometry,
    build_seliger_navmesh,
)
from water_topology.dumps import load_compact_store

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"


class SyntheticNavmeshTests(unittest.TestCase):
    def test_polygon_with_hole_cdt_and_dual_path(self):
        shell = [(0.0, 0.0), (100.0, 0.0), (100.0, 100.0), (0.0, 100.0), (0.0, 0.0)]
        hole = [(40.0, 40.0), (60.0, 40.0), (60.0, 60.0), (40.0, 60.0), (40.0, 40.0)]
        poly = Polygon(shell, [hole])
        hole_poly = Polygon(hole)

        mesh = build_navmesh_from_geometry(poly, feature_key="synthetic", project_from_wgs84=False)
        self.assertEqual(mesh.part_count, 1)
        self.assertEqual(mesh.hole_count, 1)
        self.assertEqual(len(mesh.triangles), 8)
        self.assertEqual(len(mesh.dual_edges), 8)

        # No triangle centroid may lie inside the island hole
        for t in mesh.triangles:
            self.assertFalse(hole_poly.contains(Point(*t.centroid)))

        start_tri = mesh.find_triangle(10.0, 10.0)
        goal_tri = mesh.find_triangle(90.0, 90.0)
        self.assertIsNotNone(start_tri)
        self.assertIsNotNone(goal_tri)
        path = mesh.shortest_triangle_path(start_tri, goal_tri)
        self.assertIsNotNone(path)
        self.assertEqual(path[0], start_tri)
        self.assertEqual(path[-1], goal_tri)


class SeligerNavmeshTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FIXTURE.exists():
            raise unittest.SkipTest(f"missing {FIXTURE}")
        cls.store = load_compact_store(FIXTURE)
        cls.mesh = build_seliger_navmesh(cls.store, 399081, project_to_utm=True)

    def test_seliger_cdt_and_dual_graph_built(self):
        self.assertEqual(self.mesh.feature_key, "r399081")
        self.assertEqual(self.mesh.crs, "EPSG:32636")
        self.assertEqual(self.mesh.part_count, 2)
        self.assertEqual(self.mesh.hole_count, 137)
        self.assertGreater(len(self.mesh.triangles), 10000)
        self.assertGreater(len(self.mesh.dual_edges), 10000)

        # Every dual edge links two valid distinct triangles with positive weight
        for e in self.mesh.dual_edges[:200]:
            self.assertNotEqual(e.from_tri, e.to_tri)
            self.assertGreater(e.weight, 0.0)

    def test_dual_graph_pathfinding_on_seliger(self):
        t0 = 0
        nbrs = self.mesh.adjacency.get(t0)
        self.assertTrue(nbrs)
        t1 = nbrs[0][0]
        path = self.mesh.shortest_triangle_path(t0, t1)
        self.assertEqual(path, [t0, t1])


if __name__ == "__main__":
    unittest.main()
