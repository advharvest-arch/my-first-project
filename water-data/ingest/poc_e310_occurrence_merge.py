#!/usr/bin/env python3
"""
AquaRoute E3.10 — TEMP PoC: relation member occurrence identity.

Uses real memberships from relation 14000871 (Oulankajoki) but NEVER writes
to water.object_members / water.objects.

Policy under test:
  occurrence_key = (member_type, member_id, role, seq)
  Ordered union must preserve duplicate OSM members at different seq
  (A@30, B@31, A@32, B@33 → 4 occurrences, not 2).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

# Shared with merge_staging (occurrence-aware)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from merge_staging import (  # noqa: E402
    occurrence_key,
    ordered_union_members_by_occurrence,
)


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


RELATION_ID = 14000871
# The known duplicate window from Karelia OSM
FOCUS_SEQS = {30, 31, 32, 33}


def legacy_union_collapse(backbone: list[dict], other: list[dict]) -> list[dict]:
    """E3.7 identity (type, id, role) — collapses legitimate OSM duplicates."""
    seen: set[tuple] = set()
    merged: list[dict] = []
    for m in backbone + other:
        k = (
            m["member_osm_type"],
            int(m["member_osm_id"]),
            m["member_role"] or "",
        )
        if k in seen:
            continue
        seen.add(k)
        merged.append(dict(m))
    return merged


def main() -> int:
    dsn = default_dsn()
    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(
                """
                SELECT seq, member_osm_type, member_osm_id, member_role
                FROM water.object_members
                WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
                ORDER BY seq
                """,
                (RELATION_ID,),
            )
            canon_full = [dict(r) for r in cur.fetchall()]
            focus = [m for m in canon_full if int(m["seq"]) in FOCUS_SEQS]
            assert len(focus) == 4, f"expected 4 focus members, got {len(focus)}"

            # TEMP staging simulation — do not touch production tables
            cur.execute("CREATE TEMP TABLE e310_batch_a (LIKE water.object_members INCLUDING DEFAULTS)")
            cur.execute("CREATE TEMP TABLE e310_batch_b (LIKE water.object_members INCLUDING DEFAULTS)")

            # Batch A: full duplicate window (as in OSM / Karelia)
            for m in focus:
                cur.execute(
                    """
                    INSERT INTO e310_batch_a (
                      parent_osm_type, parent_osm_id, seq,
                      member_osm_type, member_osm_id, member_role
                    ) VALUES ('relation', %s, %s, %s, %s, %s)
                    """,
                    (
                        RELATION_ID,
                        int(m["seq"]),
                        m["member_osm_type"],
                        int(m["member_osm_id"]),
                        m["member_role"] or "",
                    ),
                )

            # Batch B: partial overlap — only seq 30,31 plus a new seq 34 member
            # (reuse an existing non-focus member from the real relation as "new")
            partial = [m for m in focus if int(m["seq"]) in (30, 31)]
            extra = next(m for m in canon_full if int(m["seq"]) == 34)
            batch_b_members = partial + [
                {
                    "seq": 34,
                    "member_osm_type": extra["member_osm_type"],
                    "member_osm_id": extra["member_osm_id"],
                    "member_role": extra["member_role"] or "",
                }
            ]
            for m in batch_b_members:
                cur.execute(
                    """
                    INSERT INTO e310_batch_b (
                      parent_osm_type, parent_osm_id, seq,
                      member_osm_type, member_osm_id, member_role
                    ) VALUES ('relation', %s, %s, %s, %s, %s)
                    """,
                    (
                        RELATION_ID,
                        int(m["seq"]),
                        m["member_osm_type"],
                        int(m["member_osm_id"]),
                        m["member_role"] or "",
                    ),
                )

            cur.execute(
                "SELECT seq, member_osm_type, member_osm_id, member_role "
                "FROM e310_batch_a ORDER BY seq"
            )
            a = [dict(r) for r in cur.fetchall()]
            cur.execute(
                "SELECT seq, member_osm_type, member_osm_id, member_role "
                "FROM e310_batch_b ORDER BY seq"
            )
            b = [dict(r) for r in cur.fetchall()]

            legacy = legacy_union_collapse(a, b)
            occurrence = ordered_union_members_by_occurrence(a, b)

            # Focus occurrences after occurrence-aware merge (seq 30-33)
            focus_after = [
                m for m in occurrence if int(m["seq"]) in FOCUS_SEQS
            ]
            # Also count by occurrence keys from A that must survive
            a_keys = {occurrence_key(m) for m in a}
            merged_keys = {occurrence_key(m) for m in occurrence}
            preserved = a_keys <= merged_keys

            # Production fingerprint untouched
            cur.execute(
                """
                SELECT
                  (SELECT count(*) FROM water.objects) AS objects,
                  (SELECT count(*) FROM water.object_members) AS members,
                  (SELECT count(*) FROM water.object_members
                   WHERE parent_osm_id = %s) AS rel_members
                """,
                (RELATION_ID,),
            )
            fp = {k: int(v) for k, v in dict(cur.fetchone()).items()}

            # TEMP tables drop on commit/rollback — rollback to be extra safe
            conn.rollback()

            report = {
                "relation_id": RELATION_ID,
                "batch_a": [
                    f"{m['seq']}:{m['member_osm_type']}/{m['member_osm_id']}/{m['member_role']}"
                    for m in a
                ],
                "batch_b": [
                    f"{m['seq']}:{m['member_osm_type']}/{m['member_osm_id']}/{m['member_role']}"
                    for m in b
                ],
                "legacy_e37_collapsed_count": len(legacy),
                "legacy_focus_unique_type_id_role": len(
                    {
                        (
                            m["member_osm_type"],
                            int(m["member_osm_id"]),
                            m["member_role"] or "",
                        )
                        for m in a
                    }
                ),
                "occurrence_merge_count": len(occurrence),
                "occurrence_focus_30_33_count": len(focus_after),
                "occurrence_keys_from_a_preserved": preserved,
                "pass_four_occurrences": len(focus_after) == 4 and preserved,
                "fingerprint": fp,
                "canonical_relation_unchanged": fp["rel_members"] == 40,
                "policy": (
                    "occurrence_key=(member_type, member_id, role, seq); "
                    "ordered union must not collapse legitimate OSM duplicates"
                ),
            }
            print(json.dumps(report, ensure_ascii=False, indent=2))
            return 0 if report["pass_four_occurrences"] else 1


if __name__ == "__main__":
    sys.exit(main())
