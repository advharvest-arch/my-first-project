"""Build buffered navigation corridors for linear waterways (river/canal/stream).

Constructs metric corridor polygons and routing segments for linear water
objects based on OSM `width` tags or waterway class defaults, and binds
corridor endpoints to polygon boundaries (Navmesh triangles/edges) strictly at
confirmed `ENDPOINT_ON_POLYGON` OSM nodes.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import shapely
from pyproj import Transformer
from shapely.geometry import LineString, Polygon

from .build_navmesh import DEFAULT_CRS, WaterNavmesh
from .build_water_graph import ENDPOINT_ON_POLYGON, WaterFeatureGraph, build_water_graph
from .osm_store import OsmStore
from .tags import feature_role, is_open_connector_tags

DEFAULT_WIDTH_M: dict[str, float] = {
    "river": 16.0,
    "canal": 12.0,
    "stream": 4.0,
}

_WIDTH_RE = re.compile(r"^\s*([0-9]+(?:[.,][0-9]+)?)")


def parse_width_m(tags: dict[str, str], *, min_width_m: float = 1.0) -> tuple[float, str]:
    """Return (width_m, source) from OSM `width` tag or waterway class default."""
    for key in ("width", "est_width"):
        raw = tags.get(key)
        if not raw:
            continue
        m = _WIDTH_RE.match(raw)
        if m:
            val = float(m.group(1).replace(",", "."))
            if val > 0:
                return max(val, min_width_m), f"tag:{key}"
    wtype = tags.get("waterway", "stream")
    return max(DEFAULT_WIDTH_M.get(wtype, 4.0), min_width_m), f"default:{wtype}"


@dataclass
class CorridorEndpointPortal:
    node_id: int
    area_key: str
    xy: tuple[float, float]
    navmesh_triangle_id: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "nodeId": self.node_id,
            "areaKey": self.area_key,
            "xy": [self.xy[0], self.xy[1]],
            "navmeshTriangleId": self.navmesh_triangle_id,
        }


@dataclass
class WaterwayCorridor:
    key: str
    osm_type: str
    osm_id: int
    waterway_class: str
    width_m: float
    width_source: str
    length_m: float
    centerline_coords: list[tuple[float, float]]
    buffer_polygon: Polygon
    portals: list[CorridorEndpointPortal] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "key": self.key,
            "osmType": self.osm_type,
            "osmId": self.osm_id,
            "waterwayClass": self.waterway_class,
            "widthM": self.width_m,
            "widthSource": self.width_source,
            "lengthM": self.length_m,
            "portalCount": len(self.portals),
            "portals": [p.to_dict() for p in self.portals],
            "bufferAreaM2": float(self.buffer_polygon.area),
        }


@dataclass
class CorridorNetwork:
    crs: str
    corridors: dict[str, WaterwayCorridor] = field(default_factory=dict)
    routing_edges: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "crs": self.crs,
            "summary": {
                "corridorCount": len(self.corridors),
                "boundPortalCount": sum(len(c.portals) for c in self.corridors.values()),
                "navmeshLinkedPortals": sum(
                    1
                    for c in self.corridors.values()
                    for p in c.portals
                    if p.navmesh_triangle_id is not None
                ),
                "routingEdgeCount": len(self.routing_edges),
            },
            "corridors": [c.to_dict() for _, c in sorted(self.corridors.items())],
            "routingEdges": self.routing_edges,
        }


def _bind_point_to_navmesh(mesh: WaterNavmesh, x: float, y: float) -> int | None:
    tri_id = mesh.find_triangle(x, y)
    if tri_id is not None:
        return tri_id
    # Boundary node on a polygon vertex/edge: find triangle sharing that boundary vertex
    pt = shapely.Point(x, y)
    best_id: int | None = None
    best_d = math.inf
    for t in mesh.triangles:
        poly = Polygon(t.vertices)
        d = float(poly.distance(pt))
        if d <= 1e-3 and d < best_d:
            best_d = d
            best_id = t.tri_id
    return best_id


def build_corridors(
    store: OsmStore,
    water_graph: WaterFeatureGraph,
    *,
    navmeshes: dict[str, WaterNavmesh] | None = None,
    crs: str = DEFAULT_CRS,
    project_from_wgs84: bool = True,
) -> CorridorNetwork:
    """Build buffered waterway corridors and connect them at ENDPOINT_ON_POLYGON nodes."""
    transformer = (
        Transformer.from_crs("EPSG:4326", crs, always_xy=True) if project_from_wgs84 else None
    )

    def project_pt(lon: float, lat: float) -> tuple[float, float]:
        if transformer is None:
            return (float(lon), float(lat))
        x, y = transformer.transform(lon, lat)
        return (float(x), float(y))

    # Collect confirmed ENDPOINT_ON_POLYGON attachments indexed by way_id
    way_endpoint_bindings: dict[int, list[tuple[int, str]]] = {}
    for edge in water_graph.edges:
        if edge.connection_type != ENDPOINT_ON_POLYGON:
            continue
        ev = edge.evidence
        if ev.get("osmType") != "way" or not isinstance(ev.get("osmId"), int):
            continue
        wid = int(ev["osmId"])
        way = store.ways.get(wid)
        if way is None or len(way.nds) < 2:
            continue
        bindings = way_endpoint_bindings.setdefault(wid, [])
        if "areaKeys" in ev:
            for ak in ev["areaKeys"]:
                area_node = water_graph.nodes.get(ak)
                if area_node is None:
                    continue
                area_nds = set(store.object_node_ids(area_node.osm_type, area_node.osm_id))
                for end_nid in (way.nds[0], way.nds[-1]):
                    if end_nid in area_nds and (end_nid, ak) not in bindings:
                        bindings.append((end_nid, ak))
        elif isinstance(ev.get("nodeId"), int):
            nid = int(ev["nodeId"])
            for endpoint_key in (edge.from_key, edge.to_key):
                node_obj = water_graph.nodes.get(endpoint_key)
                if node_obj and node_obj.role == "area":
                    if (nid, endpoint_key) not in bindings:
                        bindings.append((nid, endpoint_key))

    corridors: dict[str, WaterwayCorridor] = {}
    routing_edges: list[dict[str, Any]] = []

    for wid in sorted(way_endpoint_bindings):
        way = store.ways.get(wid)
        if way is None or not is_open_connector_tags(way.tags) or feature_role(way.tags) != "waterway":
            continue
        raw_coords = [store.nodes[nid] for nid in way.nds if nid in store.nodes]
        if len(raw_coords) < 2:
            continue
        proj_coords = [project_pt(lon, lat) for lon, lat in raw_coords]
        line = LineString(proj_coords)
        if line.is_empty or line.length <= 0.0:
            continue

        width_m, width_src = parse_width_m(way.tags)
        half_w = width_m / 2.0
        buf = line.buffer(half_w, cap_style="flat", join_style="round")
        if not isinstance(buf, Polygon):
            buf = buf.convex_hull if isinstance(buf, shapely.GeometryCollection) else Polygon()

        portals: list[CorridorEndpointPortal] = []
        for nid, area_key in way_endpoint_bindings[wid]:
            if nid not in store.nodes:
                continue
            xy = project_pt(*store.nodes[nid])
            tri_id = None
            if navmeshes and area_key in navmeshes:
                tri_id = _bind_point_to_navmesh(navmeshes[area_key], xy[0], xy[1])
            portals.append(
                CorridorEndpointPortal(
                    node_id=nid,
                    area_key=area_key,
                    xy=xy,
                    navmesh_triangle_id=tri_id,
                )
            )

        key = f"w{wid}"
        corridor = WaterwayCorridor(
            key=key,
            osm_type="way",
            osm_id=wid,
            waterway_class=way.tags.get("waterway", "river"),
            width_m=width_m,
            width_source=width_src,
            length_m=float(line.length),
            centerline_coords=proj_coords,
            buffer_polygon=buf,
            portals=portals,
        )
        corridors[key] = corridor

        if len(portals) >= 2:
            p0, p1 = portals[0], portals[-1]
            routing_edges.append(
                {
                    "corridorKey": key,
                    "wayId": wid,
                    "fromArea": p0.area_key,
                    "toArea": p1.area_key,
                    "fromNodeId": p0.node_id,
                    "toNodeId": p1.node_id,
                    "fromTriangleId": p0.navmesh_triangle_id,
                    "toTriangleId": p1.navmesh_triangle_id,
                    "lengthM": float(line.length),
                    "widthM": width_m,
                    "connectionType": ENDPOINT_ON_POLYGON,
                }
            )
        elif len(portals) == 1:
            p0 = portals[0]
            routing_edges.append(
                {
                    "corridorKey": key,
                    "wayId": wid,
                    "fromArea": p0.area_key,
                    "toArea": None,
                    "fromNodeId": p0.node_id,
                    "toNodeId": way.nds[-1] if way.nds[0] == p0.node_id else way.nds[0],
                    "fromTriangleId": p0.navmesh_triangle_id,
                    "toTriangleId": None,
                    "lengthM": float(line.length),
                    "widthM": width_m,
                    "connectionType": ENDPOINT_ON_POLYGON,
                }
            )

    return CorridorNetwork(
        crs=crs if project_from_wgs84 else "EPSG:4326",
        corridors=corridors,
        routing_edges=routing_edges,
    )


def main(argv: list[str] | None = None) -> int:
    from .build_navmesh import build_seliger_navmesh
    from .dumps import load_compact_store

    default_store = (
        Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "seliger_store.json.gz"
    )
    p = argparse.ArgumentParser(description="Build buffered waterway corridors for Seliger.")
    p.add_argument("--seed", default="relation/399081")
    p.add_argument("--store", default=str(default_store))
    p.add_argument("--out", help="Optional path to write corridors JSON")
    args = p.parse_args(argv)

    store = load_compact_store(Path(args.store))
    wgraph = build_water_graph(args.seed, store)
    seliger_mesh = build_seliger_navmesh(store, 399081, project_to_utm=True)
    net = build_corridors(store, wgraph, navmeshes={"r399081": seliger_mesh})
    payload = net.to_dict()
    if args.out:
        Path(args.out).write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    print(json.dumps(payload["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    if __package__ is None or __package__ == "":
        sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
        from water_topology.build_corridors import main as _main

        raise SystemExit(_main())
    raise SystemExit(main())
