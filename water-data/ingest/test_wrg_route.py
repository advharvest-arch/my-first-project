#!/usr/bin/env python3
"""WRG-004 first-route MVP tests. Offline unit tests plus optional live DB cases."""

from __future__ import annotations

import unittest

from shapely import LineString

from wrg_route import (
    BIND_MAX_M,
    ROUTER_VERSION,
    START,
    STATUS_ENDPOINT_NOT_ON_WATER,
    STATUS_NO_WATER_CONNECTION,
    STATUS_ROUTE_FOUND,
    VALIDATION_CASES,
    Via,
    astar,
    compress_layers,
    concat_lines,
    count_e1_mesh_transitions,
    default_dsn,
    e1_node,
    haversine_m,
    looks_like_forbidden_chord,
    mesh_node,
)


class WrgRouteOfflineTests(unittest.TestCase):
    def test_bind_threshold_is_metres_not_km(self) -> None:
        self.assertEqual(BIND_MAX_M, 25.0)
        self.assertLess(BIND_MAX_M, 100.0)
        self.assertNotEqual(BIND_MAX_M, 3000.0)
        self.assertNotEqual(BIND_MAX_M, 10000.0)
        self.assertNotEqual(BIND_MAX_M, 25000.0)

    def test_status_contract(self) -> None:
        self.assertEqual(
            {c["expect"] for c in VALIDATION_CASES},
            {
                STATUS_ROUTE_FOUND,
                STATUS_NO_WATER_CONNECTION,
                STATUS_ENDPOINT_NOT_ON_WATER,
            },
        )
        self.assertTrue(ROUTER_VERSION.startswith("wrg-004"))

    def test_haversine_forbidden_chord_length(self) -> None:
        d = haversine_m((37.3270442, 60.2490477), (37.2303366, 60.184603))
        self.assertGreater(d, 8900.0)
        self.assertLess(d, 9100.0)

    def test_forbidden_chord_detector(self) -> None:
        chord = [(37.3270442, 60.2490477), (37.2303366, 60.184603)]
        self.assertTrue(looks_like_forbidden_chord(chord, 8960.7))
        long_ok = [
            (37.3270442, 60.2490477),
            (37.40, 60.22),
            (37.50, 60.20),
            (37.2303366, 60.184603),
        ]
        self.assertFalse(looks_like_forbidden_chord(long_ok, 40000.0))

    def test_compress_e1_mesh_e1(self) -> None:
        nodes = [
            e1_node(1),
            e1_node(2),
            mesh_node(10, 1, 0),
            mesh_node(10, 1, 1),
            e1_node(9),
        ]
        pt = compress_layers(nodes)
        self.assertEqual(pt, ("E1", "mesh", "E1"))
        self.assertEqual(count_e1_mesh_transitions(pt), 2)

    def test_concat_lines_joins_at_endpoint(self) -> None:
        a = LineString([(0.0, 0.0), (1.0, 0.0)])
        b = LineString([(1.0, 0.0), (1.0, 1.0)])
        g = concat_lines([a, b])
        self.assertIsNotNone(g)
        assert g is not None
        self.assertEqual(len(g.coords), 3)

    def test_astar_portal_not_geodesic_teleport(self) -> None:
        """Portal cost is along-edge (5+5), not a 100 m chord between far ends."""
        adj: dict = {}
        via_e1 = Via("e1", 1, 0.0, 1.0)
        via_mesh = Via("mesh")
        via_p = Via("portal", 1, 0.5, 0.0)
        a, b = e1_node(1), e1_node(2)
        m0, m1 = mesh_node(1, 1, 0), mesh_node(1, 1, 1)
        adj[a] = [(b, 10.0, via_e1), (m0, 5.0, via_p)]
        adj[b] = [(a, 10.0, via_e1)]
        adj[m0] = [(a, 5.0, via_p), (m1, 3.0, via_mesh)]
        adj[m1] = [(m0, 3.0, via_mesh)]
        adj[START] = [(a, 0.0, Via("start_stub"))]
        goal = ("g",)
        adj[m1].append((goal, 0.0, Via("goal_stub")))
        path, dist = astar(adj, START, goal, lambda _n: 0.0)
        self.assertIsNotNone(path)
        self.assertAlmostEqual(dist or 0.0, 8.0)
        layers = compress_layers(n for n, _v in (path or []) )
        self.assertEqual(layers, ("E1", "mesh"))


class WrgRouteLiveTests(unittest.TestCase):
    router = None

    @classmethod
    def setUpClass(cls) -> None:
        try:
            import psycopg2

            from wrg_route import WrgRouter

            conn = psycopg2.connect(default_dsn())
            cur = conn.cursor()
            cur.execute(
                """
                SELECT to_regclass('water.wrg_unified_e1_node'),
                       to_regclass('water.wrg_mesh_triangles')
                """
            )
            row = cur.fetchone()
            if not row or row[0] is None or row[1] is None:
                conn.close()
                return
            cls.conn = conn
            cls.router = WrgRouter(conn)
        except Exception:
            cls.router = None

    def setUp(self) -> None:
        if self.router is None:
            self.skipTest("WRG unified/mesh tables not available")

    def _case(self, case_id: str) -> dict:
        for c in VALIDATION_CASES:
            if c["id"] == case_id:
                return c
        raise AssertionError(case_id)

    def test_live_five_cases(self) -> None:
        router = self.router
        assert router is not None
        for case in VALIDATION_CASES:
            with self.subTest(case=case["id"]):
                res = router.route(case["a"][0], case["a"][1], case["b"][0], case["b"][1])
                self.assertEqual(res.status, case["expect"], case["id"])
                if case.get("expect_path_type") and res.status == STATUS_ROUTE_FOUND:
                    self.assertEqual(tuple(res.path_type), tuple(case["expect_path_type"]))
                if case.get("forbid_chord"):
                    self.assertGreaterEqual(res.mesh_hops, 1)
                    self.assertFalse(res.geometry_validation.get("forbidden_chord"))
                    water = router.validate_mesh_in_area(res, osm_id=1603199)
                    leftover = water.get("mesh_leftover_m")
                    self.assertIsNotNone(leftover)
                    self.assertLessEqual(float(leftover), 1.0)
                    self.assertGreater(len(res.geometry.coords), 2)


if __name__ == "__main__":
    unittest.main()
