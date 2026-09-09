"""Visual GeoJSON is a view of PR #86 discovery — no new topology."""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from water_topology.export_visual import build_visual_geojson, write_visual_geojson
from water_topology.dumps import load_compact_store

ROOT = Path(__file__).resolve().parents[2]
DOCS = ROOT / "docs"
FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seliger_store.json.gz"
DISCOVERY_JSON = DOCS / "seliger-topology-discovery.json"
DISCOVERY_GEO = DOCS / "seliger-topology-discovery.geojson"


class VisualExportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not DISCOVERY_JSON.exists() or not DISCOVERY_GEO.exists():
            raise unittest.SkipTest("PR #86 discovery artefacts missing")
        if not FIXTURE.exists():
            raise unittest.SkipTest(f"missing fixture {FIXTURE}")
        cls.collection = build_visual_geojson(
            discovery_json=json.loads(DISCOVERY_JSON.read_text(encoding="utf-8")),
            discovery_geojson=json.loads(DISCOVERY_GEO.read_text(encoding="utf-8")),
            store=load_compact_store(FIXTURE),
        )

    def test_two_outers_and_137_inners(self):
        layers = [f["properties"]["layer"] for f in self.collection["features"]]
        self.assertEqual(layers.count("seed-outer"), 2)
        self.assertEqual(layers.count("osm-contour-inner"), 137)
        self.assertEqual(self.collection["properties"]["inner_polygons"], 137)
        self.assertEqual(self.collection["properties"]["seed_outers"], 2)

    def test_no_direct_osm_linestrings(self):
        for feat in self.collection["features"]:
            props = feat["properties"]
            geom = feat["geometry"]["type"]
            if props.get("connection_type") == "DIRECT_OSM":
                self.assertEqual(props["layer"], "direct-osm-node")
                self.assertEqual(geom, "Point")
            self.assertNotEqual(props.get("layer"), "confirmed-connection")

    def test_waterway_connectors_are_real_ways(self):
        connectors = [
            f
            for f in self.collection["features"]
            if f["properties"]["layer"] == "waterway-connector"
        ]
        self.assertEqual(len(connectors), 20)
        for feat in connectors:
            self.assertIn(feat["geometry"]["type"], {"LineString", "MultiLineString"})
            self.assertTrue(feat["properties"].get("connector_osm_id"))
            self.assertGreaterEqual(len(feat["geometry"]["coordinates"]), 2)

    def test_canal_and_island_statuses(self):
        canal = next(
            f
            for f in self.collection["features"]
            if f["properties"].get("connector_osm_id") == 167688573
        )
        self.assertEqual(canal["properties"]["connection_type"], "WATERWAY_CONNECTOR")
        beloe = next(
            f
            for f in self.collection["features"]
            if f["properties"].get("osm_id") == 20542134
            and f["properties"]["layer"] == "confirmed-feature"
        )
        self.assertTrue(beloe["properties"]["in_confirmed_component"])
        for osm_id in (1305535843, 1135420114, 49220130):
            feat = next(
                f
                for f in self.collection["features"]
                if f["properties"].get("osm_id") == osm_id
                and f["properties"]["layer"] == "island-water"
            )
            self.assertFalse(feat["properties"]["in_confirmed_component"])

    def test_write_roundtrip_matches_public_path_shape(self):
        out = Path("/tmp/seliger-topology-debug.geojson")
        props = write_visual_geojson(
            discovery_json_path=DISCOVERY_JSON,
            discovery_geojson_path=DISCOVERY_GEO,
            store_path=FIXTURE,
            out_path=out,
        )
        self.assertEqual(props["inner_polygons"], 137)
        self.assertFalse(props["focus_labels_missing"])


if __name__ == "__main__":
    unittest.main()
