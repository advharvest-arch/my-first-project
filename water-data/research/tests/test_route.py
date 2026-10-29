"""11 regression tests for end-to-end water routing (A*, funnel smoothing, OUTSIDE_WATER, NO_PATH)."""

from __future__ import annotations

import math
import unittest
from pathlib import Path

from shapely.geometry import LineString, Polygon

from water_topology.build_navmesh import build_navmesh_from_geometry
from water_topology.build_water_graph import build_water_graph
from water_topology.dumps import load_compact_store
from water_topology.osm_store import Member, OsmStore, RelRec, WayRec
from water_topology.rings import reconstruct_relation_geometry
from water_topology.route import (
    CLEARANCE_K,
    STATUS_NO_PATH,
    STATUS_OK,
    STATUS_OUTSIDE_WATER,
    UnifiedWaterRouter,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"


class SyntheticRoutingAndFunnelTests(unittest.TestCase):
    def setUp(self) -> None:
        self.store = OsmStore()
        # Lake A (0,0)-(100,100) with an inner island hole (40,40)-(60,60)
        self.store.nodes[1] = (0.0, 0.0)
        self.store.nodes[2] = (100.0, 0.0)
        self.store.nodes[3] = (100.0, 100.0)
        self.store.nodes[4] = (0.0, 100.0)
        self.store.ways[10] = WayRec(10, nds=[1, 2, 3, 4, 1], tags={})

        self.store.nodes[11] = (40.0, 40.0)
        self.store.nodes[12] = (60.0, 40.0)
        self.store.nodes[13] = (60.0, 60.0)
        self.store.nodes[14] = (40.0, 60.0)
        self.store.ways[11] = WayRec(11, nds=[11, 12, 13, 14, 11], tags={"place": "islet"})

        self.store.relations[9] = RelRec(
            9,
            members=[Member("way", 10, "outer"), Member("way", 11, "inner")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )

        # Lake B (200,0)-(300,100) connected to Lake A via canal way 30 (node 2 -> node 5)
        self.store.nodes[5] = (200.0, 0.0)
        self.store.nodes[6] = (300.0, 0.0)
        self.store.nodes[7] = (300.0, 100.0)
        self.store.nodes[8] = (200.0, 100.0)
        self.store.ways[20] = WayRec(20, nds=[5, 6, 7, 8, 5], tags={"natural": "water", "water": "lake"})

        self.store.nodes[99] = (150.0, 0.0)
        self.store.ways[30] = WayRec(30, nds=[2, 99, 5], tags={"waterway": "canal", "width": "12"})

        self.wgraph = build_water_graph(("relation", 9), self.store)
        self.router = UnifiedWaterRouter(self.store, self.wgraph, project_from_wgs84=False)

    def test_01_outside_water_returns_outside_water(self):
        res_land = self.router.route_xy((-50.0, -50.0), (10.0, 10.0))
        self.assertEqual(res_land.status, STATUS_OUTSIDE_WATER)
        res_island = self.router.route_xy((50.0, 50.0), (10.0, 10.0))
        self.assertEqual(res_island.status, STATUS_OUTSIDE_WATER)

    def test_02_funnel_smoothing_avoids_island_hole(self):
        res = self.router.route_xy((10.0, 10.0), (90.0, 90.0))
        self.assertEqual(res.status, STATUS_OK)
        self.assertGreater(res.length_m, math.hypot(80.0, 80.0))
        island_interior = Polygon([(40.1, 40.1), (59.9, 40.1), (59.9, 59.9), (40.1, 59.9)])
        route_line = LineString(res.coordinates_xy)
        self.assertFalse(route_line.intersects(island_interior))

    def test_02b_open_water_line_of_sight_is_straight(self):
        res = self.router.route_xy((10.0, 10.0), (10.0, 90.0))
        self.assertEqual(res.status, STATUS_OK)
        self.assertAlmostEqual(res.length_m, 80.0, delta=1.0)
        self.assertLessEqual(len(res.coordinates_xy), 3)

    def test_02c_low_clearance_triangles_cost_more(self):
        mesh = self.router.navmeshes["r9"]
        scored = []
        for t in mesh.triangles:
            d = self.router._triangle_clearance("r9", t.centroid)
            scored.append((d, t.tri_id))
        scored.sort()
        self.assertGreater(len(scored), 1)
        d_near, tid_near = scored[0]
        d_far, tid_far = scored[-1]
        self.assertLess(d_near, d_far)
        f_near = UnifiedWaterRouter._clearance_factor(d_near)
        f_far = UnifiedWaterRouter._clearance_factor(d_far)
        self.assertGreater(f_near, f_far)
        ca = mesh.triangles[tid_near].centroid
        u = ("tri", "r9", tid_near)
        dual = [
            (nbr, w)
            for nbr, w, meta in self.router.adj[u]
            if meta.get("kind") == "navmesh_dual"
        ]
        self.assertTrue(dual)
        nbr, w = dual[0]
        cb = mesh.triangles[nbr[2]].centroid
        base = math.hypot(ca[0] - cb[0], ca[1] - cb[1])
        fb = UnifiedWaterRouter._clearance_factor(
            self.router._triangle_clearance("r9", cb)
        )
        self.assertAlmostEqual(w, base * 0.5 * (f_near + fb), places=5)
        self.assertAlmostEqual(f_near, 1.0 + CLEARANCE_K / (d_near + 1.0), places=6)

    def test_03_cross_corridor_route_between_two_lakes(self):
        res = self.router.route_xy((20.0, 20.0), (250.0, 50.0))
        self.assertEqual(res.status, STATUS_OK)
        self.assertIn("r9", res.visited_features)
        self.assertIn("w20", res.visited_features)
        self.assertIn("w30", res.visited_corridors)
        self.assertGreater(res.length_m, 200.0)

    def test_04_disconnected_component_returns_no_path(self):
        isolated_poly = Polygon([(500.0, 500.0), (600.0, 500.0), (600.0, 600.0), (500.0, 600.0)])
        isolated_mesh = build_navmesh_from_geometry(
            isolated_poly, feature_key="w999", project_from_wgs84=False
        )
        self.router.navmeshes["w999"] = isolated_mesh
        for t in isolated_mesh.triangles:
            self.router.state_xy[("tri", "w999", t.tri_id)] = t.centroid

        res = self.router.route_xy((10.0, 10.0), (550.0, 550.0))
        self.assertEqual(res.status, STATUS_NO_PATH)


class SeligerEndToEndRoutingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        if not FIXTURE.exists():
            raise unittest.SkipTest(f"missing {FIXTURE}")
        cls.store = load_compact_store(FIXTURE)
        cls.wgraph = build_water_graph(("relation", 399081), cls.store)
        cls.router = UnifiedWaterRouter(cls.store, cls.wgraph, project_from_wgs84=True)

    def test_05_seliger_south_to_north_across_polonovka(self):
        mesh = self.router.navmeshes["r399081"]
        south_tri = next(t for t in mesh.triangles if t.part_index == 0)
        north_tri = next(t for t in mesh.triangles if t.part_index == 1)
        res = self.router.route_xy(south_tri.centroid, north_tri.centroid)
        self.assertEqual(res.status, STATUS_OK)
        self.assertIn("r399081", res.visited_features)
        self.assertIn("r1203668", res.visited_features)
        self.assertGreater(res.length_m, 10000.0)

    def test_06_seliger_route_around_islands_stays_in_water(self):
        mesh = self.router.navmeshes["r399081"]
        south_tris = [t for t in mesh.triangles if t.part_index == 0]
        res = self.router.route_xy(
            south_tris[50].centroid,
            south_tris[len(south_tris) // 2].centroid,
        )
        self.assertEqual(res.status, STATUS_OK)
        self.assertEqual(res.visited_features, ["r399081"])
        self.assertGreater(res.length_m, 5000.0)
        self.assertGreaterEqual(len(res.coordinates_lonlat), 2)

    def test_07_route_seliger_through_knyazha_to_seremo(self):
        p_seliger = self.router.navmeshes["r399081"].triangles[10].centroid
        p_seremo = self.router.navmeshes["r9617478"].triangles[0].centroid
        res = self.router.route_xy(p_seliger, p_seremo)
        self.assertEqual(res.status, STATUS_OK)
        self.assertIn("r399081", res.visited_features)
        self.assertIn("w81753515", res.visited_features)
        self.assertIn("r9617478", res.visited_features)
        self.assertLess(
            res.visited_features.index("r399081"),
            res.visited_features.index("w81753515"),
        )
        self.assertLess(
            res.visited_features.index("w81753515"),
            res.visited_features.index("r9617478"),
        )

    def test_08_route_full_chain_seliger_to_knyazhka(self):
        p_seliger = self.router.navmeshes["r399081"].triangles[10].centroid
        p_knyazhka = self.router.navmeshes["r18072605"].triangles[0].centroid
        res = self.router.route_xy(p_seliger, p_knyazhka)
        self.assertEqual(res.status, STATUS_OK)
        expected_chain = ["r399081", "w81753515", "r9617478", "r9617480", "r9617479", "r18072605"]
        for feat in expected_chain:
            self.assertIn(feat, res.visited_features)
        for earlier, later in zip(expected_chain, expected_chain[1:]):
            self.assertLess(res.visited_features.index(earlier), res.visited_features.index(later))

    def test_09_route_seliger_via_canal_to_beloe_yuzhnoe(self):
        p_seliger = self.router.navmeshes["r399081"].triangles[0].centroid
        p_beloe = self.router.navmeshes["w20542134"].triangles[0].centroid
        res = self.router.route_xy(p_seliger, p_beloe)
        self.assertEqual(res.status, STATUS_OK)
        self.assertIn("r399081", res.visited_features)
        self.assertIn("w20542134", res.visited_features)
        self.assertIn("w167688573", res.visited_corridors)
        self.assertGreater(res.length_m, 100.0)

    def test_10_seliger_point_on_khachin_island_land_returns_outside_water(self):
        # Way 30171650 is Khachin island (inner hole of r399081); pick a land point away from internal lakes
        khachin_coords = [self.store.nodes[n] for n in self.store.ways[30171650].nds if n in self.store.nodes]
        khachin_poly = Polygon(khachin_coords).Representative_point() if hasattr(Polygon, "Representative_point") else Polygon(khachin_coords).representative_point()
        land_xy = self.router.project_pt(khachin_poly.x, khachin_poly.y)
        p_seliger = self.router.navmeshes["r399081"].triangles[0].centroid
        res = self.router.route_xy(land_xy, p_seliger)
        self.assertEqual(res.status, STATUS_OUTSIDE_WATER)

    def test_11_seliger_to_unconnected_polonets_returns_no_path(self):
        # Lake Polonets (relation/1236637) is nearby in the store but has no OSM water connection
        geom_polonets, _ = reconstruct_relation_geometry(self.store, 1236637)
        mesh_polonets = build_navmesh_from_geometry(
            geom_polonets, feature_key="r1236637", project_from_wgs84=True
        )
        self.router.navmeshes["r1236637"] = mesh_polonets
        for t in mesh_polonets.triangles:
            self.router.state_xy[("tri", "r1236637", t.tri_id)] = t.centroid
        try:
            p_seliger = self.router.navmeshes["r399081"].triangles[0].centroid
            p_polonets = mesh_polonets.triangles[0].centroid
            res = self.router.route_xy(p_seliger, p_polonets)
            self.assertEqual(res.status, STATUS_NO_PATH)
        finally:
            self.router.navmeshes.pop("r1236637", None)
            for t in mesh_polonets.triangles:
                self.router.state_xy.pop(("tri", "r1236637", t.tri_id), None)


if __name__ == "__main__":
    unittest.main()
