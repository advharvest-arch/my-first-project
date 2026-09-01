#!/usr/bin/env python3
"""
AquaRoute E5 — Isolated WaterGraph PoC builder (E1 exact endpoints only).

Reads water.routing_segments → writes water.wg_build / wg_nodes / wg_edges.
Does NOT mutate canonical OSM tables or routing_segments.
Does NOT wire to AquaRoute / sea-map / BRouter.
Does NOT use tolerance, proximity, name, crossings, or relation-as-edge.

Example:
  python3 ingest/e5_watergraph_poc_build.py --json-out data/e5_watergraph_poc.json
  python3 ingest/e5_watergraph_poc_build.py --qa-only
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values

RELATION_IDS = {
    "belomor": 9909116,
    "volga_baltic": 16738852,
    "ladoga": 21149039,
}
VB_GAP_WAYS = (28433211, 824398188)
E1_DECIMALS = 7
BUILDER_VERSION = "e5-poc-1"
INIT_SQL = Path(__file__).resolve().parents[1] / "db" / "init" / "013_watergraph_poc.sql"


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


def e1_key(x: float, y: float) -> tuple[Decimal, Decimal]:
    return (
        Decimal(f"{round(float(x), E1_DECIMALS):.{E1_DECIMALS}f}"),
        Decimal(f"{round(float(y), E1_DECIMALS):.{E1_DECIMALS}f}"),
    )


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def fingerprint(cur: Any) -> dict[str, int]:
    cur.execute(
        """
        SELECT
          (SELECT count(*) FROM water.objects) AS objects,
          (SELECT count(*) FROM water.object_members) AS members,
          (SELECT count(*) FROM water.object_conflicts) AS conflicts
        """
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


class UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
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


def apply_schema(cur: Any) -> None:
    sql = INIT_SQL.read_text(encoding="utf-8")
    cur.execute(sql)


def clear_graph(cur: Any) -> None:
    # Child tables first via CASCADE from build, or truncate all
    cur.execute("TRUNCATE water.wg_edges, water.wg_nodes, water.wg_build RESTART IDENTITY CASCADE")


def load_segments(cur: Any) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          s.object_id,
          s.osm_type,
          s.osm_id,
          s.part_index,
          s.name,
          s.water_type,
          s.waterway,
          s.category,
          s.relevance,
          s.is_relation_member,
          s.parent_relation_ids,
          s.length_m,
          s.point_count,
          s.is_zero_length,
          ST_AsEWKT(s.geometry) AS geom_ewkt,
          ST_X(s.start_point) AS sx,
          ST_Y(s.start_point) AS sy,
          ST_X(s.end_point) AS ex,
          ST_Y(s.end_point) AS ey
        FROM water.routing_segments s
        WHERE s.start_point IS NOT NULL AND s.end_point IS NOT NULL
          AND GeometryType(s.geometry) = 'LINESTRING'
        ORDER BY s.osm_type, s.osm_id, s.part_index
        """
    )
    return [dict(r) for r in cur.fetchall()]


