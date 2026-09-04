#!/usr/bin/env python3
"""WRG-004 first-route MVP tests. Offline unit tests plus optional live DB cases."""

from __future__ import annotations

import unittest

from shapely import LineString

from wrg_route import (
    BIND_MAX_M,
    FUNNEL_ENDPOINT_MAX_M,
    PIP_GEOGRAPHY_EPS_M,
    ROUTER_VERSION,
    START,
    STATUS_ENDPOINT_NOT_ON_WATER,
    STATUS_NO_WATER_CONNECTION,
    STATUS_ROUTE_FOUND,
    VALIDATION_CASES,
    Via,
    astar,
    closest_point_on_segment,
    compress_layers,
    concat_lines,
    count_e1_mesh_transitions,
    default_dsn,
    e1_node,
    haversine_m,
    looks_like_forbidden_chord,
    mesh_node,
    splice_line_endpoints,
)

# Vygozero osm_id 253836, wrg_areas 13042, MultiPolygon part 2 (component 151).
VYGOZERO_CLICKS = {
    "A_open": (34.67528548737927, 63.554195750000005),
    "B_open": (34.73855236583127, 63.55419459800001),
    "C_shore": (34.66045462338924, 63.53239232000001),
    "D_island": (34.49858018310547, 63.696671930000004),
    "E_narrow": (35.49870324707031, 63.41899896),
    "part1": (34.228553244731756, 63.861165150000005),
}


