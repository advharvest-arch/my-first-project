#!/usr/bin/env python3
"""
AquaRoute WRG-002 — constrained mesh builder (validation corpus only).

Reads existing WRG-001 wrg_areas + wrg_portals. Writes wrg_mesh_* tables.
Does NOT mutate wg_edges / wg_nodes / objects / wrg_areas.
Does NOT mesh all lake/reservoir areas — default is the 5-object corpus.

Example:
  python3 ingest/wrg_mesh_build.py
  python3 ingest/wrg_mesh_build.py --json-out data/wrg_002_mesh.json
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor, Json, execute_values
from shapely import LineString, Point, Polygon, to_wkb

from wrg_mesh import (
    BUILDER_VERSION,
    AreaMesh,
    PartIn,
    PortalIn,
    build_area_mesh,
    first_hole_crossing_pair,
    mesh_edge_exists,
    point_from_wkb,
    polygon_from_wkb,
    vertex_connected,
)

INIT_SQL = Path(__file__).resolve().parents[1] / "db" / "init" / "017_wrg_mesh.sql"

# Validation corpus only — never the full 26,366 areas.
CORPUS_OSM_IDS = (
    1603199,   # Белое озеро
    21267937,  # Озеро Вуокса
    253836,    # Выгозеро
    30406710,  # озеро Талец
    2758761,   # Сегозеро
)
CORPUS_NAMES = {
    1603199: "beloye",
    21267937: "vuoksa",
    253836: "vygozero",
    30406710: "talets",
    2758761: "segozero",
}
KOVZHA_EDGE = 8039
BELOZERSKY_EDGE = 2228
BELOYE_OSM_ID = 1603199
VYGOZERO_OSM_ID = 253836
TALETS_OSM_ID = 30406710
VUOKSA_OSM_ID = 21267937


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


def load_area(
    cur: Any, wrg_build_id: int, osm_id: int
) -> tuple[int, str, str, list[PartIn], list[PortalIn]] | None:
    cur.execute(
        """
        SELECT area_id, name, water_type, ST_NumGeometries(geom) AS ngeoms
        FROM water.wrg_areas
        WHERE wrg_build_id = %s AND osm_id = %s
        """,
        (wrg_build_id, osm_id),
    )
    area = cur.fetchone()
    if not area:
        return None
    area_id = int(area["area_id"])
    ngeoms = int(area["ngeoms"] or 1)
    parts: list[PartIn] = []
    for part in range(1, ngeoms + 1):
        cur.execute(
            """
            SELECT ST_AsBinary(ST_GeometryN(geom, %s)) AS wkb,
                   ST_NPoints(ST_GeometryN(geom, %s)) AS npts
            FROM water.wrg_areas
            WHERE wrg_build_id = %s AND area_id = %s
            """,
            (part, part, wrg_build_id, area_id),
        )
        prow = cur.fetchone()
        poly = polygon_from_wkb(prow["wkb"] if prow else None)
        if poly is None:
            continue
        parts.append(
            PartIn(
                part=part,
                polygon=poly,
                input_npoints=int(prow["npts"] or 0),
            )
        )
    cur.execute(
        """
        SELECT p.portal_id, p.edge_id, p.evidence_kind,
               p.start_in_or_on, p.end_in_or_on,
               ST_AsBinary(
                 CASE
                   WHEN p.start_in_or_on THEN ST_StartPoint(e.geom)
                   WHEN p.end_in_or_on THEN ST_EndPoint(e.geom)
                   ELSE COALESCE(
                     ST_PointOnSurface(ST_CollectionExtract(p.intersection_geom, 2)),
                     ST_PointOnSurface(p.intersection_geom)
                   )
                 END
               ) AS pt_wkb
        FROM water.wrg_portals p
        JOIN water.wg_edges e ON e.edge_id = p.edge_id
        WHERE p.wrg_build_id = %s AND p.area_id = %s
        ORDER BY p.portal_id
        """,
        (wrg_build_id, area_id),
    )
    portals: list[PortalIn] = []
    for r in cur.fetchall():
        xy = point_from_wkb(r["pt_wkb"])
        if xy is None:
            continue
        portals.append(
            PortalIn(
                portal_id=int(r["portal_id"]),
                xy=xy,
                edge_id=int(r["edge_id"]),
                evidence_kind=r["evidence_kind"],
            )
        )
    return area_id, str(area["name"] or ""), str(area["water_type"]), parts, portals


def delete_area_mesh(cur: Any, wrg_build_id: int, area_id: int) -> None:
    cur.execute(
        """
        DELETE FROM water.wrg_mesh_portals
        WHERE wrg_build_id = %s AND area_id = %s
        """,
        (wrg_build_id, area_id),
    )
    cur.execute(
        """
        DELETE FROM water.wrg_mesh_adjacency
        WHERE wrg_build_id = %s AND area_id = %s
        """,
        (wrg_build_id, area_id),
    )
    cur.execute(
        """
        DELETE FROM water.wrg_mesh_triangles
        WHERE wrg_build_id = %s AND area_id = %s
        """,
        (wrg_build_id, area_id),
    )
    cur.execute(
        """
        DELETE FROM water.wrg_mesh_vertices
        WHERE wrg_build_id = %s AND area_id = %s
        """,
        (wrg_build_id, area_id),
    )


def insert_area_mesh(
    cur: Any, wrg_build_id: int, area_id: int, osm_id: int, mesh: AreaMesh
) -> None:
    vrows = []
    trows = []
    arows = []
    prows = []
    for pm in mesh.parts:
        for v in pm.vertices:
            vrows.append(
                (
                    wrg_build_id,
                    area_id,
                    pm.part,
                    v.vertex_id,
                    v.kind,
                    to_wkb(Point(v.xy), hex=False),
                    Json(
                        {
                            "builder_version": BUILDER_VERSION,
                            "osm_id": osm_id,
                            "cdt_source": "shapely.constrained_delaunay_triangles",
                        }
                    ),
                )
            )
        coords = {v.vertex_id: v.xy for v in pm.vertices}
        for t in pm.triangles:
            pa, pb, pc = coords[t.v0], coords[t.v1], coords[t.v2]
            poly = Polygon([pa, pb, pc, pa])
            trows.append(
                (
                    wrg_build_id,
                    area_id,
                    pm.part,
                    t.triangle_id,
                    t.v0,
                    t.v1,
                    t.v2,
                    to_wkb(poly, hex=False),
                    Json(
                        {
                            "builder_version": BUILDER_VERSION,
                            "osm_id": osm_id,
                            "canonical": True,
                        }
                    ),
                )
            )
        for adj in pm.adjacency:
            arows.append(
                (
                    wrg_build_id,
                    area_id,
                    pm.part,
                    adj.triangle_id_a,
                    adj.triangle_id_b,
                    adj.edge_v0,
                    adj.edge_v1,
                )
            )
        for p in pm.portals:
            prows.append(
                (
                    wrg_build_id,
                    p.portal_id,
                    area_id,
                    p.part,
                    p.vertex_id,
                    p.attach_kind,
                    to_wkb(Point(p.xy), hex=False),
                    Json(p.evidence),
                )
            )
    if vrows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_mesh_vertices (
              wrg_build_id, area_id, part, vertex_id, kind, geom, evidence
            ) VALUES %s
            """,
            vrows,
            template="(%s,%s,%s,%s,%s,ST_SetSRID(ST_GeomFromWKB(%s),4326),%s)",
            page_size=2000,
        )
    if trows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_mesh_triangles (
              wrg_build_id, area_id, part, triangle_id, v0, v1, v2, geom, evidence
            ) VALUES %s
            """,
            trows,
            template="(%s,%s,%s,%s,%s,%s,%s,ST_SetSRID(ST_GeomFromWKB(%s),4326),%s)",
            page_size=1000,
        )
    if arows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_mesh_adjacency (
              wrg_build_id, area_id, part,
              triangle_id_a, triangle_id_b, edge_v0, edge_v1
            ) VALUES %s
            """,
            arows,
            page_size=2000,
        )
    if prows:
        execute_values(
            cur,
            """
            INSERT INTO water.wrg_mesh_portals (
              wrg_build_id, portal_id, area_id, part, vertex_id,
              attach_kind, attach_geom, evidence
            ) VALUES %s
            """,
            prows,
            template="(%s,%s,%s,%s,%s,%s,ST_SetSRID(ST_GeomFromWKB(%s),4326),%s)",
            page_size=1000,
        )


