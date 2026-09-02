#!/usr/bin/env python3
"""
AquaRoute E3.14 — read-only geometry reconstruction audit for relation 16738852.

Does NOT mutate water.objects / object_members / conflicts.
LineMerge / ST_Collect run only as diagnostic SELECT experiments.
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

REL = 16738852
CONTROLS = (9909116, 21149039, 16738852)


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
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def audit(dsn: str) -> dict[str, Any]:
    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM water.objects) AS objects,
                  (SELECT count(*) FROM water.object_members) AS members,
                  (SELECT count(*) FROM (
                     SELECT osm_type, osm_id FROM water.objects
                     GROUP BY 1,2 HAVING count(*)>1
                   ) t) AS identity_dups,
                  (SELECT count(*) FROM water.object_members m
                   LEFT JOIN water.objects o
                     ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
                   WHERE o.id IS NULL) AS orphan_parents,
                  (SELECT count(*) FROM water.objects
                   WHERE NOT ST_IsValid(geometry)) AS invalid_geom
                """
            )
            fingerprint = {k: int(v) for k, v in dict(cur.fetchone()).items()}

            # --- A/B members ---
            cur.execute(
                """
                SELECT
                  m.seq,
                  m.member_osm_type,
                  m.member_osm_id,
                  m.member_role,
                  (o.id IS NOT NULL) AS has_object,
                  (o.geometry IS NOT NULL) AS has_geometry,
                  GeometryType(o.geometry) AS gtype,
                  ST_SRID(o.geometry) AS srid,
                  ST_IsValid(o.geometry) AS is_valid,
                  ST_NPoints(o.geometry) AS npoints,
                  round(ST_Length(o.geometry::geography)::numeric, 3) AS length_m,
                  ST_X(ST_StartPoint(ST_GeometryN(
                    CASE WHEN GeometryType(o.geometry)='LINESTRING' THEN o.geometry
                         ELSE ST_GeometryN(o.geometry, 1) END, 1))) AS start_lon,
                  ST_Y(ST_StartPoint(ST_GeometryN(
                    CASE WHEN GeometryType(o.geometry)='LINESTRING' THEN o.geometry
                         ELSE ST_GeometryN(o.geometry, 1) END, 1))) AS start_lat,
                  ST_X(ST_EndPoint(ST_GeometryN(
                    CASE WHEN GeometryType(o.geometry)='LINESTRING' THEN o.geometry
                         ELSE ST_GeometryN(o.geometry, 1) END, 1))) AS end_lon,
                  ST_Y(ST_EndPoint(ST_GeometryN(
                    CASE WHEN GeometryType(o.geometry)='LINESTRING' THEN o.geometry
                         ELSE ST_GeometryN(o.geometry, 1) END, 1))) AS end_lat,
                  round(ST_XMin(o.geometry)::numeric, 6) AS xmin,
                  round(ST_YMin(o.geometry)::numeric, 6) AS ymin,
                  round(ST_XMax(o.geometry)::numeric, 6) AS xmax,
                  round(ST_YMax(o.geometry)::numeric, 6) AS ymax
                FROM water.object_members m
                LEFT JOIN water.objects o
                  ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
                WHERE m.parent_osm_type = 'relation' AND m.parent_osm_id = %s
                ORDER BY m.seq
                """,
                (REL,),
            )
            members = [dict(r) for r in cur.fetchall()]

            missing_objects = [m for m in members if not m["has_object"]]
            missing_geometry = [
                m for m in members if m["has_object"] and not m["has_geometry"]
            ]
            invalid = [m for m in members if m["has_object"] and m["is_valid"] is False]
            unexpected_type = [
                m
                for m in members
                if m["has_geometry"] and m["gtype"] not in ("LINESTRING", "MULTILINESTRING")
            ]

            stop = bool(missing_objects or missing_geometry or invalid)
            completeness = {
                "listed": len(members),
                "present_objects": sum(1 for m in members if m["has_object"]),
                "with_geometry": sum(1 for m in members if m["has_geometry"]),
                "complete_by_policy": len(missing_objects) == 0
                and len(missing_geometry) == 0,
                "definition": (
                    "complete = all member refs exist in water.objects with geometry; "
                    "does NOT imply geometric continuity"
                ),
            }

            if stop:
                return {
                    "fingerprint": fingerprint,
                    "completeness": completeness,
                    "abort": True,
                    "missing_objects": missing_objects,
                    "missing_geometry": missing_geometry,
                    "invalid": invalid,
                    "unexpected_type": unexpected_type,
                }

            # Endpoints via first/last dump point (read-only)
            cur.execute(
                """
                WITH mem AS (
                  SELECT m.seq, m.member_osm_type, m.member_osm_id, m.member_role,
                         o.geometry
                  FROM water.object_members m
                  JOIN water.objects o
                    ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                  WHERE m.parent_osm_id=%s
                ),
                pts AS (
                  SELECT seq, member_osm_id, member_role, geometry,
                    (ST_DumpPoints(geometry)).path AS path,
                    (ST_DumpPoints(geometry)).geom AS pt
                  FROM mem
                ),
                ranked AS (
                  SELECT seq, member_osm_id, member_role, geometry, path, pt,
                    row_number() OVER (PARTITION BY seq ORDER BY path) AS rn_asc,
                    row_number() OVER (PARTITION BY seq ORDER BY path DESC) AS rn_desc
                  FROM pts
                )
                SELECT seq, member_osm_id, member_role,
                  GeometryType(geometry) AS gtype,
                  ST_NPoints(geometry) AS npoints,
                  round(ST_Length(geometry::geography)::numeric, 3) AS length_m,
                  ST_SRID(geometry) AS srid,
                  ST_IsValid(geometry) AS is_valid,
                  max(ST_X(pt)) FILTER (WHERE rn_asc=1) AS start_lon,
                  max(ST_Y(pt)) FILTER (WHERE rn_asc=1) AS start_lat,
                  max(ST_X(pt)) FILTER (WHERE rn_desc=1) AS end_lon,
                  max(ST_Y(pt)) FILTER (WHERE rn_desc=1) AS end_lat
                FROM ranked
                GROUP BY seq, member_osm_id, member_role, geometry
                ORDER BY seq
                """,
                (REL,),
            )
            seq_members = [dict(r) for r in cur.fetchall()]

            # --- D endpoint gaps (PostGIS geography meters) ---
            # For MULTI members use start/end of the full geometry via DumpPoints extremes
            # already computed above; gap SQL uses LINESTRING start/end or Multi first/last point.
            cur.execute(
                """
                WITH mem AS (
                  SELECT m.seq, m.member_osm_id, o.geometry,
                    ST_PointN(o.geometry, 1) AS s,
                    ST_PointN(o.geometry, ST_NPoints(o.geometry)) AS e
                  FROM water.object_members m
                  JOIN water.objects o
                    ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                  WHERE m.parent_osm_id=%s
                ),
                pairs AS (
                  SELECT a.seq AS seq_a, b.seq AS seq_b,
                    a.member_osm_id AS way_a, b.member_osm_id AS way_b,
                    ST_Distance(a.e::geography, b.s::geography) AS forward_m,
                    LEAST(
                      ST_Distance(a.e::geography, b.s::geography),
                      ST_Distance(a.e::geography, b.e::geography),
                      ST_Distance(a.s::geography, b.s::geography),
                      ST_Distance(a.s::geography, b.e::geography)
                    ) AS best_m
                  FROM mem a
                  JOIN mem b ON b.seq = a.seq + 1
                )
                SELECT * FROM pairs ORDER BY seq_a
                """,
                (REL,),
            )
            sql_gaps = [dict(r) for r in cur.fetchall()]
            forward_vals = [float(g["forward_m"]) for g in sql_gaps]
            best_vals = [float(g["best_m"]) for g in sql_gaps]

            def pct(vals: list[float], p: float) -> float:
                if not vals:
                    return 0.0
                s = sorted(vals)
                i = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
                return s[i]

            gap_stats = {
                "pairs": len(sql_gaps),
                "forward_end_to_start": {
                    "max_m": max(forward_vals) if forward_vals else None,
                    "median_m": statistics.median(forward_vals) if forward_vals else None,
                    "p95_m": pct(forward_vals, 95),
                    "pairs_gap_gt_0": sum(1 for v in forward_vals if v > 0),
                    "pairs_gap_gt_1m": sum(1 for v in forward_vals if v > 1),
                    "pairs_gap_gt_10m": sum(1 for v in forward_vals if v > 10),
                    "pairs_gap_gt_100m": sum(1 for v in forward_vals if v > 100),
                },
                "best_endpoint_pair": {
                    "max_m": max(best_vals) if best_vals else None,
                    "median_m": statistics.median(best_vals) if best_vals else None,
                    "p95_m": pct(best_vals, 95),
                    "pairs_gap_gt_0": sum(1 for v in best_vals if v > 0),
                    "pairs_gap_gt_1m": sum(1 for v in best_vals if v > 1),
                    "pairs_gap_gt_10m": sum(1 for v in best_vals if v > 10),
                    "pairs_gap_gt_100m": sum(1 for v in best_vals if v > 100),
                },
                "top20_forward_gaps": sorted(
                    [
                        {
                            "seq_a": int(g["seq_a"]),
                            "seq_b": int(g["seq_b"]),
                            "way_a": int(g["way_a"]),
                            "way_b": int(g["way_b"]),
                            "forward_m": float(g["forward_m"]),
                            "best_m": float(g["best_m"]),
                        }
                        for g in sql_gaps
                    ],
                    key=lambda x: -x["forward_m"],
                )[:20],
                "top20_best_gaps": sorted(
                    [
                        {
                            "seq_a": int(g["seq_a"]),
                            "seq_b": int(g["seq_b"]),
                            "way_a": int(g["way_a"]),
                            "way_b": int(g["way_b"]),
                            "forward_m": float(g["forward_m"]),
                            "best_m": float(g["best_m"]),
                        }
                        for g in sql_gaps
                    ],
                    key=lambda x: -x["best_m"],
                )[:20],
                "note": (
                    "Distances are QA only — not used to auto-join. "
                    "best_endpoint_pair considers possible reverses without mutating geometry."
                ),
            }

            # --- E orientation (diagnostic greedy chain) ---
            # Walk seq order; for each next way choose orientation minimizing gap to current tip.
            tip_lon = float(seq_members[0]["end_lon"])
            tip_lat = float(seq_members[0]["end_lat"])
            # Also try starting with first way reversed
            def chain_stats(start_reversed: bool) -> dict[str, Any]:
                first = seq_members[0]
                if start_reversed:
                    tip = (float(first["start_lon"]), float(first["start_lat"]))
                    rev_count = 1
                else:
                    tip = (float(first["end_lon"]), float(first["end_lat"]))
                    rev_count = 0
                compatible = 0
                need_reverse = 0
                decisions = []
                for nxt in seq_members[1:]:
                    s = (float(nxt["start_lon"]), float(nxt["start_lat"]))
                    e = (float(nxt["end_lon"]), float(nxt["end_lat"]))
                    d_fwd = haversine_m(tip[0], tip[1], s[0], s[1])
                    d_rev = haversine_m(tip[0], tip[1], e[0], e[1])
                    if d_fwd <= d_rev:
                        compatible += 1
                        tip = e
                        decisions.append(
                            {
                                "seq": int(nxt["seq"]),
                                "way": int(nxt["member_osm_id"]),
                                "action": "keep",
                                "gap_m": round(d_fwd, 3),
                            }
                        )
                    else:
                        need_reverse += 1
                        rev_count += 1
                        tip = s
                        decisions.append(
                            {
                                "seq": int(nxt["seq"]),
                                "way": int(nxt["member_osm_id"]),
                                "action": "reverse_for_chain",
                                "gap_m": round(d_rev, 3),
                            }
                        )
                return {
                    "start_reversed": start_reversed,
                    "neighbors_keep": compatible,
                    "neighbors_need_reverse": need_reverse,
                    "total_reversed_including_start": rev_count,
                    "final_tip": {"lon": tip[0], "lat": tip[1]},
                    "sample_decisions_first10": decisions[:10],
                    "sample_decisions_largest_gaps": sorted(
                        decisions, key=lambda x: -x["gap_m"]
                    )[:10],
                }

            orient_a = chain_stats(False)
            orient_b = chain_stats(True)
            orientation = {
                "policy": "diagnostic greedy chain only; no geometry written",
                "start_as_stored": orient_a,
                "start_reversed": orient_b,
                "preferred": (
                    "start_as_stored"
                    if orient_a["neighbors_need_reverse"]
                    <= orient_b["neighbors_need_reverse"]
                    else "start_reversed"
                ),
            }

            # --- F/G reconstruction (read-only SELECT) ---
            cur.execute(
                """
                SELECT
                  GeometryType(geom) AS gtype,
                  ST_SRID(geom) AS srid,
                  ST_NPoints(geom) AS npoints,
                  ST_NumGeometries(geom) AS n_parts,
                  round(ST_Length(geom::geography)::numeric, 1) AS length_m,
                  round(ST_XMin(geom)::numeric, 5) AS xmin,
                  round(ST_YMin(geom)::numeric, 5) AS ymin,
                  round(ST_XMax(geom)::numeric, 5) AS xmax,
                  round(ST_YMax(geom)::numeric, 5) AS ymax,
                  ST_IsValid(geom) AS is_valid
                FROM (
                  SELECT ST_Collect(o.geometry ORDER BY m.seq) AS geom
                  FROM water.object_members m
                  JOIN water.objects o
                    ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                  WHERE m.parent_osm_id=%s
                ) t
                """,
                (REL,),
            )
            collect_stats = dict(cur.fetchone())

            cur.execute(
                """
                SELECT
                  GeometryType(geom) AS gtype,
                  ST_SRID(geom) AS srid,
                  ST_NPoints(geom) AS npoints,
                  ST_NumGeometries(
                    CASE WHEN GeometryType(geom) LIKE 'MULTI%%' THEN geom
                         ELSE ST_Multi(geom) END
                  ) AS n_parts,
                  round(ST_Length(geom::geography)::numeric, 1) AS length_m,
                  round(ST_XMin(geom)::numeric, 5) AS xmin,
                  round(ST_YMin(geom)::numeric, 5) AS ymin,
                  round(ST_XMax(geom)::numeric, 5) AS xmax,
                  round(ST_YMax(geom)::numeric, 5) AS ymax,
                  ST_IsValid(geom) AS is_valid
                FROM (
                  SELECT ST_LineMerge(ST_Collect(o.geometry ORDER BY m.seq)) AS geom
                  FROM water.object_members m
                  JOIN water.objects o
                    ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                  WHERE m.parent_osm_id=%s
                ) t
                """,
                (REL,),
            )
            linemerge_stats = dict(cur.fetchone())

            # Canonical relation geometry
            cur.execute(
                """
                SELECT name, water_type,
                  GeometryType(geometry) AS gtype,
                  ST_SRID(geometry) AS srid,
                  ST_NPoints(geometry) AS npoints,
                  ST_NumGeometries(
                    CASE WHEN GeometryType(geometry) LIKE 'MULTI%%' THEN geometry
                         ELSE ST_Multi(geometry) END
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
                (REL,),
            )
            canonical = dict(cur.fetchone())

            # Why xmax differs: how many member ways extend beyond canonical xmax
            cur.execute(
                """
                SELECT count(*) AS n_members_beyond_canon_xmax,
                  round(max(ST_XMax(o.geometry))::numeric,5) AS members_xmax,
                  round(max(ST_XMax(o.geometry)) FILTER (
                    WHERE ST_XMax(o.geometry) > (SELECT ST_XMax(geometry) FROM water.objects
                      WHERE osm_type='relation' AND osm_id=%s)
                  )::numeric,5) AS beyond_xmax
                FROM water.object_members m
                JOIN water.objects o ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                WHERE m.parent_osm_id=%s
                """,
                (REL, REL),
            )
            beyond = dict(cur.fetchone())
            cur.execute(
                """
                SELECT m.seq, m.member_osm_id,
                  round(ST_XMin(o.geometry)::numeric,5) AS xmin,
                  round(ST_XMax(o.geometry)::numeric,5) AS xmax,
                  round(ST_Length(o.geometry::geography)::numeric,1) AS length_m
                FROM water.object_members m
                JOIN water.objects o ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                WHERE m.parent_osm_id=%s
                  AND ST_XMax(o.geometry) > (
                    SELECT ST_XMax(geometry) FROM water.objects
                    WHERE osm_type='relation' AND osm_id=%s
                  )
                ORDER BY m.seq
                """,
                (REL, REL),
            )
            members_east_of_canon = [dict(r) for r in cur.fetchall()]

            # --- I conflicts ---
            cur.execute(
                """
                SELECT conflict_type, resolution, status, count(*) AS n
                FROM water.object_conflicts
                WHERE status='open' AND conflict_type='geometry'
                GROUP BY 1,2,3
                """
            )
            open_geom_conflicts = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT c.osm_type, c.osm_id, c.resolution, c.notes, b.batch_key
                FROM water.object_conflicts c
                JOIN water.import_batches b ON b.id=c.batch_id
                WHERE c.osm_type='relation' AND c.osm_id=%s AND c.conflict_type='geometry'
                ORDER BY c.id
                """,
                (REL,),
            )
            relation_conflicts = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                SELECT count(DISTINCT m.member_osm_id) AS member_ways_with_geom_conflict
                FROM water.object_members m
                JOIN water.object_conflicts c
                  ON c.osm_type=m.member_osm_type AND c.osm_id=m.member_osm_id
                 AND c.conflict_type='geometry' AND c.status='open'
                WHERE m.parent_osm_id=%s
                """,
                (REL,),
            )
            member_conflict_n = int(cur.fetchone()["member_ways_with_geom_conflict"])

            # --- J controls ---
            cur.execute(
                """
                SELECT o.osm_id, o.name,
                  (SELECT count(*) FROM water.object_members m
                   WHERE m.parent_osm_id=o.osm_id) AS listed,
                  (SELECT count(*) FROM water.object_members m
                   WHERE m.parent_osm_id=o.osm_id
                     AND EXISTS (
                       SELECT 1 FROM water.objects x
                       WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
                     )) AS present,
                  (SELECT count(*) FROM water.object_members m
                   JOIN water.objects x
                     ON x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
                   WHERE m.parent_osm_id=o.osm_id AND x.geometry IS NULL) AS missing_geom,
                  (SELECT count(*) FROM water.object_members m
                   JOIN water.objects x
                     ON x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
                   WHERE m.parent_osm_id=o.osm_id AND NOT ST_IsValid(x.geometry)) AS invalid_member_geom,
                  GeometryType(o.geometry) AS rel_gtype,
                  round(ST_Length(o.geometry::geography)::numeric,1) AS rel_length_m,
                  round(ST_XMax(o.geometry)::numeric,5) AS rel_xmax
                FROM water.objects o
                WHERE o.osm_type='relation' AND o.osm_id = ANY(%s)
                ORDER BY o.osm_id
                """,
                (list(CONTROLS),),
            )
            controls = [dict(r) for r in cur.fetchall()]

            member_summary = [
                {
                    "seq": int(m["seq"]),
                    "member_type": "way",
                    "member_id": int(m["member_osm_id"]),
                    "role": m["member_role"] or "",
                    "gtype": m["gtype"],
                    "srid": int(m["srid"]),
                    "is_valid": bool(m["is_valid"]),
                    "npoints": int(m["npoints"]),
                    "length_m": float(m["length_m"]),
                    "start": [float(m["start_lon"]), float(m["start_lat"])],
                    "end": [float(m["end_lon"]), float(m["end_lat"])],
                }
                for m in seq_members
            ]

            return {
                "abort": False,
                "fingerprint": fingerprint,
                "completeness": completeness,
                "availability": {
                    "missing_objects": 0,
                    "missing_geometry": 0,
                    "invalid_geometry": 0,
                    "unexpected_types": [
                        {
                            "seq": int(m["seq"]),
                            "id": int(m["member_osm_id"]),
                            "gtype": m["gtype"],
                        }
                        for m in unexpected_type
                    ],
                },
                "members": member_summary,
                "endpoint_gaps": gap_stats,
                "orientation": orientation,
                "diagnostic_reconstruction": {
                    "st_collect": collect_stats,
                    "st_linemerge_of_collect": linemerge_stats,
                    "note": (
                        "Computed in SELECT only; not written to water.objects. "
                        "Not for routing."
                    ),
                },
                "canonical_relation_geometry": canonical,
                "canonical_vs_members": {
                    "canonical_length_m": float(canonical["length_m"]),
                    "collect_length_m": float(collect_stats["length_m"]),
                    "linemerge_length_m": float(linemerge_stats["length_m"]),
                    "length_delta_collect_minus_canonical_m": float(collect_stats["length_m"])
                    - float(canonical["length_m"]),
                    "canonical_xmax": float(canonical["xmax"]),
                    "collect_xmax": float(collect_stats["xmax"]),
                    "members_beyond_canonical_xmax": beyond,
                    "member_ways_east_of_canonical_xmax": members_east_of_canon,
                    "explanation": (
                        "Canonical relation.geometry is the E3.7 keep_canonical "
                        "assembly from an earlier extract (Leningrad-era MULTILINESTRING, "
                        "902 pts, xmax~35.84E). Vologda merge added missing member "
                        "OBJECTS but kept relation geometry because staging relation "
                        "geometry had fewer points (730). Member ways themselves extend "
                        "to ~38.56E — completeness of members ≠ updated relation geometry."
                    ),
                },
                "conflicts": {
                    "open_geometry_summary": open_geom_conflicts,
                    "relation_16738852_geometry_conflicts": relation_conflicts,
                    "vb_member_ways_with_open_geometry_conflict": member_conflict_n,
                },
                "controls": controls,
                "conclusion": {
                    "can_build_geometry_from_real_member_ways": True,
                    "member_data_sufficient": True,
                    "geometrically_continuous": (
                        gap_stats["best_endpoint_pair"]["pairs_gap_gt_10m"] == 0
                        if gap_stats["best_endpoint_pair"]["pairs_gap_gt_10m"] is not None
                        else None
                    ),
                    "continuous_note": (
                        "Continuity judged only by endpoint gaps with optional reverse; "
                        "complete membership alone does not imply continuity."
                    ),
                    "canonical_geometry_incomplete_vs_members": float(canonical["xmax"])
                    < float(collect_stats["xmax"]),
                },
            }


def main() -> int:
    ap = argparse.ArgumentParser(description="E3.14 read-only VB geometry recon audit")
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--json-out", default=None)
    ap.add_argument(
        "--omit-members-stdout",
        action="store_true",
        help="Omit per-member array from stdout (still in --json-out)",
    )
    args = ap.parse_args()
    report = audit(args.dsn or default_dsn())
    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=_json_default)
            + "\n"
        )
        print(f"wrote {out}", file=sys.stderr)
    printable = dict(report)
    if args.omit_members_stdout and "members" in printable:
        printable["members_count"] = len(printable.pop("members"))
    print(json.dumps(printable, ensure_ascii=False, indent=2, default=_json_default))
    return 1 if report.get("abort") else 0


if __name__ == "__main__":
    sys.exit(main())
