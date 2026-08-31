#!/usr/bin/env python3
"""
AquaRoute E3.7 PoC — staging + merge on real Belomor 9909116 data.

Steps:
  1. Apply is assumed done (005–008).
  2. Snapshot fingerprint + Belomor members.
  3. Remove members seq>=15 from canonical (controlled incomplete setup).
  4. Load batch A (seq 0..19) and batch B (seq 19..28) into staging from REAL rows.
  5. Merge A then B → expect 29 unique members restored.
  6. Negative tags conflict on a real member way (no geometry invent).
  7. Re-merge same batches → idempotent (no dup members/conflicts flood).
  8. Assert fingerprint objects unchanged; members back to baseline.

Does not download new PBFs. Does not touch sea-map.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any
from urllib.parse import urlparse

import psycopg2
from psycopg2.extras import Json, RealDictCursor

# Local import
sys.path.insert(0, os.path.dirname(__file__))
from merge_staging import create_batch, default_dsn, merge_batch  # noqa: E402


BEL = 9909116


def fingerprint(cur: Any) -> dict[str, int]:
    cur.execute(
        """
        SELECT
          (SELECT count(*) FROM water.objects) AS objects,
          (SELECT count(*) FROM water.object_members) AS members
        """
    )
    row = cur.fetchone()
    return {"objects": int(row["objects"]), "members": int(row["members"])}


def belomor_member_count(cur: Any) -> int:
    cur.execute(
        """
        SELECT count(*) AS n FROM water.object_members
        WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
        """,
        (BEL,),
    )
    return int(cur.fetchone()["n"])


def load_belomor_members(cur: Any) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT seq, member_osm_type, member_osm_id, member_role
        FROM water.object_members
        WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
        ORDER BY seq
        """,
        (BEL,),
    )
    rows = [dict(r) for r in cur.fetchall()]
    if len(rows) != 29:
        raise RuntimeError(f"Belomor must start complete (29), got {len(rows)}")
    return rows


def stage_relation_and_members(
    cur: Any,
    batch_id: int,
    members: list[dict[str, Any]],
    *,
    tags_override: dict[str, Any] | None = None,
) -> None:
    """Copy relation + listed member ways from canonical into staging."""
    cur.execute(
        """
        SELECT osm_type, osm_id, name, water_type, geometry, tags, source, source_version
        FROM water.objects
        WHERE osm_type = 'relation' AND osm_id = %s
        """,
        (BEL,),
    )
    rel = cur.fetchone()
    if rel is None:
        raise RuntimeError("Belomor relation missing in canonical")

    tags = dict(rel["tags"] or {})
    if tags_override:
        tags = {**tags, **tags_override}

    cur.execute(
        """
        INSERT INTO water.staging_objects (
          batch_id, osm_type, osm_id, name, water_type, geometry, tags,
          source, source_version
        ) VALUES (
          %s, 'relation', %s, %s, %s, %s, %s, %s, %s
        )
        ON CONFLICT (batch_id, osm_type, osm_id) DO UPDATE SET
          tags = EXCLUDED.tags,
          name = EXCLUDED.name
        """,
        (
            batch_id,
            BEL,
            rel["name"],
            rel["water_type"],
            rel["geometry"],
            Json(tags),
            rel["source"],
            rel["source_version"],
        ),
    )

    for m in members:
        cur.execute(
            """
            INSERT INTO water.staging_members (
              batch_id, parent_osm_type, parent_osm_id, seq,
              member_osm_type, member_osm_id, member_role
            ) VALUES (%s, 'relation', %s, %s, %s, %s, %s)
            ON CONFLICT (batch_id, parent_osm_type, parent_osm_id, seq) DO UPDATE SET
              member_osm_type = EXCLUDED.member_osm_type,
              member_osm_id = EXCLUDED.member_osm_id,
              member_role = EXCLUDED.member_role
            """,
            (
                batch_id,
                BEL,
                int(m["seq"]),
                m["member_osm_type"],
                int(m["member_osm_id"]),
                m["member_role"] or "",
            ),
        )
        # Stage the member way object (real geometry from canonical)
        if m["member_osm_type"] != "way":
            continue
        cur.execute(
            """
            SELECT osm_type, osm_id, name, water_type, geometry, tags, source, source_version
            FROM water.objects
            WHERE osm_type = 'way' AND osm_id = %s
            """,
            (int(m["member_osm_id"]),),
        )
        way = cur.fetchone()
        if way is None:
            # Do not create placeholder — skip object staging (member row still staged)
            continue
        cur.execute(
            """
            INSERT INTO water.staging_objects (
              batch_id, osm_type, osm_id, name, water_type, geometry, tags,
              source, source_version
            ) VALUES (
              %s, 'way', %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (batch_id, osm_type, osm_id) DO NOTHING
            """,
            (
                batch_id,
                int(way["osm_id"]),
                way["name"],
                way["water_type"],
                way["geometry"],
                Json(dict(way["tags"] or {})),
                way["source"],
                way["source_version"],
            ),
        )


