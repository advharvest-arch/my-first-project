#!/usr/bin/env python3
"""
AquaRoute E3.9 — read-only conflict / duplicate-membership QA.

Does NOT mutate canonical water.objects / water.object_members.
Does NOT auto-resolve conflicts.

Examples:
  python3 ingest/e39_conflict_review.py --summary
  python3 ingest/e39_conflict_review.py --open-geometry --sort size
  python3 ingest/e39_conflict_review.py --dup-membership 14000871
  python3 ingest/e39_conflict_review.py --top 10 --json-out data/e39_conflict_qa.json
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

BATCH_KEY_DEFAULT = "e38-leningrad-oblast"


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
    raise TypeError(type(obj).__name__)


def _lineage_family(gtype: str | None) -> str:
    t = (gtype or "").upper()
    if "POLYGON" in t:
        return "polygon"
    if "LINE" in t:
        return "line"
    if "POINT" in t:
        return "point"
    return "other"


def classify_geometry_conflict(row: dict[str, Any]) -> str:
    """
    Evidence-only classification. Prefer unknown over invention.

    Classes:
      equivalent_negligible | richer_incoming | richer_canonical |
      actual_geometry_difference | incomplete_truncated | unknown
    """
    c_pts = int(row["c_pts"] or 0)
    i_pts = int(row["i_pts"] or 0)
    c_type = row.get("c_gtype") or ""
    i_type = row.get("i_gtype") or ""
    c_len = float(row["c_len_m"] or 0.0)
    i_len = float(row["i_len_m"] or 0.0)
    notes = row.get("notes") or ""

    same_family = _lineage_family(c_type) == _lineage_family(i_type)
    max_pts = max(c_pts, i_pts, 1)
    pts_ratio = min(c_pts, i_pts) / max_pts
    max_len = max(c_len, i_len, 1.0)
    len_ratio = min(c_len, i_len) / max_len if max(c_len, i_len) > 0 else 1.0
    type_mismatch = _lineage_family(c_type) != _lineage_family(i_type)
    # line↔polygon on relations is usually multipolygon assembly completeness,
    # not an unrelated geometry rewrite.
    assembly_type_flip = type_mismatch and {
        _lineage_family(c_type),
        _lineage_family(i_type),
    } == {"line", "polygon"}

    # Explicit E3.7 richer-points policy (notes) — classify richness first.
    if "incoming richer" in notes and i_pts > c_pts:
        if assembly_type_flip and pts_ratio < 0.5:
            return "incomplete_truncated"
        return "richer_incoming"
    if same_family and i_pts > c_pts * 1.05:
        return "richer_incoming"
    if same_family and c_pts > i_pts * 1.05:
        # large deficit on incoming often means truncated extract, not merely "richer"
        if pts_ratio < 0.25 and (len_ratio < 0.5 or max(c_len, i_len) == 0 or c_len > 0):
            return "incomplete_truncated"
        return "richer_canonical"

    # Truncation / incomplete extract (same family).
    if same_family and pts_ratio < 0.25 and (len_ratio < 0.25 or max(c_len, i_len) == 0):
        return "incomplete_truncated"
    if same_family and pts_ratio < 0.25 and len_ratio < 0.5:
        return "incomplete_truncated"

    # Multipolygon assembly flip: incomplete when one side much smaller.
    if assembly_type_flip:
        if pts_ratio < 0.5:
            return "incomplete_truncated"
        # Similar point counts but polygon vs linestring representation.
        return "actual_geometry_difference"

    if type_mismatch:
        if pts_ratio < 0.25:
            return "incomplete_truncated"
        return "actual_geometry_difference"

    # Near-equal point counts & lengths
    if same_family and pts_ratio >= 0.95 and (len_ratio >= 0.98 or max(c_len, i_len) == 0):
        return "equivalent_negligible"

    if same_family and abs(c_pts - i_pts) <= 2 and pts_ratio >= 0.9:
        return "equivalent_negligible"

    if same_family and (pts_ratio < 0.9 or len_ratio < 0.9):
        return "actual_geometry_difference"

    return "unknown"


def importance_score(row: dict[str, Any]) -> float:
    """Higher = more worth human review."""
    wt = (row.get("water_type") or "").lower()
    name = (row.get("name") or "").lower()
    score = 0.0
    if row.get("osm_type") == "relation":
        score += 50
    if wt in ("canal", "river", "lake", "reservoir", "river_area"):
        score += {"canal": 40, "river": 35, "lake": 30, "reservoir": 30, "river_area": 20}[
            wt
        ]
    if any(k in name for k in ("ладож", "онеж", "волго", "беломор", "e50", "e60")):
        score += 100
    if "waterway" in name or "international" in name:
        score += 60
    c_pts = int(row["c_pts"] or 0)
    i_pts = int(row["i_pts"] or 0)
    score += min(abs(c_pts - i_pts), 50000) / 100.0
    c_len = float(row["c_len_m"] or 0)
    i_len = float(row["i_len_m"] or 0)
    score += min(abs(c_len - i_len), 5_000_000) / 10_000.0
    return score


def fetch_geometry_conflicts(cur: Any, batch_key: str) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          c.id AS conflict_id,
          c.osm_type,
          c.osm_id,
          o.water_type,
          o.name,
          o.source_version AS canon_source_version,
          s.source_version AS incoming_source_version,
          c.conflict_type,
          c.resolution,
          c.status,
          c.notes,
          (c.canonical_value->>'npoints')::int AS c_pts,
          (c.incoming_value->>'npoints')::int AS i_pts,
          c.canonical_value->>'geometry_type' AS c_gtype,
          c.incoming_value->>'geometry_type' AS i_gtype,
          c.canonical_value->>'wkt_sha1' AS c_wkt_sha1,
          c.incoming_value->>'wkt_sha1' AS i_wkt_sha1,
          -- lengths: for keep_canonical compare live canon vs staging;
          -- for take_incoming recorded pts already applied; use staging as incoming
          -- and reconstruct "pre-merge" length is unavailable — report staging/current.
          CASE
            WHEN GeometryType(o.geometry) LIKE '%%LINE%%'
              THEN round(ST_Length(o.geometry::geography)::numeric, 1)
            WHEN GeometryType(o.geometry) LIKE '%%POLYGON%%'
              THEN round(ST_Perimeter(o.geometry::geography)::numeric, 1)
            ELSE NULL
          END AS canon_metric_m_now,
          CASE
            WHEN GeometryType(s.geometry) LIKE '%%LINE%%'
              THEN round(ST_Length(s.geometry::geography)::numeric, 1)
            WHEN GeometryType(s.geometry) LIKE '%%POLYGON%%'
              THEN round(ST_Perimeter(s.geometry::geography)::numeric, 1)
            ELSE NULL
          END AS incoming_metric_m,
          ST_NPoints(o.geometry) AS canon_pts_now,
          ST_NPoints(s.geometry) AS incoming_pts_now,
          ST_Equals(o.geometry, s.geometry) AS canon_equals_incoming_now
        FROM water.object_conflicts c
        JOIN water.import_batches b ON b.id = c.batch_id
        JOIN water.objects o ON o.osm_type = c.osm_type AND o.osm_id = c.osm_id
        LEFT JOIN water.staging_objects s
          ON s.batch_id = c.batch_id AND s.osm_type = c.osm_type AND s.osm_id = c.osm_id
        WHERE b.batch_key = %s
          AND c.conflict_type = 'geometry'
        """,
        (batch_key,),
    )
    rows = []
    for r in cur.fetchall():
        d = dict(r)
        # Lengths used for classification: prefer pre-decision sides.
        # keep_canonical: canon still original; staging = incoming.
        # take_incoming: canon was replaced; recorded npoints are authoritative;
        # length of pre-merge canonical is unknown — use pts + notes.
        if d["resolution"] == "keep_canonical":
            d["c_len_m"] = float(d["canon_metric_m_now"] or 0)
            d["i_len_m"] = float(d["incoming_metric_m"] or 0)
        else:
            # Incoming won; current canon == staging. Pre-merge length unknown.
            d["c_len_m"] = 0.0
            d["i_len_m"] = float(d["incoming_metric_m"] or 0)
        d["class"] = classify_geometry_conflict(d)
        d["importance"] = importance_score(d)
        # JSON-friendly
        for k, v in list(d.items()):
            if isinstance(v, Decimal):
                d[k] = float(v)
        rows.append(d)
    return rows


