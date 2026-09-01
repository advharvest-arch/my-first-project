#!/usr/bin/env python3
"""
AquaRoute E9 — Export PostGIS WaterGraph Belomor NAVIGABLE subgraph
for the sea-map pilot provider (browser-safe snapshot).

Does NOT change canonical DB. Does NOT download PBF.
Re-run after E8 navigation classification when refreshing the fixture.

  python3 ingest/e9_export_postgis_wg_pilot.py \
    --out ../sea-map/src/__fixtures__/postgis-watergraph/belomor-navigable.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

BELOMOR_ID = 9909116
VB_GAP_WAYS = (28433211, 824398188)


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


def ser_edge(e: dict[str, Any]) -> dict[str, Any]:
    return {
        "edge_id": int(e["edge_id"]),
        "osm_type": e.get("osm_type"),
        "osm_id": int(e["osm_id"]),
        "name": e.get("name"),
        "waterway": e.get("waterway"),
        "from_node_id": int(e["from_node_id"]),
        "to_node_id": int(e["to_node_id"]),
        "length_m": float(e["length_m"]),
        "parent_relation_ids": [int(x) for x in (e.get("parent_relation_ids") or [])],
        "nav_status": e["nav_status"],
        "nav_reasons": list(e.get("nav_reasons") or []),
        "safety_status": e.get("safety_status"),
        "geom": e.get("geom"),
    }


def export(dsn: str) -> dict[str, Any]:
    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("SELECT max(build_id) AS b FROM water.wg_build")
            build_id = int(cur.fetchone()["b"])
            cur.execute("SELECT max(navigation_run_id) AS n FROM water.wg_navigation_run")
            nav_run = cur.fetchone()["n"]
            if nav_run is None:
                raise SystemExit("No wg_navigation_run — run e8_navigation_semantics.py first")
            nav_run = int(nav_run)
            cur.execute("SELECT max(safety_run_id) AS s FROM water.wg_safety_run")
            safety_run = cur.fetchone()["s"]
            safety_run = int(safety_run) if safety_run is not None else None

            cur.execute(
                """
                SELECT e.edge_id, e.osm_type, e.osm_id, e.name, e.waterway,
                       e.from_node_id, e.to_node_id, e.length_m,
                       e.parent_relation_ids,
                       ST_AsGeoJSON(e.geom)::json AS geom,
                       n.status AS nav_status,
                       n.reasons AS nav_reasons,
                       s.status AS safety_status
                FROM water.wg_edges e
                JOIN water.wg_edge_navigation n
                  ON n.edge_id = e.edge_id AND n.navigation_run_id = %s
                LEFT JOIN water.wg_edge_safety s
                  ON s.edge_id = e.edge_id AND s.safety_run_id = %s
                WHERE e.build_id = %s AND %s = ANY (e.parent_relation_ids)
                ORDER BY e.edge_id
                """,
                (nav_run, safety_run, build_id, BELOMOR_ID),
            )
            edges = [dict(r) for r in cur.fetchall()]
            node_ids = sorted(
                {int(e["from_node_id"]) for e in edges}
                | {int(e["to_node_id"]) for e in edges}
            )
            cur.execute(
                """
                SELECT node_id, e1_lon AS lon, e1_lat AS lat
                FROM water.wg_nodes
                WHERE build_id = %s AND node_id = ANY (%s)
                """,
                (build_id, node_ids),
            )
            nodes = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT e.edge_id, e.osm_type, e.osm_id, e.name, e.waterway,
                       e.from_node_id, e.to_node_id, e.length_m,
                       e.parent_relation_ids,
                       ST_AsGeoJSON(e.geom)::json AS geom,
                       n.status AS nav_status,
                       n.reasons AS nav_reasons,
                       NULL::text AS safety_status
                FROM water.wg_edges e
                JOIN water.wg_edge_navigation n
                  ON n.edge_id = e.edge_id AND n.navigation_run_id = %s
                WHERE e.build_id = %s AND e.osm_id IN %s
                """,
                (nav_run, build_id, VB_GAP_WAYS),
            )
            vb_gap = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT e.edge_id, e.osm_id, e.name, e.from_node_id, e.to_node_id,
                       n.status AS nav_status
                FROM water.wg_edges e
                JOIN water.wg_edge_navigation n
                  ON n.edge_id = e.edge_id AND n.navigation_run_id = %s
                WHERE e.build_id = %s AND e.name IS NOT NULL
                  AND (
                    e.name ILIKE '%%ахтуб%%' OR e.name ILIKE '%%akhtub%%'
                    OR e.name ILIKE '%%волг%%' OR e.name ILIKE '%%volga%%'
                  )
                LIMIT 200
                """,
                (nav_run, build_id),
            )
            va = [dict(r) for r in cur.fetchall()]

    return {
        "schemaVersion": "e9-postgis-watergraph-pilot-1",
        "build_id": build_id,
        "navigation_run_id": nav_run,
        "safety_run_id": safety_run,
        "relation_id": BELOMOR_ID,
        "policy": {
            "routable_nav_status": ["NAVIGABLE"],
            "forbidden_nav_status": ["UNKNOWN", "BLOCKED"],
            "note": (
                "Snapshot export of PostGIS WaterGraph Belomor subgraph. "
                "Exact E1 node ids; no proximity stitching."
            ),
        },
        "nodes": [
            {
                "node_id": int(n["node_id"]),
                "lon": float(n["lon"]),
                "lat": float(n["lat"]),
            }
            for n in nodes
        ],
        "edges": [ser_edge(e) for e in edges],
        "vb_gap_edges": [ser_edge(e) for e in vb_gap],
        "volga_akhtuba_sample": [
            {
                "edge_id": int(e["edge_id"]),
                "osm_id": int(e["osm_id"]),
                "name": e["name"],
                "from_node_id": int(e["from_node_id"]),
                "to_node_id": int(e["to_node_id"]),
                "nav_status": e["nav_status"],
            }
            for e in va
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=None)
    ap.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parents[2]
        / "sea-map"
        / "src"
        / "__fixtures__"
        / "postgis-watergraph"
        / "belomor-navigable.json",
    )
    args = ap.parse_args()
    data = export(args.dsn or default_dsn())
    nav = sum(1 for e in data["edges"] if e["nav_status"] == "NAVIGABLE")
    unk = sum(1 for e in data["edges"] if e["nav_status"] != "NAVIGABLE")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        json.dumps(
            {
                "out": str(args.out),
                "belomor_edges": len(data["edges"]),
                "navigable": nav,
                "non_navigable": unk,
                "nodes": len(data["nodes"]),
            },
            indent=2,
        )
    )
    if unk:
        print("ERROR: Belomor export must be NAVIGABLE-only for E9 pilot", file=sys.stderr)
        return 2
    if nav != 29:
        print(f"WARN: expected 29 Belomor NAVIGABLE edges, got {nav}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
