"""Unit tests for the research FastAPI wrapper (no Seliger navmesh load)."""

from __future__ import annotations

import unittest
from unittest.mock import patch

from fastapi import HTTPException

from water_topology.api import RouteRequest, post_route, route_result_to_geojson
from water_topology.route import STATUS_OK, STATUS_OUTSIDE_WATER, RouteResult


class StubRouter:
    def route_lonlat(self, start, goal):
        return RouteResult(
            status=STATUS_OK,
            coordinates_lonlat=[start, goal],
            length_m=123.4,
            visited_features=["r399081"],
            visited_corridors=[],
        )


class ApiGeojsonTests(unittest.TestCase):
    def test_ok_result_is_linestring_feature_collection(self):
        res = RouteResult(
            status=STATUS_OK,
            coordinates_lonlat=[(33.0, 57.0), (33.1, 57.1)],
            length_m=10.0,
            visited_features=["r399081"],
        )
        fc = route_result_to_geojson(res)
        self.assertEqual(fc["type"], "FeatureCollection")
        line = next(f for f in fc["features"] if f["properties"]["kind"] == "water-route")
        self.assertEqual(line["geometry"]["type"], "LineString")
        self.assertEqual(line["geometry"]["coordinates"], [[33.0, 57.0], [33.1, 57.1]])

    def test_outside_water_has_empty_features_and_status(self):
        fc = route_result_to_geojson(RouteResult(status=STATUS_OUTSIDE_WATER))
        self.assertEqual(fc["properties"]["status"], STATUS_OUTSIDE_WATER)
        self.assertEqual(fc["features"], [])


class ApiEndpointTests(unittest.TestCase):
    def test_post_route_returns_geojson(self):
        with patch("water_topology.api.get_router", return_value=StubRouter()):
            body = post_route(RouteRequest(start=[33.08, 57.04], end=[33.09, 57.05]))
        self.assertEqual(body["type"], "FeatureCollection")
        self.assertEqual(body["properties"]["status"], STATUS_OK)
        line = next(f for f in body["features"] if f["properties"]["kind"] == "water-route")
        self.assertEqual(line["geometry"]["type"], "LineString")

    def test_post_route_rejects_bad_coordinates(self):
        with patch("water_topology.api.get_router", return_value=StubRouter()):
            with self.assertRaises(HTTPException) as ctx:
                post_route(RouteRequest(start=[33.08], end=[33.09, 57.05]))
        self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
