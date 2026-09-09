"""Regression facts for discoverWaterGraph(relation/399081).

The expected graph is NOT fully hardcoded. Tests assert known OSM topology
facts by id. Names are display-only and are never used as discovery input.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path

from water_topology.discover import discover_water_graph
from water_topology.dumps import load_compact_store, load_seliger_audit_dumps

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"
SEED = ("relation", 399081)


def _load_store():
    if FIXTURE.exists():
        return load_compact_store(FIXTURE)
    if os.environ.get("SELIGER_TOPOLOGY_ALLOW_DUMPS") == "1":
        return load_seliger_audit_dumps()
    raise unittest.SkipTest(f"missing fixture {FIXTURE}")


class SeligerTopologyRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = _load_store()
        cls.graph = discover_water_graph(SEED, cls.store)

    def test_seed_relation_399081_two_outer_parts(self):
        g = self.graph
        self.assertEqual(g.seed_key, "r399081")
        self.assertTrue(g.has_node("relation", 399081))
        self.assertEqual(g.seed.get("outerPartCount"), 2)
        node = g.node("relation", 399081)
        self.assertEqual(node.outer_part_count, 2)
        self.assertEqual(node.geometry["type"], "MultiPolygon")
        self.assertEqual(len(node.geometry["coordinates"]), 2)

    def test_discovery_does_not_require_a_name_list(self):
        # Strip names from a copy of tags on the in-memory graph nodes and
        # re-run: ids in the confirmed component stay discoverable.
        store = _load_store()
        for way in store.ways.values():
            way.tags.pop("name", None)
            way.tags.pop("name:ru", None)
            way.tags.pop("alt_name", None)
        for rel in store.relations.values():
            rel.tags.pop("name", None)
            rel.tags.pop("name:ru", None)
            rel.tags.pop("alt_name", None)
        nameless = discover_water_graph(SEED, store)
        for osm_type, osm_id in [
            ("relation", 1203668),
            ("way", 81753515),
            ("relation", 9617478),
            ("relation", 9617480),
            ("relation", 9617479),
            ("relation", 18072605),
            ("relation", 18358803),
            ("way", 20542134),
            ("way", 167688573),
            ("relation", 399614),
            ("way", 30164445),
            ("relation", 1159264),
        ]:
            node = nameless.node(osm_type, osm_id)
            self.assertIsNotNone(node, f"missing {osm_type}/{osm_id} without names")
            self.assertTrue(node.in_confirmed_component, f"{osm_type}/{osm_id} not connected without names")

    def test_polonovka_direct_osm(self):
        e = self.graph.connected_pair(("relation", 399081), ("relation", 1203668))
        self.assertIsNotNone(e)
        self.assertEqual(e.connection_type, "DIRECT_OSM")
        self.assertEqual(e.status, "confirmed")
        self.assertGreaterEqual(e.evidence["sharedNodeCount"], 6)
        self.assertGreaterEqual(e.evidence["sharedEdgeCount"], 4)
        self.assertTrue(e.evidence["sharedNodes"])

    def test_knyazha_chain_to_knyazhka(self):
        g = self.graph
        self.assertTrue(g.node("way", 81753515).in_confirmed_component)
        self.assertTrue(g.node("relation", 9617478).in_confirmed_component)
        self.assertTrue(g.node("relation", 9617480).in_confirmed_component)
        self.assertTrue(g.node("relation", 9617479).in_confirmed_component)
        self.assertTrue(g.node("relation", 18072605).in_confirmed_component)
        self.assertIsNotNone(g.connected_pair(("relation", 399081), ("way", 81753515)))
        self.assertIsNotNone(g.connected_pair(("way", 81753515), ("relation", 9617478)))
        self.assertIsNotNone(g.connected_pair(("relation", 9617478), ("relation", 9617480)))
        self.assertIsNotNone(g.connected_pair(("relation", 9617480), ("relation", 9617479)))
        self.assertIsNotNone(g.connected_pair(("relation", 9617479), ("relation", 18072605)))
        # Княжа ≠ Княжка: two vertices
        self.assertNotEqual(
            g.node("way", 81753515).key, g.node("relation", 18072605).key
        )
        self.assertEqual(g.node("way", 81753515).hops_from_seed, 1)
        self.assertEqual(g.node("relation", 9617478).hops_from_seed, 2)
        self.assertEqual(g.node("relation", 9617480).hops_from_seed, 3)
        self.assertEqual(g.node("relation", 9617479).hops_from_seed, 4)
        self.assertEqual(g.node("relation", 18072605).hops_from_seed, 5)
        knyazhka_path = next(b["path"] for b in g.branches if b["leaf"] == "r18072605")
        for earlier, later in (
            ("r9617478", "r9617480"),
            ("r9617480", "r9617479"),
            ("r9617479", "r18072605"),
        ):
            self.assertIn(earlier, knyazhka_path)
            self.assertIn(later, knyazhka_path)
            self.assertLess(knyazhka_path.index(earlier), knyazhka_path.index(later))

    def test_varvarina_to_svyatoe(self):
        g = self.graph
        self.assertTrue(g.has_node("way", 1316976066))
        self.assertTrue(g.node("relation", 18358803).in_confirmed_component)
        self.assertIsNotNone(g.connected_pair(("relation", 399081), ("way", 1316976066)))
        self.assertIsNotNone(g.connected_pair(("way", 1316976066), ("relation", 18358803)))

    def test_canal_to_beloe_yuzhnoe(self):
        g = self.graph
        self.assertTrue(g.node("way", 167688573).in_confirmed_component)
        self.assertTrue(g.node("way", 20542134).in_confirmed_component)
        pair = g.connected_pair(("relation", 399081), ("way", 20542134))
        self.assertIsNotNone(pair)
        self.assertEqual(pair.connection_type, "WATERWAY_CONNECTOR")
        ids = {c["osmId"] for c in pair.connectors}
        self.assertIn(167688573, ids)
        beloe = g.node("way", 20542134)
        self.assertIsNotNone(beloe.island)
        self.assertIn(30171650, beloe.island["parentIslandWayIds"] or [])

    def test_sig_ryasivoe_lastso(self):
        g = self.graph
        self.assertTrue(g.node("relation", 399614).in_confirmed_component)  # Сиг
        self.assertTrue(g.node("way", 30164445).in_confirmed_component)  # Рясивое
        self.assertTrue(g.node("relation", 1159264).in_confirmed_component)  # Ласцо
        self.assertIsNotNone(g.connected_pair(("relation", 399081), ("way", 195929170)))
        self.assertIsNotNone(g.connected_pair(("way", 195929170), ("relation", 399614)))
        self.assertIsNotNone(g.connected_pair(("relation", 399081), ("way", 82331216)))
        self.assertIsNotNone(g.connected_pair(("way", 82331216), ("way", 30164445)))
        self.assertIsNotNone(g.connected_pair(("relation", 399081), ("way", 81323084)))
        self.assertIsNotNone(g.connected_pair(("way", 81323084), ("relation", 1159264)))

    def test_polonets_is_not_connected(self):
        g = self.graph
        node = g.node("relation", 1236637)
        self.assertIsNotNone(node, "Полонец r1236637 must still be discovered in the scan")
        self.assertFalse(node.in_confirmed_component)
        self.assertIsNone(g.connected_pair(("relation", 399081), ("relation", 1236637), confirmed=True))
        nearby = [r for r in g.nearby if r["osmId"] == 1236637]
        self.assertTrue(nearby)

    def test_nearby_candidates_are_not_confirmed(self):
        g = self.graph
        for osm_type, osm_id in [
            ("way", 119343953),  # Садок
            ("way", 430378915),
            ("relation", 16459681),
            ("relation", 1729194),  # Дивное
        ]:
            node = g.node(osm_type, osm_id)
            self.assertIsNotNone(node, f"missing nearby {osm_type}/{osm_id}")
            self.assertFalse(node.in_confirmed_component)
            self.assertIsNone(g.connected_pair(("relation", 399081), (osm_type, osm_id), confirmed=True))
            row = [r for r in g.nearby if r["osmId"] == osm_id]
            self.assertTrue(row, f"{osm_id} not listed as nearby")

        sadok = [r for r in g.nearby if r["osmId"] == 119343953][0]
        self.assertEqual(sadok["connectionType"], "PORTAGE_CANDIDATE")
        self.assertLessEqual(sadok["distanceM"], 100)
        self.assertGreater(sadok["distanceM"], 0)
        self.assertIn("proximity only", sadok["candidateReason"])

    def test_island_water_features(self):
        g = self.graph
        pond_a = g.node("way", 1305535843)
        pond_b = g.node("way", 1135420114)
        black = g.node("way", 49220130)
        self.assertIsNotNone(pond_a)
        self.assertIsNotNone(pond_b)
        self.assertFalse(pond_a.in_confirmed_component)
        self.assertFalse(pond_b.in_confirmed_component)
        self.assertTrue(pond_a.island["separateObject"])
        self.assertTrue(pond_b.island["separateObject"])
        self.assertIn(31057309, pond_a.island["parentIslandWayIds"])
        self.assertIn(1135420115, pond_b.island["parentIslandWayIds"])
        self.assertIsNotNone(black)
        self.assertTrue(black.island)
        self.assertFalse(black.in_confirmed_component)
        keys = {row["osmId"] for row in g.island_water}
        self.assertIn(1305535843, keys)
        self.assertIn(1135420114, keys)
        self.assertIn(20542134, keys)
        self.assertIn(49220130, keys)

    def test_two_glubokoe_are_distinct(self):
        g = self.graph
        chained = g.node("relation", 9617480)
        other = g.node("way", 30196394)
        self.assertTrue(chained.in_confirmed_component)
        if other is not None:
            self.assertFalse(other.in_confirmed_component)

    def test_confirmed_edges_explain_why(self):
        for e in self.graph.confirmed_edges():
            self.assertIn(e.connection_type, {"DIRECT_OSM", "WATERWAY_CONNECTOR"})
            self.assertIn("why", e.evidence)
            if e.connection_type == "DIRECT_OSM":
                self.assertGreater(e.evidence.get("sharedNodeCount", 0), 0)
            if e.connection_type == "WATERWAY_CONNECTOR":
                self.assertTrue(e.connectors)
                self.assertIn("connector", e.evidence)


if __name__ == "__main__":
    unittest.main()