def build_graph(conn: Any) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        apply_schema(cur)
        clear_graph(cur)
        segs = load_segments(cur)
        if not segs:
            raise RuntimeError("no routing_segments to build from")

        # Collect unique E1 nodes
        node_keys: list[tuple[Decimal, Decimal]] = []
        key_to_local: dict[tuple[Decimal, Decimal], int] = {}
        for s in segs:
            for xy in (e1_key(s["sx"], s["sy"]), e1_key(s["ex"], s["ey"])):
                if xy not in key_to_local:
                    key_to_local[xy] = len(node_keys)
                    node_keys.append(xy)

        # Placeholder build row (counts filled after)
        cur.execute(
            """
            INSERT INTO water.wg_build (
              rule_id, source_view, segment_count, node_count, edge_count,
              component_count, builder, builder_version, extras
            ) VALUES (
              'E1', 'water.routing_segments', %s, %s, %s, 0,
              'ingest/e5_watergraph_poc_build.py', %s, '{}'::jsonb
            ) RETURNING build_id
            """,
            (len(segs), len(node_keys), len(segs), BUILDER_VERSION),
        )
        build_id = int(cur.fetchone()["build_id"])

        node_rows = [
            (
                build_id,
                float(lon),
                float(lat),
                f"SRID=4326;POINT({float(lon)} {float(lat)})",
            )
            for lon, lat in node_keys
        ]
        execute_values(
            cur,
            """
            INSERT INTO water.wg_nodes (build_id, e1_lon, e1_lat, geom)
            VALUES %s
            """,
            node_rows,
            template="(%s, %s, %s, ST_GeomFromEWKT(%s))",
            page_size=2000,
        )

        # Map E1 key → node_id
        cur.execute(
            """
            SELECT node_id, e1_lon, e1_lat
            FROM water.wg_nodes WHERE build_id = %s
            """,
            (build_id,),
        )
        key_to_node: dict[tuple[Decimal, Decimal], int] = {}
        for r in cur.fetchall():
            k = (Decimal(r["e1_lon"]), Decimal(r["e1_lat"]))
            key_to_node[k] = int(r["node_id"])

        edge_rows = []
        for s in segs:
            fk = e1_key(s["sx"], s["sy"])
            tk = e1_key(s["ex"], s["ey"])
            edge_rows.append(
                (
                    build_id,
                    s["osm_type"],
                    s["osm_id"],
                    s["part_index"],
                    s["object_id"],
                    key_to_node[fk],
                    key_to_node[tk],
                    s["name"],
                    s["water_type"],
                    s["waterway"],
                    s["category"],
                    s["relevance"],
                    s["is_relation_member"],
                    s["parent_relation_ids"],
                    s["geom_ewkt"],
                    float(s["length_m"] or 0.0),
                    s["point_count"],
                    bool(s["is_zero_length"]),
                )
            )
        execute_values(
            cur,
            """
            INSERT INTO water.wg_edges (
              build_id, osm_type, osm_id, part_index, object_id,
              from_node_id, to_node_id,
              name, water_type, waterway, category, relevance,
              is_relation_member, parent_relation_ids,
              geom, length_m, point_count, is_zero_length
            ) VALUES %s
            """,
            edge_rows,
            template=(
                "(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,"
                "ST_GeomFromEWKT(%s),%s,%s,%s)"
            ),
            page_size=1000,
        )

        # Degrees
        cur.execute(
            """
            UPDATE water.wg_nodes n SET degree = d.deg
            FROM (
              SELECT node_id, count(*)::int AS deg FROM (
                SELECT from_node_id AS node_id FROM water.wg_edges WHERE build_id = %(b)s
                UNION ALL
                SELECT to_node_id FROM water.wg_edges WHERE build_id = %(b)s
              ) u GROUP BY node_id
            ) d
            WHERE n.node_id = d.node_id AND n.build_id = %(b)s
            """,
            {"b": build_id},
        )

        # Components via Union-Find on edges (node indices remapped)
        node_ids = sorted(key_to_node.values())
        nid_to_i = {nid: i for i, nid in enumerate(node_ids)}
        uf = UnionFind(len(node_ids))
        cur.execute(
            """
            SELECT from_node_id, to_node_id FROM water.wg_edges WHERE build_id = %s
            """,
            (build_id,),
        )
        for r in cur.fetchall():
            uf.union(nid_to_i[int(r["from_node_id"])], nid_to_i[int(r["to_node_id"])])

        root_to_cid: dict[int, int] = {}
        # Prefer labeling by component size (largest first) for stable-ish ids
        groups: dict[int, list[int]] = defaultdict(list)
        for i, nid in enumerate(node_ids):
            groups[uf.find(i)].append(nid)
        ordered = sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        for cid, (_root, members) in enumerate(ordered):
            for nid in members:
                root_to_cid[nid] = cid

        # Bulk update component_id via TEMP table
        pairs = [(nid, cid) for nid, cid in root_to_cid.items()]
        cur.execute("CREATE TEMP TABLE e5_comp (nid bigint, cid int) ON COMMIT DROP")
        execute_values(
            cur, "INSERT INTO e5_comp (nid, cid) VALUES %s", pairs, page_size=5000
        )
        cur.execute(
            """
            UPDATE water.wg_nodes n
            SET component_id = c.cid
            FROM e5_comp c
            WHERE n.node_id = c.nid AND n.build_id = %s
            """,
            (build_id,),
        )
        cur.execute(
            """
            UPDATE water.wg_edges e
            SET component_id = n.component_id
            FROM water.wg_nodes n
            WHERE e.from_node_id = n.node_id AND e.build_id = %s
            """,
            (build_id,),
        )

        component_count = len(ordered)
        cur.execute(
            """
            UPDATE water.wg_build SET
              node_count = %s,
              edge_count = %s,
              component_count = %s,
              extras = %s::jsonb
            WHERE build_id = %s
            """,
            (
                len(node_keys),
                len(segs),
                component_count,
                json.dumps(
                    {
                        "e1_decimals": E1_DECIMALS,
                        "undirected_note": "edge stores start→end orientation only",
                        "navigability": False,
                        "aqua_route_wired": False,
                    }
                ),
                build_id,
            ),
        )
        conn.commit()
        return {
            "build_id": build_id,
            "segment_count": len(segs),
            "node_count": len(node_keys),
            "edge_count": len(segs),
            "component_count": component_count,
        }