def stage_conflicting_way_tags(cur: Any, batch_id: int, way_osm_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT osm_type, osm_id, name, water_type, geometry, tags, source, source_version
        FROM water.objects
        WHERE osm_type = 'way' AND osm_id = %s
        """,
        (way_osm_id,),
    )
    way = cur.fetchone()
    if way is None:
        raise RuntimeError(f"way {way_osm_id} not in canonical")
    tags = dict(way["tags"] or {})
    incoming = {
        **tags,
        "_e37_conflict_probe": "1",
        "name": (tags.get("name") or "canal-segment") + " [E37-CONFLICT]",
    }
    cur.execute(
        """
        INSERT INTO water.staging_objects (
          batch_id, osm_type, osm_id, name, water_type, geometry, tags,
          source, source_version
        ) VALUES (
          %s, 'way', %s, %s, %s, %s, %s, %s, %s
        )
        ON CONFLICT (batch_id, osm_type, osm_id) DO UPDATE SET
          tags = EXCLUDED.tags,
          name = EXCLUDED.name
        """,
        (
            batch_id,
            way_osm_id,
            incoming.get("name"),
            way["water_type"],
            way["geometry"],
            Json(incoming),
            way["source"],
            "e37-negative-tags-probe",
        ),
    )
    return {"way_osm_id": way_osm_id, "canonical_tags": tags, "incoming_tags": incoming}


def run(dsn: str) -> dict[str, Any]:
    report: dict[str, Any] = {"ok": False}
    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            baseline = fingerprint(cur)
            report["baseline"] = baseline
            members = load_belomor_members(cur)
            probe_way_id = int(members[0]["member_osm_id"])

            # Controlled incomplete setup (document in report)
            cur.execute(
                """
                DELETE FROM water.object_members
                WHERE parent_osm_type = 'relation'
                  AND parent_osm_id = %s
                  AND seq >= 15
                """,
                (BEL,),
            )
            after_delete = belomor_member_count(cur)
            report["after_controlled_delete_members"] = after_delete
            if after_delete != 15:
                raise RuntimeError(f"expected 15 members after delete, got {after_delete}")

            batch_a = members[:20]  # seq 0..19
            batch_b = members[19:]  # seq 19..28 (overlap on 19)

            id_a = create_batch(
                cur,
                batch_key="e37-poc-belomor-A",
                source_version="e37-poc-A",
                dataset_name="belomor-members-0-19",
                notes="PoC batch A from live Belomor members",
            )
            id_b = create_batch(
                cur,
                batch_key="e37-poc-belomor-B",
                source_version="e37-poc-B",
                dataset_name="belomor-members-19-28",
                notes="PoC batch B from live Belomor members",
            )
            id_neg = create_batch(
                cur,
                batch_key="e37-poc-tags-conflict",
                source_version="e37-negative-tags",
                dataset_name="belomor-way-tags-probe",
                notes="Negative tags conflict probe",
            )
            report["batch_ids"] = {"A": id_a, "B": id_b, "neg": id_neg}

            stage_relation_and_members(cur, id_a, batch_a)
            stage_relation_and_members(cur, id_b, batch_b)
            neg_meta = stage_conflicting_way_tags(cur, id_neg, probe_way_id)
            report["negative_probe"] = {
                "way_osm_id": neg_meta["way_osm_id"],
                "incoming_extra_key": "_e37_conflict_probe",
            }
        conn.commit()

        # Merge A
        r_a = merge_batch(conn, id_a)
        conn.commit()
        # Merge B
        r_b = merge_batch(conn, id_b)
        conn.commit()
        # Negative tags merge
        r_neg = merge_batch(conn, id_neg)
        conn.commit()

        report["merge_A"] = r_a
        report["merge_B"] = r_b
        report["merge_neg"] = r_neg

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            n_members = belomor_member_count(cur)
            cur.execute(
                """
                SELECT count(*) AS n FROM (
                  SELECT member_osm_type, member_osm_id, member_role
                  FROM water.object_members
                  WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
                  GROUP BY 1, 2, 3
                ) u
                """,
                (BEL,),
            )
            unique_m = int(cur.fetchone()["n"])
            cur.execute(
                """
                SELECT member_role, count(*) AS n
                FROM water.object_members
                WHERE parent_osm_type = 'relation' AND parent_osm_id = %s
                GROUP BY 1
                """,
                (BEL,),
            )
            roles = {r["member_role"]: int(r["n"]) for r in cur.fetchall()}

            cur.execute(
                """
                SELECT count(*) AS n FROM water.object_conflicts
                WHERE batch_id = %s AND conflict_type IN ('tags', 'name')
                """,
                (id_neg,),
            )
            neg_conflicts = int(cur.fetchone()["n"])

            cur.execute(
                "SELECT tags FROM water.objects WHERE osm_type = 'way' AND osm_id = %s",
                (probe_way_id,),
            )
            canon_tags = dict(cur.fetchone()["tags"] or {})

            fp_after = fingerprint(cur)

            # Idempotency: merge A and B again
        r_a2 = merge_batch(conn, id_a)
        conn.commit()
        r_b2 = merge_batch(conn, id_b)
        conn.commit()
        r_neg2 = merge_batch(conn, id_neg)
        conn.commit()

        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            fp_idem = fingerprint(cur)
            n_members_idem = belomor_member_count(cur)
            cur.execute(
                """
                SELECT count(*) AS n FROM water.object_conflicts
                WHERE batch_id = %s AND conflict_type IN ('tags', 'name')
                """,
                (id_neg,),
            )
            neg_conflicts_idem = int(cur.fetchone()["n"])
            cur.execute("SELECT count(*) AS n FROM water.object_batch_links")
            links = int(cur.fetchone()["n"])
            cur.execute("SELECT count(*) AS n FROM water.import_batches")
            batches = int(cur.fetchone()["n"])

        report["after_merge"] = {
            "belomor_members": n_members,
            "belomor_unique_memberships": unique_m,
            "roles": roles,
            "fingerprint": fp_after,
            "negative_conflicts": neg_conflicts,
            "canonical_has_probe_tag": "_e37_conflict_probe" in canon_tags,
        }
        report["idempotency"] = {
            "merge_A2": r_a2,
            "merge_B2": r_b2,
            "merge_neg2": r_neg2,
            "fingerprint": fp_idem,
            "belomor_members": n_members_idem,
            "negative_conflicts": neg_conflicts_idem,
        }
        report["framework_counts"] = {
            "import_batches": batches,
            "object_batch_links": links,
        }

        assertions = {
            "belomor_29": n_members == 29 and unique_m == 29,
            "all_main_stream": roles.get("main_stream") == 29,
            "objects_unchanged": fp_after["objects"] == baseline["objects"],
            "members_restored": fp_after["members"] == baseline["members"],
            "negative_conflict_recorded": neg_conflicts >= 1,
            "canonical_tags_not_silently_overwritten": "_e37_conflict_probe"
            not in canon_tags,
            "idempotent_members": n_members_idem == 29,
            "idempotent_fingerprint": fp_idem == fp_after,
            "idempotent_conflicts": neg_conflicts_idem == neg_conflicts,
        }
        report["assertions"] = assertions
        report["ok"] = all(assertions.values())
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
    return report


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
    report = run(dsn)
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0 if report.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
