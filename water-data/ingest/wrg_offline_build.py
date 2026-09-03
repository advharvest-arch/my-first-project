#!/usr/bin/env python3
"""
AquaRoute WRG-001 — offline physical overlay builder.

Reads water.objects (lake/reservoir polygons) + water.wg_edges (E1, read-only).
Writes water.wrg_* tables. Does NOT mutate wg_edges / wg_nodes / objects.
Does NOT create proximity, snap, hub, or chord edges.

Physical components = E1 adjacency ∪ proven portals ∪ area boundary links.

Example:
  python3 ingest/wrg_offline_build.py
  python3 ingest/wrg_offline_build.py --json-out data/wrg_001_build.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values, Json

BUILDER_VERSION = "wrg-001-1"
INIT_SQL = Path(__file__).resolve().parents[1] / "db" / "init" / "016_wrg_physical.sql"
BELOYE_OSM_ID = 1603199
STRELKA_MALAYA = 72500
STRELKA_BOLSHAYA = 1114249
ELAGIN_PONDS = 8613894
AREA_KEY_BASE = 1_000_000_000_000


def default_dsn() -> str:
    host = os.environ.get("WATER_DB_HOST", "127.0.0.1")
    port = os.environ.get("WATER_DB_PORT", "5433")
    db = os.environ.get("WATER_DB_NAME", "aquaroute_water")
    user = os.environ.get("WATER_DB_USER", "aquaroute")
    password = os.environ.get(
        "WATER_DB_PASSWORD",
        os.environ.get("POSTGRES_PASSWORD", "change_me_local_only"),
    )
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if password in ("change_me_local_only", "") and env_path.exists():
        for line in env_path.read_text().splitlines():
            if line.startswith("POSTGRES_PASSWORD="):
                password = line.split("=", 1)[1].strip()
                break
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _json_default(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(type(obj).__name__)


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[int, int] = {}
        self.rank: dict[int, int] = {}

    def add(self, x: int) -> None:
        if x not in self.parent:
            self.parent[x] = x
            self.rank[x] = 0

    def find(self, x: int) -> int:
        self.add(x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            self.parent[ra] = rb
        elif self.rank[ra] > self.rank[rb]:
            self.parent[rb] = ra
        else:
            self.parent[rb] = ra
            self.rank[ra] += 1


def e1_fingerprint(cur: Any, wg_build_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT count(*)::bigint AS edge_count,
               COALESCE(sum(edge_id), 0)::numeric AS edge_id_sum
        FROM water.wg_edges WHERE build_id = %s
        """,
        (wg_build_id,),
    )
    row = dict(cur.fetchone())
    payload = f"{row['edge_count']}|{row['edge_id_sum']}"
    row["checksum"] = hashlib.sha256(payload.encode()).hexdigest()[:16]
    row["edge_count"] = int(row["edge_count"])
    row["edge_id_sum"] = str(row["edge_id_sum"])
    return row


def apply_schema(cur: Any) -> None:
    sql = INIT_SQL.read_text()
    cur.execute(sql)


def insert_areas(cur: Any, wrg_build_id: int) -> int:
    cur.execute(
        """
        INSERT INTO water.wrg_areas (
          wrg_build_id, object_id, osm_type, osm_id, name, water_type, geom
        )
        SELECT
          %(b)s,
          o.id,
          o.osm_type,
          o.osm_id,
          o.name,
          o.water_type,
          o.geometry
        FROM water.objects o
        WHERE o.water_type IN ('lake', 'reservoir')
          AND GeometryType(o.geometry) IN ('POLYGON', 'MULTIPOLYGON')
          AND COALESCE(o.tags->>'water', '') NOT IN (
            'pond', 'wastewater', 'moat', 'basin', 'oxbow', 'reflecting_pool'
          )
        ORDER BY o.id
        """,
        {"b": wrg_build_id},
    )
    return int(cur.rowcount)


