"""OSM water-model audit: tags/roles only. No network in CI."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from osm_water_model_audit.assemble import (
    FORBIDDEN_COMPUTED_KEYS,
    assemble_object,
    assert_no_computed_links,
    summarize_sample,
)
from osm_water_model_audit.classify import (
    classify_inspect_layer,
    classify_member,
    classify_relation_object,
    classify_way_object,
    is_area_tags,
    is_multipolygon_area,
    is_waterway_relation,
    member_geometry_type,
    way_is_closed,
)
from osm_water_model_audit.report import build_report, write_report
from osm_water_model_audit.seeds import SEEDS

FIXTURE = (
    Path(__file__).resolve().parent
    / "fixtures"
    / "osm_water_model_audit"
    / "relation_2406778.json"
)


def _load_elements() -> list[dict]:
    return json.loads(FIXTURE.read_text(encoding="utf-8"))["elements"]


class ClassifyAlignedWithInspectorTests(unittest.TestCase):
    def test_area_vs_centerline_tags(self):
        self.assertTrue(is_area_tags({"natural": "water", "water": "river"}))
        self.assertTrue(
            is_multipolygon_area(
                {"type": "multipolygon", "natural": "water", "water": "river"}
            )
        )
        self.assertFalse(is_waterway_relation({"type": "multipolygon", "waterway": "river"}))
        self.assertTrue(is_waterway_relation({"type": "waterway", "waterway": "river"}))
        self.assertFalse(is_multipolygon_area({"type": "waterway", "waterway": "river"}))

    def test_names_are_not_classification_inputs(self):
        lake = {"natural": "water", "water": "lake", "name": "Селигер"}
        unnamed = {"natural": "water", "water": "lake"}
        self.assertEqual(
            classify_inspect_layer(lake, "polygon"),
            classify_inspect_layer(unnamed, "polygon"),
        )
        self.assertEqual(classify_relation_object(lake), "polygon-lake")
        river_named = {"waterway": "river", "name": "Волга"}
        river_unnamed = {"waterway": "river"}
        self.assertEqual(
            classify_inspect_layer(river_named, "line"),
            classify_inspect_layer(river_unnamed, "line"),
        )
        self.assertEqual(classify_way_object(river_named, closed=False), "centerline-river")

    def test_untagged_open_outer_is_mp_outer_not_centerline(self):
        rel = {"type": "multipolygon", "natural": "water", "water": "river"}
        cls = classify_member(role="outer", member_tags={}, relation_tags=rel)
        self.assertEqual(cls, "mp-outer")
        self.assertNotEqual(cls, "other")
        geom = member_geometry_type(
            role="outer",
            relation_tags=rel,
            member_tags={},
            node_ids=[1, 2, 3],
        )
        self.assertEqual(geom, "LineString")
        self.assertFalse(way_is_closed([1, 2, 3]))

    def test_waterway_relation_members_use_line_class(self):
        rel = {"type": "waterway", "waterway": "river"}
        cls = classify_member(
            role="main_stream",
            member_tags={"waterway": "river"},
            relation_tags=rel,
        )
        self.assertEqual(cls, "centerline-river")
        inherited = classify_member(role="main_stream", member_tags={}, relation_tags=rel)
        self.assertEqual(inherited, "centerline-river")


class Relation2406778FixtureTests(unittest.TestCase):
    def setUp(self):
        self.elements = _load_elements()
        self.obj = assemble_object(
            "relation", 2406778, self.elements, seed_key="river_area_mouth"
        )

    def test_relation_is_polygon_river_area(self):
        self.assertIsNone(self.obj.get("error"))
        self.assertEqual(self.obj["classification"], "polygon-river-area")
        self.assertEqual(self.obj["geometry_type"], "MultiPolygon")
        self.assertEqual(self.obj["osm_type"], "relation")
        self.assertEqual(self.obj["role_counts"]["outer"], 5)
        self.assertEqual(self.obj["role_counts"]["inner"], 2)

    def test_way_180396592_mp_outer_linestring_three_untagged(self):
        target = next(m for m in self.obj["members"] if m["osm_id"] == 180396592)
        self.assertEqual(target["role"], "outer")
        self.assertEqual(target["classification"], "mp-outer")
        self.assertNotEqual(target["classification"], "other")
        self.assertEqual(target["geometry_type"], "LineString")
        self.assertEqual(target["vertex_count"], 3)
        self.assertEqual(target["tags"], {})
        self.assertFalse(target["closed"])
        self.assertTrue(target["open"])
        self.assertEqual(target["start_node_id"], 301)
        self.assertEqual(target["end_node_id"], 303)

    def test_inner_not_centerline(self):
        for m in self.obj["members"]:
            if m["role"] == "inner":
                self.assertEqual(m["classification"], "mp-inner")
                self.assertNotIn(m["classification"], ("centerline-river", "other"))

    def test_declared_extra_parent_not_proximity(self):
        target = next(m for m in self.obj["members"] if m["osm_id"] == 180396592)
        parent_ids = {m["relation_id"] for m in target["membership"]}
        self.assertIn(2406778, parent_ids)
        self.assertIn(2402229, parent_ids)


class WaterwayAndLakeWayTests(unittest.TestCase):
    def test_waterway_relation_main_stream(self):
        elements = [
            {
                "type": "relation",
                "id": 379295,
                "tags": {"type": "waterway", "waterway": "river", "name": "Селижаровка"},
                "members": [
                    {"type": "way", "ref": 28237778, "role": "main_stream"},
                    {"type": "way", "ref": 9, "role": "side_stream"},
                ],
            },
            {
                "type": "way",
                "id": 28237778,
                "nodes": [1, 2, 3, 4],
                "tags": {"waterway": "river"},
            },
            {
                "type": "way",
                "id": 9,
                "nodes": [4, 5, 6],
                "tags": {"waterway": "stream"},
            },
        ]
        obj = assemble_object("relation", 379295, elements)
        self.assertEqual(obj["classification"], "waterway-relation")
        self.assertEqual(obj["geometry_type"], "GeometryCollection")
        self.assertEqual(obj["role_counts"]["main_stream"], 1)
        self.assertEqual(obj["role_counts"]["side_stream"], 1)
        main = obj["members"][0]
        self.assertEqual(main["classification"], "centerline-river")
        self.assertEqual(main["geometry_type"], "LineString")
        side = obj["members"][1]
        self.assertEqual(side["classification"], "centerline-stream")

    def test_standalone_river_way(self):
        elements = [
            {
                "type": "way",
                "id": 28237778,
                "nodes": [1, 2, 3, 4],
                "tags": {"waterway": "river"},
            }
        ]
        obj = assemble_object("way", 28237778, elements)
        self.assertEqual(obj["classification"], "centerline-river")
        self.assertEqual(obj["geometry_type"], "LineString")
        self.assertFalse(obj["closed"])
        self.assertEqual(obj["membership"], [])

    def test_closed_lake_way_without_parent_relation(self):
        elements = [
            {
                "type": "way",
                "id": 20542587,
                "nodes": [10, 11, 12, 13, 10],
                "tags": {"natural": "water"},
            }
        ]
        obj = assemble_object("way", 20542587, elements)
        self.assertEqual(obj["classification"], "polygon-lake")
        self.assertEqual(obj["geometry_type"], "Polygon")
        self.assertTrue(obj["closed"])
        self.assertEqual(obj["membership"], [])

    def test_reservoir_and_lake_seed_classes(self):
        lake = assemble_object(
            "relation",
            1,
            [
                {
                    "type": "relation",
                    "id": 1,
                    "tags": {"type": "multipolygon", "natural": "water", "water": "lake"},
                    "members": [{"type": "way", "ref": 2, "role": "outer"}],
                },
                {"type": "way", "id": 2, "nodes": [1, 2, 3], "tags": {}},
            ],
        )
        res = assemble_object(
            "relation",
            3,
            [
                {
                    "type": "relation",
                    "id": 3,
                    "tags": {
                        "type": "multipolygon",
                        "natural": "water",
                        "water": "reservoir",
                    },
                    "members": [{"type": "way", "ref": 4, "role": "inner"}],
                },
                {"type": "way", "id": 4, "nodes": [1, 2, 3, 1], "tags": {}},
            ],
        )
        self.assertEqual(lake["classification"], "polygon-lake")
        self.assertEqual(res["classification"], "polygon-reservoir")
        self.assertEqual(res["members"][0]["classification"], "mp-inner")


class ReportContractTests(unittest.TestCase):
    def test_stats_and_no_computed_fields(self):
        elements = _load_elements()
        river_area = assemble_object(
            "relation", 2406778, elements, seed_key="river_area_mouth"
        )
        ww = assemble_object(
            "relation",
            379295,
            [
                {
                    "type": "relation",
                    "id": 379295,
                    "tags": {"type": "waterway", "waterway": "river"},
                    "members": [{"type": "way", "ref": 28237778, "role": "main_stream"}],
                },
                {
                    "type": "way",
                    "id": 28237778,
                    "nodes": [1, 2, 3],
                    "tags": {"waterway": "river"},
                },
            ],
            seed_key="selizharovka",
        )
        report = build_report([river_area, ww])
        assert_no_computed_links(report)
        keys_blob = json.dumps(_all_keys(report)).lower()
        for bad in FORBIDDEN_COMPUTED_KEYS:
            self.assertNotIn(bad, keys_blob)
        self.assertTrue(report["check_way_180396592"]["ok"])
        stats = report["stats"]
        self.assertEqual(stats["polygon_river_area"], 1)
        self.assertEqual(stats["waterway_relation"], 1)
        self.assertEqual(stats["relations_with_role"]["main_stream"], 1)
        self.assertEqual(stats["relations_with_role"]["inner"], 1)
        self.assertGreaterEqual(stats["untagged_outer_ways"], 1)
        self.assertGreaterEqual(stats["inner_members"], 2)
        with tempfile.TemporaryDirectory() as tmp:
            md_path, json_path = write_report(report, Path(tmp))
            md = md_path.read_text(encoding="utf-8")
            loaded = json.loads(json_path.read_text(encoding="utf-8"))
        self.assertIn("way/180396592", md)
        self.assertIn("PASS", md)
        self.assertIn("не связь", md)
        self.assertIn("main_stream", md)
        self.assertEqual(loaded["check_way_180396592"]["ok"], True)

    def test_summarize_does_not_join_polygon_and_centerline(self):
        stats = summarize_sample(
            [
                assemble_object("relation", 2406778, _load_elements()),
                assemble_object(
                    "way",
                    28237778,
                    [
                        {
                            "type": "way",
                            "id": 28237778,
                            "nodes": [1, 2, 3],
                            "tags": {"waterway": "river"},
                        }
                    ],
                ),
            ]
        )
        self.assertIn("centerline-river", stats["by_classification_seeds_and_members"])
        self.assertIn("polygon-river-area", stats["by_seed_classification"])
        self.assertNotIn("linked_pairs", stats)
        self.assertNotIn("nearest", stats)

    def test_seed_list_covers_required_reference_keys(self):
        keys = {s["key"] for s in SEEDS}
        self.assertGreaterEqual(len(SEEDS), 12)
        for required in (
            "seliger",
            "selizharovka",
            "river_area_mouth",
            "river_area_large",
            "ladoga",
            "onega",
            "beloe",
            "rybinsk",
            "volga",
            "neva",
            "river_way",
            "lake_way",
        ):
            self.assertIn(required, keys)
        ids = {(s["osm_type"], s["osm_id"]) for s in SEEDS}
        self.assertIn(("relation", 399081), ids)
        self.assertIn(("relation", 2406778), ids)
        self.assertIn(("relation", 379295), ids)


def _all_keys(payload) -> list[str]:
    keys: list[str] = []
    if isinstance(payload, dict):
        for k, v in payload.items():
            keys.append(str(k))
            keys.extend(_all_keys(v))
    elif isinstance(payload, list):
        for item in payload:
            keys.extend(_all_keys(item))
    return keys


if __name__ == "__main__":
    unittest.main()
