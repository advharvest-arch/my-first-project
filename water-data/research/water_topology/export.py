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


def graph_to_geojson(
    graph: WaterGraph,
    store: OsmStore | None = None,
    *,
    water_feature_graph: Any | None = None,
) -> dict[str, Any]:
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

    props: dict[str, Any] = {
        "seed": graph.seed,
        "summary": graph.summary,
        "layers": list(LAYER_COLORS),
    }
    if water_feature_graph is not None:
        props["waterFeatureGraphSummary"] = water_feature_graph.to_dict()["summary"]
    return {
        "type": "FeatureCollection",
        "name": "seliger-topology-discovery",
        "properties": props,
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


def graph_to_markdown(graph: WaterGraph, *, water_feature_graph: Any | None = None) -> str:
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
    if water_feature_graph is not None:
        lines.extend(render_water_feature_graph_markdown_section(water_feature_graph))
    lines.append("## Notes")
    lines.append("")
    for n in graph.notes:
        lines.append(f"- {n}")
    lines.append("")
    lines.append("Княжа и Княжка, одноимённые озёра, relation vs внешняя акватория — разные вершины.")
    lines.append("Две outer-площади seed-relation не сливаются в один polygon.")
    lines.append("")
    return "\n".join(lines)


def render_water_feature_graph_markdown_section(water_feature_graph: Any) -> list[str]:
    wfg = water_feature_graph.to_dict()
    ws = wfg["summary"]
    lines: list[str] = []
    lines.append("## K. Strict WaterFeature Graph (`build_water_graph.py`)")
    lines.append("")
    lines.append(
        "Граф водных объектов, построенный только по 4 правилам OSM-топологии "
        "(`SHARED_NODE`, `SHARED_WAY`, `RELATION_ROLE`, `ENDPOINT_ON_POLYGON`), "
        "без proximity и без перескакивания через промежуточные площади."
    )
    lines.append("")
    lines.append(f"- vertices (`nodeCount`): **{ws['nodeCount']}**")
    lines.append(f"- edges (`edgeCount`): **{ws['edgeCount']}**")
    lines.append(
        f"- edge counts by type: `{json.dumps(ws.get('edgeCountsByType') or {}, ensure_ascii=False)}`"
    )
    lines.append("")
    lines.append("### K.1. WaterFeature nodes")
    lines.append("")
    lines.append("| key | OSM | name (display only) | role | hops |")
    lines.append("|---|---|---|---|---:|")
    for n in sorted(wfg["nodes"], key=lambda x: (x["hopsFromSeed"], x["key"])):
        nm = (n.get("tags") or {}).get("name") or ""
        lines.append(
            f"| `{n['key']}` | {n['osmType']}/{n['osmId']} | {nm} | {n['role']} | {n['hopsFromSeed']} |"
        )
    lines.append("")
    lines.append("### K.2. WaterFeature edges and OSM evidence")
    lines.append("")
    lines.append("| from | to | connectionType | osmType/osmId | evidence |")
    lines.append("|---|---|---|---|---|")
    for e in wfg["edges"]:
        ev = e["evidence"]
        oid = f"{ev.get('osmType')}/{ev.get('osmId')}"
        lines.append(
            f"| `{e['from']}` | `{e['to']}` | `{e['connectionType']}` | `{oid}` | `{json.dumps(ev, ensure_ascii=False)}` |"
        )
    lines.append("")
    return lines


def update_discovery_outputs(
    water_feature_graph: Any,
    out_dir: Path,
    *,
    store: OsmStore | None = None,
    stem: str = "seliger-topology-discovery",
) -> dict[str, Path]:
    out_dir = Path(out_dir)
    json_path = out_dir / f"{stem}.json"
    geo_path = out_dir / f"{stem}.geojson"
    md_path = out_dir / f"{stem}.md"
    if not (json_path.exists() and geo_path.exists() and md_path.exists()):
        from .discover import discover_water_graph

        if store is None:
            raise ValueError("store required when discovery outputs do not yet exist")
        disc = discover_water_graph(water_feature_graph.seed_key, store)
        return write_outputs(disc, out_dir, store=store, stem=stem, water_feature_graph=water_feature_graph)

    wfg_dict = water_feature_graph.to_dict()
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    payload["waterFeatureGraph"] = wfg_dict
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    geo = json.loads(geo_path.read_text(encoding="utf-8"))
    geo.setdefault("properties", {})["waterFeatureGraphSummary"] = wfg_dict["summary"]
    geo_path.write_text(json.dumps(geo, ensure_ascii=False), encoding="utf-8")

    md = md_path.read_text(encoding="utf-8")
    section = "\n".join(render_water_feature_graph_markdown_section(water_feature_graph)) + "\n"
    marker = "## K. Strict WaterFeature Graph (`build_water_graph.py`)"
    notes_marker = "## Notes"
    if marker in md and notes_marker in md:
        before = md.split(marker, 1)[0]
        after = notes_marker + md.split(notes_marker, 1)[1]
        md = before + section + after
    elif notes_marker in md:
        before, after = md.split(notes_marker, 1)
        md = before + section + notes_marker + after
    else:
        md = md.rstrip() + "\n\n" + section
    md_path.write_text(md, encoding="utf-8")
    return {"json": json_path, "geojson": geo_path, "md": md_path}


def write_outputs(
    graph: WaterGraph,
    out_dir: Path,
    *,
    store: OsmStore | None = None,
    stem: str = "seliger-topology-discovery",
    water_feature_graph: Any | None = None,
) -> dict[str, Path]:
    if water_feature_graph is None and store is not None:
        from .build_water_graph import build_water_graph

        water_feature_graph = build_water_graph(graph.seed_key, store)
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / f"{stem}.json"
    geo_path = out_dir / f"{stem}.geojson"
    md_path = out_dir / f"{stem}.md"
    payload = graph.to_dict()
    if water_feature_graph is not None:
        payload["waterFeatureGraph"] = water_feature_graph.to_dict()
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    geo_path.write_text(
        json.dumps(
            graph_to_geojson(graph, store, water_feature_graph=water_feature_graph),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    md_path.write_text(
        graph_to_markdown(graph, water_feature_graph=water_feature_graph),
        encoding="utf-8",
    )
    return {"json": json_path, "geojson": geo_path, "md": md_path}