def insert_portals(cur: Any, wrg_build_id: int, wg_build_id: int) -> int:
    cur.execute(
        """
        INSERT INTO water.wrg_portals (
          wrg_build_id, area_id, edge_id, from_node_id, to_node_id,
          evidence_kind, start_in_or_on, end_in_or_on,
          intersection_type, intersection_length_m, intersection_geom, evidence
        )
        SELECT
          %(wrg)s,
          h.area_id,
          h.edge_id,
          h.from_node_id,
          h.to_node_id,
          CASE
            WHEN h.start_in_or_on OR h.end_in_or_on THEN 'endpoint_in_or_on_area'
            ELSE 'edge_intersection'
          END,
          h.start_in_or_on,
          h.end_in_or_on,
          GeometryType(h.ix_geom),
          h.lineal_m,
          h.ix_geom,
          jsonb_build_object(
            'start_in_or_on', h.start_in_or_on,
            'end_in_or_on', h.end_in_or_on,
            'intersection_type', GeometryType(h.ix_geom),
            'intersection_length_m', h.lineal_m,
            'rule', 'covers_endpoint_or_positive_line_intersection'
          )
        FROM (
          SELECT
            a.area_id,
            e.edge_id,
            e.from_node_id,
            e.to_node_id,
            ST_Covers(a.geom, ST_StartPoint(e.geom)) AS start_in_or_on,
            ST_Covers(a.geom, ST_EndPoint(e.geom)) AS end_in_or_on,
            ST_Intersection(e.geom, a.geom) AS ix_geom,
            COALESCE(
              ST_Length(ST_CollectionExtract(ST_Intersection(e.geom, a.geom), 2)::geography),
              0
            ) AS lineal_m
          FROM water.wg_edges e
          JOIN water.wrg_areas a
            ON a.wrg_build_id = %(wrg)s
           AND ST_Intersects(e.geom, a.geom)
          WHERE e.build_id = %(wg)s
        ) h
        WHERE h.start_in_or_on OR h.end_in_or_on OR h.lineal_m > 0
        """,
        {"wrg": wrg_build_id, "wg": wg_build_id},
    )
    return int(cur.rowcount)


def insert_area_links(cur: Any, wrg_build_id: int) -> int:
    cur.execute(
        """
        INSERT INTO water.wrg_area_links (
          wrg_build_id, area_id_a, area_id_b, evidence_kind,
          shared_boundary_m, evidence
        )
        SELECT
          %(wrg)s,
          a.area_id,
          b.area_id,
          'touches_shared_boundary',
          ST_Length(
            ST_CollectionExtract(
              ST_Intersection(ST_Boundary(a.geom), ST_Boundary(b.geom)),
              1
            )::geography
          ),
          jsonb_build_object(
            'osm_a', a.osm_id,
            'osm_b', b.osm_id,
            'rule', 'ST_Touches_and_shared_boundary_length_gt_0'
          )
        FROM water.wrg_areas a
        JOIN water.wrg_areas b
          ON a.wrg_build_id = %(wrg)s
         AND b.wrg_build_id = %(wrg)s
         AND a.area_id < b.area_id
         AND a.geom && b.geom
         AND ST_Touches(a.geom, b.geom)
        WHERE ST_Length(
            ST_CollectionExtract(
              ST_Intersection(ST_Boundary(a.geom), ST_Boundary(b.geom)),
              1
            )::geography
          ) > 0
        """,
        {"wrg": wrg_build_id},
    )
    return int(cur.rowcount)


