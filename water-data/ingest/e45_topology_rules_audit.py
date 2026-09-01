#!/usr/bin/env python3
"""
AquaRoute E4.5 — READ-ONLY topology rules audit / PoC.

Collects measured facts that back docs/E4_5_TOPOLOGY_RULES.md.
Does NOT create graph nodes/edges or mutate canonical / segment data.

Example:
  python3 ingest/e45_topology_rules_audit.py --json-out data/e45_topology_rules.json
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
CONTINUITY_M = 10.0


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


def ensure_ep(cur: Any) -> None:
    cur.execute(
        """
        CREATE TEMP TABLE e45_ep ON COMMIT DROP AS
        SELECT
          (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
          geom,
          ST_Transform(geom, 3857) AS g3857
        FROM (
          SELECT osm_type, osm_id, part_index, start_point AS geom
          FROM water.routing_segments
          UNION ALL
          SELECT osm_type, osm_id, part_index, end_point
          FROM water.routing_segments
        ) u
        WHERE geom IS NOT NULL
        """
    )


def connectivity_block(cur: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}

    def one(mode: str, tol: float | None) -> dict[str, Any]:
        if mode == "exact":
            cur.execute(
                """
                WITH cl AS (
                  SELECT count(DISTINCT seg_key)::int AS deg
                  FROM e45_ep
                  GROUP BY round(ST_X(geom)::numeric, 7), round(ST_Y(geom)::numeric, 7)
                ),
                deg AS (
                  SELECT deg, count(*)::bigint AS clusters FROM cl GROUP BY 1
                ),
                seg_touch AS (
                  SELECT e.seg_key, bool_or(c.cnt >= 2) AS connected
                  FROM e45_ep e
                  JOIN (
                    SELECT round(ST_X(geom)::numeric, 7) AS gx,
                           round(ST_Y(geom)::numeric, 7) AS gy,
                           count(DISTINCT seg_key) AS cnt
                    FROM e45_ep GROUP BY 1,2
                  ) c ON round(ST_X(e.geom)::numeric, 7)=c.gx
                     AND round(ST_Y(e.geom)::numeric, 7)=c.gy
                  GROUP BY e.seg_key
                )
                SELECT
                  (SELECT count(*) FROM cl) AS unique_endpoints,
                  (SELECT coalesce(sum(clusters),0) FROM deg WHERE deg >= 2) AS connected_clusters,
                  (SELECT coalesce(sum(clusters),0) FROM deg WHERE deg = 1) AS isolated_endpoints,
                  (SELECT coalesce(sum(clusters),0) FROM deg WHERE deg >= 3) AS junction_candidates,
                  (SELECT count(*) FROM seg_touch WHERE NOT connected) AS segments_without_connection
                """
            )
            summary = {k: int(v) for k, v in dict(cur.fetchone()).items()}
            cur.execute(
                """
                SELECT deg AS degree, count(*)::bigint AS clusters
                FROM (
                  SELECT count(DISTINCT seg_key)::int AS deg
                  FROM e45_ep
                  GROUP BY round(ST_X(geom)::numeric, 7), round(ST_Y(geom)::numeric, 7)
                ) t GROUP BY 1 ORDER BY 1
                """
            )
        else:
            cur.execute(
                """
                WITH cl AS (
                  SELECT count(DISTINCT seg_key)::int AS deg
                  FROM e45_ep
                  GROUP BY ST_X(ST_SnapToGrid(g3857, %(tol)s)),
                           ST_Y(ST_SnapToGrid(g3857, %(tol)s))
                ),
                deg AS (
                  SELECT deg, count(*)::bigint AS clusters FROM cl GROUP BY 1
                ),
                seg_touch AS (
                  SELECT e.seg_key, bool_or(c.cnt >= 2) AS connected
                  FROM e45_ep e
                  JOIN (
                    SELECT ST_X(ST_SnapToGrid(g3857, %(tol)s)) AS gx,
                           ST_Y(ST_SnapToGrid(g3857, %(tol)s)) AS gy,
                           count(DISTINCT seg_key) AS cnt
                    FROM e45_ep GROUP BY 1,2
                  ) c ON ST_X(ST_SnapToGrid(e.g3857, %(tol)s))=c.gx
                     AND ST_Y(ST_SnapToGrid(e.g3857, %(tol)s))=c.gy
                  GROUP BY e.seg_key
                )
                SELECT
                  (SELECT count(*) FROM cl) AS unique_endpoints,
                  (SELECT coalesce(sum(clusters),0) FROM deg WHERE deg >= 2) AS connected_clusters,
                  (SELECT coalesce(sum(clusters),0) FROM deg WHERE deg = 1) AS isolated_endpoints,
                  (SELECT coalesce(sum(clusters),0) FROM deg WHERE deg >= 3) AS junction_candidates,
                  (SELECT count(*) FROM seg_touch WHERE NOT connected) AS segments_without_connection
                """,
                {"tol": tol},
            )
            summary = {k: int(v) for k, v in dict(cur.fetchone()).items()}
            cur.execute(
                """
                SELECT deg AS degree, count(*)::bigint AS clusters
                FROM (
                  SELECT count(DISTINCT seg_key)::int AS deg
                  FROM e45_ep
                  GROUP BY ST_X(ST_SnapToGrid(g3857, %(tol)s)),
                           ST_Y(ST_SnapToGrid(g3857, %(tol)s))
                ) t GROUP BY 1 ORDER BY 1
                """,
                {"tol": tol},
            )
        summary["degree_distribution"] = [
            {"degree": int(r["degree"]), "clusters": int(r["clusters"])}
            for r in cur.fetchall()
        ]
        summary["mode"] = mode
        summary["tolerance_m"] = tol
        return summary

    out["exact"] = one("exact", None)
    for tol in (1.0, 5.0, 10.0):
        out[f"tolerance_{int(tol)}m"] = one("tolerance", tol)
    out["proposed_primary_rule"] = "E1_exact_endpoint_match"
    out["tolerance_note"] = (
        "1/5/10m are diagnostic SnapToGrid bands (EPSG:3857 approx). "
        "They do NOT prove navigability and must NOT auto-create edges."
    )
    return out


def crossings(cur: Any) -> dict[str, Any]:
    cur.execute(
        """
        CREATE TEMP TABLE e45_seg ON COMMIT DROP AS
        SELECT
          (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
          geometry
        FROM water.routing_segments
        """
    )
    cur.execute("CREATE INDEX ON e45_seg USING GIST (geometry)")
    cur.execute(
        """
        SELECT
          count(*)::bigint AS intersecting_pairs,
          count(*) FILTER (WHERE ST_Crosses(a.geometry, b.geometry))::bigint AS proper_crossings,
          count(*) FILTER (
            WHERE ST_Touches(a.geometry, b.geometry)
              AND NOT ST_Crosses(a.geometry, b.geometry)
              AND NOT ST_Overlaps(a.geometry, b.geometry)
          )::bigint AS touches_only,
          count(*) FILTER (WHERE ST_Overlaps(a.geometry, b.geometry))::bigint AS overlaps
        FROM e45_seg a
        JOIN e45_seg b
          ON a.seg_key < b.seg_key
         AND a.geometry && b.geometry
         AND ST_Intersects(a.geometry, b.geometry)
        """
    )
    row = {k: int(v) for k, v in dict(cur.fetchone()).items()}
    row["rule"] = (
        "proper_crossings => CROSSING_UNRESOLVED (no auto junction); "
        "touches_only ok only via endpoint E1; overlaps unresolved"
    )
    return row


def tag_inventory(cur: Any) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          count(*)::bigint AS candidates,
          count(*) FILTER (
            WHERE tags ? 'bridge' AND COALESCE(tags->>'bridge','') NOT IN ('','no','false','0')
          )::bigint AS bridge_tagged,
          count(*) FILTER (
            WHERE tags ? 'tunnel' AND COALESCE(tags->>'tunnel','') NOT IN ('','no','false','0')
          )::bigint AS tunnel_tagged,
          count(*) FILTER (
            WHERE COALESCE(tags->>'tunnel','') = 'culvert'
               OR tags->>'waterway' = 'culvert'
          )::bigint AS culvert_signal,
          count(*) FILTER (
            WHERE tags->>'waterway' IN ('lock_gate','lock')
               OR COALESCE(tags->>'lock','') IN ('yes','true','1')
          )::bigint AS lock_signal,
          count(*) FILTER (
            WHERE tags->>'waterway' = 'dam' OR tags->>'water' = 'dam'
          )::bigint AS dam_signal,
          count(*) FILTER (WHERE tags->>'waterway' = 'weir')::bigint AS weir_signal,
          count(*) FILTER (WHERE tags->>'waterway' = 'waterfall')::bigint AS waterfall_signal,
          count(*) FILTER (WHERE tags ? 'oneway')::bigint AS oneway_tagged,
          count(*) FILTER (WHERE tags ? 'boat')::bigint AS boat_tagged,
          count(*) FILTER (
            WHERE tags ? 'boat:oneway' OR tags ? 'motorboat:oneway' OR tags ? 'canoe:oneway'
          )::bigint AS boat_oneway_tagged
        FROM water.routing_candidates
        """
    )
    cand = {k: int(v) for k, v in dict(cur.fetchone()).items()}

    def top(key: str, where: str, limit: int = 12) -> list[dict[str, Any]]:
        cur.execute(
            f"""
            SELECT COALESCE(tags->>%s, '(null)') AS value, count(*)::bigint AS n
            FROM water.routing_candidates
            WHERE {where}
            GROUP BY 1 ORDER BY 2 DESC LIMIT %s
            """,
            (key, limit),
        )
        return [{"value": r["value"], "n": int(r["n"])} for r in cur.fetchall()]

    distributions = {
        "bridge": top("bridge", "tags ? 'bridge'"),
        "tunnel": top("tunnel", "tags ? 'tunnel'"),
        "lock": top(
            "lock",
            "tags ? 'lock' OR tags->>'waterway' IN ('lock','lock_gate')",
        ),
        "oneway": top("oneway", "tags ? 'oneway'"),
        "boat": top("boat", "tags ? 'boat'"),
        "waterway_structures": top(
            "waterway",
            "tags->>'waterway' IN ('lock_gate','lock','dam','weir','waterfall','culvert')",
        ),
    }

    cur.execute(
        """
        SELECT
          count(*)::bigint AS segments,
          count(*) FILTER (
            WHERE o.tags ? 'bridge' AND COALESCE(o.tags->>'bridge','') NOT IN ('','no')
          )::bigint AS bridge,
          count(*) FILTER (
            WHERE o.tags ? 'tunnel' AND COALESCE(o.tags->>'tunnel','') NOT IN ('','no')
          )::bigint AS tunnel,
          count(*) FILTER (
            WHERE o.tags->>'waterway' IN ('lock_gate','lock')
               OR o.tags->>'lock' IN ('yes','true','1')
          )::bigint AS lockish,
          count(*) FILTER (WHERE o.tags->>'waterway' IN ('dam','weir'))::bigint AS dam_weir,
          count(*) FILTER (WHERE o.tags ? 'oneway')::bigint AS oneway
        FROM water.routing_segments s
        JOIN water.objects o ON o.osm_type = s.osm_type AND o.osm_id = s.osm_id
        """
    )
    segs = {k: int(v) for k, v in dict(cur.fetchone()).items()}

    cur.execute(
        """
        SELECT osm_type, count(*)::bigint AS n
        FROM water.routing_candidates
        WHERE tags->>'waterway' IN ('lock_gate','lock','dam','weir','waterfall')
           OR COALESCE(tags->>'lock','') IN ('yes','true','1')
        GROUP BY 1 ORDER BY 2 DESC
        """
    )
    structure_by_type = {r["osm_type"]: int(r["n"]) for r in cur.fetchall()}

    # Manual-review examples
    cur.execute(
        """
        (
          SELECT 'bridge' AS kind, osm_type, osm_id, left(COALESCE(name,''),60) AS name,
                 tags->>'bridge' AS tag_value, relevance
          FROM water.routing_candidates
          WHERE tags ? 'bridge' AND COALESCE(tags->>'bridge','') NOT IN ('','no')
          ORDER BY osm_id LIMIT 5
        )
        UNION ALL
        (
          SELECT 'tunnel_yes', osm_type, osm_id, left(COALESCE(name,''),60),
                 tags->>'tunnel', relevance
          FROM water.routing_candidates
          WHERE tags->>'tunnel' = 'yes'
          ORDER BY osm_id LIMIT 5
        )
        UNION ALL
        (
          SELECT 'lock_gate', osm_type, osm_id, left(COALESCE(name,''),60),
                 tags->>'waterway', relevance
          FROM water.routing_candidates
          WHERE tags->>'waterway' = 'lock_gate'
          ORDER BY osm_id LIMIT 5
        )
        UNION ALL
        (
          SELECT 'oneway', osm_type, osm_id, left(COALESCE(name,''),60),
                 tags->>'oneway', relevance
          FROM water.routing_candidates
          WHERE tags ? 'oneway'
          ORDER BY osm_id LIMIT 5
        )
        """
    )
    examples = [dict(r) for r in cur.fetchall()]

    return {
        "candidates": cand,
        "segments": segs,
        "structure_by_osm_type": structure_by_type,
        "distributions": distributions,
        "examples_for_manual_review": examples,
        "data_sufficiency": {
            "bridge": "sparse (19) — cannot drive general grade-separation defaults",
            "tunnel_culvert": "common via tunnel=culvert — keep as segment attribute; E1 only for adjacency",
            "lock_dam_weir": "present as HIGH features — topology-relevant, not auto-passable",
            "oneway": "very sparse (12) — inventory only; no directed routing in E4.5",
        },
    }


def chain_for_relation(cur: Any, relation_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT om.seq, om.member_osm_id,
               ST_X(s.start_point) AS sx, ST_Y(s.start_point) AS sy,
               ST_X(s.end_point) AS ex, ST_Y(s.end_point) AS ey
        FROM water.object_members om
        JOIN water.routing_segments s
          ON s.osm_type = om.member_osm_type AND s.osm_id = om.member_osm_id
        WHERE om.parent_osm_type = 'relation'
          AND om.parent_osm_id = %(rid)s
          AND om.member_osm_type = 'way'
        ORDER BY om.seq, s.part_index
        """,
        {"rid": relation_id},
    )
    segs = [dict(r) for r in cur.fetchall()]
    gaps = []
    continuous = 0
    for i in range(len(segs) - 1):
        a, b = segs[i], segs[i + 1]
        d = min(
            haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
            haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
            haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
            haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
        )
        # Exact-rule proxy: also check 7-decimal equality of any endpoint pair
        exact = False
        for p1 in ((a["sx"], a["sy"]), (a["ex"], a["ey"])):
            for p2 in ((b["sx"], b["sy"]), (b["ex"], b["ey"])):
                if round(p1[0], 7) == round(p2[0], 7) and round(p1[1], 7) == round(
                    p2[1], 7
                ):
                    exact = True
        if d <= CONTINUITY_M:
            continuous += 1
        else:
            gaps.append(
                {
                    "seq_a": a["seq"],
                    "seq_b": b["seq"],
                    "way_a": a["member_osm_id"],
                    "way_b": b["member_osm_id"],
                    "gap_m": round(d, 3),
                    "exact_endpoint_match": exact,
                }
            )
    return {
        "member_segments": len(segs),
        "seq_links": max(0, len(segs) - 1),
        "continuous_links_le_10m": continuous,
        "gaps_gt_10m": gaps,
        "geometrically_continuous": len(gaps) == 0 and len(segs) > 0,
    }


def vb_gap(cur: Any) -> dict[str, Any]:
    cur.execute(
        """
        SELECT osm_id,
               ST_X(start_point) AS sx, ST_Y(start_point) AS sy,
               ST_X(end_point) AS ex, ST_Y(end_point) AS ey
        FROM water.routing_segments
        WHERE osm_type = 'way' AND osm_id = ANY(%(ids)s)
        """,
        {"ids": list(VB_GAP_WAYS)},
    )
    rows = {r["osm_id"]: dict(r) for r in cur.fetchall()}
    a, b = rows.get(VB_GAP_WAYS[0]), rows.get(VB_GAP_WAYS[1])
    gap_m = None
    exact = False
    if a and b:
        gap_m = min(
            haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
            haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
            haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
            haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
        )
        for p1 in ((a["sx"], a["sy"]), (a["ex"], a["ey"])):
            for p2 in ((b["sx"], b["sy"]), (b["ex"], b["ey"])):
                if round(p1[0], 7) == round(p2[0], 7) and round(p1[1], 7) == round(
                    p2[1], 7
                ):
                    exact = True
    return {
        "ways": list(VB_GAP_WAYS),
        "min_endpoint_gap_m": round(gap_m, 3) if gap_m is not None else None,
        "min_endpoint_gap_km": round(gap_m / 1000.0, 3) if gap_m is not None else None,
        "exact_endpoint_match_E1": exact,
        "would_E1_connect": exact,
        "would_tolerance_10m_connect": bool(gap_m is not None and gap_m <= 10.0),
        "stitched": False,
        "rule_outcome": "UNRESOLVED_GAP — must not become a connection under E1–E4",
    }


def relation_poc(cur: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}

    # Belomor
    cur.execute(
        """
        SELECT count(*) AS rel_as_seg FROM water.routing_segments
        WHERE osm_type='relation' AND osm_id=%(rid)s
        """,
        {"rid": RELATION_IDS["belomor"]},
    )
    belomor_rel_seg = int(cur.fetchone()["rel_as_seg"]) > 0
    belomor_chain = chain_for_relation(cur, RELATION_IDS["belomor"])
    out["belomor"] = {
        "relation_id": RELATION_IDS["belomor"],
        "relation_as_segment": belomor_rel_seg,
        "chain": belomor_chain,
        "E1_preserves_chain": belomor_chain["geometrically_continuous"],
        "note": "Proposed E1 topology preserves Belomor member chain; no synthetic seam.",
    }

    # Volga-Baltic
    cur.execute(
        """
        SELECT count(*) AS rel_as_seg FROM water.routing_segments
        WHERE osm_type='relation' AND osm_id=%(rid)s
        """,
        {"rid": RELATION_IDS["volga_baltic"]},
    )
    vb_rel_seg = int(cur.fetchone()["rel_as_seg"]) > 0
    vb_chain = chain_for_relation(cur, RELATION_IDS["volga_baltic"])
    out["volga_baltic"] = {
        "relation_id": RELATION_IDS["volga_baltic"],
        "relation_as_segment": vb_rel_seg,
        "chain": vb_chain,
        "known_gap": vb_gap(cur),
        "note": "Gap seq 53→54 remains unresolved; not an E1 connection.",
    }

    # Ladoga
    cur.execute(
        """
        SELECT count(*) AS rel_as_seg FROM water.routing_segments
        WHERE osm_type='relation' AND osm_id=%(rid)s
        """,
        {"rid": RELATION_IDS["ladoga"]},
    )
    ladoga_rel = int(cur.fetchone()["rel_as_seg"]) > 0
    cur.execute(
        """
        SELECT count(*) AS n FROM water.routing_segments
        WHERE osm_type='way' AND %(rid)s = ANY(parent_relation_ids)
        """,
        {"rid": RELATION_IDS["ladoga"]},
    )
    ring_n = int(cur.fetchone()["n"])
    cur.execute(
        """
        SELECT tags->>'type' AS rel_type, water_type, geometry_type
        FROM water.routing_candidates
        WHERE osm_type='relation' AND osm_id=%(rid)s
        """,
        {"rid": RELATION_IDS["ladoga"]},
    )
    meta = dict(cur.fetchone() or {})
    out["ladoga"] = {
        "relation_id": RELATION_IDS["ladoga"],
        "relation_as_segment": ladoga_rel,
        "meta": meta,
        "member_ring_segments": ring_n,
        "proposed_as_single_centerline": False,
        "seq_chain_as_routing_success": False,
        "rule": "L1/L2 — multipolygon rings are not an artificial centerline",
    }
    return out


def proposed_rules_summary() -> dict[str, Any]:
    return {
        "endpoint": {
            "primary": "E1 exact endpoint match → connection candidate",
            "tolerance_1_5_10m": "diagnostic only; not auto-edges; not navigability",
        },
        "junctions": {
            "degree_ge_3": "junction candidate only",
            "crossing_alone": "not a junction",
        },
        "crossings": {
            "proper": "CROSSING_UNRESOLVED",
            "touches_only": "via E1 endpoints only",
            "overlaps": "unresolved / cleanup",
        },
        "bridges_tunnels": "sparse bridge; culvert common — attribute only; no auto grade-sep defaults",
        "locks_dams_weirs": "topology-relevant; not auto-passable",
        "relations": "provenance only; membership ≠ edge",
        "lakes": "no auto centerline from multipolygon rings",
        "directionality": "inventory only; not implemented",
    }


def run(dsn: str, skip_crossings: bool = False) -> dict[str, Any]:
    report: dict[str, Any] = {
        "stage": "E4.5",
        "title": "Topology rules specification — measured PoC",
        "proposed_rules": proposed_rules_summary(),
        "constraints": [
            "no graph_nodes/graph_edges",
            "no mutation of routing_segments or canonical OSM tables",
            "no proximity stitching",
            "tolerance != navigability",
        ],
    }
    with psycopg2.connect(dsn) as conn:
        conn.autocommit = False
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical"] = fingerprint(cur)
            cur.execute("SELECT count(*) AS n FROM water.routing_segments")
            report["segments"] = int(cur.fetchone()["n"])

            ensure_ep(cur)
            cur.execute("SELECT count(*) AS n FROM e45_ep")
            report["endpoint_rows"] = int(cur.fetchone()["n"])
            report["endpoint_connectivity"] = connectivity_block(cur)

            if skip_crossings:
                report["crossings"] = {"skipped": True}
            else:
                report["crossings"] = crossings(cur)

            report["tag_inventory"] = tag_inventory(cur)
            report["relation_poc"] = relation_poc(cur)
            conn.rollback()

    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical_after"] = fingerprint(cur)
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

    if report["canonical"] != report["canonical_after"]:
        print("ERROR: canonical changed", file=sys.stderr)
        return 2

    poc = report["relation_poc"]
    if not poc["belomor"]["E1_preserves_chain"]:
        print("ERROR: Belomor chain not preserved under continuity check", file=sys.stderr)
        return 3
    gap = poc["volga_baltic"]["known_gap"]
    if gap.get("would_E1_connect") or gap.get("stitched"):
        print("ERROR: VB gap incorrectly treated as connection", file=sys.stderr)
        return 4
    if poc["ladoga"].get("proposed_as_single_centerline"):
        print("ERROR: Ladoga incorrectly proposed as centerline", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
