"""Tests for end-to-end water routing (A*, funnel smoothing, OUTSIDE_WATER, NO_PATH)."""

from __future__ import annotations

import math
import unittest
from pathlib import Path

from shapely.geometry import LineString, Polygon

from water_topology.build_water_graph import build_water_graph
from water_topology.dumps import load_compact_store
from water_topology.osm_store import Member, OsmStore, RelRec, WayRec
from water_topology.route import (
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

    def test_outside_water_returns_outside_water(self):
        # Point on land outside polygons
        res_land = self.router.route_xy((-50.0, -50.0), (10.0, 10.0))
        self.assertEqual(res_land.status, STATUS_OUTSIDE_WATER)
        # Point inside the island hole (50, 50)
        res_island = self.router.route_xy((50.0, 50.0), (10.0, 10.0))
        self.assertEqual(res_island.status, STATUS_OUTSIDE_WATER)

    def test_funnel_smoothing_avoids_island_hole(self):
        res = self.router.route_xy((10.0, 10.0), (90.0, 90.0))
        self.assertEqual(res.status, STATUS_OK)
        self.assertGreater(res.length_m, math.hypot(80.0, 80.0))
        island_interior = Polygon([(40.1, 40.1), (59.9, 40.1), (59.9, 59.9), (40.1, 59.9)])
        route_line = LineString(res.coordinates_xy)
        self.assertFalse(route_line.intersects(island_interior))

    def test_cross_corridor_route_between_two_lakes(self):
        res = self.router.route_xy((20.0, 20.0), (250.0, 50.0))
        self.assertEqual(res.status, STATUS_OK)
        self.assertIn("r9", res.visited_features)
        self.assertIn("w20", res.visited_features)
        self.assertIn("w30", res.visited_corridors)
        self.assertGreater(res.length_m, 200.0)

    def test_disconnected_component_returns_no_path(self):
        # Add an unlinked water polygon into navmeshes without graph edges
        self.store.nodes[50] = (500.0, 500.0)
        self.store.nodes[51] = (600.0, 500.0)
        self.store.nodes[52] = (600.0, 600.0)
        self.store.nodes[53] = (500.0, 600.0)
        from water_topology.build_navmesh import build_navmesh_from_geometry

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

    def test_route_seliger_through_knyazha_to_seremo(self):
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

    def test_route_seliger_via_canal_to_beloe_yuzhnoe(self):
        p_seliger = self.router.navmeshes["r399081"].triangles[0].centroid
        p_beloe = self.router.navmeshes["w20542134"].triangles[0].centroid
        res = self.router.route_xy(p_seliger, p_beloe)
        self.assertEqual(res.status, STATUS_OK)
        self.assertIn("r399081", res.visited_features)
        self.assertIn("w20542134", res.visited_features)
        self.assertIn("w167688573", res.visited_corridors)
        self.assertGreater(res.length_m, 100.0)


if __name__ == "__main__":
    unittest.main()