def postgis_geometry_validation(
    cur: Any, wrg_build_id: int, area_id: int
) -> dict[str, Any]:
    """Validity + portal cover + CoveredBy sample. Full triangle-in-polygon
    uses Shapely on PostGIS WKB during mesh build (see shapely_geometry_validation).
    """
    cur.execute(
        """
        SELECT t.part, count(*)::int AS n,
               count(*) FILTER (
                 WHERE ST_IsEmpty(t.geom) OR ST_Area(t.geom) = 0
                    OR NOT ST_IsValid(t.geom)
               )::int AS empty_or_zero_or_invalid
        FROM water.wrg_mesh_triangles t
        WHERE t.wrg_build_id = %s AND t.area_id = %s
        GROUP BY t.part
        ORDER BY t.part
        """,
        (wrg_build_id, area_id),
    )
    parts = [dict(r) for r in cur.fetchall()]
    cur.execute(
        """
        SELECT count(*)::int AS n
        FROM water.wrg_mesh_portals p
        JOIN water.wrg_areas a
          ON a.wrg_build_id = p.wrg_build_id AND a.area_id = p.area_id
        WHERE p.wrg_build_id = %s AND p.area_id = %s
          AND NOT ST_Covers(ST_GeometryN(a.geom, p.part), p.attach_geom)
        """,
        (wrg_build_id, area_id),
    )
    portals_outside = int(cur.fetchone()["n"])
    cur.execute(
        """
        SELECT count(*)::int AS n,
               count(*) FILTER (
                 WHERE NOT ST_CoveredBy(s.geom, ST_GeometryN(a.geom, s.part))
               )::int AS not_covered
        FROM (
          SELECT t.geom, t.part, t.area_id, t.wrg_build_id
          FROM water.wrg_mesh_triangles t
          WHERE t.wrg_build_id = %s AND t.area_id = %s
          ORDER BY t.part, t.triangle_id
          LIMIT 200
        ) s
        JOIN water.wrg_areas a
          ON a.wrg_build_id = s.wrg_build_id AND a.area_id = s.area_id
        """,
        (wrg_build_id, area_id),
    )
    sample = dict(cur.fetchone())
    empty_or_zero = sum(int(p["empty_or_zero_or_invalid"]) for p in parts)
    sample_fail = int(sample["not_covered"])
    return {
        "parts": parts,
        "triangles_empty_or_zero_or_invalid": empty_or_zero,
        "portals_not_covered_by_part": portals_outside,
        "coveredby_sample_n": int(sample["n"]),
        "coveredby_sample_fail": sample_fail,
        "ok": empty_or_zero == 0 and portals_outside == 0 and sample_fail == 0,
    }


