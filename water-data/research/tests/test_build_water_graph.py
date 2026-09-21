"""WaterFeature graph for seed relation/399081: OSM evidence only."""

from __future__ import annotations

import unittest
from pathlib import Path

from water_topology.build_water_graph import (
    ENDPOINT_ON_POLYGON,
    SHARED_NODE,
    WATERWAY_CONNECTOR,
    build_water_graph,
)
from water_topology.dumps import load_compact_store
from water_topology.osm_store import Member, OsmStore, RelRec, WayRec

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"
SEED = ("relation", 399081)


def _closed(store: OsmStore, wid: int, origin: tuple[float, float], tags: dict, size: float = 0.01):
    x, y = origin
    n0 = wid * 10
    nds = [n0, n0 + 1, n0 + 2, n0 + 3, n0]
    store.nodes[n0] = (x, y)
    store.nodes[n0 + 1] = (x + size, y)
    store.nodes[n0 + 2] = (x + size, y + size)
    store.nodes[n0 + 3] = (x, y + size)
    store.ways[wid] = WayRec(wid, nds=nds, tags=tags)


class BuildWaterGraphSeligerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not FIXTURE.exists():
            raise unittest.SkipTest(f"missing {FIXTURE}")
        cls.store = load_compact_store(FIXTURE)
        cls.g = build_water_graph(SEED, cls.store)

    def test_reference_features_discovered_by_id(self):
        g = self.g
        self.assertTrue(g.has_node("relation", 399081))
        self.assertTrue(g.has_node("relation", 1203668))  # Полоновка
        self.assertTrue(g.has_node("way", 81753515))  # Княжа
        self.assertTrue(g.has_node("relation", 9617478))  # Серемо
        self.assertTrue(g.has_node("relation", 379295))  # Селижаровка

    def test_no_direct_seliger_seremo_shortcut(self):
        self.assertIsNone(self.g.connected_pair(("relation", 399081), ("relation", 9617478)))
        self.assertIsNotNone(self.g.connected_pair(("relation", 399081), ("way", 81753515)))
        self.assertIsNotNone(self.g.connected_pair(("way", 81753515), ("relation", 9617478)))

    def test_polonovka_shared_node(self):
        e = self.g.connected_pair(("relation", 399081), ("relation", 1203668))
        self.assertIsNotNone(e)
        self.assertEqual(e.connection_type, SHARED_NODE)
        self.assertIn("osmId", e.evidence)

    def test_selizharovka_osm_evidence(self):
        e = self.g.connected_pair(("relation", 399081), ("relation", 379295))
        self.assertIsNotNone(e)
        self.assertIn(e.connection_type, {SHARED_NODE, ENDPOINT_ON_POLYGON})
        self.assertIn("osmId", e.evidence)

    def test_nearby_unconnected_have_no_edge(self):
        g = self.g
        self.assertFalse(g.has_node("relation", 1236637))  # Полонец
        self.assertFalse(g.has_node("way", 119343953))  # Садок
        self.assertIsNone(g.connected_pair(("relation", 399081), ("relation", 1236637)))

    def test_every_edge_has_osm_id_and_allowed_type(self):
        allowed = {
            SHARED_NODE,
            "SHARED_WAY",
            "RELATION_ROLE",
            ENDPOINT_ON_POLYGON,
            WATERWAY_CONNECTOR,
        }
        for e in self.g.edges:
            self.assertIn(e.connection_type, allowed)
            self.assertIsInstance(e.evidence.get("osmId"), int)

    def test_names_are_not_required(self):
        store = load_compact_store(FIXTURE)
        for way in store.ways.values():
            way.tags.pop("name", None)
            way.tags.pop("name:ru", None)
            way.tags.pop("alt_name", None)
        for rel in store.relations.values():
            rel.tags.pop("name", None)
            rel.tags.pop("name:ru", None)
            rel.tags.pop("alt_name", None)
        g = build_water_graph(SEED, store)
        self.assertTrue(g.has_node("relation", 1203668))
        self.assertTrue(g.has_node("way", 81753515))
        self.assertTrue(g.has_node("relation", 9617478))
        self.assertTrue(g.has_node("relation", 379295))

    def test_deterministic(self):
        g2 = build_water_graph(SEED, self.store)
        self.assertEqual([n.key for n in self.g.nodes.values()], [n.key for n in g2.nodes.values()])
        self.assertEqual(
            [(e.connection_type, e.from_key, e.to_key) for e in self.g.edges],
            [(e.connection_type, e.from_key, e.to_key) for e in g2.edges],
        )


class ConnectorExactlyTwoAreasTests(unittest.TestCase):
    def test_three_areas_on_one_way_no_shortcut(self):
        store = OsmStore()
        _closed(store, 1, (0.0, 0.0), {})
        store.relations[9] = RelRec(
            9,
            members=[Member("way", 1, "outer")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )
        _closed(store, 2, (0.05, 0.0), {"natural": "water", "water": "river"})
        _closed(store, 3, (0.10, 0.0), {"natural": "water", "water": "lake"})
        a = store.ways[1].nds[1]
        b = store.ways[2].nds[0]
        c = store.ways[2].nds[1]
        d = store.ways[3].nds[0]
        store.ways[8] = WayRec(8, nds=[a, b, c, d], tags={"waterway": "river"})
        g = build_water_graph(("relation", 9), store)
        self.assertIsNone(g.connected_pair(("relation", 9), ("way", 3)))
        self.assertFalse(any(e.connection_type == WATERWAY_CONNECTOR and {e.from_key, e.to_key} == {"r9", "w3"} for e in g.edges))

    def test_canal_links_exactly_two_areas(self):
        store = OsmStore()
        _closed(store, 1, (0.0, 0.0), {})
        store.relations[9] = RelRec(
            9,
            members=[Member("way", 1, "outer")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )
        _closed(store, 3, (0.4, 0.0), {"natural": "water", "water": "lake"})
        store.ways[4] = WayRec(
            4,
            nds=[store.ways[1].nds[0], 8001, store.ways[3].nds[0]],
            tags={"waterway": "canal"},
        )
        store.nodes[8001] = (0.2, 0.0)
        g = build_water_graph(("relation", 9), store)
        e = g.connected_pair(("relation", 9), ("way", 3))
        self.assertIsNotNone(e)
        self.assertEqual(e.connection_type, WATERWAY_CONNECTOR)
        self.assertEqual(e.evidence["osmId"], 4)
        self.assertFalse(g.has_node("way", 4))


if __name__ == "__main__":
    unittest.main()
