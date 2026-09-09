from __future__ import annotations

import unittest

from water_topology.osm_store import OsmStore, RelRec, WayRec, Member
from water_topology.rings import assemble_rings, reconstruct_relation_geometry


def _store_two_outers() -> OsmStore:
    """Two separate closed outer ways sharing a name must stay two polygons."""
    store = OsmStore()
    # south square
    store.nodes = {
        1: (0.0, 0.0),
        2: (1.0, 0.0),
        3: (1.0, 1.0),
        4: (0.0, 1.0),
        5: (0.0, 0.0),
        # north square, disjoint
        11: (0.0, 3.0),
        12: (1.0, 3.0),
        13: (1.0, 4.0),
        14: (0.0, 4.0),
        15: (0.0, 3.0),
        # hole inside south
        21: (0.25, 0.25),
        22: (0.5, 0.25),
        23: (0.5, 0.5),
        24: (0.25, 0.5),
        25: (0.25, 0.25),
    }
    store.ways[100] = WayRec(100, nds=[1, 2, 3, 4, 1], tags={})
    store.ways[101] = WayRec(101, nds=[11, 12, 13, 14, 11], tags={})
    store.ways[102] = WayRec(102, nds=[21, 22, 23, 24, 21], tags={"place": "islet"})
    store.relations[1] = RelRec(
        1,
        members=[
            Member("way", 100, "outer"),
            Member("way", 101, "outer"),
            Member("way", 102, "inner"),
        ],
        tags={"type": "multipolygon", "natural": "water", "name": "SameName"},
    )
    return store


class RingAssemblyTests(unittest.TestCase):
    def test_open_ways_join_by_endpoint_node_id_only(self):
        store = OsmStore()
        store.nodes = {1: (0, 0), 2: (1, 0), 3: (1, 1), 4: (0, 1)}
        store.ways[10] = WayRec(10, nds=[1, 2])
        store.ways[11] = WayRec(11, nds=[2, 3])
        store.ways[12] = WayRec(12, nds=[3, 4])
        store.ways[13] = WayRec(13, nds=[4, 1])
        rings, issues, stats = assemble_rings([10, 11, 12, 13], store.ways, store.nodes, "outer")
        self.assertEqual(stats["closed_rings"], 1)
        self.assertTrue(rings[0]["closed"])
        self.assertEqual(rings[0]["closed_by"], "endpoint_node_id_chain")
        self.assertFalse(any(i["kind"] == "unclosed_ring" for i in issues))

    def test_two_outers_are_not_dissolved_because_of_shared_name(self):
        store = _store_two_outers()
        geom, meta = reconstruct_relation_geometry(store, 1)
        self.assertIsNotNone(geom)
        self.assertEqual(meta["outer_part_count"], 2)
        self.assertEqual(geom.geom_type, "MultiPolygon")
        self.assertEqual(len(geom.geoms), 2)
        self.assertEqual(len(meta["island_polys"]), 1)


if __name__ == "__main__":
    unittest.main()