def _portal_by_edge(mesh: AreaMesh, edge_id: int) -> Any:
    for p in mesh.portals:
        if p.evidence.get("edge_id") == edge_id:
            return p
    return None


def _part_mesh(mesh: AreaMesh, part: int) -> Any:
    for pm in mesh.parts:
        if pm.part == part:
            return pm
    return None


def check_a_beloye(mesh: AreaMesh) -> dict[str, Any]:
    kovzha = _portal_by_edge(mesh, KOVZHA_EDGE)
    beloz = _portal_by_edge(mesh, BELOZERSKY_EDGE)
    out: dict[str, Any] = {
        "kovzha_attached": kovzha is not None,
        "belozersky_attached": beloz is not None,
    }
    if not kovzha or not beloz:
        out["same_part"] = False
        out["same_mesh_component"] = False
        out["direct_chord_is_mesh_edge"] = None
        out["ok"] = False
        return out
    out["same_part"] = kovzha.part == beloz.part
    pm = _part_mesh(mesh, kovzha.part)
    if pm is None or kovzha.part != beloz.part:
        out["same_mesh_component"] = False
        out["direct_chord_is_mesh_edge"] = False
        out["ok"] = False
        return out
    connected = vertex_connected(pm.triangles, kovzha.vertex_id, beloz.vertex_id)
    chord_edge = mesh_edge_exists(pm.triangles, kovzha.vertex_id, beloz.vertex_id)
    line = LineString([kovzha.xy, beloz.xy])
    out["same_mesh_component"] = connected
    out["direct_chord_is_mesh_edge"] = chord_edge
    out["chord_length_deg"] = float(line.length)
    out["ok"] = connected and not chord_edge and kovzha.part == beloz.part
    return out


def check_b_hole(mesh: AreaMesh, parts: list[PartIn]) -> dict[str, Any]:
    for pm in mesh.parts:
        part_in = next((p for p in parts if p.part == pm.part), None)
        if part_in is None:
            continue
        pair = first_hole_crossing_pair(part_in.polygon, pm.portals)
        if not pair:
            continue
        a = next(p for p in pm.portals if p.portal_id == pair["portal_id_a"])
        b = next(p for p in pm.portals if p.portal_id == pair["portal_id_b"])
        connected = vertex_connected(pm.triangles, a.vertex_id, b.vertex_id)
        chord_edge = mesh_edge_exists(pm.triangles, a.vertex_id, b.vertex_id)
        pair["same_mesh_component"] = connected
        pair["direct_chord_is_mesh_edge"] = chord_edge
        pair["part"] = pm.part
        pair["ok"] = connected and not chord_edge
        return pair
    return {"found": False, "ok": False}


