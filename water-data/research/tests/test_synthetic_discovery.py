"""Synthetic graph: discovery must work without names as a join key."""

from __future__ import annotations

import unittest

from water_topology.discover import discover_water_graph
from water_topology.osm_store import Member, OsmStore, RelRec, WayRec


def _add_closed_way(store: OsmStore, wid: int, origin: tuple[float, float], tags: dict, size: float = 0.01):
    x, y = origin
    n0 = wid * 10
    nds = [n0, n0 + 1, n0 + 2, n0 + 3, n0]
    store.nodes[n0] = (x, y)
    store.nodes[n0 + 1] = (x + size, y)
    store.nodes[n0 + 2] = (x + size, y + size)
    store.nodes[n0 + 3] = (x, y + size)
    store.ways[wid] = WayRec(wid, nds=nds, tags=tags)


class SyntheticDiscoveryTests(unittest.TestCase):
    def test_bfs_follows_shared_nodes_and_connectors_not_names(self):
        store = OsmStore()
        # Seed lake: unnamed relation, two outers would be overkill here — one outer way.
        _add_closed_way(
            store, 1, (0.0, 0.0), {"natural": "water", "water": "lake"}, size=0.05
        )
        # Attach seed as relation so membership is tested.
        store.relations[9] = RelRec(
            9,
            members=[Member("way", 1, "outer")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )
        # Unnamed neighbour sharing two nodes with the seed outer way.
        shared_a, shared_b = store.ways[1].nds[1], store.ways[1].nds[2]
        store.ways[2] = WayRec(
            2,
            nds=[shared_a, shared_b, 9001, 9002, shared_a],
            tags={"natural": "water", "water": "pond"},
        )
        store.nodes[9001] = (0.08, 0.02)
        store.nodes[9002] = (0.08, 0.04)
        # Canal from seed node to a third unnamed lake (no shared node seed↔lake3).
        far = 40
        _add_closed_way(store, 3, (0.4, 0.0), {"natural": "water", "water": "lake"}, size=0.02)
        seed_node = store.ways[1].nds[0]
        lake3_node = store.ways[3].nds[0]
        store.ways[4] = WayRec(
            4,
            nds=[seed_node, 8001, lake3_node],
            tags={"waterway": "canal"},
        )
        store.nodes[8001] = (0.2, 0.0)
        # Nearby unnamed pond,  ~20–30 m, no shared node (0.00025 deg ≈ 28 m).
        _add_closed_way(
            store,
            5,
            (0.0, -0.00028),
            {"natural": "water", "water": "pond"},
            size=0.00005,
        )
        # Isolated named lake far away — name must not pull it into the connected graph.
        _add_closed_way(
            store,
            6,
            (2.0, 2.0),
            {"natural": "water", "water": "lake", "name": "ShouldNotJoinByName"},
            size=0.05,
        )
        # Two same-name lakes: only the one sharing a node is connected.
        _add_closed_way(
            store,
            7,
            (5.0, 5.0),
            {"natural": "water", "name": "Twin"},
            size=0.02,
        )

        graph = discover_water_graph(("relation", 9), store, nearby_m=250.0, portage_m=100.0)

        self.assertTrue(graph.has_node("relation", 9))
        self.assertTrue(graph.has_node("way", 2))
        self.assertTrue(graph.has_node("way", 3))
        self.assertTrue(graph.has_node("way", 4))
        self.assertIsNotNone(graph.connected_pair(("relation", 9), ("way", 2)))
        canal_edge = graph.connected_pair(("relation", 9), ("way", 3), confirmed=True)
        self.assertIsNotNone(canal_edge)
        self.assertEqual(canal_edge.connection_type, "WATERWAY_CONNECTOR")
        self.assertEqual(canal_edge.connectors[0]["osmId"], 4)
        self.assertIn("connector", canal_edge.evidence)

        # Nearby pond is a candidate, not confirmed.
        self.assertTrue(graph.has_node("way", 5))
        self.assertIsNone(graph.connected_pair(("relation", 9), ("way", 5), confirmed=True))
        near = [r for r in graph.nearby if r["osmId"] == 5]
        self.assertEqual(len(near), 1)
        self.assertIn(near[0]["connectionType"], {"NEARBY_CANDIDATE", "PORTAGE_CANDIDATE"})

        # Named far lake is not in the confirmed component.
        far_node = graph.node("way", 6)
        if far_node is not None:
            self.assertFalse(far_node.in_confirmed_component)
        self.assertIsNone(graph.connected_pair(("relation", 9), ("way", 6), confirmed=True))
        self.assertIsNone(graph.connected_pair(("relation", 9), ("way", 7), confirmed=True))

        # No name appears as a join key in evidence.
        for e in graph.confirmed_edges():
            blob = str(e.evidence).lower()
            self.assertNotIn("shouldnotjoinbyname", blob)
            self.assertNotIn("twin", blob)

    def test_way_seed_is_accepted(self):
        store = OsmStore()
        _add_closed_way(store, 11, (0, 0), {"natural": "water", "water": "lake"})
        _add_closed_way(store, 12, (1, 1), {"natural": "water"})
        # share a node
        store.ways[12].nds[0] = store.ways[11].nds[0]
        graph = discover_water_graph(("way", 11), store)
        self.assertEqual(graph.seed_key, "w11")
        self.assertIsNotNone(graph.connected_pair(("way", 11), ("way", 12)))


if __name__ == "__main__":
    unittest.main()
