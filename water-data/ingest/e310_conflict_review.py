#!/usr/bin/env python3
"""
AquaRoute E3.10 — manual conflict review CLI (status only).

SAFETY: never mutates water.objects geometry/tags/members.
Accepting take_incoming only records review status — it does NOT apply geometry.

Commands:
  list [--status open] [--type geometry] [--batch-key KEY]
  show --id N
  accept --id N [--notes TEXT]
  reject --id N [--notes TEXT]
  defer  --id N [--notes TEXT]

Probe (safe, does not touch real E3.8 conflicts):
  probe-demo   # insert→accept/reject/defer→cleanup in one transaction-ish flow
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
from psycopg2.extras import Json, RealDictCursor

ALLOWED_STATUS = ("open", "accepted", "rejected", "deferred")


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


def cmd_list(cur: Any, args: argparse.Namespace) -> None:
    clauses = ["1=1"]
    params: list[Any] = []
    if args.status:
        clauses.append("c.status = %s")
        params.append(args.status)
    if args.type:
        clauses.append("c.conflict_type = %s")
        params.append(args.type)
    if args.batch_key:
        clauses.append("b.batch_key = %s")
        params.append(args.batch_key)
    where = " AND ".join(clauses)
    cur.execute(
        f"""
        SELECT c.id, c.osm_type, c.osm_id, c.conflict_type,
               c.resolution AS recommendation, c.status,
               b.batch_key, left(c.notes, 80) AS notes,
               o.water_type, o.name
        FROM water.object_conflicts c
        JOIN water.import_batches b ON b.id = c.batch_id
        LEFT JOIN water.objects o ON o.osm_type = c.osm_type AND o.osm_id = c.osm_id
        WHERE {where}
        ORDER BY c.id
        LIMIT %s
        """,
        (*params, args.limit),
    )
    rows = [dict(r) for r in cur.fetchall()]
    print(json.dumps(rows, ensure_ascii=False, indent=2, default=_json_default))
    print(f"\n# {len(rows)} row(s)  (recommendation=resolution; status=review)", file=sys.stderr)


def cmd_show(cur: Any, conflict_id: int) -> None:
    cur.execute(
        """
        SELECT c.*, b.batch_key, b.source_version AS batch_source_version,
               o.water_type, o.name AS object_name,
               o.source_version AS object_source_version,
               CASE WHEN GeometryType(o.geometry) LIKE '%%LINE%%'
                    THEN round(ST_Length(o.geometry::geography)::numeric, 1)
                    WHEN GeometryType(o.geometry) LIKE '%%POLYGON%%'
                    THEN round(ST_Perimeter(o.geometry::geography)::numeric, 1)
                    ELSE NULL END AS canon_metric_m,
               ST_NPoints(o.geometry) AS canon_pts_now,
               ST_GeometryType(o.geometry) AS canon_gtype_now,
               s.source_version AS staging_source_version,
               CASE WHEN s.geometry IS NULL THEN NULL
                    WHEN GeometryType(s.geometry) LIKE '%%LINE%%'
                    THEN round(ST_Length(s.geometry::geography)::numeric, 1)
                    WHEN GeometryType(s.geometry) LIKE '%%POLYGON%%'
                    THEN round(ST_Perimeter(s.geometry::geography)::numeric, 1)
                    ELSE NULL END AS incoming_metric_m,
               ST_NPoints(s.geometry) AS incoming_pts,
               ST_GeometryType(s.geometry) AS incoming_gtype
        FROM water.object_conflicts c
        JOIN water.import_batches b ON b.id = c.batch_id
        LEFT JOIN water.objects o ON o.osm_type = c.osm_type AND o.osm_id = c.osm_id
        LEFT JOIN water.staging_objects s
          ON s.batch_id = c.batch_id AND s.osm_type = c.osm_type AND s.osm_id = c.osm_id
        WHERE c.id = %s
        """,
        (conflict_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise SystemExit(f"conflict id={conflict_id} not found")
    d = dict(row)
    out = {
        "id": d["id"],
        "osm_type": d["osm_type"],
        "osm_id": d["osm_id"],
        "conflict_type": d["conflict_type"],
        "recommendation": d["resolution"],
        "status": d["status"],
        "batch_key": d["batch_key"],
        "notes": d["notes"],
        "review_notes": d.get("review_notes"),
        "reviewed_at": str(d["reviewed_at"]) if d.get("reviewed_at") else None,
        "canonical": {
            "value": d["canonical_value"],
            "water_type": d.get("water_type"),
            "name": d.get("object_name"),
            "source_version": d.get("object_source_version"),
            "geometry_type_now": d.get("canon_gtype_now"),
            "npoints_now": d.get("canon_pts_now"),
            "metric_m_now": float(d["canon_metric_m"]) if d.get("canon_metric_m") is not None else None,
        },
        "incoming": {
            "value": d["incoming_value"],
            "source_version": d.get("staging_source_version") or d.get("batch_source_version"),
            "geometry_type": d.get("incoming_gtype"),
            "npoints": d.get("incoming_pts"),
            "metric_m": float(d["incoming_metric_m"]) if d.get("incoming_metric_m") is not None else None,
        },
        "safety": (
            "Review updates status only. Canonical geometry is NOT changed by "
            "accept/reject/defer. Applying take_incoming requires a separate "
            "explicit apply operation (not available in E3.10)."
        ),
    }
    print(json.dumps(out, ensure_ascii=False, indent=2, default=_json_default))


def set_status(
    cur: Any,
    conflict_id: int,
    status: str,
    notes: str | None,
    *,
    allow_probe_only: bool = False,
) -> dict[str, Any]:
    if status not in ("accepted", "rejected", "deferred"):
        raise SystemExit(f"invalid review status {status!r}")
    cur.execute(
        "SELECT id, status, resolution, notes FROM water.object_conflicts WHERE id = %s",
        (conflict_id,),
    )
    row = cur.fetchone()
    if row is None:
        raise SystemExit(f"conflict id={conflict_id} not found")
    if allow_probe_only:
        cur.execute(
            """
            SELECT b.batch_key FROM water.object_conflicts c
            JOIN water.import_batches b ON b.id = c.batch_id
            WHERE c.id = %s
            """,
            (conflict_id,),
        )
        bk = cur.fetchone()["batch_key"]
        if not str(bk).startswith("e310-probe-"):
            raise SystemExit(
                f"refusing to mutate non-probe conflict id={conflict_id} "
                f"(batch_key={bk}); use --i-understand-production for real rows"
            )
    cur.execute(
        """
        UPDATE water.object_conflicts
        SET status = %s,
            reviewed_at = now(),
            review_notes = %s
        WHERE id = %s
        RETURNING id, osm_type, osm_id, resolution AS recommendation, status,
                  reviewed_at, review_notes
        """,
        (status, notes, conflict_id),
    )
    out = dict(cur.fetchone())
    out["canonical_geometry_changed"] = False
    out["note"] = "status updated only; recommendation left intact; no geometry apply"
    return out


def cmd_probe_demo(conn: Any) -> None:
    """Create probe batch + 3 conflicts; accept/reject/defer; delete batch."""
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            INSERT INTO water.import_batches (
              batch_key, source, source_version, dataset_name, status, notes
            ) VALUES (
              'e310-probe-review', 'osm', 'e310-probe', 'probe-only', 'merged',
              'E3.10 review workflow probe — safe to delete'
            )
            ON CONFLICT (batch_key) DO UPDATE
              SET notes = EXCLUDED.notes
            RETURNING id
            """
        )
        batch_id = int(cur.fetchone()["id"])
        # Clear prior probe conflicts
        cur.execute(
            "DELETE FROM water.object_conflicts WHERE batch_id = %s", (batch_id,)
        )
        specs = [
            ("accepted", "take_incoming"),
            ("rejected", "keep_canonical"),
            ("deferred", "take_incoming"),
        ]
        ids: list[int] = []
        for i, (_target, reco) in enumerate(specs):
            cur.execute(
                """
                INSERT INTO water.object_conflicts (
                  osm_type, osm_id, batch_id, conflict_type,
                  canonical_value, incoming_value, resolution, status, notes
                ) VALUES (
                  'way', %s, %s, 'geometry',
                  %s, %s, %s, 'open', 'e310 probe row'
                )
                RETURNING id
                """,
                (
                    -(9000000 + i),  # negative fake osm_id — not a real object
                    batch_id,
                    Json({"npoints": 10, "probe": True}),
                    Json({"npoints": 12, "probe": True}),
                    reco,
                ),
            )
            ids.append(int(cur.fetchone()["id"]))

        results = []
        for cid, (target, _) in zip(ids, specs):
            results.append(
                set_status(
                    cur,
                    cid,
                    target,
                    notes=f"probe → {target}",
                    allow_probe_only=True,
                )
            )

        cur.execute(
            """
            SELECT id, osm_id, resolution AS recommendation, status, review_notes
            FROM water.object_conflicts WHERE batch_id = %s ORDER BY id
            """,
            (batch_id,),
        )
        final_rows = [dict(r) for r in cur.fetchall()]

        # Cleanup probe batch (cascades conflicts)
        cur.execute("DELETE FROM water.import_batches WHERE id = %s", (batch_id,))

        # Fingerprint sanity
        cur.execute(
            """
            SELECT
              (SELECT count(*) FROM water.objects) AS objects,
              (SELECT count(*) FROM water.object_members) AS members,
              (SELECT count(*) FROM water.object_conflicts
               WHERE osm_id < 0) AS leftover_probe_conflicts
            """
        )
        fp = dict(cur.fetchone())

    conn.commit()
    print(
        json.dumps(
            {
                "probe": "e310-review-workflow",
                "transitions": results,
                "rows_before_cleanup": final_rows,
                "cleaned_up": True,
                "fingerprint_after": {k: int(v) for k, v in fp.items()},
                "canonical_geometry_changed": False,
            },
            ensure_ascii=False,
            indent=2,
            default=_json_default,
        )
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="E3.10 conflict review (status only)")
    ap.add_argument("--dsn", default=None)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_list = sub.add_parser("list", help="List conflicts")
    p_list.add_argument("--status", default="open")
    p_list.add_argument("--type", default=None)
    p_list.add_argument("--batch-key", default=None)
    p_list.add_argument("--limit", type=int, default=100)

    p_show = sub.add_parser("show", help="Show one conflict with canonical/incoming")
    p_show.add_argument("--id", type=int, required=True)

    for name in ("accept", "reject", "defer"):
        p = sub.add_parser(name, help=f"Set status={name}d" if name != "defer" else "Set status=deferred")
        p.add_argument("--id", type=int, required=True)
        p.add_argument("--notes", default=None)
        p.add_argument(
            "--i-understand-production",
            action="store_true",
            help="Allow reviewing non-probe conflicts (still does NOT apply geometry)",
        )

    sub.add_parser("probe-demo", help="Safe accept/reject/defer demo with cleanup")

    args = ap.parse_args()
    dsn = args.dsn or default_dsn()

    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            if args.cmd == "list":
                cmd_list(cur, args)
            elif args.cmd == "show":
                cmd_show(cur, args.id)
            elif args.cmd in ("accept", "reject", "defer"):
                status = {"accept": "accepted", "reject": "rejected", "defer": "deferred"}[
                    args.cmd
                ]
                allow_probe = not args.i_understand_production
                # If production flag set, allow any; else probe-only guard
                if args.i_understand_production:
                    out = set_status(cur, args.id, status, args.notes, allow_probe_only=False)
                else:
                    out = set_status(cur, args.id, status, args.notes, allow_probe_only=True)
                conn.commit()
                print(json.dumps(out, ensure_ascii=False, indent=2, default=_json_default))
            elif args.cmd == "probe-demo":
                cmd_probe_demo(conn)
            else:
                raise SystemExit(f"unknown cmd {args.cmd}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
