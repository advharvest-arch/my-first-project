"""Serialize a WaterGraph to JSON / GeoJSON / Markdown (research artefacts)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from shapely.geometry import mapping, shape

from .discover import WaterGraph, parse_key
from .osm_store import OsmStore
from .tags import pick_name

LAYER_COLORS = {
    "water-area": "#1d4ed8",
    "water-feature": "#0ea5e9",
    "waterway": "#22c55e",
    "confirmed-connection": "#16a34a",
    "connector-way": "#a3e635",
    "nearby-candidate": "#f59e0b",
    "island-water": "#c026d3",
    "uncertain-connection": "#ef4444",
    "portage-candidate": "#fb7185",
}


def _centroid_of_node(node) -> list[float] | None:
    if not node.geometry:
        return None
    try:
        g = shape(node.geometry)
        if g.is_empty:
            return None
        c = g.representative_point()
        return [c.x, c.y]
    except Exception:
        return None


def graph_to_geojson(graph: WaterGraph, store: OsmStore | None = None) -> dict[str, Any]:
    features: list[dict[str, Any]] = []

    seed_node = graph.nodes.get(graph.seed_key)
    if seed_node and seed_node.geometry:
        geom = shape(seed_node.geometry)
        if geom.geom_type == "MultiPolygon":
            parts = list(geom.geoms)
        elif geom.geom_type == "Polygon":
            parts = [geom]
        else:
            parts = []
        for i, part in enumerate(parts):
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "layer": "water-area",
                        "kind": "seed-outer-part",
                        "seed": True,
                        "key": seed_node.key,
                        "osmType": seed_node.osm_type,
                        "osmId": seed_node.osm_id,
                        "name": seed_node.name,
                        "partIndex": i,
                        "outerPartCount": seed_node.outer_part_count,
                        "stroke": LAYER_COLORS["water-area"],
                        "fill": LAYER_COLORS["water-area"],
                    },
                    "geometry": mapping(part),
                }
            )

    connector_keys = set()
    for e in graph.confirmed_edges():
        for c in e.connectors:
            connector_keys.add(c.get("key") or f"{c['osmType'][0]}{c['osmId']}")

    for node in graph.nodes.values():
        if node.key == graph.seed_key:
            continue
        if not node.geometry:
            continue
        if node.island and not node.in_confirmed_component:
            layer = "island-water"
        elif node.role == "waterway":
            layer = "waterway"
        elif not node.in_confirmed_component:
            layer = "nearby-candidate"
        else:
            layer = "water-feature"
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "layer": layer,
                    "key": node.key,
                    "osmType": node.osm_type,
                    "osmId": node.osm_id,
                    "name": node.name,
                    "role": node.role,
                    "hopsFromSeed": node.hops_from_seed,
                    "inConfirmedComponent": node.in_confirmed_component,
                    "island": node.island,
                    "stroke": LAYER_COLORS[layer],
                    "fill": LAYER_COLORS[layer],
                },
                "geometry": node.geometry,
            }
        )

    if store is not None:
        for key in connector_keys:
            if key in graph.nodes and graph.nodes[key].geometry:
                continue
            osm_type, osm_id = parse_key(key)
            if osm_type != "way" or osm_id not in store.ways:
                continue
            way = store.ways[osm_id]
            coords = store.way_coords(way)
            if len(coords) < 2:
                continue
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "layer": "connector-way",
                        "key": key,
                        "osmType": "way",
                        "osmId": osm_id,
                        "name": pick_name(way.tags),
                        "tags": way.tags,
                        "stroke": LAYER_COLORS["connector-way"],
                    },
                    "geometry": {"type": "LineString", "coordinates": coords},
                }
            )

    for e in graph.edges:
        a = graph.nodes.get(e.from_key)
        b = graph.nodes.get(e.to_key)
        if a is None or b is None:
            continue
        ca, cb = _centroid_of_node(a), _centroid_of_node(b)
        if not ca or not cb:
            continue
        if e.status == "confirmed":
            layer = "confirmed-connection"
        elif e.connection_type == "PORTAGE_CANDIDATE":
            layer = "portage-candidate"
        else:
            layer = "uncertain-connection"
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "layer": layer,
                    "from": e.from_key,
                    "to": e.to_key,
                    "connectionType": e.connection_type,
                    "status": e.status,
                    "connectors": e.connectors,
                    "evidence": e.evidence,
                    "stroke": LAYER_COLORS[layer],
                },
                "geometry": {"type": "LineString", "coordinates": [ca, cb]},
            }
        )

    return {
        "type": "FeatureCollection",
        "name": "seliger-topology-discovery",
        "properties": {
            "seed": graph.seed,
            "summary": graph.summary,
            "layers": list(LAYER_COLORS),
        },
        "features": features,
    }


def _fmt_name(graph: WaterGraph, key: str) -> str:
    node = graph.nodes.get(key)
    if node is None:
        return key
    if node.name:
        return f"{node.name} ({key})"
    return key


def _fmt_evidence(ev: dict[str, Any]) -> str:
    parts = []
    if "sharedNodeCount" in ev:
        parts.append(f"sharedNodes={ev['sharedNodeCount']}")
        if ev.get("sharedEdgeCount"):
            parts.append(f"sharedEdges={ev['sharedEdgeCount']}")
        sample = ev.get("sharedNodes") or []
        if sample:
            parts.append("ids=" + ",".join(str(x) for x in sample[:5]))
    if ev.get("connector"):
        parts.append(f"connector={ev['connector']}")
    if ev.get("distanceM") is not None:
        parts.append(f"distanceM={ev['distanceM']:.1f}")
    if ev.get("geometryRelation"):
        parts.append(ev["geometryRelation"])
    if ev.get("why"):
        parts.append(str(ev["why"]))
    return "; ".join(parts) if parts else json.dumps(ev, ensure_ascii=False)


def graph_to_markdown(graph: WaterGraph) -> str:
    s = graph.summary
    lines: list[str] = []
    lines.append("# Topology discovery: water graph from OSM seed")
    lines.append("")
    lines.append("Исследовательский слой. **БД, WRG, seligerDebug и production WaterSystem не изменялись.**")
    lines.append("Навигация не оценивалась. Названия не являются ключом обнаружения.")
    lines.append("")
    lines.append("Алгоритм: `discoverWaterGraph(seed)` — BFS по общим OSM node id и open waterways")
    lines.append("(`river|stream|canal`). Слои A `DIRECT_OSM` и B `WATERWAY_CONNECTOR` подтверждают")
    lines.append("топологию. C `GEOMETRY_CONTACT` и D `NEARBY`/`PORTAGE` — только candidates.")
    lines.append("Переиспользованы tag-предикаты ingest (`is_water_tagged` / `is_area_water_tags` /")
    lines.append("`pick_name`) и сборка колец по endpoint node id из реконструкции 399081 (`assemble_rings`).")
    lines.append("")
    lines.append("Артефакты: [seliger-topology-discovery.json](seliger-topology-discovery.json), "
                 "[seliger-topology-discovery.geojson](seliger-topology-discovery.geojson).")
    lines.append("")
    lines.append("## A. Seed")
    lines.append("")
    lines.append(f"- OSM: `{graph.seed.get('osmType')}/{graph.seed.get('osmId')}` (`{graph.seed_key}`)")
    lines.append(f"- name (display only): {graph.seed.get('name')!r}")
    lines.append(f"- tags: `{json.dumps(graph.seed.get('tags') or {}, ensure_ascii=False)}`")
    lines.append(f"- outer parts (kept separate, not dissolved): **{graph.seed.get('outerPartCount')}**")
    lines.append(f"- OSM nodes in seed geometry: {graph.seed.get('nodeCount')}")
    lines.append(f"- bbox: {graph.seed.get('bbox')}")
    if graph.seed.get("ringAssembly"):
        ra = graph.seed["ringAssembly"]
        lines.append(f"- ring assembly outer: `{ra.get('outerStats')}`")
        lines.append(f"- ring assembly inner: `{ra.get('innerStats')}`")
    lines.append("")
    lines.append("## B. WaterFeatures")
    lines.append("")
    lines.append(f"- nodes in output graph: **{s['waterFeatureCount']}**")
    lines.append(f"- area features: {s['areaFeatureCount']}")
    lines.append(f"- waterway features: {s['waterwayFeatureCount']}")
    lines.append(f"- confirmed BFS component size: **{s['confirmedComponentSize']}**")
    lines.append("")
    lines.append("## C. Confirmed connections")
    lines.append("")
    lines.append(f"- confirmed edges: **{s['confirmedConnectionCount']}**")
    lines.append(f"  - DIRECT_OSM: {s['directOsmCount']}")
    lines.append(f"  - WATERWAY_CONNECTOR: {s['waterwayConnectorCount']}")
    lines.append("")
    lines.append("## D. Candidate connections")
    lines.append("")
    lines.append(f"- candidate edges: **{s['candidateConnectionCount']}**")
    lines.append(f"- nearby candidates: {s['nearbyCandidateCount']}")
    lines.append("")
    lines.append("## E. Full graph (confirmed component)")
    lines.append("")
    lines.append("| key | OSM | name | role | hops | island |")
    lines.append("|---|---|---|---|---:|---|")
    confirmed_nodes = [
        n for n in graph.nodes.values() if n.in_confirmed_component
    ]
    confirmed_nodes.sort(key=lambda n: (n.hops_from_seed or 0, n.key))
    for n in confirmed_nodes:
        island = ""
        if n.island:
            island = f"parent {n.island.get('parentIslandWayIds')}"
        lines.append(
            f"| `{n.key}` | {n.osm_type}/{n.osm_id} | {n.name or ''} | {n.role} | "
            f"{n.hops_from_seed} | {island} |"
        )
    lines.append("")
    lines.append("## F. Branches (BFS tree from seed)")
    lines.append("")
    for br in graph.branches:
        path = " → ".join(
            f"{nm or '?'} (`{k}`)" for k, nm in zip(br["path"], br["names"])
        )
        lines.append(f"- hops={br['hops']}: {path}")
    if not graph.branches:
        lines.append("- (no area leaves beyond seed)")
    lines.append("")
    lines.append("## G. Nearby candidates (not connected)")
    lines.append("")
    lines.append("| key | OSM | name | d (m) | geometry | reason | type |")
    lines.append("|---|---|---|---:|---|---|---|")
    for row in graph.nearby:
        d = row.get("distanceM")
        d_s = "" if d is None else f"{d:.1f}"
        lines.append(
            f"| `{row['key']}` | {row['osmType']}/{row['osmId']} | {row.get('name') or ''} | "
            f"{d_s} | {row.get('geometryRelation')} | {row.get('candidateReason')} | "
            f"{row.get('connectionType')} |"
        )
    if not graph.nearby:
        lines.append("| — | | | | | | |")
    lines.append("")
    lines.append("## H. Island water features")
    lines.append("")
    lines.append("| key | OSM | name | parent island ways | membership | direct | connector | separate | in BFS |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for row in graph.island_water:
        lines.append(
            f"| `{row['key']}` | {row['osmType']}/{row['osmId']} | {row.get('name') or ''} | "
            f"{row.get('parentIslandWayIds')} | {row.get('osmMembership')} | "
            f"{row.get('directTopologyToParent')} | {row.get('hasWaterwayConnector')} | "
            f"{row.get('separateObject')} | {row.get('inConfirmedComponent')} |"
        )
    if not graph.island_water:
        lines.append("| — | | | | | | | | |")
    lines.append("")
    lines.append("## I. UNCERTAIN cases")
    lines.append("")
    for row in graph.uncertain:
        lines.append(
            f"- `{row.get('kind')}` {row.get('from')} → {row.get('to')}: "
            f"{(row.get('evidence') or {}).get('why', row.get('evidence'))}"
        )
    if not graph.uncertain:
        lines.append("- none")
    lines.append("")
    lines.append("## J. Confirmed edges: OSM ids and evidence")
    lines.append("")
    lines.append("| from | to | type | connectors | evidence |")
    lines.append("|---|---|---|---|---|")
    for e in graph.confirmed_edges():
        conn = json.dumps(e.connectors, ensure_ascii=False)
        lines.append(
            f"| `{e.from_key}` | `{e.to_key}` | {e.connection_type} | `{conn}` | {_fmt_evidence(e.evidence)} |"
        )
    lines.append("")
    lines.append("## Notes")
    lines.append("")
    for n in graph.notes:
        lines.append(f"- {n}")
    lines.append("")
    lines.append("Княжа и Княжка, одноимённые озёра, relation vs внешняя акватория — разные вершины.")
    lines.append("Две outer-площади seed-relation не сливаются в один polygon.")
    lines.append("")
    return "\n".join(lines)


def write_outputs(
    graph: WaterGraph,
    out_dir: Path,
    *,
    store: OsmStore | None = None,
    stem: str = "seliger-topology-discovery",
) -> dict[str, Path]:
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{stem}.json"
    geo_path = out_dir / f"{stem}.geojson"
    md_path = out_dir / f"{stem}.md"
    payload = graph.to_dict()
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    geo_path.write_text(
        json.dumps(graph_to_geojson(graph, store), ensure_ascii=False),
        encoding="utf-8",
    )
    md_path.write_text(graph_to_markdown(graph), encoding="utf-8")
    return {"json": json_path, "geojson": geo_path, "md": md_path}