def qa_report(conn: Any, build_id: int | None = None) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        if build_id is None:
            cur.execute("SELECT build_id FROM water.wg_build ORDER BY build_id DESC LIMIT 1")
            row = cur.fetchone()
            if not row:
                raise RuntimeError("no wg_build rows — run builder first")
            build_id = int(row["build_id"])

        report: dict[str, Any] = {
            "stage": "E5",
            "title": "Isolated WaterGraph PoC QA",
            "build_id": build_id,
            "canonical": fingerprint(cur),
        }

        cur.execute(
            """
            SELECT segment_count, node_count, edge_count, component_count,
                   rule_id, builder_version, built_at, extras
            FROM water.wg_build WHERE build_id = %s
            """,
            (build_id,),
        )
        report["build"] = dict(cur.fetchone())
        report["build"]["built_at"] = str(report["build"]["built_at"])

        cur.execute(
            """
            SELECT count(*) AS nodes,
                   count(*) FILTER (WHERE degree = 0) AS isolated_nodes_deg0,
                   count(*) FILTER (WHERE degree = 1) AS deadend_nodes,
                   count(*) FILTER (WHERE degree >= 3) AS junction_nodes
            FROM water.wg_nodes WHERE build_id = %s
            """,
            (build_id,),
        )
        report["nodes"] = {k: int(v) for k, v in dict(cur.fetchone()).items()}

        cur.execute(
            """
            SELECT degree, count(*) AS n
            FROM water.wg_nodes WHERE build_id = %s
            GROUP BY 1 ORDER BY 1
            """,
            (build_id,),
        )
        report["degree_distribution"] = [
            {"degree": int(r["degree"]), "nodes": int(r["n"])} for r in cur.fetchall()
        ]

        cur.execute(
            """
            SELECT count(*) AS edges,
                   count(*) FILTER (WHERE is_zero_length) AS zero_length_edges,
                   count(*) FILTER (WHERE NOT ST_IsValid(geom)) AS invalid_geom_edges,
                   count(*) FILTER (
                     WHERE cardinality(parent_relation_ids) IS NULL
                        OR cardinality(parent_relation_ids) = 0
                   ) AS edges_without_parent_rel
            FROM water.wg_edges WHERE build_id = %s
            """,
            (build_id,),
        )
        report["edges"] = {k: int(v) for k, v in dict(cur.fetchone()).items()}

        # Edge-components: group by component_id
        cur.execute(
            """
            SELECT component_id, count(*) AS edge_count,
                   round(sum(length_m)::numeric, 2) AS length_m
            FROM water.wg_edges WHERE build_id = %s
            GROUP BY 1
            """,
            (build_id,),
        )
        comps = [dict(r) for r in cur.fetchall()]
        sizes = Counter(int(c["edge_count"]) for c in comps)
        report["components"] = {
            "count": len(comps),
            "isolated_single_edge_components": sizes.get(1, 0),
            "nontrivial_edge_components": sum(v for k, v in sizes.items() if k >= 2),
            "size_buckets": {
                "1": sizes.get(1, 0),
                "2": sizes.get(2, 0),
                "3-5": sum(sizes[s] for s in sizes if 3 <= s <= 5),
                "6-10": sum(sizes[s] for s in sizes if 6 <= s <= 10),
                "11-50": sum(sizes[s] for s in sizes if 11 <= s <= 50),
                "51-100": sum(sizes[s] for s in sizes if 51 <= s <= 100),
                "101-1000": sum(sizes[s] for s in sizes if 101 <= s <= 1000),
                "1001+": sum(sizes[s] for s in sizes if s >= 1001),
            },
            "largest": sorted(
                [
                    {
                        "component_id": int(c["component_id"]) if c["component_id"] is not None else None,
                        "edge_count": int(c["edge_count"]),
                        "length_km": round(float(c["length_m"]) / 1000.0, 3),
                    }
                    for c in comps
                ],
                key=lambda x: (-x["edge_count"], x["component_id"] or 0),
            )[:10],
        }

        # Belomor
        report["belomor"] = relation_qa(cur, build_id, RELATION_IDS["belomor"], expect_one=True)
        # Volga-Baltic
        report["volga_baltic"] = relation_qa(
            cur, build_id, RELATION_IDS["volga_baltic"], expect_one=False
        )
        report["volga_baltic"]["gap_seq_53_54"] = vb_gap_qa(cur, build_id)
        # Ladoga
        report["ladoga"] = relation_qa(
            cur, build_id, RELATION_IDS["ladoga"], expect_one=False
        )
        report["ladoga"]["navigation_semantics"] = False
        report["ladoga"]["artificial_centerline"] = False
        report["ladoga"]["note"] = (
            "Ring edges remain geometric segments under E1; topology ≠ navigation."
        )

        report["crossing_check"] = crossing_check(cur, build_id)
        return report


