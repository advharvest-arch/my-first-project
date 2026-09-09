from __future__ import annotations

import unittest

from water_topology.tags import (
    feature_role,
    is_area_water_tags,
    is_open_connector_tags,
    is_water_tagged,
    pick_name,
    register_connector_value,
)


class TagClassifierTests(unittest.TestCase):
    def test_area_tags_match_ingest_intent(self):
        self.assertTrue(is_area_water_tags({"natural": "water", "water": "lake"}))
        self.assertTrue(is_area_water_tags({"natural": "water", "water": "pond"}))
        self.assertTrue(is_area_water_tags({"natural": "water", "water": "river"}))
        self.assertTrue(is_area_water_tags({"landuse": "reservoir"}))
        self.assertTrue(is_water_tagged({"natural": "water"}))

    def test_connectors_are_open_waterways_only(self):
        self.assertEqual(feature_role({"waterway": "river"}), "waterway")
        self.assertEqual(feature_role({"waterway": "stream"}), "waterway")
        self.assertEqual(feature_role({"waterway": "canal"}), "waterway")
        self.assertEqual(feature_role({"waterway": "ditch"}), "waterway-weak")
        self.assertEqual(feature_role({"waterway": "drain"}), "waterway-weak")
        self.assertTrue(is_open_connector_tags({"waterway": "canal"}))
        self.assertFalse(is_open_connector_tags({"waterway": "ditch"}))

    def test_closed_river_area_without_waterway_key_is_area(self):
        # Knyazha-style: natural=water, water=river, no waterway=*
        self.assertEqual(feature_role({"natural": "water", "water": "river"}), "area")

    def test_names_are_display_only(self):
        self.assertEqual(pick_name({"name": "Княжа"}), "Княжа")
        self.assertIsNone(pick_name({"natural": "water"}))
        self.assertNotEqual(pick_name({"name": "Княжа"}), pick_name({"name": "Княжка"}))

    def test_classifier_is_extensible(self):
        from water_topology import tags as tags_mod

        before = set(tags_mod.CONNECTOR_WATERWAY_VALUES)
        try:
            register_connector_value("fairway")
            self.assertTrue(is_open_connector_tags({"waterway": "fairway"}))
        finally:
            tags_mod.CONNECTOR_WATERWAY_VALUES.clear()
            tags_mod.CONNECTOR_WATERWAY_VALUES.update(before)


if __name__ == "__main__":
    unittest.main()