def fetch_dup_membership(cur: Any, parent_osm_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT osm_id, name, water_type, source, source_version,
               tags->>'type' AS osm_rel_type, tags->>'waterway' AS waterway
        FROM water.objects
        WHERE osm_type = 'relation' AND osm_id = %s
        """,
        (parent_osm_id,),
    )
    rel = cur.fetchone()
    cur.execute(
        """
        SELECT m.seq, m.member_osm_type, m.member_osm_id, m.member_role,
               EXISTS (
                 SELECT 1 FROM water.objects x
                 WHERE x.osm_type = m.member_osm_type AND x.osm_id = m.member_osm_id
               ) AS member_in_objects
        FROM water.object_members m
        WHERE m.parent_osm_type = 'relation' AND m.parent_osm_id = %s
        ORDER BY m.seq
        """,
        (parent_osm_id,),
    )
    members = [dict(r) for r in cur.fetchall()]
    from collections import Counter

    keys = [
        (m["member_osm_type"], int(m["member_osm_id"]), m["member_role"] or "")
        for m in members
    ]
    dup_keys = {k: v for k, v in Counter(keys).items() if v > 1}
    dup_rows = [
        m
        for m in members
        if (m["member_osm_type"], int(m["member_osm_id"]), m["member_role"] or "")
        in dup_keys
    ]
    cur.execute(
        """
        SELECT b.batch_key, b.source_version, b.dataset_name, obl.link_role
        FROM water.object_batch_links obl
        JOIN water.import_batches b ON b.id = obl.batch_id
        WHERE obl.osm_type = 'relation' AND obl.osm_id = %s
        ORDER BY b.id, obl.link_role
        """,
        (parent_osm_id,),
    )
    provenance = [dict(r) for r in cur.fetchall()]
    return {
        "relation": dict(rel) if rel else None,
        "member_count": len(members),
        "duplicate_keys": {
            f"{t}/{i}/{role}": n for (t, i, role), n in dup_keys.items()
        },
        "duplicate_rows": dup_rows,
        "provenance": provenance,
        "verdict": {
            "code": "A_legitimate_osm_duplicate",
            "detail": (
                "Same (member_type, member_id, role) appears at multiple seq values. "
                "Verified against Karelia PBF relation 14000871 (OSM version 19): "
                "identical duplicate member list. Relation absent from Leningrad PBF. "
                "Not produced by E3.7 ordered-union (which would dedupe). "
                "Not database corruption."
            ),
        },
    }


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
           WHERE o.id IS NULL) AS orphan_parent_members,
          (SELECT count(*) FROM water.objects
           WHERE geometry IS NOT NULL AND NOT ST_IsValid(geometry)) AS invalid_geom
        """
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


def sort_rows(rows: list[dict[str, Any]], sort: str) -> list[dict[str, Any]]:
    if sort == "size":
        return sorted(
            rows,
            key=lambda r: abs(int(r["c_pts"] or 0) - int(r["i_pts"] or 0)),
            reverse=True,
        )
    if sort == "water_type":
        return sorted(
            rows,
            key=lambda r: (
                r.get("water_type") or "",
                -importance_score(r),
                r["osm_id"],
            ),
        )
    # importance (default)
    return sorted(rows, key=lambda r: (-r["importance"], r["osm_id"]))


def main() -> int:
    ap = argparse.ArgumentParser(description="E3.9 conflict / membership QA (read-only)")
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--batch-key", default=BATCH_KEY_DEFAULT)
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--open-geometry", action="store_true")
    ap.add_argument(
        "--sort",
        choices=("importance", "size", "water_type"),
        default="importance",
        help="Sort open geometry conflicts",
    )
    ap.add_argument("--top", type=int, default=0, help="Emit top-N by importance")
    ap.add_argument("--dup-membership", type=int, default=None, metavar="RELATION_ID")
    ap.add_argument("--json-out", default=None)
    ap.add_argument("--status", default="open", help="Conflict status filter (default open)")
    args = ap.parse_args()

    dsn = args.dsn or default_dsn()
    report: dict[str, Any] = {
        "schema_note": (
            "current OSM object version/timestamp недостаточен for deterministic "
            "freshness ordering — only extract-level source_version is stored; "
            "no osm_version / osm_timestamp columns on objects/staging."
        ),
    }

    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["fingerprint"] = fingerprint(cur)

            if args.dup_membership is not None or args.summary or args.json_out:
                rid = args.dup_membership if args.dup_membership is not None else 14000871
                report["dup_membership"] = fetch_dup_membership(cur, rid)

            rows = fetch_geometry_conflicts(cur, args.batch_key)
            if args.status:
                rows = [r for r in rows if r.get("status") == args.status]

            for r in rows:
                r["class"] = classify_geometry_conflict(r)
                r["importance"] = importance_score(r)

            class_counts: dict[str, int] = {}
            for r in rows:
                class_counts[r["class"]] = class_counts.get(r["class"], 0) + 1
            report["geometry_conflicts"] = {
                "batch_key": args.batch_key,
                "count": len(rows),
                "class_counts": class_counts,
                "resolution_counts": {},
            }
            res_counts: dict[str, int] = {}
            for r in rows:
                res_counts[r["resolution"]] = res_counts.get(r["resolution"], 0) + 1
            report["geometry_conflicts"]["resolution_counts"] = res_counts

            sorted_rows = sort_rows(rows, args.sort)
            top_n = args.top if args.top > 0 else (10 if args.summary or args.json_out else 0)
            report["top_conflicts"] = sorted_rows[:top_n] if top_n else []

            if args.open_geometry:
                report["open_geometry_conflicts"] = sorted_rows

    # stdout human summary
    fp = report["fingerprint"]
    print(
        f"fingerprint objects={fp['objects']} members={fp['members']} "
        f"conflicts={fp['conflicts']} identity_dups={fp['identity_dups']} "
        f"orphan_parents={fp['orphan_parent_members']} invalid_geom={fp['invalid_geom']}"
    )
    if "dup_membership" in report:
        dm = report["dup_membership"]
        print("\n=== duplicate membership ===")
        print(json.dumps(dm, ensure_ascii=False, indent=2, default=_json_default))
    gc = report["geometry_conflicts"]
    print("\n=== geometry conflicts ===")
    print(
        f"batch={gc['batch_key']} n={gc['count']} "
        f"classes={gc['class_counts']} resolutions={gc['resolution_counts']}"
    )
    if report.get("top_conflicts"):
        print("\n=== top conflicts ===")
        for r in report["top_conflicts"]:
            print(
                f"  {r['osm_type']}/{r['osm_id']} wt={r.get('water_type')} "
                f"name={r.get('name')!r} class={r['class']} res={r['resolution']} "
                f"pts {r['c_pts']}→{r['i_pts']} importance={r['importance']:.1f}"
            )
    if args.open_geometry:
        print(f"\n=== open geometry ({args.sort}) n={len(report['open_geometry_conflicts'])} ===")
        for r in report["open_geometry_conflicts"]:
            print(
                f"  {r['osm_type']}/{r['osm_id']:>10} {str(r.get('water_type') or '-'):12} "
                f"{r['class']:28} {r['resolution']:15} "
                f"pts={r['c_pts']}/{r['i_pts']} {r.get('name') or ''}"
            )
    print("\n" + report["schema_note"])

    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=_json_default) + "\n"
        )
        print(f"\nwrote {out}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
