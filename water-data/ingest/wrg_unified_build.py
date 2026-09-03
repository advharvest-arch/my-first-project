#!/usr/bin/env python3
"""
AquaRoute WRG-003 — unified physical connectivity (offline).

Reads wg_nodes/wg_edges (E1, read-only) + WRG-002 mesh/portals for the
validation corpus. Writes wrg_unified_* tables. Does not mutate wg_edges.

Example:
  python3 ingest/wrg_unified_build.py
  python3 ingest/wrg_unified_build.py --json-out data/wrg_003_unified.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import Json, RealDictCursor, execute_values

from wrg_unified import (
    BUILDER_VERSION,
    AttachmentIn,
    MeshTriangle,
    MeshVertexRef,
    compute_unified,
)

INIT_SQL = Path(__file__).resolve().parents[1] / "db" / "init" / "018_wrg_unified.sql"

CORPUS_OSM_IDS = (
    1603199,  # Белое
    21267937,  # Вуокса
    253836,  # Выгозеро
    30406710,  # Талец
    2758761,  # Сегозеро
)
KOVZHA_EDGE = 8039
BELOZERSKY_EDGE = 2228
BELOYE_OSM_ID = 1603199
VYGOZERO_OSM_ID = 253836
TALETS_OSM_ID = 30406710
STRELKA_FORK_NODE = 3452
SREDNYAYA_NEVKA_NODE = 4769
STRELKA_OSM = (72500, 1114249, 8613894)


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
    cur.execute(INIT_SQL.read_text())


def delete_unified(cur: Any, wrg_build_id: int) -> None:
    for table in (
        "water.wrg_unified_attachment",
        "water.wrg_unified_mesh_vertex",
        "water.wrg_unified_e1_node",
        "water.wrg_unified_component",
    ):
        cur.execute(
            f"DELETE FROM {table} WHERE wrg_build_id = %s",
            (wrg_build_id,),
        )


def load_graph(
    cur: Any, wrg_build_id: int, wg_build_id: int, osm_ids: tuple[int, ...]
) -> tuple[list[int], list[tuple[int, int]], list[MeshVertexRef], list[MeshTriangle], list[AttachmentIn], dict[str, Any]]:
    cur.execute(
        "SELECT node_id FROM water.wg_nodes WHERE build_id = %s ORDER BY node_id",
        (wg_build_id,),
    )
    e1_nodes = [int(r["node_id"]) for r in cur.fetchall()]
    cur.execute(
        """
        SELECT from_node_id, to_node_id
        FROM water.wg_edges WHERE build_id = %s
        """,
        (wg_build_id,),
    )
    e1_edges = [(int(r["from_node_id"]), int(r["to_node_id"])) for r in cur.fetchall()]

    cur.execute(
        """
        SELECT v.area_id, v.part, v.vertex_id
        FROM water.wrg_mesh_vertices v
        JOIN water.wrg_areas a
          ON a.wrg_build_id = v.wrg_build_id AND a.area_id = v.area_id
        WHERE v.wrg_build_id = %s AND a.osm_id = ANY(%s)
        ORDER BY v.area_id, v.part, v.vertex_id
        """,
        (wrg_build_id, list(osm_ids)),
    )
    mesh_vertices = [
        MeshVertexRef(int(r["area_id"]), int(r["part"]), int(r["vertex_id"]))
        for r in cur.fetchall()
    ]
    cur.execute(
        """
        SELECT t.area_id, t.part, t.triangle_id, t.v0, t.v1, t.v2
        FROM water.wrg_mesh_triangles t
        JOIN water.wrg_areas a
          ON a.wrg_build_id = t.wrg_build_id AND a.area_id = t.area_id
        WHERE t.wrg_build_id = %s AND a.osm_id = ANY(%s)
        ORDER BY t.area_id, t.part, t.triangle_id
        """,
        (wrg_build_id, list(osm_ids)),
    )
    triangles = [
        MeshTriangle(
            int(r["area_id"]),
            int(r["part"]),
            int(r["triangle_id"]),
            int(r["v0"]),
            int(r["v1"]),
            int(r["v2"]),
        )
        for r in cur.fetchall()
    ]
    cur.execute(
        """
        SELECT mp.portal_id, mp.area_id, mp.part, mp.vertex_id,
               wp.edge_id, wp.from_node_id, wp.to_node_id
        FROM water.wrg_mesh_portals mp
        JOIN water.wrg_portals wp
          ON wp.wrg_build_id = mp.wrg_build_id AND wp.portal_id = mp.portal_id
        JOIN water.wrg_areas a
          ON a.wrg_build_id = mp.wrg_build_id AND a.area_id = mp.area_id
        WHERE mp.wrg_build_id = %s AND a.osm_id = ANY(%s)
        ORDER BY mp.portal_id
        """,
        (wrg_build_id, list(osm_ids)),
    )
    attachments = [
        AttachmentIn(
            portal_id=int(r["portal_id"]),
            area_id=int(r["area_id"]),
            part=int(r["part"]),
            vertex_id=int(r["vertex_id"]),
            edge_id=int(r["edge_id"]),
            from_node_id=int(r["from_node_id"]),
            to_node_id=int(r["to_node_id"]),
        )
        for r in cur.fetchall()
    ]
    cur.execute(
        """
        SELECT count(*)::int AS n
        FROM water.wrg_portals p
        JOIN water.wrg_areas a
          ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
        WHERE p.wrg_build_id = %s AND a.osm_id = ANY(%s)
          AND NOT EXISTS (
            SELECT 1 FROM water.wrg_mesh_portals mp
            WHERE mp.wrg_build_id = p.wrg_build_id AND mp.portal_id = p.portal_id
          )
        """,
        (wrg_build_id, list(osm_ids)),
    )
    orphan = int(cur.fetchone()["n"])
    extra = {"orphan_portals": orphan, "corpus_osm_ids": list(osm_ids)}
    return e1_nodes, e1_edges, mesh_vertices, triangles, attachments, extra


def insert_unified(cur: Any, wrg_build_id: int, result: Any) -> None:
    comp_rows = []
    e1_rows = []
    mv_rows = []
    for rec in result.components:
        parts = {(v.area_id, v.part) for v in rec.mesh_vertices}
        comp_rows.append(
            (
                wrg_build_id,
                rec.physical_component_id,
                len(rec.e1_nodes),
                len(rec.mesh_vertices),
                len(rec.attachments),
                len(parts),
                rec.min_e1_node_id,
                rec.min_area_id,
                rec.min_part,
                rec.min_vertex_id,
                Json(
                    {
                        "builder_version": BUILDER_VERSION,
                        "rule": "e1_edges+mesh_triangle_sides+portal_vertex_to_e1_endpoints",
                    }
                ),
            )
        )
        for n in rec.e1_nodes:
            e1_rows.append((wrg_build_id, n, rec.physical_component_id))
        for v in rec.mesh_vertices:
            mv_rows.append(
                (
                    wrg_build_id,
                    v.area_id,
                    v.part,
                    v.vertex_id,
                    rec.physical_component_id,
                )
            )
    execute_values(
        cur,
        """
        INSERT INTO water.wrg_unified_component (
          wrg_build_id, physical_component_id, e1_node_count, mesh_vertex_count,
          portal_attachment_count, area_part_count,
          min_e1_node_id, min_area_id, min_part, min_vertex_id, evidence
        ) VALUES %s
        """,
        comp_rows,
        page_size=2000,
    )
    execute_values(
        cur,
        """
        INSERT INTO water.wrg_unified_e1_node (
          wrg_build_id, node_id, physical_component_id
        ) VALUES %s
        """,
        e1_rows,
        page_size=5000,
    )
    if mv_rows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_unified_mesh_vertex (
              wrg_build_id, area_id, part, vertex_id, physical_component_id
            ) VALUES %s
            """,
            mv_rows,
            page_size=5000,
        )
    att_rows = []
    for att in result.attachments:
        tri = result.triangle_of_vertex.get((att.area_id, att.part, att.vertex_id))
        att_rows.append(
            (
                wrg_build_id,
                att.portal_id,
                att.area_id,
                att.part,
                att.vertex_id,
                att.edge_id,
                att.from_node_id,
                att.to_node_id,
                tri,
                Json(
                    {
                        "builder_version": BUILDER_VERSION,
                        "bind": "mesh_vertex_to_e1_edge_endpoints",
                    }
                ),
            )
        )
    if att_rows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_unified_attachment (
              wrg_build_id, portal_id, area_id, part, vertex_id,
              edge_id, from_node_id, to_node_id, triangle_id, evidence
            ) VALUES %s
            """,
            att_rows,
            page_size=2000,
        )


def _edge_nodes(cur: Any, edge_id: int) -> tuple[int, int] | None:
    cur.execute(
        "SELECT from_node_id, to_node_id FROM water.wg_edges WHERE edge_id = %s",
        (edge_id,),
    )
    r = cur.fetchone()
    if not r:
        return None
    return int(r["from_node_id"]), int(r["to_node_id"])


def run_checks(
    cur: Any,
    wrg_build_id: int,
    result: Any,
    extra: dict[str, Any],
) -> dict[str, Any]:
    checks: dict[str, Any] = {}
    e1_of = result.e1_component_of

    kovzha = _edge_nodes(cur, KOVZHA_EDGE)
    beloz = _edge_nodes(cur, BELOZERSKY_EDGE)
    if kovzha and beloz:
        cid_a = e1_of.get(kovzha[0])
        cid_b = e1_of.get(beloz[0])
        checks["A_beloye_kovzha_belozersky"] = {
            "kovzha_from": kovzha[0],
            "belozersky_from": beloz[0],
            "unified_cid_kovzha": cid_a,
            "unified_cid_belozersky": cid_b,
            "ok": cid_a is not None and cid_a == cid_b,
        }

    cur.execute(
        """
        SELECT count(*)::int AS n FROM water.wrg_areas
        WHERE wrg_build_id = %s AND osm_id = ANY(%s)
        """,
        (wrg_build_id, list(STRELKA_OSM)),
    )
    strelka_areas = int(cur.fetchone()["n"])
    fork_cid = e1_of.get(STRELKA_FORK_NODE)
    nevka_cid = e1_of.get(SREDNYAYA_NEVKA_NODE)
    checks["B_strelka_no_new_land_link"] = {
        "strelka_or_pond_wrg_areas": strelka_areas,
        "fork_node": STRELKA_FORK_NODE,
        "srednyaya_nevka_node": SREDNYAYA_NEVKA_NODE,
        "fork_unified_cid": fork_cid,
        "srednyaya_unified_cid": nevka_cid,
        "ok": strelka_areas == 0 and fork_cid is not None and fork_cid != nevka_cid,
    }

    cur.execute(
        """
        SELECT a.area_id, v.part
        FROM water.wrg_mesh_vertices v
        JOIN water.wrg_areas a
          ON a.wrg_build_id = v.wrg_build_id AND a.area_id = v.area_id
        WHERE v.wrg_build_id = %s AND a.osm_id = %s
        GROUP BY a.area_id, v.part
        ORDER BY v.part
        """,
        (wrg_build_id, VYGOZERO_OSM_ID),
    )
    vparts = [(int(r["area_id"]), int(r["part"])) for r in cur.fetchall()]
    per_part = [
        row
        for row in result.diagnostics.get("mesh_cc_per_part") or []
        if (row["area_id"], row["part"]) in set(vparts)
    ]
    checks["C_vygozero_parts"] = {
        "parts": [p for _a, p in vparts],
        "mesh_cc_per_part": per_part,
        "cross_part_connections": result.diagnostics.get("cross_part_connections"),
        "ok": result.diagnostics.get("cross_part_connections") == 0
        and len(vparts) == 3
        and all(row["mesh_only_components"] >= 1 for row in per_part),
    }

    cur.execute(
        """
        SELECT wp.from_node_id
        FROM water.wrg_mesh_portals mp
        JOIN water.wrg_portals wp
          ON wp.wrg_build_id = mp.wrg_build_id AND wp.portal_id = mp.portal_id
        JOIN water.wrg_areas a
          ON a.wrg_build_id = mp.wrg_build_id AND a.area_id = mp.area_id
        WHERE mp.wrg_build_id = %s AND a.osm_id = %s
        ORDER BY mp.portal_id
        """,
        (wrg_build_id, TALETS_OSM_ID),
    )
    talets_nodes = [int(r["from_node_id"]) for r in cur.fetchall()]
    talets_cids = [e1_of.get(n) for n in talets_nodes]
    checks["D_talets_portals"] = {
        "n_portals": len(talets_nodes),
        "unified_cids": talets_cids,
        "ok": len(talets_nodes) == 3
        and len(set(talets_cids)) == 1
        and talets_cids[0] is not None,
    }
    return checks


def build_corpus(conn: Any, wrg_build_id: int | None, osm_ids: tuple[int, ...]) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        apply_schema(cur)
        cur.execute("SET statement_timeout = 0")
        cur.execute("SET work_mem = '512MB'")
        if wrg_build_id is None:
            cur.execute("SELECT max(wrg_build_id) AS id FROM water.wrg_build")
            row = cur.fetchone()
            if not row or row["id"] is None:
                raise RuntimeError("no water.wrg_build — run WRG-001/002 first")
            wrg_build_id = int(row["id"])
        cur.execute(
            "SELECT wg_build_id FROM water.wrg_build WHERE wrg_build_id = %s",
            (wrg_build_id,),
        )
        brow = cur.fetchone()
        if not brow:
            raise RuntimeError(f"wrg_build_id {wrg_build_id} not found")
        wg_build_id = int(brow["wg_build_id"])
        before = e1_fingerprint(cur, wg_build_id)
        loaded = load_graph(cur, wrg_build_id, wg_build_id, osm_ids)
        e1_nodes, e1_edges, mesh_vertices, triangles, attachments, extra = loaded
        result = compute_unified(
            e1_nodes, e1_edges, mesh_vertices, triangles, attachments
        )
        result.diagnostics["orphan_portals"] = extra["orphan_portals"]
        delete_unified(cur, wrg_build_id)
        insert_unified(cur, wrg_build_id, result)
        checks = run_checks(cur, wrg_build_id, result, extra)
        after = e1_fingerprint(cur, wg_build_id)
        checks["E_wg_edges_unchanged"] = {
            "before": before,
            "after": after,
            "ok": before["checksum"] == after["checksum"]
            and before["edge_count"] == after["edge_count"]
            and after["checksum"] == "33f7f14a3dc26e44"
            and after["edge_count"] == 175173,
        }
        conn.commit()
        return {
            "wrg_build_id": wrg_build_id,
            "wg_build_id": wg_build_id,
            "builder_version": BUILDER_VERSION,
            "corpus_osm_ids": list(osm_ids),
            "diagnostics": result.diagnostics,
            "checks": checks,
            "no_wg_edges_written": True,
            "no_proximity": True,
            "no_hubs_or_chords": True,
            "no_area_clique": True,
            "no_all_areas": True,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="WRG-003 unified physical connectivity")
    parser.add_argument("--dsn", default=default_dsn())
    parser.add_argument("--wrg-build-id", type=int, default=None)
    parser.add_argument(
        "--osm-ids",
        default=",".join(str(i) for i in CORPUS_OSM_IDS),
        help="corpus osm_ids whose mesh may attach E1 (default: WRG-002 five lakes)",
    )
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()
    osm_ids = tuple(int(x.strip()) for x in args.osm_ids.split(",") if x.strip())
    conn = psycopg2.connect(args.dsn)
    try:
        report = build_corpus(conn, args.wrg_build_id, osm_ids)
    finally:
        conn.close()
    text = json.dumps(report, indent=2, ensure_ascii=False, default=_json_default)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")
    checks = report["checks"]
    diag = report["diagnostics"]
    ok = (
        checks.get("A_beloye_kovzha_belozersky", {}).get("ok") is True
        and checks.get("B_strelka_no_new_land_link", {}).get("ok") is True
        and checks.get("C_vygozero_parts", {}).get("ok") is True
        and checks.get("D_talets_portals", {}).get("ok") is True
        and checks.get("E_wg_edges_unchanged", {}).get("ok") is True
        and diag.get("cross_part_connections") == 0
        and report["no_wg_edges_written"] is True
    )
    return 0 if ok else 2


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