def assign_components(
    cur: Any, wrg_build_id: int, wg_build_id: int
) -> int:
    uf = UnionFind()

    cur.execute(
        """
        SELECT node_id FROM water.wg_nodes WHERE build_id = %s
        """,
        (wg_build_id,),
    )
    e1_nodes = [int(r["node_id"]) for r in cur.fetchall()]
    for nid in e1_nodes:
        uf.add(nid)

    cur.execute(
        """
        SELECT area_id, osm_id FROM water.wrg_areas WHERE wrg_build_id = %s
        """,
        (wrg_build_id,),
    )
    areas = [(int(r["area_id"]), int(r["osm_id"])) for r in cur.fetchall()]
    area_osm = {aid: osm for aid, osm in areas}
    for aid, _osm in areas:
        uf.add(AREA_KEY_BASE + aid)

    cur.execute(
        """
        SELECT from_node_id, to_node_id
        FROM water.wg_edges WHERE build_id = %s
        """,
        (wg_build_id,),
    )
    for r in cur.fetchall():
        uf.union(int(r["from_node_id"]), int(r["to_node_id"]))

    cur.execute(
        """
        SELECT area_id, from_node_id, to_node_id
        FROM water.wrg_portals WHERE wrg_build_id = %s
        """,
        (wrg_build_id,),
    )
    for r in cur.fetchall():
        ak = AREA_KEY_BASE + int(r["area_id"])
        uf.union(ak, int(r["from_node_id"]))
        uf.union(ak, int(r["to_node_id"]))

    cur.execute(
        """
        SELECT area_id_a, area_id_b
        FROM water.wrg_area_links WHERE wrg_build_id = %s
        """,
        (wrg_build_id,),
    )
    for r in cur.fetchall():
        uf.union(
            AREA_KEY_BASE + int(r["area_id_a"]),
            AREA_KEY_BASE + int(r["area_id_b"]),
        )

    groups: dict[int, dict[str, list[int]]] = defaultdict(
        lambda: {"nodes": [], "areas": []}
    )
    for nid in e1_nodes:
        groups[uf.find(nid)]["nodes"].append(nid)
    for aid, _osm in areas:
        groups[uf.find(AREA_KEY_BASE + aid)]["areas"].append(aid)

    def sort_key(item: tuple[int, dict[str, list[int]]]) -> tuple[int, int, int]:
        _root, g = item
        min_node = min(g["nodes"]) if g["nodes"] else 2**63 - 1
        min_osm = (
            min(area_osm[a] for a in g["areas"]) if g["areas"] else 2**63 - 1
        )
        return (min_node, min_osm, _root)

    ordered = sorted(groups.items(), key=sort_key)

    cur.execute(
        """
        SELECT area_id, count(*)::int AS n
        FROM water.wrg_portals WHERE wrg_build_id = %s
        GROUP BY area_id
        """,
        (wrg_build_id,),
    )
    portals_by_area = {int(r["area_id"]): int(r["n"]) for r in cur.fetchall()}

    comp_rows = []
    node_rows = []
    area_rows = []
    for cid, (_root, g) in enumerate(ordered):
        min_node = min(g["nodes"]) if g["nodes"] else None
        min_osm = min(area_osm[a] for a in g["areas"]) if g["areas"] else None
        pcount = sum(portals_by_area.get(a, 0) for a in g["areas"])
        comp_rows.append(
            (wrg_build_id, cid, len(g["nodes"]), len(g["areas"]), pcount, min_node, min_osm)
        )
        for nid in g["nodes"]:
            node_rows.append((wrg_build_id, nid, cid))
        for aid in g["areas"]:
            area_rows.append((wrg_build_id, aid, cid))

    execute_values(
        cur,
        """
        INSERT INTO water.wrg_physical_component (
          wrg_build_id, physical_component_id, e1_node_count, area_count,
          portal_count, min_e1_node_id, min_area_osm_id
        ) VALUES %s
        """,
        comp_rows,
        page_size=2000,
    )
    execute_values(
        cur,
        """
        INSERT INTO water.wrg_e1_node_component (
          wrg_build_id, node_id, physical_component_id
        ) VALUES %s
        """,
        node_rows,
        page_size=5000,
    )
    if area_rows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_area_component (
              wrg_build_id, area_id, physical_component_id
            ) VALUES %s
            """,
            area_rows,
            page_size=2000,
        )
    return len(ordered)


def qa_acceptance(cur: Any, wrg_build_id: int, wg_build_id: int) -> dict[str, Any]:
    qa: dict[str, Any] = {}

    cur.execute(
        """
        SELECT p.edge_id, e.name, p.evidence_kind, p.intersection_length_m
        FROM water.wrg_portals p
        JOIN water.wg_edges e ON e.edge_id = p.edge_id
        JOIN water.wrg_areas a
          ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
        WHERE p.wrg_build_id = %s AND a.osm_id = %s
          AND e.name IN ('Ковжа', 'Белозерский')
        ORDER BY e.name, p.edge_id
        """,
        (wrg_build_id, BELOYE_OSM_ID),
    )
    beloye_portals = [dict(r) for r in cur.fetchall()]
    qa["beloye_named_portals"] = beloye_portals

    cur.execute(
        """
        SELECT DISTINCT c.physical_component_id
        FROM water.wrg_portals p
        JOIN water.wrg_areas a
          ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
        JOIN water.wrg_e1_node_component c
          ON c.wrg_build_id = p.wrg_build_id AND c.node_id = p.from_node_id
        JOIN water.wg_edges e ON e.edge_id = p.edge_id
        WHERE p.wrg_build_id = %s AND a.osm_id = %s
          AND e.name IN ('Ковжа', 'Белозерский')
        """,
        (wrg_build_id, BELOYE_OSM_ID),
    )
    cids = {int(r["physical_component_id"]) for r in cur.fetchall()}
    qa["kovzha_belozersky_beloye_same_component"] = len(cids) == 1
    qa["kovzha_belozersky_beloye_component_ids"] = sorted(cids)

    cur.execute(
        """
        SELECT count(*)::int AS n
        FROM water.wrg_e1_node_component c
        JOIN water.wg_edges e
          ON e.build_id = %s
         AND (e.from_node_id = c.node_id OR e.to_node_id = c.node_id)
        WHERE c.wrg_build_id = %s AND e.name = 'Ковжа'
        """,
        (wg_build_id, wrg_build_id),
    )
    qa["kovzha_e1_nodes_in_wrg"] = int(cur.fetchone()["n"])

    cur.execute(
        """
        SELECT count(*)::int AS n FROM water.wrg_areas
        WHERE wrg_build_id = %s AND osm_id IN (%s, %s, %s)
        """,
        (wrg_build_id, STRELKA_MALAYA, STRELKA_BOLSHAYA, ELAGIN_PONDS),
    )
    qa["strelka_or_pond_area_count"] = int(cur.fetchone()["n"])
    qa["strelka_land_no_area"] = qa["strelka_or_pond_area_count"] == 0

    cur.execute(
        """
        SELECT count(*)::int AS n
        FROM water.wrg_areas
        WHERE wrg_build_id = %s AND water_type NOT IN ('lake', 'reservoir')
        """,
        (wrg_build_id,),
    )
    qa["non_lake_reservoir_areas"] = int(cur.fetchone()["n"])

    cur.execute(
        """
        SELECT count(*)::int AS n FROM water.wrg_area_links l
        JOIN water.wrg_areas a ON a.wrg_build_id = l.wrg_build_id AND a.area_id = l.area_id_a
        JOIN water.wrg_areas b ON b.wrg_build_id = l.wrg_build_id AND b.area_id = l.area_id_b
        WHERE l.wrg_build_id = %s
          AND a.osm_id IN (%s, %s) AND b.osm_id IN (%s, %s)
        """,
        (
            wrg_build_id,
            STRELKA_MALAYA,
            STRELKA_BOLSHAYA,
            STRELKA_MALAYA,
            STRELKA_BOLSHAYA,
        ),
    )
    qa["strelka_area_links"] = int(cur.fetchone()["n"])

    return qa


def build(conn: Any) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        apply_schema(cur)
        cur.execute("SET statement_timeout = 0")
        cur.execute("SET work_mem = '256MB'")
        cur.execute("SELECT max(build_id) AS id FROM water.wg_build")
        row = cur.fetchone()
        if not row or row["id"] is None:
            raise RuntimeError("no water.wg_build — run E5 builder first")
        wg_build_id = int(row["id"])

        before = e1_fingerprint(cur, wg_build_id)

        cur.execute(
            """
            INSERT INTO water.wrg_build (
              wg_build_id, builder_version,
              e1_edge_count_before, e1_edge_count_after, extras
            ) VALUES (%s, %s, %s, %s, %s)
            RETURNING wrg_build_id
            """,
            (
                wg_build_id,
                BUILDER_VERSION,
                before["edge_count"],
                before["edge_count"],
                Json({"e1_fingerprint_before": before}),
            ),
        )
        wrg_build_id = int(cur.fetchone()["wrg_build_id"])

        area_count = insert_areas(cur, wrg_build_id)
        portal_count = insert_portals(cur, wrg_build_id, wg_build_id)
        link_count = insert_area_links(cur, wrg_build_id)
        component_count = assign_components(cur, wrg_build_id, wg_build_id)

        after = e1_fingerprint(cur, wg_build_id)
        if after["checksum"] != before["checksum"]:
            raise RuntimeError(
                f"wg_edges mutated during WRG build: {before} -> {after}"
            )

        qa = qa_acceptance(cur, wrg_build_id, wg_build_id)
        extras = {
            "e1_fingerprint_before": before,
            "e1_fingerprint_after": after,
            "acceptance": qa,
            "no_wg_edges_written": True,
            "no_proximity": True,
            "no_hubs_or_chords": True,
        }
        cur.execute(
            """
            UPDATE water.wrg_build SET
              e1_edge_count_after = %s,
              area_count = %s,
              portal_count = %s,
              area_link_count = %s,
              physical_component_count = %s,
              extras = %s
            WHERE wrg_build_id = %s
            """,
            (
                after["edge_count"],
                area_count,
                portal_count,
                link_count,
                component_count,
                Json(extras),
                wrg_build_id,
            ),
        )
        conn.commit()
        return {
            "wrg_build_id": wrg_build_id,
            "wg_build_id": wg_build_id,
            "builder_version": BUILDER_VERSION,
            "e1_edge_count_before": before["edge_count"],
            "e1_edge_count_after": after["edge_count"],
            "e1_checksum": after["checksum"],
            "area_count": area_count,
            "portal_count": portal_count,
            "area_link_count": link_count,
            "physical_component_count": component_count,
            "acceptance": qa,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="WRG-001 offline physical builder")
    parser.add_argument("--dsn", default=default_dsn())
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()

    conn = psycopg2.connect(args.dsn)
    try:
        report = build(conn)
    finally:
        conn.close()

    text = json.dumps(report, indent=2, ensure_ascii=False, default=_json_default)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")
    acc = report["acceptance"]
    ok = (
        acc.get("kovzha_belozersky_beloye_same_component") is True
        and acc.get("strelka_land_no_area") is True
        and acc.get("non_lake_reservoir_areas") == 0
        and acc.get("strelka_area_links") == 0
        and report["e1_edge_count_before"] == report["e1_edge_count_after"]
        and len(acc.get("beloye_named_portals") or []) >= 2
    )
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
