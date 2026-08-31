#!/usr/bin/env python3
"""
AquaRoute E3.3 — offline OSM → water.objects / water.object_members.

Uses pyosmium. No Overpass, no AquaRoute, no graph construction.
Relation geometry = MultiLineString collected from member way geometries
(real OSM coords). Gaps between ways are preserved (no ST_LineMerge / seams).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlparse

import osmium
import osmium.geom
import psycopg2
from psycopg2.extras import Json, execute_batch


WATERWAY_TYPES = {
    "river": "river",
    "canal": "canal",
    "stream": "stream",
    "ditch": "other",
    "drain": "other",
    "fairway": "other",
}


def normalize_water_type(tags: dict[str, str]) -> str | None:
    """Simple tag-only normalization. No proximity / name heuristics."""
    ww = tags.get("waterway")
    if ww in WATERWAY_TYPES:
        return WATERWAY_TYPES[ww]
    if tags.get("natural") == "water":
        water = tags.get("water")
        if water == "lake":
            return "lake"
        if water == "reservoir":
            return "reservoir"
        if water in ("river", "riverbank"):
            return "river_area"
        return None
    if tags.get("landuse") == "reservoir":
        return "reservoir"
    if tags.get("natural") == "bay":
        return None
    return None


def is_water_tagged(tags: dict[str, str]) -> bool:
    if "waterway" in tags:
        return True
    if tags.get("natural") == "water":
        return True
    if tags.get("landuse") == "reservoir":
        return True
    if tags.get("type") == "waterway":
        return True
    if tags.get("route") == "waterway":
        return True
    return False


def pick_name(tags: dict[str, str]) -> str | None:
    for key in ("name", "name:ru", "name:en", "alt_name"):
        if tags.get(key):
            return tags[key]
    return None


def osm_type_char_to_name(ch: str) -> str:
    return {"n": "node", "w": "way", "r": "relation"}[ch]


@dataclass
class WayRec:
    osm_id: int
    tags: dict[str, str]
    wkt: str | None


@dataclass
class RelRec:
    osm_id: int
    tags: dict[str, str]
    members: list[tuple[str, int, str]] = field(default_factory=list)  # type, id, role


@dataclass
class NodeRec:
    osm_id: int
    tags: dict[str, str]
    wkt: str | None


class CollectHandler(osmium.SimpleHandler):
    def __init__(self) -> None:
        super().__init__()
        self.wkt_factory = osmium.geom.WKTFactory()
        self.ways: dict[int, WayRec] = {}
        self.relations: dict[int, RelRec] = {}
        self.nodes: dict[int, NodeRec] = {}

    def node(self, n: osmium.osm.Node) -> None:
        tags = dict(n.tags)
        if not is_water_tagged(tags):
            return
        try:
            wkt = self.wkt_factory.create_point(n)
        except Exception:
            wkt = None
        self.nodes[n.id] = NodeRec(osm_id=n.id, tags=tags, wkt=wkt)

    def way(self, w: osmium.osm.Way) -> None:
        tags = dict(w.tags)
        wkt = None
        try:
            wkt = self.wkt_factory.create_linestring(w)
        except Exception:
            wkt = None
        self.ways[w.id] = WayRec(osm_id=w.id, tags=tags, wkt=wkt)

    def relation(self, r: osmium.osm.Relation) -> None:
        tags = dict(r.tags)
        members: list[tuple[str, int, str]] = []
        for m in r.members:
            members.append((osm_type_char_to_name(m.type), m.ref, m.role or ""))
        self.relations[r.id] = RelRec(osm_id=r.id, tags=tags, members=members)


def relation_multilinestring_wkt(rel: RelRec, ways: dict[int, WayRec]) -> str | None:
    """Collect member way linestrings in order. No merging across gaps."""
    parts: list[str] = []
    for mtype, mid, _role in rel.members:
        if mtype != "way":
            continue
        way = ways.get(mid)
        if way is None or not way.wkt:
            continue
        # WKT from osmium is LINESTRING(...); strip keyword for MultiLineString parts
        body = way.wkt
        if body.startswith("LINESTRING"):
            parts.append(body[len("LINESTRING") :].strip())
        elif body.startswith("LINEARRING"):
            parts.append(body[len("LINEARRING") :].strip())
    if not parts:
        return None
    return "MULTILINESTRING(" + ",".join(parts) + ")"


def default_dsn() -> str:
    host = os.environ.get("WATER_DB_HOST", "127.0.0.1")
    port = os.environ.get("WATER_DB_PORT", "5433")
    db = os.environ.get("WATER_DB_NAME", "aquaroute_water")
    user = os.environ.get("WATER_DB_USER", "aquaroute")
    password = os.environ.get(
        "WATER_DB_PASSWORD",
        os.environ.get("POSTGRES_PASSWORD", "change_me_local_only"),
    )
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def upsert_object(
    cur: Any,
    *,
    osm_type: str,
    osm_id: int,
    name: str | None,
    water_type: str | None,
    wkt: str,
    tags: dict[str, str],
    source_version: str,
) -> None:
    cur.execute(
        """
        INSERT INTO water.objects (
          osm_type, osm_id, name, water_type, geometry, tags,
          source, source_version, imported_at
        ) VALUES (
          %s, %s, %s, %s,
          ST_SetSRID(ST_GeomFromText(%s), 4326),
          %s, 'osm', %s, now()
        )
        ON CONFLICT (osm_type, osm_id) DO UPDATE SET
          name = EXCLUDED.name,
          water_type = EXCLUDED.water_type,
          geometry = EXCLUDED.geometry,
          tags = EXCLUDED.tags,
          source = EXCLUDED.source,
          source_version = EXCLUDED.source_version,
          imported_at = EXCLUDED.imported_at
        """,
        (
            osm_type,
            osm_id,
            name,
            water_type,
            wkt,
            Json(tags),
            source_version,
        ),
    )


def replace_relation_members(
    cur: Any, parent_osm_id: int, members: list[tuple[str, int, str]]
) -> None:
    cur.execute(
        """
        DELETE FROM water.object_members
        WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
        """,
        (parent_osm_id,),
    )
    rows = [
        ("relation", parent_osm_id, seq, mtype, mid, role)
        for seq, (mtype, mid, role) in enumerate(members)
    ]
    execute_batch(
        cur,
        """
        INSERT INTO water.object_members (
          parent_osm_type, parent_osm_id, seq,
          member_osm_type, member_osm_id, member_role
        ) VALUES (%s, %s, %s, %s, %s, %s)
        """,
        rows,
        page_size=200,
    )


def count_summary(cur: Any) -> dict[str, int]:
    cur.execute("SELECT count(*) FROM water.objects")
    objects = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM water.objects WHERE osm_type = 'way'")
    ways = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM water.objects WHERE osm_type = 'relation'")
    rels = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM water.objects WHERE osm_type = 'node'")
    nodes = cur.fetchone()[0]
    cur.execute("SELECT count(*) FROM water.object_members")
    members = cur.fetchone()[0]
    return {
        "objects": objects,
        "ways": ways,
        "relations": rels,
        "nodes": nodes,
        "object_members": members,
    }


def run_import(path: str, dsn: str, source_version: str | None) -> dict[str, Any]:
    handler = CollectHandler()
    handler.apply_file(path, locations=True)

    water_relations = {
        rid: rel
        for rid, rel in handler.relations.items()
        if is_water_tagged(rel.tags)
    }
    if not water_relations and 9909116 in handler.relations:
        # Belomor extract: always treat the target relation as in-scope
        water_relations[9909116] = handler.relations[9909116]

    member_way_ids: set[int] = set()
    member_node_ids: set[int] = set()
    for rel in water_relations.values():
        for mtype, mid, _role in rel.members:
            if mtype == "way":
                member_way_ids.add(mid)
            elif mtype == "node":
                member_node_ids.add(mid)

    ways_to_import: dict[int, WayRec] = {}
    for wid, way in handler.ways.items():
        if wid in member_way_ids or is_water_tagged(way.tags):
            ways_to_import[wid] = way

    nodes_to_import: dict[int, NodeRec] = dict(handler.nodes)
    # Member nodes that are water-tagged are already included; bare coordinate
    # nodes are not stored as water.objects (geometry lives on ways).

    if source_version is None:
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        source_version = f"osm-api-relation-9909116-{ts}"

    dataset_note = (
        f"Offline import of {os.path.basename(path)}; "
        f"water relations={sorted(water_relations)}; "
        f"target Belomor relation 9909116"
    )

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            before = count_summary(cur)

            for node in nodes_to_import.values():
                if not node.wkt:
                    continue
                upsert_object(
                    cur,
                    osm_type="node",
                    osm_id=node.osm_id,
                    name=pick_name(node.tags),
                    water_type=normalize_water_type(node.tags),
                    wkt=node.wkt,
                    tags=node.tags,
                    source_version=source_version,
                )

            for way in ways_to_import.values():
                if not way.wkt:
                    # Skip ways without resolvable geometry rather than inventing one
                    continue
                upsert_object(
                    cur,
                    osm_type="way",
                    osm_id=way.osm_id,
                    name=pick_name(way.tags),
                    water_type=normalize_water_type(way.tags),
                    wkt=way.wkt,
                    tags=way.tags,
                    source_version=source_version,
                )

            for rel in water_relations.values():
                wkt = relation_multilinestring_wkt(rel, handler.ways)
                if not wkt:
                    raise RuntimeError(
                        f"relation {rel.osm_id}: no member way geometries "
                        f"(cannot invent geometry)"
                    )
                upsert_object(
                    cur,
                    osm_type="relation",
                    osm_id=rel.osm_id,
                    name=pick_name(rel.tags),
                    water_type=normalize_water_type(rel.tags),
                    wkt=wkt,
                    tags=rel.tags,
                    source_version=source_version,
                )
                replace_relation_members(cur, rel.osm_id, rel.members)

            cur.execute(
                """
                INSERT INTO water.data_sources (source_name, source_version, notes)
                VALUES (%s, %s, %s)
                """,
                ("osm", source_version, dataset_note),
            )

            after = count_summary(cur)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    return {
        "source_version": source_version,
        "before": before,
        "after": after,
        "water_relations": sorted(water_relations),
        "ways_selected": len(ways_to_import),
        "ways_with_geometry": sum(1 for w in ways_to_import.values() if w.wkt),
        "nodes_selected": len(nodes_to_import),
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "osm_file",
        nargs="?",
        default=None,
        help="Path to local .osm / .osm.pbf (default: water-data/data/belomor-...osm)",
    )
    parser.add_argument(
        "--dsn",
        default=None,
        help="PostgreSQL DSN (default: WATER_DB_* / POSTGRES_PASSWORD env)",
    )
    parser.add_argument(
        "--source-version",
        default=None,
        help="Override source_version (default: osm-api-relation-9909116-<utc>)",
    )
    args = parser.parse_args(argv)

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    osm_file = args.osm_file or os.path.join(
        root, "data", "belomor-relation-9909116-full.osm"
    )
    if not os.path.isfile(osm_file):
        print(f"OSM file not found: {osm_file}", file=sys.stderr)
        print("Run: ingest/download_belomor.sh", file=sys.stderr)
        return 1

    dsn = args.dsn or default_dsn()
    # hide password in logs
    parsed = urlparse(dsn)
    safe = f"{parsed.scheme}://{parsed.username}@***{parsed.hostname}:{parsed.port}{parsed.path}"
    print(f"Importing {osm_file}")
    print(f"DSN {safe}")

    result = run_import(osm_file, dsn, args.source_version)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