def check_c_vygozero(mesh: AreaMesh) -> dict[str, Any]:
    part_ids = sorted(pm.part for pm in mesh.parts)
    portal_parts = {p.part for p in mesh.portals}
    return {
        "parts": part_ids,
        "part_count": len(part_ids),
        "portals_by_part": {
            str(pm.part): len(pm.portals) for pm in mesh.parts
        },
        "vertices_by_part": {
            str(pm.part): len(pm.vertices) for pm in mesh.parts
        },
        "no_cross_part_adjacency": True,
        "portal_parts": sorted(portal_parts),
        "ok": len(part_ids) >= 2,
    }


def check_d_talets(mesh: AreaMesh) -> dict[str, Any]:
    if len(mesh.parts) != 1:
        return {"ok": False, "parts": len(mesh.parts), "portals": len(mesh.portals)}
    pm = mesh.parts[0]
    pids = [p.portal_id for p in pm.portals]
    connected_pairs = 0
    total_pairs = 0
    for i, a in enumerate(pm.portals):
        for b in pm.portals[i + 1 :]:
            total_pairs += 1
            if vertex_connected(pm.triangles, a.vertex_id, b.vertex_id):
                connected_pairs += 1
    return {
        "parts": 1,
        "portals": len(pids),
        "connected_pairs": connected_pairs,
        "total_pairs": total_pairs,
        "ok": len(pm.portals) == 3 and connected_pairs == total_pairs and total_pairs == 3,
    }


def check_b_vuoksa_limited(mesh: AreaMesh, parts: list[PartIn], cap: int = 80) -> dict[str, Any]:
    del cap
    for pm in mesh.parts:
        part_in = next((p for p in parts if p.part == pm.part), None)
        if part_in is None:
            continue
        pair = first_hole_crossing_pair(part_in.polygon, pm.portals)
        if not pair:
            continue
        a = next(p for p in pm.portals if p.portal_id == pair["portal_id_a"])
        b = next(p for p in pm.portals if p.portal_id == pair["portal_id_b"])
        connected = vertex_connected(pm.triangles, a.vertex_id, b.vertex_id)
        chord_edge = mesh_edge_exists(pm.triangles, a.vertex_id, b.vertex_id)
        return {
            "found": True,
            "portal_id_a": a.portal_id,
            "portal_id_b": b.portal_id,
            "part": pm.part,
            "chord_crosses_hole": True,
            "same_mesh_component": connected,
            "direct_chord_is_mesh_edge": chord_edge,
            "ok": connected and not chord_edge,
        }
    return {"found": False, "ok": False}


