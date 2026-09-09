"""Independent validation of confirmed edges and BFS membership."""

from __future__ import annotations

import os
import unittest
from pathlib import Path

from water_topology.discover import discover_water_graph, parse_key
from water_topology.dumps import load_compact_store, load_seliger_audit_dumps
from water_topology.osm_store import Member, OsmStore, RelRec, WayRec
from water_topology.validate import (
    PR85_SKIP_EDGES,
    shortest_path,
    validate_direct_edge,
    validate_graph,
    validate_waterway_connector,
)

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"
SEED = ("relation", 399081)


def _load_store():
    if FIXTURE.exists():
        return load_compact_store(FIXTURE)
    if os.environ.get("SELIGER_TOPOLOGY_ALLOW_DUMPS") == "1":
        return load_seliger_audit_dumps()
    raise unittest.SkipTest(f"missing fixture {FIXTURE}")


def _add_closed_way(store: OsmStore, wid: int, origin: tuple[float, float], tags: dict, size: float = 0.01):
    x, y = origin
    n0 = wid * 10
    nds = [n0, n0 + 1, n0 + 2, n0 + 3, n0]
    store.nodes[n0] = (x, y)
    store.nodes[n0 + 1] = (x + size, y)
    store.nodes[n0 + 2] = (x + size, y + size)
    store.nodes[n0 + 3] = (x, y + size)
    store.ways[wid] = WayRec(wid, nds=nds, tags=tags)


class EvidenceAndBfsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = _load_store()
        cls.graph = discover_water_graph(SEED, cls.store)
        cls.report = validate_graph(cls.graph, cls.store)

    def test_every_direct_osm_has_shared_node_or_edge(self):
        direct = [e for e in self.graph.confirmed_edges() if e.connection_type == "DIRECT_OSM"]
        self.assertGreater(len(direct), 0)
        for e in direct:
            rec = validate_direct_edge(self.store, e)
            self.assertTrue(rec["valid"], rec)
            self.assertTrue(rec["sharedNodeCount"] or rec["sharedEdgeCount"])
            self.assertTrue(e.evidence.get("sharedNodes"))
            claimed = set(e.evidence["sharedNodes"])
            self.assertTrue(claimed <= set(rec["sharedNodes"]) | claimed)
            self.assertTrue(claimed <= set(rec["sharedNodes"]) or rec["sharedNodeCount"] >= len(claimed))

    def test_every_waterway_connector_has_concrete_connector(self):
        ww = [e for e in self.graph.confirmed_edges() if e.connection_type == "WATERWAY_CONNECTOR"]
        for e in ww:
            self.assertTrue(e.connectors, e)
            rec = validate_waterway_connector(self.store, self.graph, e)
            self.assertTrue(rec["valid"], rec)
            skips = [
                s for s in rec["suspicious"] if "skip" in s.get("reason", "").lower()
            ]
            self.assertFalse(skips, rec)
            for c in e.connectors:
                self.assertIn("osmId", c)
                ck = c.get("key")
                self.assertTrue(e.evidence.get("connector") or ck)

    def test_pr85_skip_edges_are_gone(self):
        for finding in PR85_SKIP_EDGES:
            e = self.graph.connected_pair(
                parse_key(finding["from"]), parse_key(finding["to"]), confirmed=True
            )
            if e is None:
                continue
            self.assertNotEqual(
                e.connection_type,
                "WATERWAY_CONNECTOR",
                f"{finding['from']}—{finding['to']} must not skip via {finding['connector']}",
            )

    def test_seliger_sereymo_path_goes_through_knyazha(self):
        skip = self.graph.connected_pair(("relation", 399081), ("relation", 9617478), confirmed=True)
        if skip is not None:
            self.assertNotEqual(skip.connection_type, "WATERWAY_CONNECTOR")
        path = shortest_path(self.graph, "r399081", "r9617478", types={"DIRECT_OSM"})
        self.assertIsNotNone(path)
        nodes, edges = path
        # Honest 2-hop: through Knyazha area and/or the Knyazha axis way as a vertex.
        self.assertTrue("w81753515" in nodes or "w32487176" in nodes, nodes)
        self.assertTrue(all(e.connection_type == "DIRECT_OSM" for e in edges))
        for e in edges:
            self.assertTrue(e.evidence.get("sharedNodes") or e.evidence.get("sharedNodeCount"))
        # Area chain still exists as DIRECT_OSM hops.
        self.assertIsNotNone(self.graph.connected_pair(("relation", 399081), ("way", 81753515)))
        self.assertIsNotNone(self.graph.connected_pair(("way", 81753515), ("relation", 9617478)))

    def test_canal_beloe_keeps_named_connector(self):
        e = self.graph.connected_pair(("relation", 399081), ("way", 20542134))
        self.assertIsNotNone(e)
        self.assertEqual(e.connection_type, "WATERWAY_CONNECTOR")
        self.assertEqual(e.connectors[0]["osmId"], 167688573)

    def test_proximity_does_not_create_bfs_edge(self):
        for osm_type, osm_id in [
            ("way", 119343953),
            ("way", 430378915),
            ("relation", 16459681),
            ("relation", 1729194),
            ("relation", 6407846),
        ]:
            node = self.graph.node(osm_type, osm_id)
            self.assertIsNotNone(node)
            self.assertFalse(node.in_confirmed_component)
            self.assertIsNone(
                self.graph.connected_pair(("relation", 399081), (osm_type, osm_id), confirmed=True)
            )

    def test_island_without_connector_not_in_bfs(self):
        for osm_id in (1305535843, 1135420114, 49220130):
            node = self.graph.node("way", osm_id)
            self.assertIsNotNone(node)
            self.assertFalse(node.in_confirmed_component)
            self.assertTrue(node.island)
            self.assertTrue(node.island.get("separateObject"))

    def test_beloe_island_is_in_bfs_because_of_canal(self):
        node = self.graph.node("way", 20542134)
        self.assertTrue(node.in_confirmed_component)
        self.assertTrue(node.island)
        self.assertTrue(node.island.get("hasWaterwayConnector"))

    def test_duplicate_glubokoe_not_merged(self):
        a = self.graph.node("relation", 9617480)
        b = self.graph.node("way", 30196394)
        self.assertTrue(a.in_confirmed_component)
        self.assertFalse(b.in_confirmed_component)
        self.assertNotEqual(a.key, b.key)

    def test_nameless_rerun_keeps_distinct_ids(self):
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
        self.assertTrue(nameless.node("relation", 9617480).in_confirmed_component)
        other = nameless.node("way", 30196394)
        if other is not None:
            self.assertFalse(other.in_confirmed_component)
        self.assertNotEqual(
            nameless.node("way", 81753515).key,
            nameless.node("relation", 18072605).key,
        )

    def test_polonets_outside_confirmed_component(self):
        node = self.graph.node("relation", 1236637)
        self.assertIsNotNone(node)
        self.assertFalse(node.in_confirmed_component)
        self.assertTrue(any(r["osmId"] == 1236637 for r in self.graph.nearby))

    def test_every_confirmed_node_has_traced_path(self):
        self.assertEqual(self.report["summary"]["confirmedNodesMissingPath"], 0)
        self.assertEqual(self.report["summary"]["invalidDirectCount"], 0)
        self.assertEqual(self.report["summary"]["invalidWaterwayConnectorCount"], 0)
        for row in self.report["confirmed_component"]["shortestPaths"]:
            for step in row["steps"]:
                self.assertIn(step["connectionType"], {"DIRECT_OSM", "WATERWAY_CONNECTOR"})
                ev = step["evidence"]
                if step["connectionType"] == "DIRECT_OSM":
                    self.assertTrue(ev.get("sharedNodes") or ev.get("sharedNodeCount"))
                else:
                    self.assertTrue(step["connectors"] or ev.get("connector"))

    def test_independent_validator_counts(self):
        s = self.report["summary"]
        self.assertEqual(s["invalidDirectCount"], 0)
        self.assertEqual(s["invalidWaterwayConnectorCount"], 0)
        self.assertEqual(len(self.report["invalid_direct_connections"]), 0)
        self.assertEqual(len(self.report["invalid_waterway_connectors"]), 0)


