#!/usr/bin/env python3
"""
AquaRoute E3.15 — read-only water topology audit for a relation.

Members are the source of truth; relation.geometry is treated as a derived cache.
Does NOT mutate canonical tables, apply conflicts, or invent seams.

Example:
  python3 ingest/e315_topology_audit.py --relation 16738852
  python3 ingest/e315_topology_audit.py --relation 9909116 --json-out data/e315_belomor.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

CONTINUITY_THRESHOLD_M = 10.0


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


def pct(vals: list[float], p: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    i = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return s[i]


def fingerprint(cur: Any) -> dict[str, int]:
    cur.execute(
        """
        SELECT
          (SELECT count(*) FROM water.objects) AS objects,
          (SELECT count(*) FROM water.object_members) AS members,
          (SELECT count(*) FROM water.object_conflicts) AS conflicts,
          (SELECT count(*) FROM (
             SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
           ) t) AS identity_dups,
          (SELECT count(*) FROM water.object_members m
           LEFT JOIN water.objects o
             ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
           WHERE o.id IS NULL) AS orphan_parents,
          (SELECT count(*) FROM water.objects WHERE NOT ST_IsValid(geometry)) AS invalid_geom
        """
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


def load_relation_meta(cur: Any, relation_id: int) -> dict[str, Any] | None:
    cur.execute(
        """
        SELECT osm_id, name, water_type, tags->>'type' AS rel_type,
               tags->>'waterway' AS waterway,
               GeometryType(geometry) AS gtype,
               ST_SRID(geometry) AS srid,
               ST_NPoints(geometry) AS npoints,
               ST_NumGeometries(
                 CASE WHEN GeometryType(geometry) LIKE 'MULTI%%'
                      THEN geometry ELSE ST_Multi(geometry) END
               ) AS n_parts,
               round(ST_Length(geometry::geography)::numeric, 1) AS length_m,
               round(ST_XMin(geometry)::numeric, 5) AS xmin,
               round(ST_YMin(geometry)::numeric, 5) AS ymin,
               round(ST_XMax(geometry)::numeric, 5) AS xmax,
               round(ST_YMax(geometry)::numeric, 5) AS ymax,
               ST_IsValid(geometry) AS is_valid
        FROM water.objects
        WHERE osm_type='relation' AND osm_id=%s
        """,
        (relation_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def load_members(cur: Any, relation_id: int) -> list[dict[str, Any]]:
    """
    Endpoints: first/last vertex of the stored linestring-like geometry.
    For MULTILINESTRING, use first vertex of first part and last vertex of last part
    via ST_PointN on the dump-ordered extremes (no write).
    """
    cur.execute(
        """
        WITH mem AS (
          SELECT m.seq, m.member_osm_type, m.member_osm_id, m.member_role,
                 o.geometry AS geom,
                 (o.id IS NOT NULL) AS has_object,
                 (o.geometry IS NOT NULL) AS has_geometry,
                 CASE WHEN o.geometry IS NULL THEN NULL
                      ELSE GeometryType(o.geometry) END AS gtype,
                 CASE WHEN o.geometry IS NULL THEN NULL
                      ELSE ST_SRID(o.geometry) END AS srid,
                 CASE WHEN o.geometry IS NULL THEN NULL
                      ELSE ST_IsValid(o.geometry) END AS is_valid,
                 CASE WHEN o.geometry IS NULL THEN NULL
                      ELSE ST_NPoints(o.geometry) END AS npoints,
                 CASE WHEN o.geometry IS NULL THEN NULL
                      ELSE round(ST_Length(o.geometry::geography)::numeric, 3)
                 END AS length_m
          FROM water.object_members m
          LEFT JOIN water.objects o
            ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
          WHERE m.parent_osm_type='relation' AND m.parent_osm_id=%s
        ),
        ends AS (
          SELECT seq, member_osm_type, member_osm_id, member_role,
                 has_object, has_geometry, gtype, srid, is_valid, npoints, length_m,
                 geom,
                 CASE WHEN geom IS NULL THEN NULL
                      ELSE ST_PointN(geom, 1) END AS start_pt,
                 CASE WHEN geom IS NULL THEN NULL
                      ELSE ST_PointN(geom, ST_NPoints(geom)) END AS end_pt,
                 CASE WHEN geom IS NULL THEN NULL
                      ELSE round(ST_XMin(geom)::numeric, 6) END AS xmin,
                 CASE WHEN geom IS NULL THEN NULL
                      ELSE round(ST_YMin(geom)::numeric, 6) END AS ymin,
                 CASE WHEN geom IS NULL THEN NULL
                      ELSE round(ST_XMax(geom)::numeric, 6) END AS xmax,
                 CASE WHEN geom IS NULL THEN NULL
                      ELSE round(ST_YMax(geom)::numeric, 6) END AS ymax
          FROM mem
        )
        SELECT seq, member_osm_type, member_osm_id, member_role,
               has_object, has_geometry, gtype, srid, is_valid, npoints, length_m,
               xmin, ymin, xmax, ymax,
               ST_X(start_pt) AS start_lon, ST_Y(start_pt) AS start_lat,
               ST_X(end_pt) AS end_lon, ST_Y(end_pt) AS end_lat
        FROM ends
        ORDER BY seq ASC
        """,
        (relation_id,),
    )
    return [dict(r) for r in cur.fetchall()]


def member_derived_geometry_stats(cur: Any, relation_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          GeometryType(c.geom) AS collect_gtype,
          ST_NumGeometries(c.geom) AS collect_parts,
          ST_NPoints(c.geom) AS collect_npoints,
          round(ST_Length(c.geom::geography)::numeric, 1) AS collect_length_m,
          round(ST_XMin(c.geom)::numeric, 5) AS collect_xmin,
          round(ST_YMin(c.geom)::numeric, 5) AS collect_ymin,
          round(ST_XMax(c.geom)::numeric, 5) AS collect_xmax,
          round(ST_YMax(c.geom)::numeric, 5) AS collect_ymax,
          GeometryType(lm.geom) AS linemerge_gtype,
          ST_NumGeometries(
            CASE WHEN GeometryType(lm.geom) LIKE 'MULTI%%' THEN lm.geom
                 ELSE ST_Multi(lm.geom) END
          ) AS linemerge_parts,
          ST_NPoints(lm.geom) AS linemerge_npoints,
          round(ST_Length(lm.geom::geography)::numeric, 1) AS linemerge_length_m
        FROM (
          SELECT ST_Collect(o.geometry ORDER BY m.seq) AS geom
          FROM water.object_members m
          JOIN water.objects o
            ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
          WHERE m.parent_osm_id=%s
        ) c
        CROSS JOIN LATERAL (
          SELECT ST_LineMerge(c.geom) AS geom
        ) lm
        """,
        (relation_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else {}


def analyze_topology(
    members: list[dict[str, Any]], threshold_m: float = CONTINUITY_THRESHOLD_M
) -> dict[str, Any]:
    missing_obj = [m for m in members if not m["has_object"]]
    missing_geom = [m for m in members if m["has_object"] and not m["has_geometry"]]
    invalid = [
        m for m in members if m["has_geometry"] and m["is_valid"] is False
    ]

    if missing_obj or missing_geom or invalid:
        return {
            "classification": "GEOMETRY_INCOMPLETE",
            "completeness": {
                "listed": len(members),
                "present_objects": len(members) - len(missing_obj),
                "with_valid_geometry": len(members)
                - len(missing_obj)
                - len(missing_geom)
                - len(invalid),
            },
            "missing_objects": len(missing_obj),
            "missing_geometry": len(missing_geom),
            "invalid_geometry": len(invalid),
            "pairs": [],
            "gap_summary": None,
            "components": None,
            "orientation": None,
        }

    usable = members  # all complete
    pairs: list[dict[str, Any]] = []
    keep = 0
    need_rev = 0

    # Greedy chain tip for orientation summary
    tip = (float(usable[0]["end_lon"]), float(usable[0]["end_lat"]))
    for i in range(len(usable) - 1):
        a, b = usable[i], usable[i + 1]
        a_s = (float(a["start_lon"]), float(a["start_lat"]))
        a_e = (float(a["end_lon"]), float(a["end_lat"]))
        b_s = (float(b["start_lon"]), float(b["start_lat"]))
        b_e = (float(b["end_lon"]), float(b["end_lat"]))

        d_end_start = haversine_m(a_e[0], a_e[1], b_s[0], b_s[1])
        d_end_end = haversine_m(a_e[0], a_e[1], b_e[0], b_e[1])
        # also consider if A itself were conceptually already reversed relative to tip:
        # for pair metrics we evaluate orientations of B relative to A's stored end,
        # and separately best of four for continuity components.
        best_four = [
            ("end_start_keep_B", d_end_start, False),
            ("end_end_reverse_B", d_end_end, True),
            (
                "start_start_reverse_A_keep_B",
                haversine_m(a_s[0], a_s[1], b_s[0], b_s[1]),
                False,
            ),
            (
                "start_end_reverse_A_reverse_B",
                haversine_m(a_s[0], a_s[1], b_e[0], b_e[1]),
                True,
            ),
        ]
        best_label, best_m, _ = min(best_four, key=lambda x: x[1])

        # Chosen orientation for sequential chain relative to A's stored direction:
        if d_end_start <= d_end_end:
            chosen = "end(A)->start(B) keep_B"
            gap_chosen = d_end_start
            b_reversed = False
            keep += 1
        else:
            chosen = "end(A)->end(B) reverse_B"
            gap_chosen = d_end_end
            b_reversed = True
            need_rev += 1

        # Greedy tip update (independent summary)
        d_tip_s = haversine_m(tip[0], tip[1], b_s[0], b_s[1])
        d_tip_e = haversine_m(tip[0], tip[1], b_e[0], b_e[1])
        if d_tip_s <= d_tip_e:
            tip = b_e
            greedy_action = "keep"
            greedy_gap = d_tip_s
        else:
            tip = b_s
            greedy_action = "reverse"
            greedy_gap = d_tip_e

        pairs.append(
            {
                "seq_a": int(a["seq"]),
                "seq_b": int(b["seq"]),
                "way_a": int(a["member_osm_id"]),
                "way_b": int(b["member_osm_id"]),
                "chosen_orientation": chosen,
                "b_logically_reversed": b_reversed,
                "gap_m": round(gap_chosen, 3),
                "best_endpoint_pair": best_label,
                "best_gap_m": round(best_m, 3),
                "greedy_chain_action_on_B": greedy_action,
                "greedy_gap_m": round(greedy_gap, 3),
                "a_end": [a_e[0], a_e[1]],
                "b_start": [b_s[0], b_s[1]],
                "b_end": [b_e[0], b_e[1]],
                "a_bbox": [float(a["xmin"]), float(a["ymin"]), float(a["xmax"]), float(a["ymax"])],
                "b_bbox": [float(b["xmin"]), float(b["ymin"]), float(b["xmax"]), float(b["ymax"])],
            }
        )

    gaps = [p["best_gap_m"] for p in pairs]
    chosen_gaps = [p["gap_m"] for p in pairs]

    def bucket(vals: list[float]) -> dict[str, int]:
        return {
            "le_10m": sum(1 for v in vals if v <= 10),
            "gt_10_le_100m": sum(1 for v in vals if 10 < v <= 100),
            "gt_100m_le_1km": sum(1 for v in vals if 100 < v <= 1000),
            "gt_1km": sum(1 for v in vals if v > 1000),
        }

    gap_summary = {
        "pairs": len(pairs),
        "using_best_endpoint_pair": {
            "median_m": statistics.median(gaps) if gaps else None,
            "p95_m": pct(gaps, 95),
            "max_m": max(gaps) if gaps else None,
            "buckets": bucket(gaps),
        },
        "using_A_stored_end_to_B_chosen": {
            "median_m": statistics.median(chosen_gaps) if chosen_gaps else None,
            "p95_m": pct(chosen_gaps, 95),
            "max_m": max(chosen_gaps) if chosen_gaps else None,
            "buckets": bucket(chosen_gaps),
        },
        "threshold_m_for_components": threshold_m,
        "note": (
            "best_endpoint_pair allows either end of A to either end of B "
            "(logical reverse). Continuity components use best_gap_m."
        ),
    }

    critical = [
        {
            "seq_a": p["seq_a"],
            "seq_b": p["seq_b"],
            "way_a": p["way_a"],
            "way_b": p["way_b"],
            "gap_m": p["best_gap_m"],
            "chosen_orientation": p["chosen_orientation"],
            "best_endpoint_pair": p["best_endpoint_pair"],
            "endpoints": {
                "a_end": p["a_end"],
                "b_start": p["b_start"],
                "b_end": p["b_end"],
            },
            "bbox_a": p["a_bbox"],
            "bbox_b": p["b_bbox"],
        }
        for p in pairs
        if p["best_gap_m"] > 1000
    ]

    # Connected components on best_gap_m <= threshold
    components: list[dict[str, Any]] = []
    if usable:
        start_i = 0
        for i, p in enumerate(pairs):
            if p["best_gap_m"] > threshold_m:
                chunk = usable[start_i : i + 1]
                components.append(_component_info(chunk, len(components)))
                start_i = i + 1
        components.append(_component_info(usable[start_i:], len(components)))

    classification = (
        "GEOMETRICALLY_CONTINUOUS"
        if all(p["best_gap_m"] <= threshold_m for p in pairs)
        else "GEOMETRICALLY_FRAGMENTED"
    )

    return {
        "classification": classification,
        "classification_rules": {
            "GEOMETRY_INCOMPLETE": "missing member object or missing/invalid geometry",
            "GEOMETRICALLY_CONTINUOUS": f"all members valid and all best neighbor gaps <= {threshold_m} m",
            "GEOMETRICALLY_FRAGMENTED": f"members complete but some best neighbor gap > {threshold_m} m",
            "not_implied": [
                "navigability",
                "locks/portage absence",
                "legal passage",
                "vessel suitability",
            ],
        },
        "completeness": {
            "listed": len(members),
            "present_objects": len(members),
            "with_valid_geometry": len(members),
            "missing_objects": 0,
            "missing_geometry": 0,
            "invalid_geometry": 0,
        },
        "orientation": {
            "pairs_keep_B": keep,
            "pairs_reverse_B": need_rev,
            "note": "logical audit only; no geometry UPDATE",
        },
        "gap_summary": gap_summary,
        "critical_gaps_gt_1km": critical,
        "components": {
            "count": len(components),
            "threshold_m": threshold_m,
            "items": components,
        },
        "pairs": pairs,
    }


def _component_info(chunk: list[dict[str, Any]], idx: int) -> dict[str, Any]:
    length = sum(float(m["length_m"] or 0) for m in chunk)
    return {
        "component_id": idx,
        "member_count": len(chunk),
        "seq_start": int(chunk[0]["seq"]),
        "seq_end": int(chunk[-1]["seq"]),
        "length_m": round(length, 1),
        "way_ids_sample": [int(m["member_osm_id"]) for m in chunk[:5]],
    }


def audit_relation(
    dsn: str,
    relation_id: int,
    threshold_m: float = CONTINUITY_THRESHOLD_M,
    include_pairs: bool = False,
) -> dict[str, Any]:
    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            fp = fingerprint(cur)
            meta = load_relation_meta(cur, relation_id)
            if meta is None:
                return {
                    "error": f"relation {relation_id} not found in water.objects",
                    "fingerprint": fp,
                }
            members = load_members(cur, relation_id)
            topo = analyze_topology(members, threshold_m=threshold_m)
            derived = None
            if topo["classification"] != "GEOMETRY_INCOMPLETE":
                derived = member_derived_geometry_stats(cur, relation_id)

            # Special highlight for known VB gap
            highlight = None
            for p in topo.get("pairs") or []:
                if p["seq_a"] == 53 and p["seq_b"] == 54:
                    highlight = {
                        "seq": "53→54",
                        "gap_m_best": p["best_gap_m"],
                        "gap_m_chosen": p["gap_m"],
                        "ways": [p["way_a"], p["way_b"]],
                        "chosen_orientation": p["chosen_orientation"],
                    }
                    break

            out = {
                "relation_id": relation_id,
                "relation": {
                    "name": meta.get("name"),
                    "water_type": meta.get("water_type"),
                    "rel_type": meta.get("rel_type"),
                    "waterway": meta.get("waterway"),
                },
                "fingerprint": fp,
                "source_of_truth": "water.object_members + water.objects member geometries",
                "relation_geometry_role": "derived/cached; not used for ordering or continuity",
                "canonical_relation_geometry": {
                    "gtype": meta.get("gtype"),
                    "srid": meta.get("srid"),
                    "n_parts": meta.get("n_parts"),
                    "npoints": meta.get("npoints"),
                    "length_m": float(meta["length_m"]) if meta.get("length_m") is not None else None,
                    "bbox": [
                        float(meta["xmin"]),
                        float(meta["ymin"]),
                        float(meta["xmax"]),
                        float(meta["ymax"]),
                    ]
                    if meta.get("xmin") is not None
                    else None,
                    "is_valid": meta.get("is_valid"),
                },
                "member_derived_geometry_diagnostic": derived,
                "topology": {
                    k: v
                    for k, v in topo.items()
                    if include_pairs or k != "pairs"
                },
                "highlight_seq_53_54": highlight,
            }
            if include_pairs:
                out["topology"]["pairs"] = topo.get("pairs")
            return out


def main() -> int:
    ap = argparse.ArgumentParser(description="E3.15 read-only relation topology audit")
    ap.add_argument("--relation", type=int, required=True)
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--threshold-m", type=float, default=CONTINUITY_THRESHOLD_M)
    ap.add_argument("--json-out", default=None)
    ap.add_argument(
        "--include-pairs",
        action="store_true",
        help="Include all neighbor pairs in output (can be large)",
    )
    args = ap.parse_args()

    report = audit_relation(
        args.dsn or default_dsn(),
        args.relation,
        threshold_m=args.threshold_m,
        include_pairs=args.include_pairs,
    )
    text = json.dumps(report, ensure_ascii=False, indent=2, default=_json_default)
    print(text)
    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n")
        print(f"wrote {out}", file=sys.stderr)
    return 0 if "error" not in report else 1


if __name__ == "__main__":
    sys.exit(main())