def relation_qa(
    cur: Any, build_id: int, relation_id: int, expect_one: bool
) -> dict[str, Any]:
    cur.execute(
        """
        SELECT edge_id, osm_id, part_index, from_node_id, to_node_id,
               component_id, length_m
        FROM water.wg_edges
        WHERE build_id = %s AND %s = ANY (parent_relation_ids)
        ORDER BY osm_id, part_index
        """,
        (build_id, relation_id),
    )
    edges = [dict(r) for r in cur.fetchall()]
    cids = {e["component_id"] for e in edges}
    # Induced components among relation edges only (node UF within subset)
    if edges:
        nodes = sorted({e["from_node_id"] for e in edges} | {e["to_node_id"] for e in edges})
        ni = {n: i for i, n in enumerate(nodes)}
        uf = UnionFind(len(nodes))
        for e in edges:
            uf.union(ni[e["from_node_id"]], ni[e["to_node_id"]])
        induced = len({uf.find(i) for i in range(len(nodes))})
        # Count E1 internal connections = edges that connect two nodes both in set
        # For a path of N segments in one component: N-1 "internal" shared nodes of degree>=2 within subset
        # User asked: 28 internal E1 connections for Belomor 29 segments
        # = number of E1 shared endpoint unions within the chain = N-1 for a simple path
        shared_nodes = 0
        deg = Counter()
        for e in edges:
            deg[e["from_node_id"]] += 1
            deg[e["to_node_id"]] += 1
        shared_nodes = sum(1 for n, d in deg.items() if d >= 2)
        internal_e1_connections = shared_nodes  # for a path, equals N-1
    else:
        induced = 0
        internal_e1_connections = 0
        shared_nodes = 0

    out = {
        "relation_id": relation_id,
        "edge_count": len(edges),
        "unique_osm_ids": len({e["osm_id"] for e in edges}),
        "total_length_m": round(sum(float(e["length_m"]) for e in edges), 2),
        "induced_component_count": induced,
        "distinct_stored_component_ids": len(cids),
        "internal_e1_shared_nodes": shared_nodes,
        "internal_e1_connections": internal_e1_connections,
    }
    if expect_one:
        out["expected_single_component"] = True
        out["ok_single_component"] = induced == 1 and len(edges) == 29
        out["ok_28_internal"] = internal_e1_connections == 28
    return out


