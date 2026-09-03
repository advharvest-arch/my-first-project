#!/usr/bin/env python3
"""WRG-005 funnel unit tests. No database, no topology changes."""

from __future__ import annotations

import unittest

from wrg_funnel import (
    MeshPartIndex,
    funnel_mesh_run,
    polyline_length_m,
    string_pull,
    triarea2,
)


def square_index() -> MeshPartIndex:
    # (0,0)-(10,0)-(10,10)-(0,10) as lon/lat-like degrees, split on diagonal.
    xy = {
        0: (0.0, 0.0),
        1: (10.0, 0.0),
        2: (10.0, 10.0),
        3: (0.0, 10.0),
    }
    tris = {
        0: (0, 1, 2),
        1: (0, 2, 3),
    }
    return MeshPartIndex.from_triangles(1, 1, tris, xy)


class FunnelOfflineTests(unittest.TestCase):
    def test_triarea_ccw(self) -> None:
        self.assertGreater(triarea2((0.0, 0.0), (1.0, 0.0), (0.0, 1.0)), 0.0)

    def test_empty_corridor_is_straight(self) -> None:
        pts = string_pull((0.0, 0.0), [], (4.0, 3.0))
        self.assertEqual(pts[0], (0.0, 0.0))
        self.assertEqual(pts[-1], (4.0, 3.0))
        self.assertEqual(len(pts), 2)

    def test_convex_two_triangles_pulls_straight(self) -> None:
        idx = square_index()
        res = funnel_mesh_run(
            idx,
            path_vids=[0, 1, 2, 3],
            start_xy=(2.0, 1.0),
            end_xy=(1.0, 8.0),
            start_triangle_id=0,
            end_triangle_id=1,
        )
        self.assertTrue(res.ok, res.reason)
        self.assertGreaterEqual(len(res.triangle_ids), 1)
        self.assertAlmostEqual(res.coords[0][0], 2.0, places=6)
        self.assertAlmostEqual(res.coords[0][1], 1.0, places=6)
        self.assertAlmostEqual(res.coords[-1][0], 1.0, places=6)
        self.assertAlmostEqual(res.coords[-1][1], 8.0, places=6)
        self.assertLessEqual(len(res.coords), 3)
        straight = polyline_length_m([(2.0, 1.0), (1.0, 8.0)])
        pulled = polyline_length_m(res.coords)
        self.assertLessEqual(pulled, straight * 1.02 + 1.0)

    def test_corner_portal_keeps_apex(self) -> None:
        start = (0.0, 0.0)
        end = (0.0, 2.0)
        portals = [
            ((-1.0, 1.0), (-0.05, 1.0)),
            ((-1.0, 2.0), (1.0, 2.0)),
        ]
        pts = string_pull(start, portals, end)
        self.assertEqual(pts[0], start)
        self.assertEqual(pts[-1], end)
        xs = [p[0] for p in pts]
        self.assertTrue(any(x < -0.01 for x in xs[1:-1]) or min(xs) < -0.01)

    def test_vertex_fallback_preserved_on_failure(self) -> None:
        idx = square_index()
        res = funnel_mesh_run(
            idx,
            path_vids=[],
            start_xy=(0.0, 0.0),
            end_xy=(1.0, 1.0),
            start_triangle_id=None,
            end_triangle_id=None,
        )
        self.assertFalse(res.ok)
        self.assertTrue(res.vertex_path_fallback)


if __name__ == "__main__":
    unittest.main()