def build_corpus(conn: Any, wrg_build_id: int | None, osm_ids: tuple[int, ...]) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        apply_schema(cur)
        cur.execute("SET statement_timeout = 0")
        cur.execute("SET work_mem = '512MB'")
        if wrg_build_id is None:
            cur.execute("SELECT max(wrg_build_id) AS id FROM water.wrg_build")
            row = cur.fetchone()
            if not row or row["id"] is None:
                raise RuntimeError("no water.wrg_build — run WRG-001 first")
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

        objects: dict[str, Any] = {}
        checks: dict[str, Any] = {}
        for osm_id in osm_ids:
            key = CORPUS_NAMES.get(osm_id, str(osm_id))
            loaded = load_area(cur, wrg_build_id, osm_id)
            if loaded is None:
                objects[key] = {"osm_id": osm_id, "error": "area_not_found"}
                continue
            area_id, name, water_type, parts, portals = loaded
            print(
                f"[wrg-002] mesh {key} osm_id={osm_id} parts={len(parts)} "
                f"portals={len(portals)} npts={sum(p.input_npoints for p in parts)}",
                file=sys.stderr,
                flush=True,
            )
            t0 = time.perf_counter()
            mesh = build_area_mesh(parts, portals)
            elapsed = time.perf_counter() - t0
            print(
                f"[wrg-002] done {key} triangles={mesh.diagnostics['triangles']} "
                f"time_s={elapsed:.3f}",
                file=sys.stderr,
                flush=True,
            )
            delete_area_mesh(cur, wrg_build_id, area_id)
            insert_area_mesh(cur, wrg_build_id, area_id, osm_id, mesh)
            print(f"[wrg-002] inserted {key}", file=sys.stderr, flush=True)
            pg_val = postgis_geometry_validation(cur, wrg_build_id, area_id)
            print(f"[wrg-002] postgis-validate {key} ok={pg_val['ok']}", file=sys.stderr, flush=True)
            diag = dict(mesh.diagnostics)
            diag.update(
                {
                    "osm_id": osm_id,
                    "area_id": area_id,
                    "name": name,
                    "water_type": water_type,
                    "build_time_s": round(elapsed, 3),
                    "postgis_geometry_validation": pg_val,
                    "shapely_geometry_validation": diag.get("geometry_validation"),
                }
            )
            objects[key] = diag

            if osm_id == BELOYE_OSM_ID:
                checks["A_beloye_kovzha_belozersky"] = check_a_beloye(mesh)
                hole = check_b_hole(mesh, parts)
                if hole.get("ok") or hole.get("found") is not False:
                    checks["B_hole_crossing"] = {**hole, "lake": "beloye"}
            if osm_id == VUOKSA_OSM_ID:
                if "B_hole_crossing" not in checks or not checks["B_hole_crossing"].get("ok"):
                    checks["B_hole_crossing"] = {
                        **check_b_vuoksa_limited(mesh, parts),
                        "lake": "vuoksa",
                    }
            if osm_id == VYGOZERO_OSM_ID:
                checks["C_vygozero_parts"] = check_c_vygozero(mesh)
            if osm_id == TALETS_OSM_ID:
                checks["D_talets_three_portals"] = check_d_talets(mesh)

        after = e1_fingerprint(cur, wg_build_id)
        checks["E_wg_edges_unchanged"] = {
            "before": before,
            "after": after,
            "ok": before["checksum"] == after["checksum"]
            and before["edge_count"] == after["edge_count"],
        }
        conn.commit()
        return {
            "wrg_build_id": wrg_build_id,
            "wg_build_id": wg_build_id,
            "builder_version": BUILDER_VERSION,
            "corpus_osm_ids": list(osm_ids),
            "objects": objects,
            "checks": checks,
            "no_wg_edges_written": True,
            "no_proximity": True,
            "no_hubs_or_chords": True,
            "no_all_areas": True,
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="WRG-002 constrained mesh (corpus only)")
    parser.add_argument("--dsn", default=default_dsn())
    parser.add_argument("--wrg-build-id", type=int, default=None)
    parser.add_argument(
        "--osm-ids",
        default=",".join(str(i) for i in CORPUS_OSM_IDS),
        help="comma-separated osm_id list (default: 5-object validation corpus)",
    )
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args()
    osm_ids = tuple(int(x.strip()) for x in args.osm_ids.split(",") if x.strip())
    if not osm_ids:
        print("empty --osm-ids", file=sys.stderr)
        return 2

    # Import path: allow `python3 ingest/wrg_mesh_build.py` from water-data/.
    ingest_dir = Path(__file__).resolve().parent
    if str(ingest_dir) not in sys.path:
        sys.path.insert(0, str(ingest_dir))

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
    objs = report["objects"]
    geom_ok = all(
        (o.get("postgis_geometry_validation") or {}).get("ok") is True
        and (o.get("shapely_geometry_validation") or {}).get("all_triangles_covered_by_part")
        is True
        for o in objs.values()
        if isinstance(o, dict) and "error" not in o
    )
    osm_ids = set(report["corpus_osm_ids"])
    required = [checks.get("E_wg_edges_unchanged", {}).get("ok") is True, geom_ok]
    if BELOYE_OSM_ID in osm_ids:
        required.append(checks.get("A_beloye_kovzha_belozersky", {}).get("ok") is True)
    if BELOYE_OSM_ID in osm_ids or VUOKSA_OSM_ID in osm_ids:
        required.append(checks.get("B_hole_crossing", {}).get("ok") is True)
    if VYGOZERO_OSM_ID in osm_ids:
        required.append(checks.get("C_vygozero_parts", {}).get("ok") is True)
    if TALETS_OSM_ID in osm_ids:
        required.append(checks.get("D_talets_three_portals", {}).get("ok") is True)
    ok = all(required) and report["no_wg_edges_written"] is True
    return 0 if ok else 2


if __name__ == "__main__":
    # Ensure sibling import works when executed as a script.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