class ThreeAreaConnectorTests(unittest.TestCase):
    def test_third_area_on_connector_does_not_skip(self):
        """Seed — river — lake A — same river — lake B must not emit seed—B shortcut."""
        store = OsmStore()
        # Untagged outer member (real OSM shore), seed tags live on the relation.
        _add_closed_way(store, 1, (0.0, 0.0), {}, size=0.02)
        _add_closed_way(store, 2, (0.1, 0.0), {"natural": "water", "water": "lake"}, size=0.02)
        _add_closed_way(store, 3, (0.2, 0.0), {"natural": "water", "water": "lake"}, size=0.02)
        store.relations[9] = RelRec(
            9,
            members=[Member("way", 1, "outer")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )
        a_end = store.ways[1].nds[1]
        b_left = store.ways[2].nds[0]
        b_right = store.ways[2].nds[1]
        c_end = store.ways[3].nds[0]
        store.ways[8] = WayRec(8, nds=[a_end, b_left, b_right, c_end], tags={"waterway": "river"})
        graph = discover_water_graph(("relation", 9), store)
        skip = graph.connected_pair(("relation", 9), ("way", 3), confirmed=True)
        if skip is not None:
            self.assertNotEqual(skip.connection_type, "WATERWAY_CONNECTOR")
        self.assertTrue(graph.node("way", 2).in_confirmed_component)
        self.assertTrue(graph.node("way", 3).in_confirmed_component)
        path = shortest_path(graph, "r9", "w3", types={"DIRECT_OSM"})
        self.assertIsNotNone(path)
        self.assertIn("w8", path[0])

    def test_two_area_canal_still_emits_connector_edge(self):
        store = OsmStore()
        _add_closed_way(store, 1, (0.0, 0.0), {}, size=0.02)
        _add_closed_way(store, 2, (0.3, 0.0), {"natural": "water", "water": "lake"}, size=0.02)
        store.relations[9] = RelRec(
            9,
            members=[Member("way", 1, "outer")],
            tags={"type": "multipolygon", "natural": "water", "water": "lake"},
        )
        store.ways[4] = WayRec(
            4,
            nds=[store.ways[1].nds[0], 777, store.ways[2].nds[0]],
            tags={"waterway": "canal"},
        )
        store.nodes[777] = (0.15, 0.0)
        graph = discover_water_graph(("relation", 9), store)
        e = graph.connected_pair(("relation", 9), ("way", 2), confirmed=True)
        self.assertIsNotNone(e)
        self.assertEqual(e.connection_type, "WATERWAY_CONNECTOR")
        self.assertEqual(e.connectors[0]["osmId"], 4)


if __name__ == "__main__":
    unittest.main()
