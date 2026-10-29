"""Minimal FastAPI wrapper around UnifiedWaterRouter (research-only).

Does not modify route.py. Load Seliger fixture once, then POST /api/route.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .build_water_graph import build_water_graph
from .dumps import load_compact_store
from .route import STATUS_OK, RouteResult, UnifiedWaterRouter

DEFAULT_SEED = os.environ.get("WATER_ROUTER_SEED", "relation/399081")
DEFAULT_STORE = Path(
    os.environ.get(
        "WATER_ROUTER_STORE",
        str(Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "seliger_store.json.gz"),
    )
)

app = FastAPI(title="Water Router API", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_router: UnifiedWaterRouter | None = None


class RouteRequest(BaseModel):
    start: list[float]
    end: list[float]
    includeMesh: bool = False


def get_router() -> UnifiedWaterRouter:
    """Lazy singleton: same construction as tests/route.py CLI (seed r399081)."""
    global _router
    if _router is None:
        store = load_compact_store(DEFAULT_STORE)
        wgraph = build_water_graph(DEFAULT_SEED, store)
        _router = UnifiedWaterRouter(store, wgraph)
    return _router


def _parse_lonlat(value: list[float], name: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise HTTPException(status_code=400, detail=f"{name} must be [lon, lat]")
    try:
        lon = float(value[0])
        lat = float(value[1])
    except (TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"{name} must be numeric [lon, lat]") from exc
    if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
        raise HTTPException(status_code=400, detail=f"{name} out of range")
    return lon, lat


def route_result_to_geojson(res: RouteResult) -> dict[str, Any]:
    coords = [list(p) for p in res.coordinates_lonlat]
    features: list[dict[str, Any]] = []
    if res.status == STATUS_OK and len(coords) >= 2:
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "water-route",
                    "status": res.status,
                    "lengthM": round(res.length_m, 1),
                    "visitedFeatures": res.visited_features,
                    "visitedCorridors": res.visited_corridors,
                    "pointCount": len(coords),
                },
                "geometry": {"type": "LineString", "coordinates": coords},
            }
        )
        for role, pt in (("start", coords[0]), ("goal", coords[-1])):
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "kind": "water-route-endpoint",
                        "endpointRole": role,
                        "status": res.status,
                    },
                    "geometry": {"type": "Point", "coordinates": pt},
                }
            )
    return {
        "type": "FeatureCollection",
        "properties": {
            "status": res.status,
            "lengthM": round(res.length_m, 1),
            "visitedFeatures": res.visited_features,
            "visitedCorridors": res.visited_corridors,
            "pointCount": len(coords),
            "meshTriangleCount": len(res.visited_triangles),
        },
        "features": features,
    }


def mesh_triangle_features(router: UnifiedWaterRouter, res: RouteResult) -> list[dict[str, Any]]:
    """GeoJSON polygons for CDT triangles visited by A* (debug only)."""
    features: list[dict[str, Any]] = []
    seen: set[tuple[str, int]] = set()
    for area_key, tid in res.visited_triangles:
        key = (area_key, tid)
        if key in seen:
            continue
        seen.add(key)
        mesh = router.navmeshes.get(area_key)
        if mesh is None or tid < 0 or tid >= len(mesh.triangles):
            continue
        verts = mesh.triangles[tid].vertices
        ring = [list(router.unproject_pt(x, y)) for x, y in verts]
        if ring[0] != ring[-1]:
            ring.append(ring[0])
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "kind": "navmesh-triangle",
                    "areaKey": area_key,
                    "triId": tid,
                },
                "geometry": {"type": "Polygon", "coordinates": [ring]},
            }
        )
    return features


@app.post("/api/route")
def post_route(body: RouteRequest) -> dict[str, Any]:
    start = _parse_lonlat(body.start, "start")
    end = _parse_lonlat(body.end, "end")
    router = get_router()
    res = router.route_lonlat(start, end)
    fc = route_result_to_geojson(res)
    if body.includeMesh:
        fc["features"] = mesh_triangle_features(router, res) + fc["features"]
        fc["properties"]["meshTriangleCount"] = len(res.visited_triangles)
    return fc


def main() -> None:
    import uvicorn

    get_router()
    uvicorn.run(
        "water_topology.api:app",
        host=os.environ.get("WATER_ROUTER_HOST", "0.0.0.0"),
        port=int(os.environ.get("WATER_ROUTER_PORT", "8000")),
        reload=False,
    )


if __name__ == "__main__":
    if __package__ is None or __package__ == "":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from water_topology.api import main as _main

        _main()
    else:
        main()
