#!/usr/bin/env python3
"""
AquaRoute E3.7 — merge staging batches into canonical water.* tables.

Rules (E3.6):
  - identity = (osm_type, osm_id)
  - no silent geometry/tags overwrite
  - relation members = ordered union (never replace-all)
  - no placeholder objects for missing members
  - transactional per batch
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import psycopg2
from psycopg2.extras import Json, RealDictCursor


def default_dsn() -> str:
    host = os.environ.get("WATER_DB_HOST", "127.0.0.1")
    port = os.environ.get("WATER_DB_PORT", "5433")
    db = os.environ.get("WATER_DB_NAME", "aquaroute_water")
    user = os.environ.get("WATER_DB_USER", "aquaroute")
    password = os.environ.get(
        "WATER_DB_PASSWORD",
        os.environ.get("POSTGRES_PASSWORD", "change_me_local_only"),
    )
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def _json_default(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(type(obj).__name__)


def tags_equal(a: Any, b: Any) -> bool:
    da = dict(a or {})
    db = dict(b or {})
    return da == db


def tags_a_superset_of_b(a: Any, b: Any) -> bool:
    """True if every key in b is in a with the same value (a is richer or equal)."""
    da = dict(a or {})
    db = dict(b or {})
    for k, v in db.items():
        if k not in da or da[k] != v:
            return False
    return True


def record_conflict(
    cur: Any,
    *,
    osm_type: str,
    osm_id: int,
    batch_id: int,
    conflict_type: str,
    canonical_value: dict[str, Any],
    incoming_value: dict[str, Any],
    resolution: str = "keep_canonical",
    notes: str | None = None,
) -> bool:
    """Insert conflict if new. Returns True if a new row was inserted."""
    cur.execute(
        """
        INSERT INTO water.object_conflicts (
          osm_type, osm_id, batch_id, conflict_type,
          canonical_value, incoming_value, resolution, status, notes
        ) VALUES (
          %s, %s, %s, %s, %s, %s, %s, 'open', %s
        )
        ON CONFLICT (batch_id, osm_type, osm_id, conflict_type) DO NOTHING
        RETURNING id
        """,
        (
            osm_type,
            osm_id,
            batch_id,
            conflict_type,
            Json(canonical_value),
            Json(incoming_value),
            resolution,
            notes,
        ),
    )
    row = cur.fetchone()
    return row is not None


def link_batch(
    cur: Any, osm_type: str, osm_id: int, batch_id: int, link_role: str = "object"
) -> None:
    cur.execute(
        """
        INSERT INTO water.object_batch_links (osm_type, osm_id, batch_id, link_role)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT DO NOTHING
        """,
        (osm_type, osm_id, batch_id, link_role),
    )


def geometries_equal(cur: Any, geom_a: Any, geom_b: Any) -> bool:
    cur.execute(
        """
        SELECT (ST_Equals(%s::geometry, %s::geometry)
           AND ST_AsBinary(%s::geometry) = ST_AsBinary(%s::geometry)) AS eq
        """,
        (geom_a, geom_b, geom_a, geom_b),
    )
    row = cur.fetchone()
    return bool(row["eq"] if isinstance(row, dict) else row[0])


def geometry_is_valid(cur: Any, geom: Any) -> bool:
    cur.execute("SELECT ST_IsValid(%s::geometry) AS v", (geom,))
    row = cur.fetchone()
    return bool(row["v"] if isinstance(row, dict) else row[0])


def geometry_npoints(cur: Any, geom: Any) -> int:
    cur.execute("SELECT ST_NPoints(%s::geometry) AS n", (geom,))
    row = cur.fetchone()
    return int((row["n"] if isinstance(row, dict) else row[0]) or 0)


def merge_object_row(cur: Any, batch_id: int, st: dict[str, Any]) -> str:
    """
    Merge one staging object. Returns action:
      inserted | unchanged | conflict_keep_canonical | linked
    """
    osm_type = st["osm_type"]
    osm_id = int(st["osm_id"])

    cur.execute(
        """
        SELECT osm_type, osm_id, name, water_type, geometry, tags,
               source, source_version
        FROM water.objects
        WHERE osm_type = %s AND osm_id = %s
        """,
        (osm_type, osm_id),
    )
    canon = cur.fetchone()

    if canon is None:
        cur.execute(
            """
            INSERT INTO water.objects (
              osm_type, osm_id, name, water_type, geometry, tags,
              source, source_version, imported_at
            ) VALUES (
              %s, %s, %s, %s, %s, %s, %s, %s, now()
            )
            """,
            (
                osm_type,
                osm_id,
                st["name"],
                st["water_type"],
                st["geometry"],
                Json(dict(st["tags"] or {})),
                st["source"] or "osm",
                st["source_version"],
            ),
        )
        link_batch(cur, osm_type, osm_id, batch_id)
        return "inserted"

    # Existing: compare fields; never blind UPDATE
    any_conflict = False

    if (canon["name"] or None) != (st["name"] or None):
        any_conflict = True
        record_conflict(
            cur,
            osm_type=osm_type,
            osm_id=osm_id,
            batch_id=batch_id,
            conflict_type="name",
            canonical_value={"name": canon["name"]},
            incoming_value={"name": st["name"]},
            notes="name differs; keep_canonical",
        )

    if (canon["water_type"] or None) != (st["water_type"] or None):
        any_conflict = True
        record_conflict(
            cur,
            osm_type=osm_type,
            osm_id=osm_id,
            batch_id=batch_id,
            conflict_type="water_type",
            canonical_value={"water_type": canon["water_type"]},
            incoming_value={"water_type": st["water_type"]},
            notes="water_type differs; keep_canonical",
        )

    c_tags = dict(canon["tags"] or {})
    s_tags = dict(st["tags"] or {})
    if not tags_equal(c_tags, s_tags):
        # Richer incoming (superset with no disagreements) → still conflict for audit,
        # but note richness; default keep_canonical unless incoming is strict superset
        # and canonical is subset — then we MAY take_incoming for tags only.
        if tags_a_superset_of_b(s_tags, c_tags) and not tags_a_superset_of_b(c_tags, s_tags):
            resolution = "take_incoming"
            cur.execute(
                """
                UPDATE water.objects
                SET tags = %s, imported_at = now()
                WHERE osm_type = %s AND osm_id = %s
                """,
                (Json(s_tags), osm_type, osm_id),
            )
            record_conflict(
                cur,
                osm_type=osm_type,
                osm_id=osm_id,
                batch_id=batch_id,
                conflict_type="tags",
                canonical_value={"tags": c_tags},
                incoming_value={"tags": s_tags},
                resolution=resolution,
                notes="incoming tags strict superset of canonical; applied take_incoming",
            )
        else:
            any_conflict = True
            record_conflict(
                cur,
                osm_type=osm_type,
                osm_id=osm_id,
                batch_id=batch_id,
                conflict_type="tags",
                canonical_value={"tags": c_tags},
                incoming_value={"tags": s_tags},
                resolution="keep_canonical",
                notes="tags differ; keep_canonical (no silent overwrite)",
            )

    if not geometries_equal(cur, canon["geometry"], st["geometry"]):
        c_valid = geometry_is_valid(cur, canon["geometry"])
        s_valid = geometry_is_valid(cur, st["geometry"])
        c_pts = geometry_npoints(cur, canon["geometry"])
        s_pts = geometry_npoints(cur, st["geometry"])
        resolution = "keep_canonical"
        notes = "geometry differs; keep_canonical"
        # Policy: invalid never replaces valid; richer (more points) may win if both valid
        if c_valid and not s_valid:
            resolution = "keep_canonical"
            notes = "incoming invalid; keep valid canonical"
        elif (not c_valid) and s_valid:
            resolution = "take_incoming"
            notes = "canonical invalid; take valid incoming"
            cur.execute(
                """
                UPDATE water.objects
                SET geometry = %s, imported_at = now()
                WHERE osm_type = %s AND osm_id = %s
                """,
                (st["geometry"], osm_type, osm_id),
            )
        elif c_valid and s_valid and s_pts > c_pts:
            resolution = "take_incoming"
            notes = f"incoming richer ({s_pts}>{c_pts} points); take_incoming"
            cur.execute(
                """
                UPDATE water.objects
                SET geometry = %s, imported_at = now()
                WHERE osm_type = %s AND osm_id = %s
                """,
                (st["geometry"], osm_type, osm_id),
            )
        else:
            any_conflict = True

        cur.execute(
            """
            SELECT ST_AsText(%s::geometry) AS c_wkt, ST_AsText(%s::geometry) AS s_wkt,
                   GeometryType(%s::geometry) AS c_t, GeometryType(%s::geometry) AS s_t,
                   ST_NPoints(%s::geometry) AS c_n, ST_NPoints(%s::geometry) AS s_n
            """,
            (
                canon["geometry"],
                st["geometry"],
                canon["geometry"],
                st["geometry"],
                canon["geometry"],
                st["geometry"],
            ),
        )
        meta = cur.fetchone()
        record_conflict(
            cur,
            osm_type=osm_type,
            osm_id=osm_id,
            batch_id=batch_id,
            conflict_type="geometry",
            canonical_value={
                "geometry_type": meta["c_t"],
                "npoints": int(meta["c_n"] or 0),
                "wkt_sha1": hashlib.sha1((meta["c_wkt"] or "").encode()).hexdigest(),
            },
            incoming_value={
                "geometry_type": meta["s_t"],
                "npoints": int(meta["s_n"] or 0),
                "wkt_sha1": hashlib.sha1((meta["s_wkt"] or "").encode()).hexdigest(),
            },
            resolution=resolution,
            notes=notes,
        )
        if resolution == "keep_canonical":
            any_conflict = True

    link_batch(cur, osm_type, osm_id, batch_id)
    if any_conflict:
        return "conflict_keep_canonical"
    return "unchanged"


def membership_key(m: dict[str, Any]) -> tuple:
    return (m["member_osm_type"], int(m["member_osm_id"]), m["member_role"] or "")


def ordered_union_members(
    backbone: list[dict[str, Any]], other: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[tuple] = set()
    for m in backbone:
        k = membership_key(m)
        if k in seen:
            continue
        seen.add(k)
        merged.append(dict(m))
    for m in other:
        k = membership_key(m)
        if k in seen:
            continue
        seen.add(k)
        merged.append(dict(m))
    for i, m in enumerate(merged):
        m["seq"] = i
    return merged


def merge_relation_members(cur: Any, batch_id: int, parent_osm_id: int) -> dict[str, Any]:
    """
    Ordered union of canonical members with staging members for one relation.
    Never DELETE+replace-all.
    """
    cur.execute(
        """
        SELECT seq, member_osm_type, member_osm_id, member_role
        FROM water.object_members
        WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
        ORDER BY seq
        """,
        (parent_osm_id,),
    )
    canon = [dict(r) for r in cur.fetchall()]

    cur.execute(
        """
        SELECT seq, member_osm_type, member_osm_id, member_role
        FROM water.staging_members
        WHERE batch_id = %s
          AND parent_osm_type = 'relation'
          AND parent_osm_id = %s
        ORDER BY seq
        """,
        (batch_id, parent_osm_id),
    )
    staging = [dict(r) for r in cur.fetchall()]
    if not staging:
        return {"parent_osm_id": parent_osm_id, "action": "noop", "added": 0}

    # Detect seq disagreements for shared memberships
    canon_by_key = {membership_key(m): m for m in canon}
    for sm in staging:
        k = membership_key(sm)
        if k in canon_by_key and int(canon_by_key[k]["seq"]) != int(sm["seq"]):
            record_conflict(
                cur,
                osm_type="relation",
                osm_id=parent_osm_id,
                batch_id=batch_id,
                conflict_type="members_order",
                canonical_value={
                    "member": {
                        "type": k[0],
                        "id": k[1],
                        "role": k[2],
                        "seq": int(canon_by_key[k]["seq"]),
                    }
                },
                incoming_value={
                    "member": {
                        "type": k[0],
                        "id": k[1],
                        "role": k[2],
                        "seq": int(sm["seq"]),
                    }
                },
                resolution="keep_canonical",
                notes="same member with different seq; keep canonical order backbone",
            )

    # Backbone = longer list (tie → canonical if non-empty else staging)
    if len(canon) >= len(staging):
        backbone, other = canon, staging
    else:
        backbone, other = staging, canon

    merged = ordered_union_members(backbone, other)

    # Apply: insert only missing memberships; do not delete existing
    existing_keys = {membership_key(m) for m in canon}
    added = 0
    if not canon:
        # Fresh relation members: insert full merged list with seq
        for m in merged:
            cur.execute(
                """
                INSERT INTO water.object_members (
                  parent_osm_type, parent_osm_id, seq,
                  member_osm_type, member_osm_id, member_role
                ) VALUES ('relation', %s, %s, %s, %s, %s)
                """,
                (
                    parent_osm_id,
                    int(m["seq"]),
                    m["member_osm_type"],
                    int(m["member_osm_id"]),
                    m["member_role"] or "",
                ),
            )
            added += 1
    else:
        # Keep canonical seq for existing; append new members after max seq
        cur.execute(
            """
            SELECT COALESCE(MAX(seq), -1) AS max_seq
            FROM water.object_members
            WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
            """,
            (parent_osm_id,),
        )
        next_seq = int(cur.fetchone()["max_seq"]) + 1
        for m in merged:
            k = membership_key(m)
            if k in existing_keys:
                continue
            cur.execute(
                """
                INSERT INTO water.object_members (
                  parent_osm_type, parent_osm_id, seq,
                  member_osm_type, member_osm_id, member_role
                ) VALUES ('relation', %s, %s, %s, %s, %s)
                """,
                (
                    parent_osm_id,
                    next_seq,
                    m["member_osm_type"],
                    int(m["member_osm_id"]),
                    m["member_role"] or "",
                ),
            )
            next_seq += 1
            added += 1

    link_batch(cur, "relation", parent_osm_id, batch_id, "member_contrib")
    return {
        "parent_osm_id": parent_osm_id,
        "action": "union",
        "added": added,
        "canonical_before": len(canon),
        "staging": len(staging),
        "canonical_after_estimate": len(canon) + added,
    }


def merge_batch(conn: Any, batch_id: int) -> dict[str, Any]:
    actions: dict[str, int] = {}

    def bump(k: str) -> None:
        actions[k] = actions.get(k, 0) + 1

    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            "SELECT id, batch_key, status FROM water.import_batches WHERE id = %s",
            (batch_id,),
        )
        batch = cur.fetchone()
        if batch is None:
            raise RuntimeError(f"batch {batch_id} not found")
        cur.execute(
            "UPDATE water.import_batches SET status = 'merging' WHERE id = %s",
            (batch_id,),
        )

        cur.execute(
            """
            SELECT id, osm_type, osm_id, name, water_type, geometry, tags,
                   source, source_version
            FROM water.staging_objects
            WHERE batch_id = %s
            ORDER BY osm_type, osm_id
            """,
            (batch_id,),
        )
        staging_objects = [dict(r) for r in cur.fetchall()]
        for st in staging_objects:
            action = merge_object_row(cur, batch_id, st)
            bump(action)

        cur.execute(
            """
            SELECT DISTINCT parent_osm_id
            FROM water.staging_members
            WHERE batch_id = %s AND parent_osm_type = 'relation'
            ORDER BY parent_osm_id
            """,
            (batch_id,),
        )
        parents = [int(r["parent_osm_id"]) for r in cur.fetchall()]
        member_results = []
        for pid in parents:
            member_results.append(merge_relation_members(cur, batch_id, pid))

        cur.execute(
            "UPDATE water.import_batches SET status = 'merged' WHERE id = %s",
            (batch_id,),
        )

    return {
        "batch_id": batch_id,
        "batch_key": batch["batch_key"],
        "objects": actions,
        "members": member_results,
        "ok": True,
    }


def create_batch(
    cur: Any,
    *,
    batch_key: str,
    source_version: str,
    dataset_name: str,
    notes: str | None = None,
    source: str = "osm",
) -> int:
    cur.execute(
        """
        INSERT INTO water.import_batches (
          batch_key, source, source_version, dataset_name, status, notes
        ) VALUES (%s, %s, %s, %s, 'loaded', %s)
        ON CONFLICT (batch_key) DO UPDATE
          SET notes = EXCLUDED.notes
        RETURNING id
        """,
        (batch_key, source, source_version, dataset_name, notes),
    )
    return int(cur.fetchone()["id"])


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn", default=None)
    parser.add_argument("--batch-id", type=int, required=True)
    args = parser.parse_args(argv)
    dsn = args.dsn or default_dsn()
    parsed = urlparse(dsn)
    print(
        f"DSN {parsed.scheme}://{parsed.username}@***"
        f"{parsed.hostname}:{parsed.port}{parsed.path}"
    )

    conn = psycopg2.connect(dsn)
    try:
        result = merge_batch(conn, args.batch_id)
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()

    print(json.dumps(result, indent=2, ensure_ascii=False, default=_json_default))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
