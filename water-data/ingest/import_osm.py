#!/usr/bin/env python3
"""
AquaRoute E3.3/E3.4 — offline OSM → water.objects / water.object_members.

Uses pyosmium. No Overpass, no AquaRoute, no graph construction.

E3.4: two-pass scan so regional PBFs do not load every highway into memory.
Relation geometry:
  - multipolygon / area water → osmium multipolygon (real member rings)
  - waterway relations → MultiLineString from member way lines (no LineMerge/seams)
Gaps between ways are preserved. Incomplete extract-edge relations keep
whatever member geometries exist; missing members are reported by diagnostics.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
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
    if tags.get("type") == "multipolygon" and (
        tags.get("natural") == "water"
        or tags.get("water") in {"lake", "reservoir", "river", "pond", "basin"}
        or tags.get("landuse") == "reservoir"
    ):
        return True
    return False


def is_area_water_tags(tags: dict[str, str]) -> bool:
    if tags.get("natural") == "water":
        return True
    if tags.get("landuse") == "reservoir":
        return True
    if tags.get("water") in {"lake", "reservoir", "pond", "basin", "river"}:
        return True
    return False


def is_area_relation(tags: dict[str, str]) -> bool:
    if tags.get("type") == "multipolygon" and is_area_water_tags(tags):
        return True
    if tags.get("type") == "multipolygon" and tags.get("natural") == "water":
        return True
    return False


def pick_name(tags: dict[str, str]) -> str | None:
    for key in ("name", "name:ru", "name:en", "alt_name"):
        if tags.get(key):
            return tags[key]
    return None


def osm_type_char_to_name(ch: str) -> str:
    return {"n": "node", "w": "way", "r": "relation"}[ch]


def closed_linestring_to_polygon_wkt(wkt: str) -> str:
    """Preserve area semantics for closed natural=water ways (no create_polygon in WKTFactory)."""
    if not wkt.startswith("LINESTRING"):
        return wkt
    coords = wkt[len("LINESTRING") :].strip()
    if coords.startswith("(") and coords.endswith(")"):
        return f"POLYGON({coords})"
    return wkt


@dataclass
class WayRec:
    osm_id: int
    tags: dict[str, str]
    wkt: str | None


@dataclass
class RelRec:
    osm_id: int
    tags: dict[str, str]
    members: list[tuple[str, int, str]] = field(default_factory=list)
    wkt: str | None = None


@dataclass
class NodeRec:
    osm_id: int
    tags: dict[str, str]
    wkt: str | None


class IndexHandler(osmium.SimpleHandler):
    """Pass 1: discover water relations/members and water-tagged nodes/ways (no geometries)."""

    def __init__(self) -> None:
        super().__init__()
        self.water_way_ids: set[int] = set()
        self.water_node_ids: set[int] = set()
        self.relations: dict[int, RelRec] = {}

    def node(self, n: osmium.osm.Node) -> None:
        tags = dict(n.tags)
        if is_water_tagged(tags):
            self.water_node_ids.add(n.id)

    def way(self, w: osmium.osm.Way) -> None:
        tags = dict(w.tags)
        if is_water_tagged(tags):
            self.water_way_ids.add(w.id)

    def relation(self, r: osmium.osm.Relation) -> None:
        tags = dict(r.tags)
        if not is_water_tagged(tags) and r.id != 9909116:
            return
        members = [
            (osm_type_char_to_name(m.type), m.ref, m.role or "") for m in r.members
        ]
        self.relations[r.id] = RelRec(osm_id=r.id, tags=tags, members=members)


class MaterializeHandler(osmium.SimpleHandler):
    """Pass 2: build geometries only for selected ids (locations=True)."""

    def __init__(
        self,
        *,
        way_ids: set[int],
        node_ids: set[int],
        relations: dict[int, RelRec],
    ) -> None:
        super().__init__()
        self.wkt_factory = osmium.geom.WKTFactory()
        self.way_ids = way_ids
        self.node_ids = node_ids
        self.relations = relations
        self.ways: dict[int, WayRec] = {}
        self.nodes: dict[int, NodeRec] = {}

    def node(self, n: osmium.osm.Node) -> None:
        if n.id not in self.node_ids:
            return
        tags = dict(n.tags)
        wkt = None
        try:
            wkt = self.wkt_factory.create_point(n)
        except Exception:
            wkt = None
        self.nodes[n.id] = NodeRec(osm_id=n.id, tags=tags, wkt=wkt)

    def way(self, w: osmium.osm.Way) -> None:
        if w.id not in self.way_ids:
            return
        tags = dict(w.tags)
        wkt = None
        try:
            wkt = self.wkt_factory.create_linestring(w)
            if (
                wkt
                and w.is_closed()
                and is_area_water_tags(tags)
                and tags.get("waterway") is None
            ):
                wkt = closed_linestring_to_polygon_wkt(wkt)
        except Exception:
            wkt = None
        self.ways[w.id] = WayRec(osm_id=w.id, tags=tags, wkt=wkt)

    def relation(self, r: osmium.osm.Relation) -> None:
        rel = self.relations.get(r.id)
        if rel is None:
            return
        # Refresh tags/members from this pass (authoritative)
        rel.tags = dict(r.tags)
        rel.members = [
            (osm_type_char_to_name(m.type), m.ref, m.role or "") for m in r.members
        ]

    def area(self, a: osmium.osm.Area) -> None:
        """Assemble true multipolygons/polygons via libosmium area builder."""
        try:
            if a.from_way():
                wid = a.orig_id()
                if wid not in self.way_ids:
                    return
                way = self.ways.get(wid)
                if way is None:
                    return
                # Prefer area polygon over closed linestring for tagged water areas
                if is_area_water_tags(way.tags) and way.tags.get("waterway") is None:
                    way.wkt = self.wkt_factory.create_multipolygon(a)
                return
            rid = a.orig_id()
            rel = self.relations.get(rid)
            if rel is None:
                return
            rel.wkt = self.wkt_factory.create_multipolygon(a)
        except Exception:
            return

def relation_multilinestring_wkt(rel: RelRec, ways: dict[int, WayRec]) -> str | None:
    """Collect member way linestrings in order. No merging across gaps."""
    parts: list[str] = []
    for mtype, mid, _role in rel.members:
        if mtype != "way":
            continue
        way = ways.get(mid)
        if way is None or not way.wkt:
            continue
        body = way.wkt
        if body.startswith("LINESTRING"):
            parts.append(body[len("LINESTRING") :].strip())
        elif body.startswith("POLYGON"):
            # outer ring only as linestring coords — skip area rings for linear collect
            continue
        elif body.startswith("LINEARRING"):
            parts.append(body[len("LINEARRING") :].strip())
    if not parts:
        return None
    return "MULTILINESTRING(" + ",".join(parts) + ")"


def resolve_relation_wkt(rel: RelRec, ways: dict[int, WayRec]) -> str | None:
    if rel.wkt:
        return rel.wkt
    return relation_multilinestring_wkt(rel, ways)


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
    if not rows:
        return
    execute_batch(
        cur,
        """
        INSERT INTO water.object_members (
          parent_osm_type, parent_osm_id, seq,
          member_osm_type, member_osm_id, member_role
        ) VALUES (%s, %s, %s, %s, %s, %s)
        """,
        rows,
        page_size=500,
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


def default_source_version(path: str) -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    base = os.path.basename(path).replace(".osm.pbf", "").replace(".osm", "")
    return f"osm-{base}-{ts}"


def run_import(path: str, dsn: str, source_version: str | None) -> dict[str, Any]:
    t0 = time.perf_counter()

    index = IndexHandler()
    index.apply_file(path, locations=False)
    t_index = time.perf_counter()

    water_relations = dict(index.relations)
    member_way_ids: set[int] = set()
    member_node_ids: set[int] = set()
    for rel in water_relations.values():
        for mtype, mid, _role in rel.members:
            if mtype == "way":
                member_way_ids.add(mid)
            elif mtype == "node":
                member_node_ids.add(mid)

    way_ids = set(index.water_way_ids) | member_way_ids
    node_ids = set(index.water_node_ids) | {
        nid for nid in member_node_ids if nid in index.water_node_ids
    }
    # Bare coordinate member nodes are not water features; keep only water-tagged nodes.
    node_ids = set(index.water_node_ids)

    mat = MaterializeHandler(
        way_ids=way_ids, node_ids=node_ids, relations=water_relations
    )
    mat.apply_file(path, locations=True)
    t_mat = time.perf_counter()

    if source_version is None:
        source_version = default_source_version(path)

    dataset_note = (
        f"Offline import of {os.path.basename(path)}; "
        f"water_relations={len(water_relations)}; "
        f"includes Belomor 9909116={9909116 in water_relations}"
    )

    skipped_relations: list[int] = []
    imported_relations = 0

    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    try:
        with conn.cursor() as cur:
            before = count_summary(cur)

            for node in mat.nodes.values():
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

            for way in mat.ways.values():
                if not way.wkt:
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
                wkt = resolve_relation_wkt(rel, mat.ways)
                if not wkt:
                    # No invented geometry; skip object row. Members only stored with object.
                    skipped_relations.append(rel.osm_id)
                    continue
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
                imported_relations += 1

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

    t_end = time.perf_counter()
    return {
        "source_version": source_version,
        "dataset": os.path.basename(path),
        "before": before,
        "after": after,
        "water_relations_indexed": len(water_relations),
        "relations_imported": imported_relations,
        "relations_skipped_no_geometry": skipped_relations[:50],
        "relations_skipped_no_geometry_count": len(skipped_relations),
        "ways_selected": len(way_ids),
        "ways_materialized": len(mat.ways),
        "ways_with_geometry": sum(1 for w in mat.ways.values() if w.wkt),
        "nodes_selected": len(node_ids),
        "nodes_with_geometry": sum(1 for n in mat.nodes.values() if n.wkt),
        "timing_seconds": {
            "index_pass": round(t_index - t0, 3),
            "materialize_pass": round(t_mat - t_index, 3),
            "db_write": round(t_end - t_mat, 3),
            "total": round(t_end - t0, 3),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "osm_file",
        nargs="?",
        default=None,
        help="Path to local .osm / .osm.pbf",
    )
    parser.add_argument(
        "--dsn",
        default=None,
        help="PostgreSQL DSN (default: WATER_DB_* / POSTGRES_PASSWORD env)",
    )
    parser.add_argument(
        "--source-version",
        default=None,
        help="Override source_version (default: osm-<dataset>-<utc>)",
    )
    args = parser.parse_args(argv)

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    osm_file = args.osm_file or os.path.join(
        root, "data", "karelia_republic-latest.osm.pbf"
    )
    if not os.path.isfile(osm_file):
        print(f"OSM file not found: {osm_file}", file=sys.stderr)
        print(
            "Run: ingest/download_karelia.sh   # or ingest/download_belomor.sh",
            file=sys.stderr,
        )
        return 1

    dsn = args.dsn or default_dsn()
    parsed = urlparse(dsn)
    safe = (
        f"{parsed.scheme}://{parsed.username}@***"
        f"{parsed.hostname}:{parsed.port}{parsed.path}"
    )
    print(f"Importing {osm_file}")
    print(f"DSN {safe}")

    result = run_import(osm_file, dsn, args.source_version)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
