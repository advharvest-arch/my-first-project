#!/usr/bin/env python3
"""
AquaRoute E3.8 — backfill Karelia provenance links, then report overlap after Leningrad merge.

Assumes:
  - canonical DB already has Karelia import
  - Leningrad staging merged (or about to be)
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

sys.path.insert(0, os.path.dirname(__file__))
from merge_staging import create_batch, default_dsn  # noqa: E402

KARELIA_KEY = "e34-karelia-republic"
LENINGRAD_KEY = "e38-leningrad-oblast"


def backfill_karelia_batch(conn: Any) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        batch_id = create_batch(
            cur,
            batch_key=KARELIA_KEY,
            source_version="e34-karelia-republic-canonical",
            dataset_name="karelia_republic-latest.osm.pbf",
            notes="Retrospective provenance batch for pre-E3.7 Karelia canonical import",
        )
        cur.execute(
            """
            INSERT INTO water.object_batch_links (osm_type, osm_id, batch_id, link_role)
            SELECT osm_type, osm_id, %s, 'object'
            FROM water.objects
            ON CONFLICT DO NOTHING
            """,
            (batch_id,),
        )
        linked = cur.rowcount
        cur.execute(
            "UPDATE water.import_batches SET status = 'merged' WHERE id = %s",
            (batch_id,),
        )
    return {"batch_id": batch_id, "links_inserted_or_skipped": linked}


def relation_completeness(cur: Any, relation_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          o.osm_id,
          o.name,
          o.water_type,
          count(m.*) AS members_total,
          count(mw.osm_id) AS members_present,
          count(*) FILTER (WHERE mw.osm_id IS NULL) AS members_missing
        FROM water.objects o
        LEFT JOIN water.object_members m
          ON m.parent_osm_type = 'relation' AND m.parent_osm_id = o.osm_id
        LEFT JOIN water.objects mw
          ON mw.osm_type = m.member_osm_type AND mw.osm_id = m.member_osm_id
        WHERE o.osm_type = 'relation' AND o.osm_id = %s
        GROUP BY 1, 2, 3
        """,
        (relation_id,),
    )
    row = cur.fetchone()
    return dict(row) if row else {"osm_id": relation_id, "error": "not found"}


def overlap_report(conn: Any) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT id, batch_key FROM water.import_batches WHERE batch_key IN (%s, %s)",
            (KARELIA_KEY, LENINGRAD_KEY),
        )
        batches = {r["batch_key"]: int(r["id"]) for r in cur.fetchall()}
        if KARELIA_KEY not in batches or LENINGRAD_KEY not in batches:
            return {"error": "missing batch keys", "batches": batches}

        kid, lid = batches[KARELIA_KEY], batches[LENINGRAD_KEY]

        cur.execute(
            """
            WITH k AS (
              SELECT osm_type, osm_id FROM water.object_batch_links
              WHERE batch_id = %s AND link_role = 'object'
            ),
            l AS (
              SELECT osm_type, osm_id FROM water.object_batch_links
              WHERE batch_id = %s AND link_role = 'object'
            )
            SELECT
              (SELECT count(*) FROM k) AS karelia_links,
              (SELECT count(*) FROM l) AS leningrad_links,
              (SELECT count(*) FROM k JOIN l USING (osm_type, osm_id)) AS overlap,
              (SELECT count(*) FROM k LEFT JOIN l USING (osm_type, osm_id)
                 WHERE l.osm_id IS NULL) AS only_karelia,
              (SELECT count(*) FROM l LEFT JOIN k USING (osm_type, osm_id)
                 WHERE k.osm_id IS NULL) AS only_leningrad
            """,
            (kid, lid),
        )
        prov = dict(cur.fetchone())

        # Geometry conflicts involving leningrad batch
        cur.execute(
            """
            SELECT conflict_type, count(*) AS n
            FROM water.object_conflicts
            WHERE batch_id = %s
            GROUP BY 1 ORDER BY 2 DESC
            """,
            (lid,),
        )
        conflicts = {r["conflict_type"]: int(r["n"]) for r in cur.fetchall()}

        cur.execute(
            """
            SELECT osm_type, osm_id, conflict_type, resolution, left(notes, 120) AS notes
            FROM water.object_conflicts
            WHERE batch_id = %s
            ORDER BY conflict_type, osm_id
            LIMIT 15
            """,
            (lid,),
        )
        conflict_examples = [dict(r) for r in cur.fetchall()]

        # Focus relations
        focus_ids = [21149039, 16738852, 10908469, 10908402, 9909116, 1308279]
        focus = {str(rid): relation_completeness(cur, rid) for rid in focus_ids}

        cur.execute(
            """
            SELECT
              (SELECT count(*) FROM water.objects) AS objects,
              (SELECT count(*) FROM water.object_members) AS members,
              (SELECT count(*) FROM water.object_conflicts) AS conflicts
            """
        )
        fp = {k: int(v) for k, v in cur.fetchone().items()}

        # bbox of leningrad-only and overall
        cur.execute(
            """
            SELECT ST_XMin(g) xmin, ST_YMin(g) ymin, ST_XMax(g) xmax, ST_YMax(g) ymax
            FROM (
              SELECT ST_Extent(o.geometry)::geometry g
              FROM water.objects o
              JOIN water.object_batch_links l
                ON l.osm_type=o.osm_type AND l.osm_id=o.osm_id
               AND l.batch_id = %s AND l.link_role='object'
              LEFT JOIN water.object_batch_links k
                ON k.osm_type=o.osm_type AND k.osm_id=o.osm_id
               AND k.batch_id = %s AND k.link_role='object'
              WHERE k.osm_id IS NULL
            ) e
            """,
            (lid, kid),
        )
        only_l_bbox = dict(cur.fetchone() or {})

    return {
        "batches": batches,
        "provenance": prov,
        "leningrad_conflicts_by_type": conflicts,
        "conflict_examples": conflict_examples,
        "focus_relations": focus,
        "fingerprint": fp,
        "only_leningrad_bbox": only_l_bbox,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dsn", default=None)
    parser.add_argument("--backfill-karelia", action="store_true")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    dsn = args.dsn or default_dsn()
    conn = psycopg2.connect(dsn)
    out: dict[str, Any] = {}
    try:
        if args.backfill_karelia:
            out["backfill"] = backfill_karelia_batch(conn)
            conn.commit()
        if args.report:
            out["report"] = overlap_report(conn)
        print(json.dumps(out, indent=2, ensure_ascii=False, default=str))
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