def vb_gap_qa(cur: Any, build_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT osm_id, from_node_id, to_node_id, component_id,
               ST_X(ST_StartPoint(geom)) AS sx, ST_Y(ST_StartPoint(geom)) AS sy,
               ST_X(ST_EndPoint(geom)) AS ex, ST_Y(ST_EndPoint(geom)) AS ey
        FROM water.wg_edges
        WHERE build_id = %s AND osm_type = 'way' AND osm_id = ANY(%s)
        """,
        (build_id, list(VB_GAP_WAYS)),
    )
    rows = {int(r["osm_id"]): dict(r) for r in cur.fetchall()}
    a, b = rows.get(VB_GAP_WAYS[0]), rows.get(VB_GAP_WAYS[1])
    would = False
    gap_m = None
    same_comp = None
    if a and b:
        nodes_a = {a["from_node_id"], a["to_node_id"]}
        nodes_b = {b["from_node_id"], b["to_node_id"]}
        would = bool(nodes_a & nodes_b)
        same_comp = a["component_id"] == b["component_id"]
        gap_m = min(
            haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
            haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
            haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
            haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
        )
    return {
        "ways": list(VB_GAP_WAYS),
        "would_E1_connect": would,
        "same_component": same_comp,
        "min_endpoint_gap_km": round(gap_m / 1000.0, 3) if gap_m is not None else None,
        "stitched": False,
    }


def crossing_check(cur: Any, build_id: int) -> dict[str, Any]:
    """Confirm graph adjacencies come only from shared nodes (E1), not ST_Crosses."""
    cur.execute(
        """
        CREATE TEMP TABLE e5_x ON COMMIT DROP AS
        SELECT a.edge_id AS a_id, b.edge_id AS b_id,
               a.from_node_id AS a_f, a.to_node_id AS a_t,
               b.from_node_id AS b_f, b.to_node_id AS b_t
        FROM water.wg_edges a
        JOIN water.wg_edges b
          ON a.edge_id < b.edge_id
         AND a.build_id = %(b)s AND b.build_id = %(b)s
         AND a.geom && b.geom
         AND ST_Crosses(a.geom, b.geom)
        """,
        {"b": build_id},
    )
    cur.execute("SELECT count(*) AS n FROM e5_x")
    n = int(cur.fetchone()["n"])
    cur.execute(
        """
        SELECT count(*) AS share_node
        FROM e5_x
        WHERE a_f IN (b_f, b_t) OR a_t IN (b_f, b_t)
        """
    )
    share = int(cur.fetchone()["share_node"])
    return {
        "proper_crossing_edge_pairs": n,
        "crossing_pairs_sharing_E1_node": share,
        "crossing_pairs_interior_only": n - share,
        "builder_creates_edges_from_crossings": False,
        "note": "Edges exist 1:1 with routing_segments; nodes only from E1 endpoints.",
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--json-out", type=Path, default=None)
    ap.add_argument("--qa-only", action="store_true")
    ap.add_argument("--build-id", type=int, default=None)
    args = ap.parse_args()
    dsn = args.dsn or default_dsn()

    with psycopg2.connect(dsn) as conn:
        conn.autocommit = False
        canon_before = None
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            canon_before = fingerprint(cur)
        if not args.qa_only:
            summary = build_graph(conn)
        else:
            summary = {"qa_only": True}
        report = qa_report(conn, args.build_id)
        report["build_summary"] = summary
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical_after"] = fingerprint(cur)
        report["canonical_before"] = canon_before

    text = json.dumps(report, indent=2, ensure_ascii=False, default=_json_default)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")

    if report["canonical_before"] != report["canonical_after"]:
        print("ERROR: canonical changed", file=sys.stderr)
        return 2
    b = report["belomor"]
    if not b.get("ok_single_component") or not b.get("ok_28_internal"):
        print("ERROR: Belomor graph check failed", b, file=sys.stderr)
        return 3
    gap = report["volga_baltic"]["gap_seq_53_54"]
    if gap.get("would_E1_connect") or gap.get("stitched"):
        print("ERROR: VB gap incorrectly connected", gap, file=sys.stderr)
        return 4
    if report["volga_baltic"]["induced_component_count"] < 2:
        print("ERROR: VB expected >=2 induced components", file=sys.stderr)
        return 5
    if report["ladoga"].get("artificial_centerline"):
        print("ERROR: Ladoga centerline flag", file=sys.stderr)
        return 6
    if report["crossing_check"].get("builder_creates_edges_from_crossings"):
        return 7
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
