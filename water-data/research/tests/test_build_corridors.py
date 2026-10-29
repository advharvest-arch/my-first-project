"""Tests for linear waterway corridors and ENDPOINT_ON_POLYGON navmesh binding."""

from __future__ import annotations

import unittest
from pathlib import Path

from water_topology.build_corridors import (
    DEFAULT_WIDTH_M,
    build_corridors,
    parse_width_m,
)
from water_topology.build_navmesh import build_navmesh_from_geometry, build_seliger_navmesh
from water_topology.build_water_graph import ENDPOINT_ON_POLYGON, build_water_graph
from water_topology.dumps import load_compact_store
from water_topology.osm_store import Member, OsmStore, RelRec, WayRec
from water_topology.rings import reconstruct_relation_geometry

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"


class CorridorWidthAndSyntheticBindingTests(unittest.TestCase):
    def test_width_parsing_from_tag_and_class_defaults(self):
        self.assertEqual(parse_width_m({"waterway": "canal", "width": "18.5 m"}), (18.5, "tag:width"))
        self.assertEqual(parse_width_m({"waterway": "river"}), (DEFAULT_WIDTH_M["river"], "default:river"))
        self.assertEqual(parse_width_m({"waterway": "canal"}), (DEFAULT_WIDTH_M["canal"], "default:canal"))
        self.assertEqual(parse_width_m({"waterway": "stream"}), (DEFAULT_WIDTH_M["stream"], "default:stream"))

    def test_synthetic_corridor_connects_two_polygon_navmeshes_at_endpoints(self):
        store = OsmStore()
        # Lake A: (0,0)-(100,100)
        store.nodes[1] = (0.0, 0.0)
        store.nodes[2] = (100.0, 0.0)
        store.nodes[3] = (100.0, 100.0)
        store.nodes[4] = (0.0, 100.0)
        store.ways[10] = WayRec(10, nds=[1, 2, 3, 4, 1], tags={})
        store.relations[9] = RelRec(
            9,
            members=[Member("way", 10, "outer")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )
        # Lake B: (200,0)-(300,100)
        store.nodes[5] = (200.0, 0.0)
        store.nodes[6] = (300.0, 0.0)
        store.nodes[7] = (300.0, 100.0)
        store.nodes[8] = (200.0, 100.0)
        store.ways[20] = WayRec(20, nds=[5, 6, 7, 8, 5], tags={"natural": "water", "water": "lake"})
        # Canal from node 2 on Lake A boundary to node 5 on Lake B boundary
        store.nodes[99] = (150.0, 0.0)
        store.ways[30] = WayRec(30, nds=[2, 99, 5], tags={"waterway": "canal", "width": "10"})

        wgraph = build_water_graph(("relation", 9), store)
        geom_a, _ = reconstruct_relation_geometry(store, 9)
        mesh_a = build_navmesh_from_geometry(geom_a, feature_key="r9", project_from_wgs84=False)

        net = build_corridors(
            store,
            wgraph,
            navmeshes={"r9": mesh_a},
            project_from_wgs84=False,
        )
        self.assertIn("w30", net.corridors)
        corridor = net.corridors["w30"]
        self.assertEqual(corridor.width_m, 10.0)
        self.assertAlmostEqual(corridor.length_m, 100.0)
        self.assertGreater(corridor.buffer_polygon.area, 900.0)
        self.assertEqual(len(corridor.portals), 2)
        portal_r9 = next(p for p in corridor.portals if p.area_key == "r9")
        self.assertEqual(portal_r9.node_id, 2)
        self.assertIsNotNone(portal_r9.navmesh_triangle_id)
        self.assertEqual(net.routing_edges[0]["connectionType"], ENDPOINT_ON_POLYGON)


class SeligerCorridorsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FIXTURE.exists():
            raise unittest.SkipTest(f"missing {FIXTURE}")
        cls.store = load_compact_store(FIXTURE)
        cls.wgraph = build_water_graph(("relation", 399081), cls.store)
        cls.mesh = build_seliger_navmesh(cls.store, 399081, project_to_utm=True)
        cls.net = build_corridors(cls.store, cls.wgraph, navmeshes={"r399081": cls.mesh})

    def test_seliger_corridors_built_and_bound_to_navmesh(self):
        summary = self.net.to_dict()["summary"]
        self.assertGreaterEqual(summary["corridorCount"], 12)
        self.assertGreaterEqual(summary["navmeshLinkedPortals"], 12)
        # Canal to Beloe-Yuzhnoe (w167688573) and Sigovka river (w195929170)
        self.assertIn("w167688573", self.net.corridors)
        self.assertIn("w195929170", self.net.corridors)
        for c in self.net.corridors.values():
            self.assertGreater(c.width_m, 0.0)
            self.assertGreater(c.buffer_polygon.area, 0.0)
            r399081_portals = [p for p in c.portals if p.area_key == "r399081"]
            for p in r399081_portals:
                self.assertIsNotNone(p.navmesh_triangle_id)


if __name__ == "__main__":
    unittest.main()
