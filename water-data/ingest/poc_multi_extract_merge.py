#!/usr/bin/env python3
"""
AquaRoute E3.6 PoC — multi-extract relation member merge (TEMP tables only).

Uses REAL Belomor relation 9909116 members already in water.object_members.
Does NOT:
  - download new PBFs
  - invent OSM geometry
  - modify permanent water.* tables
  - create graph / seams

Simulates two batches that each saw a partial member list (as regional extracts
would), then merges with dedupe + order-preserving union.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.parse import urlparse

import psycopg2
from psycopg2.extras import RealDictCursor


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


def fetch_belomor_members(cur: Any) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT seq, member_osm_type, member_osm_id, member_role
        FROM water.object_members
        WHERE parent_osm_type = 'relation' AND parent_osm_id = 9909116
        ORDER BY seq
        """
    )
    rows = cur.fetchall()
    if len(rows) != 29:
        raise RuntimeError(f"expected 29 Belomor members, got {len(rows)}")
    return [dict(r) for r in rows]


def membership_key(m: dict[str, Any]) -> tuple:
    return (m["member_osm_type"], int(m["member_osm_id"]), m["member_role"] or "")


def merge_members(
    batch_a: list[dict[str, Any]], batch_b: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """
    Order-preserving union:
    - backbone = longer batch (tie -> A)
    - walk the other batch; append members not yet seen, keeping relative order
    - identity = (member_osm_type, member_osm_id, member_role)
    """
    if len(batch_b) > len(batch_a):
        backbone, other = batch_b, batch_a
    else:
        backbone, other = batch_a, batch_b

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

    # Reassign seq densely 0..n-1 after merge
    for i, m in enumerate(merged):
        m["seq"] = i
    return merged


def run_poc(dsn: str) -> dict[str, Any]:
    conn = psycopg2.connect(dsn)
    conn.autocommit = False
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            # Fingerprint before (must remain unchanged)
            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM water.objects) AS objects,
                  (SELECT count(*) FROM water.object_members) AS members
                """
            )
            before = {k: int(v) for k, v in cur.fetchone().items()}

            all_members = fetch_belomor_members(cur)
            # Split into two overlapping "extracts" using real memberships only.
            mid = len(all_members) // 2  # 14
            batch_a = all_members[: mid + 1]  # seq 0..14 (15 members)
            batch_b = all_members[mid:]  # seq 14..28 (15 members), overlap on seq 14

            # TEMP staging — no permanent DDL
            cur.execute("DROP TABLE IF EXISTS tmp_e36_batches")
            cur.execute("DROP TABLE IF EXISTS tmp_e36_staging_members")
            cur.execute("DROP TABLE IF EXISTS tmp_e36_merged_members")
            cur.execute(
                """
                CREATE TEMP TABLE tmp_e36_batches (
                  batch_id TEXT PRIMARY KEY,
                  source_version TEXT NOT NULL,
                  notes TEXT
                )
                """
            )
            cur.execute(
                """
                CREATE TEMP TABLE tmp_e36_staging_members (
                  batch_id TEXT NOT NULL,
                  parent_osm_type TEXT NOT NULL,
                  parent_osm_id BIGINT NOT NULL,
                  seq INTEGER NOT NULL,
                  member_osm_type TEXT NOT NULL,
                  member_osm_id BIGINT NOT NULL,
                  member_role TEXT NOT NULL DEFAULT ''
                )
                """
            )
            cur.execute(
                """
                INSERT INTO tmp_e36_batches (batch_id, source_version, notes) VALUES
                  ('A', 'poc-karelia-west-slice', 'Belomor members seq 0..14 from live DB'),
                  ('B', 'poc-karelia-east-slice', 'Belomor members seq 14..28 from live DB')
                """
            )

            for batch_id, members in (("A", batch_a), ("B", batch_b)):
                for m in members:
                    cur.execute(
                        """
                        INSERT INTO tmp_e36_staging_members (
                          batch_id, parent_osm_type, parent_osm_id, seq,
                          member_osm_type, member_osm_id, member_role
                        ) VALUES (%s, 'relation', 9909116, %s, %s, %s, %s)
                        """,
                        (
                            batch_id,
                            int(m["seq"]),
                            m["member_osm_type"],
                            int(m["member_osm_id"]),
                            m["member_role"] or "",
                        ),
                    )

            merged = merge_members(batch_a, batch_b)
            cur.execute(
                """
                CREATE TEMP TABLE tmp_e36_merged_members (
                  parent_osm_type TEXT NOT NULL,
                  parent_osm_id BIGINT NOT NULL,
                  seq INTEGER NOT NULL,
                  member_osm_type TEXT NOT NULL,
                  member_osm_id BIGINT NOT NULL,
                  member_role TEXT NOT NULL,
                  PRIMARY KEY (parent_osm_type, parent_osm_id, seq),
                  UNIQUE (parent_osm_type, parent_osm_id, member_osm_type, member_osm_id, member_role)
                )
                """
            )
            for m in merged:
                cur.execute(
                    """
                    INSERT INTO tmp_e36_merged_members (
                      parent_osm_type, parent_osm_id, seq,
                      member_osm_type, member_osm_id, member_role
                    ) VALUES ('relation', 9909116, %s, %s, %s, %s)
                    """,
                    (
                        int(m["seq"]),
                        m["member_osm_type"],
                        int(m["member_osm_id"]),
                        m["member_role"] or "",
                    ),
                )

            cur.execute("SELECT count(*) AS n FROM tmp_e36_merged_members")
            merged_count = int(cur.fetchone()["n"])
            cur.execute(
                """
                SELECT count(*) AS n FROM (
                  SELECT member_osm_type, member_osm_id, member_role
                  FROM tmp_e36_merged_members
                  GROUP BY 1, 2, 3
                ) u
                """
            )
            unique_memberships = int(cur.fetchone()["n"])

            cur.execute(
                """
                SELECT count(*) AS n
                FROM tmp_e36_merged_members m
                JOIN water.object_members c
                  ON c.parent_osm_type = 'relation'
                 AND c.parent_osm_id = 9909116
                 AND c.member_osm_type = m.member_osm_type
                 AND c.member_osm_id = m.member_osm_id
                 AND c.member_role = m.member_role
                """
            )
            overlap_with_canonical = int(cur.fetchone()["n"])

            # Roles all main_stream?
            cur.execute(
                """
                SELECT member_role, count(*) AS n
                FROM tmp_e36_merged_members
                GROUP BY 1 ORDER BY 1
                """
            )
            roles = {r["member_role"]: int(r["n"]) for r in cur.fetchall()}

            # Staging provenance counts
            cur.execute(
                """
                SELECT batch_id, count(*) AS n
                FROM tmp_e36_staging_members
                GROUP BY 1 ORDER BY 1
                """
            )
            staging_counts = {r["batch_id"]: int(r["n"]) for r in cur.fetchall()}

            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM water.objects) AS objects,
                  (SELECT count(*) FROM water.object_members) AS members
                """
            )
            after = {k: int(v) for k, v in cur.fetchone().items()}

        # Roll back TEMP work — also guarantees no accidental durable writes
        conn.rollback()
    finally:
        conn.close()

    expected_ids = {(m["member_osm_type"], int(m["member_osm_id"]), m["member_role"] or "") for m in all_members}
    merged_ids = {(m["member_osm_type"], int(m["member_osm_id"]), m["member_role"] or "") for m in merged}

    result = {
        "poc": "e36_multi_extract_member_merge",
        "relation": 9909116,
        "batch_a_members": len(batch_a),
        "batch_b_members": len(batch_b),
        "overlap_memberships": 1,
        "staging_counts": staging_counts,
        "merged_count": merged_count,
        "unique_memberships": unique_memberships,
        "roles": roles,
        "merged_equals_canonical_set": expected_ids == merged_ids,
        "overlap_with_canonical_rows": overlap_with_canonical,
        "permanent_tables_unchanged": before == after,
        "fingerprint_before": before,
        "fingerprint_after": after,
        "assertions": {
            "merged_count_29": merged_count == 29,
            "no_dup_memberships": merged_count == unique_memberships,
            "all_main_stream": roles.get("main_stream") == 29,
            "set_equals_live_belomor": expected_ids == merged_ids,
            "db_unchanged": before == after,
        },
    }
    result["ok"] = all(result["assertions"].values())
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn", default=None)
    args = parser.parse_args(argv)
    dsn = args.dsn or default_dsn()
    parsed = urlparse(dsn)
    print(
        f"DSN {parsed.scheme}://{parsed.username}@***"
        f"{parsed.hostname}:{parsed.port}{parsed.path}"
    )
    result = run_poc(dsn)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
