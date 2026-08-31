#!/usr/bin/env python3
"""
AquaRoute E4.4 — READ-ONLY topology inference audit.

Uses water.routing_segments as the only linear geometry source.
Diagnoses endpoint connectivity (exact / 1m / 5m / 10m) and crossings.
Does NOT create graph nodes/edges, mutate geometry, or stitch gaps.

Examples:
  python3 ingest/e44_topology_inference_audit.py
  python3 ingest/e44_topology_inference_audit.py --json-out data/e44_topology.json
  python3 ingest/e44_topology_inference_audit.py --skip-crossings
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

RELATION_IDS = {
    "belomor": 9909116,
    "volga_baltic": 16738852,
    "ladoga": 21149039,
}

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


def _json_default(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    if hasattr(obj, "isoformat"):
        return obj.isoformat()
    raise TypeError(type(obj).__name__)


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


def ensure_temp_endpoints(cur: Any) -> None:
    cur.execute(
        """
        CREATE TEMP TABLE e44_ep ON COMMIT DROP AS
        SELECT
          row_number() OVER () AS ep_id,
          osm_type,
          osm_id,
          part_index,
          which,
          geom,
          ST_Transform(geom, 3857) AS g3857,
          (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key
        FROM (
          SELECT osm_type, osm_id, part_index, 'S'::text AS which, start_point AS geom
          FROM water.routing_segments
          UNION ALL
          SELECT osm_type, osm_id, part_index, 'E', end_point
          FROM water.routing_segments
        ) u
        WHERE geom IS NOT NULL
        """
    )
    cur.execute("CREATE INDEX ON e44_ep (seg_key)")
    cur.execute("CREATE INDEX ON e44_ep USING GIST (g3857)")


def cluster_stats(cur: Any, mode: str, tol_m: float | None = None) -> dict[str, Any]:
    """Endpoint cluster diagnostics. SnapToGrid on EPSG:3857 for tolerances.

    Does NOT mutate geometries in water.* ; TEMP snap is diagnostic only.
    """
    if mode == "exact":
        cur.execute(
            """
            WITH cl AS (
              SELECT
                round(ST_X(geom)::numeric, 7) AS gx,
                round(ST_Y(geom)::numeric, 7) AS gy,
                count(*)::bigint AS ep_count,
                count(DISTINCT seg_key)::int AS seg_degree
              FROM e44_ep
              GROUP BY 1, 2
            ),
            seg_touch AS (
              SELECT e.seg_key,
                     bool_or(cl.seg_degree >= 2) AS connected
              FROM e44_ep e
              JOIN cl
                ON round(ST_X(e.geom)::numeric, 7) = cl.gx
               AND round(ST_Y(e.geom)::numeric, 7) = cl.gy
              GROUP BY e.seg_key
            )
            SELECT
              (SELECT count(*) FROM cl) AS unique_endpoints,
              (SELECT count(*) FROM cl WHERE seg_degree >= 2) AS connected_clusters,
              (SELECT count(*) FROM cl WHERE seg_degree = 1) AS isolated_endpoints,
              (SELECT count(*) FROM cl WHERE seg_degree >= 3) AS junction_candidates,
              (SELECT count(*) FROM seg_touch WHERE NOT connected) AS segments_without_connection,
              (SELECT coalesce(sum(ep_count),0) FROM cl) AS endpoint_rows
            """
        )
    else:
        assert tol_m is not None
        cur.execute(
            """
            WITH cl AS (
              SELECT
                ST_X(ST_SnapToGrid(g3857, %(tol)s)) AS gx,
                ST_Y(ST_SnapToGrid(g3857, %(tol)s)) AS gy,
                count(*)::bigint AS ep_count,
                count(DISTINCT seg_key)::int AS seg_degree
              FROM e44_ep
              GROUP BY 1, 2
            ),
            seg_touch AS (
              SELECT e.seg_key,
                     bool_or(cl.seg_degree >= 2) AS connected
              FROM e44_ep e
              JOIN cl
                ON ST_X(ST_SnapToGrid(e.g3857, %(tol)s)) = cl.gx
               AND ST_Y(ST_SnapToGrid(e.g3857, %(tol)s)) = cl.gy
              GROUP BY e.seg_key
            )
            SELECT
              (SELECT count(*) FROM cl) AS unique_endpoints,
              (SELECT count(*) FROM cl WHERE seg_degree >= 2) AS connected_clusters,
              (SELECT count(*) FROM cl WHERE seg_degree = 1) AS isolated_endpoints,
              (SELECT count(*) FROM cl WHERE seg_degree >= 3) AS junction_candidates,
              (SELECT count(*) FROM seg_touch WHERE NOT connected) AS segments_without_connection,
              (SELECT coalesce(sum(ep_count),0) FROM cl) AS endpoint_rows
            """,
            {"tol": tol_m},
        )
    row = dict(cur.fetchone())
    out = {k: int(v) for k, v in row.items()}
    out["mode"] = mode
    out["tolerance_m"] = tol_m
    out["note"] = (
        "connected_clusters = endpoint locations shared by >=2 segments; "
        "isolated_endpoints = locations with degree 1; "
        "junction_candidates = degree >=3; "
        "NOT graph nodes; SnapToGrid is diagnostic only (EPSG:3857 approx)."
    )
    return out


def degree_distribution(cur: Any, mode: str, tol_m: float | None = None) -> list[dict[str, int]]:
    if mode == "exact":
        cur.execute(
            """
            SELECT seg_degree AS degree, count(*)::bigint AS clusters
            FROM (
              SELECT count(DISTINCT seg_key)::int AS seg_degree
              FROM e44_ep
              GROUP BY round(ST_X(geom)::numeric, 7), round(ST_Y(geom)::numeric, 7)
            ) t
            GROUP BY 1 ORDER BY 1
            """
        )
    else:
        cur.execute(
            """
            SELECT seg_degree AS degree, count(*)::bigint AS clusters
            FROM (
              SELECT count(DISTINCT seg_key)::int AS seg_degree
              FROM e44_ep
              GROUP BY ST_X(ST_SnapToGrid(g3857, %(tol)s)),
                       ST_Y(ST_SnapToGrid(g3857, %(tol)s))
            ) t
            GROUP BY 1 ORDER BY 1
            """,
            {"tol": tol_m},
        )
    return [{"degree": int(r["degree"]), "clusters": int(r["clusters"])} for r in cur.fetchall()]


def crossing_stats(cur: Any) -> dict[str, Any]:
    cur.execute(
        """
        CREATE TEMP TABLE e44_seg ON COMMIT DROP AS
        SELECT
          osm_type, osm_id, part_index,
          (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
          geometry
        FROM water.routing_segments
        """
    )
    cur.execute("CREATE INDEX ON e44_seg USING GIST (geometry)")
    cur.execute(
        """
        CREATE TEMP TABLE e44_x ON COMMIT DROP AS
        SELECT
          a.seg_key AS a_key,
          b.seg_key AS b_key,
          ST_Touches(a.geometry, b.geometry) AS is_touches,
          ST_Crosses(a.geometry, b.geometry) AS is_crosses,
          ST_Overlaps(a.geometry, b.geometry) AS is_overlaps
        FROM e44_seg a
        JOIN e44_seg b
          ON a.seg_key < b.seg_key
         AND a.geometry && b.geometry
         AND ST_Intersects(a.geometry, b.geometry)
        """
    )
    cur.execute(
        """
        SELECT
          count(*)::bigint AS intersecting_pairs,
          count(*) FILTER (WHERE is_crosses)::bigint AS crossings,
          count(*) FILTER (WHERE is_touches AND NOT is_crosses AND NOT is_overlaps)
            ::bigint AS touches_only,
          count(*) FILTER (WHERE is_overlaps)::bigint AS overlaps,
          count(*) FILTER (
            WHERE NOT is_crosses AND NOT is_touches AND NOT is_overlaps
          )::bigint AS other_intersect
        FROM e44_x
        """
    )
    row = {k: int(v) for k, v in dict(cur.fetchone()).items()}
    row["classification_note"] = (
        "crossing = ST_Crosses (interior intersection). "
        "A crossing is NOT an automatic junction. "
        "touches_only ≈ endpoint/boundary contact already covered by connectivity."
    )
    return row


def relation_member_segments(cur: Any, relation_id: int) -> list[dict[str, Any]]:
    """Member ways in routing_segments order by object_members.seq (ways only)."""
    cur.execute(
        """
        SELECT
          om.seq,
          om.member_osm_type,
          om.member_osm_id,
          om.member_role,
          s.part_index,
          s.length_m,
          ST_X(s.start_point) AS sx,
          ST_Y(s.start_point) AS sy,
          ST_X(s.end_point) AS ex,
          ST_Y(s.end_point) AS ey,
          s.has_endpoints,
          s.segment_kind,
          s.category
        FROM water.object_members om
        LEFT JOIN water.routing_segments s
          ON s.osm_type = om.member_osm_type
         AND s.osm_id = om.member_osm_id
        WHERE om.parent_osm_type = 'relation'
          AND om.parent_osm_id = %(rid)s
          AND om.member_osm_type = 'way'
        ORDER BY om.seq, s.part_index NULLS LAST
        """,
        {"rid": relation_id},
    )
    return [dict(r) for r in cur.fetchall()]


def chain_continuity(members: list[dict[str, Any]], threshold_m: float = 10.0) -> dict[str, Any]:
    """Seq-chain endpoint continuity (diagnostic). Does not stitch."""
    segs = [m for m in members if m.get("sx") is not None]
    gaps: list[dict[str, Any]] = []
    continuous = 0
    for i in range(len(segs) - 1):
        a, b = segs[i], segs[i + 1]
        # min distance among endpoint pairings (orientation unknown)
        d = min(
            haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
            haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
            haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
            haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
        )
        ok = d <= threshold_m
        if ok:
            continuous += 1
        else:
            gaps.append(
                {
                    "seq_a": a["seq"],
                    "seq_b": b["seq"],
                    "way_a": a["member_osm_id"],
                    "way_b": b["member_osm_id"],
                    "gap_m": round(d, 3),
                }
            )
    return {
        "member_ways_in_members_table": len({m["member_osm_id"] for m in members}),
        "segments_with_geometry": len(segs),
        "seq_links": max(0, len(segs) - 1),
        "continuous_links_le_10m": continuous,
        "gaps_gt_10m": gaps,
        "geometrically_continuous": len(gaps) == 0 and len(segs) > 0,
        "threshold_m": threshold_m,
        "note": "Continuity is diagnostic only; not a navigability claim.",
    }


def relation_endpoint_stats(cur: Any, relation_id: int) -> dict[str, Any]:
    cur.execute(
        """
        WITH segs AS (
          SELECT * FROM water.routing_segments
          WHERE osm_type = 'way' AND %(rid)s = ANY (parent_relation_ids)
        ),
        ep AS (
          SELECT
            (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
            start_point AS geom FROM segs
          UNION ALL
          SELECT
            (osm_type || ':' || osm_id::text || ':' || part_index::text),
            end_point FROM segs
        ),
        cl AS (
          SELECT
            round(ST_X(geom)::numeric, 7) AS gx,
            round(ST_Y(geom)::numeric, 7) AS gy,
            count(DISTINCT seg_key) AS seg_degree
          FROM ep
          WHERE geom IS NOT NULL
          GROUP BY 1, 2
        )
        SELECT
          (SELECT count(*) FROM segs) AS segments,
          (SELECT count(*) FROM ep WHERE geom IS NOT NULL) AS endpoint_rows,
          (SELECT count(*) FROM cl) AS unique_endpoints_exact,
          (SELECT count(*) FROM cl WHERE seg_degree >= 2) AS connected_clusters,
          (SELECT count(*) FROM cl WHERE seg_degree = 1) AS isolated_endpoints,
          (SELECT count(*) FROM cl WHERE seg_degree >= 3) AS junction_candidates
        """
        ,
        {"rid": relation_id},
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


def relation_crossings(cur: Any, relation_id: int) -> dict[str, int]:
    cur.execute(
        """
        WITH segs AS (
          SELECT
            (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
            geometry
          FROM water.routing_segments
          WHERE osm_type = 'way' AND %(rid)s = ANY (parent_relation_ids)
        )
        SELECT
          count(*)::bigint AS intersecting_pairs,
          count(*) FILTER (WHERE ST_Crosses(a.geometry, b.geometry))::bigint AS crossings,
          count(*) FILTER (
            WHERE ST_Touches(a.geometry, b.geometry)
              AND NOT ST_Crosses(a.geometry, b.geometry)
              AND NOT ST_Overlaps(a.geometry, b.geometry)
          )::bigint AS touches_only
        FROM segs a
        JOIN segs b
          ON a.seg_key < b.seg_key
         AND a.geometry && b.geometry
         AND ST_Intersects(a.geometry, b.geometry)
        """,
        {"rid": relation_id},
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


def vb_gap_fact(cur: Any) -> dict[str, Any]:
    cur.execute(
        """
        SELECT osm_id, part_index, length_m,
               ST_X(start_point) AS sx, ST_Y(start_point) AS sy,
               ST_X(end_point) AS ex, ST_Y(end_point) AS ey
        FROM water.routing_segments
        WHERE osm_type = 'way' AND osm_id = ANY(%(ids)s)
        ORDER BY osm_id, part_index
        """,
        {"ids": list(VB_GAP_WAYS)},
    )
    rows = [dict(r) for r in cur.fetchall()]
    by_id = {r["osm_id"]: r for r in rows}
    a = by_id.get(VB_GAP_WAYS[0])
    b = by_id.get(VB_GAP_WAYS[1])
    gap_m = None
    if a and b:
        gap_m = min(
            haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
            haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
            haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
            haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
        )
    return {
        "ways": VB_GAP_WAYS,
        "segments_found": len(rows),
        "min_endpoint_gap_m": round(gap_m, 3) if gap_m is not None else None,
        "min_endpoint_gap_km": round(gap_m / 1000.0, 3) if gap_m is not None else None,
        "stitched": False,
        "note": "Diagnostic gap only (E3.15 / E4.3). NOT connected in this audit.",
    }


def relation_meta(cur: Any, relation_id: int) -> dict[str, Any] | None:
    cur.execute(
        """
        SELECT osm_type, osm_id, name, water_type, tags->>'type' AS rel_type,
               geometry_type, candidate_category, relevance,
               member_count, present_member_count
        FROM water.routing_candidates
        WHERE osm_type = 'relation' AND osm_id = %(rid)s
        """,
        {"rid": relation_id},
    )
    row = cur.fetchone()
    return dict(row) if row else None


def audit_relation(cur: Any, name: str, relation_id: int) -> dict[str, Any]:
    meta = relation_meta(cur, relation_id)
    members = relation_member_segments(cur, relation_id)
    out: dict[str, Any] = {
        "name": name,
        "relation_id": relation_id,
        "meta": meta,
        "relation_as_routing_segment": False,
        "endpoint_stats_exact": relation_endpoint_stats(cur, relation_id),
        "crossings_among_members": relation_crossings(cur, relation_id),
    }
    cur.execute(
        """
        SELECT count(*) AS n FROM water.routing_segments
        WHERE osm_type = 'relation' AND osm_id = %(rid)s
        """,
        {"rid": relation_id},
    )
    out["relation_as_routing_segment"] = int(cur.fetchone()["n"]) > 0

    if name == "ladoga":
        out["centerline_interpretation"] = False
        out["note"] = (
            "Ladoga is a multipolygon / lake shell. Member way segments are rings, "
            "not a navigable centerline. Continuity chain is NOT applied as routing success."
        )
        out["seq_chain"] = {
            "skipped": True,
            "reason": "multipolygon lake — not centerline",
        }
    else:
        out["seq_chain"] = chain_continuity(members)

    if name == "volga_baltic":
        out["known_gap"] = vb_gap_fact(cur)

    if name == "belomor":
        sc = out["seq_chain"]
        out["expected_continuous_chain"] = True
        out["observed_continuous_chain"] = bool(sc.get("geometrically_continuous"))

    return out


def segment_counts(cur: Any) -> dict[str, int]:
    cur.execute(
        """
        SELECT
          count(*)::bigint AS segments,
          count(*) FILTER (WHERE is_relation_member)::bigint AS relation_member_segments
        FROM water.routing_segments
        """
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


def run(dsn: str, skip_crossings: bool = False) -> dict[str, Any]:
    report: dict[str, Any] = {
        "stage": "E4.4",
        "title": "READ-ONLY topology inference audit",
        "constraints": [
            "no graph_nodes / graph_edges",
            "no geometry mutation",
            "no proximity stitching",
            "crossing != junction",
            "endpoint proximity != proof of connection for routing API",
        ],
    }
    with psycopg2.connect(dsn) as conn:
        conn.autocommit = False
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical"] = fingerprint(cur)
            report["segments"] = segment_counts(cur)

            ensure_temp_endpoints(cur)
            cur.execute("SELECT count(*) AS n FROM e44_ep")
            report["endpoint_rows"] = int(cur.fetchone()["n"])

            connectivity: dict[str, Any] = {}
            connectivity["exact"] = cluster_stats(cur, "exact")
            connectivity["exact"]["degree_distribution"] = degree_distribution(cur, "exact")
            for tol in (1.0, 5.0, 10.0):
                key = f"tolerance_{int(tol)}m"
                connectivity[key] = cluster_stats(cur, "tolerance", tol)
                connectivity[key]["degree_distribution"] = degree_distribution(
                    cur, "tolerance", tol
                )
            report["endpoint_connectivity"] = connectivity

            if skip_crossings:
                report["crossings"] = {"skipped": True}
            else:
                report["crossings"] = crossing_stats(cur)

            relations = {}
            for key, rid in RELATION_IDS.items():
                relations[key] = audit_relation(cur, key, rid)
            report["relations"] = relations

            # Ensure read-only: roll back any TEMP (ON COMMIT DROP + rollback)
            conn.rollback()

    report["canonical_after_rollback"] = None
    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical_after_rollback"] = fingerprint(cur)

    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--json-out", type=Path, default=None)
    ap.add_argument("--skip-crossings", action="store_true")
    args = ap.parse_args()

    report = run(args.dsn or default_dsn(), skip_crossings=args.skip_crossings)

    text = json.dumps(report, indent=2, ensure_ascii=False, default=_json_default)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")

    # Exit nonzero if canonical drifted (should never happen)
    c0 = report["canonical"]
    c1 = report["canonical_after_rollback"]
    if c0 != c1:
        print("ERROR: canonical fingerprint changed", file=sys.stderr)
        return 2
    if c0.get("objects") != 455001 or c0.get("members") != 199570:
        print("WARNING: unexpected fingerprint", c0, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