class WrgRouteOfflineTests(unittest.TestCase):
    def test_bind_threshold_is_metres_not_km(self) -> None:
        self.assertEqual(BIND_MAX_M, 25.0)
        self.assertLess(BIND_MAX_M, 100.0)
        self.assertLess(PIP_GEOGRAPHY_EPS_M, 1.0)
        self.assertLess(PIP_GEOGRAPHY_EPS_M * 100, BIND_MAX_M)
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
        self.assertTrue(ROUTER_VERSION.startswith("wrg-005"))

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

    def test_splice_line_endpoints_prepends_click(self) -> None:
        vertex = LineString([(37.40, 60.30), (37.41, 60.31)])
        click_a = (37.42, 60.29)
        click_b = (37.48, 60.31)
        g = splice_line_endpoints(vertex, click_a, click_b)
        self.assertEqual(g.coords[0], click_a)
        self.assertEqual(g.coords[-1], click_b)
        self.assertGreater(len(g.coords), 2)

    def test_closest_point_on_segment_is_local(self) -> None:
        a, b = (0.0, 0.0), (1.0, 0.0)
        q, t, d = closest_point_on_segment((0.5, 0.01), a, b)
        self.assertAlmostEqual(t, 0.5, places=3)
        self.assertLess(abs(q[0] - 0.5), 0.02)
        self.assertLess(d, 2000.0)

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


    def test_live_funnel_acceptance(self) -> None:
        router = self.router
        assert router is not None
        old = {
            "beloye_kovzha_belozersky": 32190.455,
            "beloye_same_part": 16331.02,
            "vygozero_same_part": 19097.088,
        }
        a = self._case("beloye_kovzha_belozersky")
        res_a = router.route(a["a"][0], a["a"][1], a["b"][0], a["b"][1])
        self.assertEqual(res_a.status, STATUS_ROUTE_FOUND)
        self.assertEqual(tuple(res_a.path_type), ("E1", "mesh", "E1"))
        self.assertIsNotNone(res_a.geometry)
        self.assertGreater(len(res_a.geometry.coords), 2)
        self.assertLessEqual(float(res_a.distance_m or 0), old["beloye_kovzha_belozersky"] + 1.0)
        water_a = router.validate_mesh_in_area(res_a, osm_id=1603199)
        self.assertLessEqual(float(water_a.get("mesh_leftover_m") or 0), 1.0)
        self.assertNotEqual(res_a.status, "NO_WATER_CONNECTION")

        b = self._case("beloye_same_part")
        res_b = router.route(b["a"][0], b["a"][1], b["b"][0], b["b"][1])
        self.assertEqual(res_b.status, STATUS_ROUTE_FOUND)
        self.assertLessEqual(float(res_b.distance_m or 0), old["beloye_same_part"] + 1.0)
        water_b = router.validate_mesh_in_area(res_b, osm_id=1603199)
        self.assertLessEqual(float(water_b.get("mesh_leftover_m") or 0), 1.0)
        src = (res_b.geometry_validation or {}).get("geometry_source")
        self.assertIn(src, ("funnel", "mesh_vertex_fallback", "mesh_vertex"))

        c = self._case("vygozero_same_part")
        res_c = router.route(c["a"][0], c["a"][1], c["b"][0], c["b"][1])
        self.assertEqual(res_c.status, STATUS_ROUTE_FOUND)
        self.assertLessEqual(float(res_c.distance_m or 0), old["vygozero_same_part"] + 1.0)
        water_c = router.validate_mesh_in_area(res_c)
        self.assertLessEqual(float(water_c.get("mesh_leftover_m") or 0), 1.0)
        self.assertGreater(len(res_c.geometry.coords), 2)

        d = self._case("strelka_land_separation")
        res_d = router.route(d["a"][0], d["a"][1], d["b"][0], d["b"][1])
        self.assertEqual(res_d.status, STATUS_NO_WATER_CONNECTION)
        self.assertTrue(res_d.geometry is None or res_d.geometry.is_empty)

        e = self._case("land_off_network")
        res_e = router.route(e["a"][0], e["a"][1], e["b"][0], e["b"][1])
        self.assertEqual(res_e.status, STATUS_ENDPOINT_NOT_ON_WATER)
        self.assertTrue(res_e.geometry is None or res_e.geometry.is_empty)

    def test_live_arbitrary_beloye_ab(self) -> None:
        router = self.router
        assert router is not None
        res = router.route(37.42, 60.29, 37.48, 60.31)
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        self.assertGreater(float(res.distance_m or 0), 0.0)
        water = router.validate_mesh_in_area(res, osm_id=1603199)
        self.assertLessEqual(float(water.get("mesh_leftover_m") or 0), 1.0)

    def _geom_ends(self, res) -> tuple[tuple[float, float], tuple[float, float]]:
        g = res.geometry
        self.assertIsNotNone(g)
        assert g is not None and not g.is_empty
        return (
            (float(g.coords[0][0]), float(g.coords[0][1])),
            (float(g.coords[-1][0]), float(g.coords[-1][1])),
        )

    def test_live_endpoint_open_water_stays_on_click(self) -> None:
        """Open Beloye: GeoJSON must start/end at the clicks, not the CDT vertex."""
        router = self.router
        assert router is not None
        a, b = (37.42, 60.29), (37.48, 60.31)
        ba, bb = router.bind(*a), router.bind(*b)
        self.assertIsNotNone(ba)
        self.assertIsNotNone(bb)
        assert ba is not None and bb is not None
        self.assertEqual(ba.kind, "mesh")
        attach = (float(ba.snap_lon), float(ba.snap_lat))
        self.assertLess(ba.dist_m, 400.0)
        self.assertLess(haversine_m(a, attach), 400.0)
        self.assertEqual(ba.as_dict().get("bind"), "covering_triangle_closest_edge")
        res = router.route(a[0], a[1], b[0], b[1])
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        start, end = self._geom_ends(res)
        self.assertLessEqual(haversine_m(a, start), FUNNEL_ENDPOINT_MAX_M)
        self.assertLessEqual(haversine_m(b, end), FUNNEL_ENDPOINT_MAX_M)
        water = router.validate_mesh_in_area(res, osm_id=1603199)
        self.assertLessEqual(float(water.get("mesh_leftover_m") or 0), 1.0)
        src = (res.geometry_validation or {}).get("geometry_source")
        self.assertNotEqual(src, "invalid")

    def test_live_endpoint_same_triangle_does_not_collapse(self) -> None:
        router = self.router
        assert router is not None
        a = (37.42, 60.29)
        b = (37.4236, 60.29)
        ba, bb = router.bind(*a), router.bind(*b)
        self.assertIsNotNone(ba)
        self.assertIsNotNone(bb)
        assert ba is not None and bb is not None
        self.assertEqual(ba.triangle_id, bb.triangle_id)
        res = router.route(a[0], a[1], b[0], b[1])
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        start, end = self._geom_ends(res)
        self.assertLessEqual(haversine_m(a, start), FUNNEL_ENDPOINT_MAX_M)
        self.assertLessEqual(haversine_m(b, end), FUNNEL_ENDPOINT_MAX_M)
        self.assertGreater(float(res.distance_m or 0), 50.0)
        water = router.validate_mesh_in_area(res, osm_id=1603199)
        self.assertLessEqual(float(water.get("mesh_leftover_m") or 0), 1.0)

    def test_live_endpoint_around_island_not_through_hole(self) -> None:
        router = self.router
        assert router is not None
        west, east = (37.348, 60.2686), (37.362, 60.2686)
        ba = router.bind(*west)
        self.assertIsNotNone(ba)
        assert ba is not None and ba.area_id is not None and ba.part is not None
        straight = LineString([west, east])
        leftover_straight = router._line_leftover_m(straight, int(ba.area_id), int(ba.part))
        self.assertIsNotNone(leftover_straight)
        self.assertGreater(float(leftover_straight), 1.0)
        res = router.route(west[0], west[1], east[0], east[1])
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        start, end = self._geom_ends(res)
        self.assertLessEqual(haversine_m(west, start), FUNNEL_ENDPOINT_MAX_M)
        self.assertLessEqual(haversine_m(east, end), FUNNEL_ENDPOINT_MAX_M)
        water = router.validate_mesh_in_area(res, osm_id=1603199)
        self.assertLessEqual(float(water.get("mesh_leftover_m") or 0), 1.0)
        geodesic = haversine_m(west, east)
        self.assertGreater(float(res.distance_m or 0), geodesic + 20.0)
        self.assertGreater(len(res.geometry.coords), 2)

    def test_live_endpoint_island_hole_is_not_on_water(self) -> None:
        """Click on an island must not E1-steal a nearby canal."""
        router = self.router
        assert router is not None
        island = (37.34993491794349, 60.26702622836401)
        self.assertIsNone(router.bind(*island))
        res = router.route(island[0], island[1], 37.42, 60.29)
        self.assertEqual(res.status, STATUS_ENDPOINT_NOT_ON_WATER)

    def test_live_endpoint_distinct_mp_parts_stay_disconnected(self) -> None:
        """Vygozero MP parts 1 and 2 are distinct physical components."""
        router = self.router
        assert router is not None
        a, b = (34.228553244731756, 63.861165150000005), (34.67528548737927, 63.554195750000005)
        res = router.route(a[0], a[1], b[0], b[1])
        self.assertEqual(res.status, STATUS_NO_WATER_CONNECTION)

    def test_live_wg_edges_checksum_unchanged(self) -> None:
        import hashlib

        router = self.router
        assert router is not None
        cur = router.conn.cursor()
        cur.execute(
            """
            SELECT count(*)::bigint, COALESCE(sum(edge_id), 0)::numeric
            FROM water.wg_edges WHERE build_id = 1
            """
        )
        n, s = cur.fetchone()
        payload = f"{int(n)}|{s}"
        self.assertEqual(hashlib.sha256(payload.encode()).hexdigest()[:16], "33f7f14a3dc26e44")
        self.assertEqual(int(n), 175173)

    def test_live_waypoint_near_shore_attach_is_local(self) -> None:
        """Beloye, ~20 m inside the shoreline: attach to closest mesh edge, not a far CDT vertex."""
        router = self.router
        assert router is not None
        a = (37.62388214905415, 60.32138103)
        b = (37.42, 60.29)
        ba = router.bind(*a)
        self.assertIsNotNone(ba)
        assert ba is not None
        self.assertEqual(ba.kind, "mesh")
        self.assertEqual((ba.lon, ba.lat), a)
        self.assertLess(ba.dist_m, 15.0)
        self.assertLess(
            haversine_m(a, (float(ba.snap_lon), float(ba.snap_lat))),
            15.0,
        )
        self.assertIsNotNone(ba.edge_v0)
        self.assertIsNotNone(ba.edge_v1)
        res = router.route(a[0], a[1], b[0], b[1])
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        start, end = self._geom_ends(res)
        self.assertLessEqual(haversine_m(a, start), FUNNEL_ENDPOINT_MAX_M)
        self.assertLessEqual(haversine_m(b, end), FUNNEL_ENDPOINT_MAX_M)
        water = router.validate_mesh_in_area(res, osm_id=1603199)
        self.assertLessEqual(float(water.get("mesh_leftover_m") or 0), 1.0)
        self.assertLess(res.bind_ms, 250.0)

    def test_live_waypoint_vygozero_near_shore(self) -> None:
        router = self.router
        assert router is not None
        a = (34.66068261774758, 63.532727429000005)
        b = (34.3220777, 63.8827376)
        ba = router.bind(*a)
        self.assertIsNotNone(ba)
        assert ba is not None
        self.assertEqual(ba.kind, "mesh")
        self.assertEqual(ba.part, 2)
        self.assertEqual(ba.physical_component_id, 151)
        self.assertEqual((ba.lon, ba.lat), a)
        self.assertLess(ba.dist_m, 10.0)
        res = router.route(a[0], a[1], b[0], b[1])
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        start, end = self._geom_ends(res)
        self.assertLessEqual(haversine_m(a, start), FUNNEL_ENDPOINT_MAX_M)
        self.assertLessEqual(haversine_m(b, end), FUNNEL_ENDPOINT_MAX_M)
        water = router.validate_mesh_in_area(res)
        self.assertLessEqual(float(water.get("mesh_leftover_m") or 0), 1.0)

    def test_live_land_near_shore_is_not_on_water(self) -> None:
        """25 m E1 radius must not turn a lake bank into water."""
        router = self.router
        assert router is not None
        cur = router.conn.cursor()
        cur.execute(
            """
            WITH a AS (
              SELECT ST_GeometryN(geom, 1) AS g
              FROM water.wrg_areas
              WHERE wrg_build_id = %s AND osm_id = 1603199
            )
            SELECT ST_X(p), ST_Y(p)
            FROM a,
            LATERAL ST_ClosestPoint(
              ST_Boundary(g),
              ST_SetSRID(ST_MakePoint(37.42, 60.29), 4326)
            ) AS bpt,
            LATERAL ST_Translate(
              bpt,
              (ST_X(bpt) - ST_X(ST_Centroid(g))) * 0.0000004,
              (ST_Y(bpt) - ST_Y(ST_Centroid(g))) * 0.0000004
            ) AS p
            """,
            (router.wrg_build_id,),
        )
        row = cur.fetchone()
        self.assertIsNotNone(row)
        lon, lat = float(row[0]), float(row[1])
        cur.execute(
            """
            SELECT ST_Covers(geom, ST_SetSRID(ST_MakePoint(%s, %s), 4326)),
                   ST_Distance(
                     geom::geography,
                     ST_SetSRID(ST_MakePoint(%s, %s), 4326)::geography
                   )
            FROM water.wrg_areas
            WHERE wrg_build_id = %s AND osm_id = 1603199
            """,
            (lon, lat, lon, lat, router.wrg_build_id),
        )
        covers, dist = cur.fetchone()
        self.assertFalse(bool(covers))
        self.assertLess(float(dist), BIND_MAX_M)
        self.assertIsNone(router.bind(lon, lat))
        res = router.route(lon, lat, 37.42, 60.29)
        self.assertEqual(res.status, STATUS_ENDPOINT_NOT_ON_WATER)


    def test_live_vygozero_clicks_stay_on_click(self) -> None:
        """A–E on part 2: mesh bind, click coords kept, GeoJSON start/end = click."""
        router = self.router
        assert router is not None
        b_open = VYGOZERO_CLICKS["B_open"]
        for key in ("A_open", "B_open", "C_shore", "D_island", "E_narrow"):
            click = VYGOZERO_CLICKS[key]
            diag = router.diagnose_bind(*click)
            self.assertEqual(diag["wrg_area"]["area_id"], 13042, key)
            self.assertEqual(diag["wrg_area"]["osm_id"], 253836, key)
            self.assertEqual(diag["multipolygon_part"], 2, key)
            self.assertTrue(diag["point_in_polygon"]["intersects_4326"] or diag["point_in_polygon"]["dwithin_eps"], key)
            self.assertFalse(diag["hole"], key)
            ba = router.bind(*click)
            self.assertIsNotNone(ba, key)
            assert ba is not None
            self.assertEqual(ba.kind, "mesh", key)
            self.assertEqual(ba.part, 2, key)
            self.assertEqual(ba.physical_component_id, 151, key)
            self.assertEqual((ba.lon, ba.lat), click, key)
            self.assertLess(ba.dist_m, 80.0, key)
            other = b_open if key != "B_open" else VYGOZERO_CLICKS["A_open"]
            res = router.route(click[0], click[1], other[0], other[1])
            self.assertEqual(res.status, STATUS_ROUTE_FOUND, key)
            start, end = self._geom_ends(res)
            self.assertLessEqual(haversine_m(click, start), FUNNEL_ENDPOINT_MAX_M, key)
            self.assertLessEqual(haversine_m(other, end), FUNNEL_ENDPOINT_MAX_M, key)
            dbg = res._endpoint_debug()
            self.assertLessEqual(float(dbg.get("click_a_to_geom_start_m") or 0), FUNNEL_ENDPOINT_MAX_M, key)
            self.assertLessEqual(float(dbg.get("click_b_to_geom_end_m") or 0), FUNNEL_ENDPOINT_MAX_M, key)

    def test_live_vygozero_mp_part1_not_same_component(self) -> None:
        router = self.router
        assert router is not None
        a = VYGOZERO_CLICKS["part1"]
        b = VYGOZERO_CLICKS["A_open"]
        da, db = router.diagnose_bind(*a), router.diagnose_bind(*b)
        self.assertEqual(da["multipolygon_part"], 1)
        self.assertEqual(db["multipolygon_part"], 2)
        self.assertNotEqual(da["physical_component_id"], db["physical_component_id"])
        res = router.route(a[0], a[1], b[0], b[1])
        self.assertEqual(res.status, STATUS_NO_WATER_CONNECTION)

    def test_live_vygozero_island_hole_not_e1(self) -> None:
        router = self.router
        assert router is not None
        cur = router.conn.cursor()
        cur.execute(
            """
            WITH a AS (
              SELECT ST_GeometryN(geom, 2) AS g
              FROM water.wrg_areas
              WHERE wrg_build_id = %s AND osm_id = 253836
            )
            SELECT ST_X(p), ST_Y(p)
            FROM a,
            LATERAL ST_PointOnSurface(ST_MakePolygon(ST_InteriorRingN(g, 1))) AS p
            """,
            (router.wrg_build_id,),
        )
        row = cur.fetchone()
        self.assertIsNotNone(row)
        lon, lat = float(row[0]), float(row[1])
        diag = router.diagnose_bind(lon, lat)
        self.assertTrue(diag["hole"])
        self.assertIsNone(router.bind(lon, lat))
        res = router.route(lon, lat, *VYGOZERO_CLICKS["A_open"])
        self.assertEqual(res.status, STATUS_ENDPOINT_NOT_ON_WATER)

    def test_live_vygozero_shore_ring_pip_jitter_is_water(self) -> None:
        """Geography dist ~0 on the exterior ring must bind mesh, not bank/E1."""
        router = self.router
        assert router is not None
        cur = router.conn.cursor()
        cur.execute(
            """
            WITH a AS (
              SELECT ST_GeometryN(geom, 2) AS g
              FROM water.wrg_areas
              WHERE wrg_build_id = %s AND osm_id = 253836
            ),
            pts AS (
              SELECT ST_LineInterpolatePoint(ST_ExteriorRing(g), t) AS p, g
              FROM a, generate_series(0.0, 1.0, 0.05) AS t
            )
            SELECT ST_X(p), ST_Y(p)
            FROM pts
            WHERE NOT ST_Intersects(g, p)
              AND ST_Distance(g::geography, p::geography) <= %s
            LIMIT 1
            """,
            (router.wrg_build_id, PIP_GEOGRAPHY_EPS_M),
        )
        row = cur.fetchone()
        if row is None:
            self.skipTest("no 4326 PIP-jitter ring sample")
        lon, lat = float(row[0]), float(row[1])
        diag = router.diagnose_bind(lon, lat)
        self.assertTrue(diag["point_in_polygon"]["dwithin_eps"])
        self.assertFalse(diag["hole"])
        ba = router.bind(lon, lat)
        self.assertIsNotNone(ba)
        assert ba is not None
        self.assertEqual(ba.kind, "mesh")
        self.assertEqual(ba.part, 2)
        self.assertEqual((ba.lon, ba.lat), (lon, lat))
        res = router.route(lon, lat, *VYGOZERO_CLICKS["B_open"])
        self.assertEqual(res.status, STATUS_ROUTE_FOUND)
        start, _end = self._geom_ends(res)
        self.assertLessEqual(haversine_m((lon, lat), start), FUNNEL_ENDPOINT_MAX_M)


if __name__ == "__main__":
    unittest.main()
