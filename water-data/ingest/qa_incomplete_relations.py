#!/usr/bin/env python3
"""
AquaRoute E3.5 — classify incomplete water.object_members using the LOCAL PBF.

No OSM API mass queries. No fixes. Read-only vs PostgreSQL + local extract.

Classification (evidence-based):
  extract_boundary  — every missing member id is ABSENT from the PBF
  internal_missing  — every missing member id is PRESENT in the PBF
                      (ingest/filter did not materialize it into water.objects)
  mixed             — some missing ids in PBF, some not
  unknown           — could not resolve (should be rare)

Also reports whether the relation geometry bbox touches the extract extent
(within a small epsilon) — supporting signal only, not sole proof.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from decimal import Decimal
from typing import Any
from urllib.parse import urlparse

import osmium
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


@dataclass
class IncompleteRel:
    relation_osm_id: int
    name: str | None
    water_type: str | None
    tags: dict
    members_total: int
    members_present: int
    members_missing: int
    missing_ways: int
    missing_nodes: int
    missing_relations: int
    xmin: float | None
    ymin: float | None
    xmax: float | None
    ymax: float | None
    missing: list[tuple[str, int]]  # (member_osm_type, member_osm_id)


class PresenceHandler(osmium.SimpleHandler):
    def __init__(self, need_n: set[int], need_w: set[int], need_r: set[int]) -> None:
        super().__init__()
        self.need_n = need_n
        self.need_w = need_w
        self.need_r = need_r
        self.found_n: set[int] = set()
        self.found_w: set[int] = set()
        self.found_r: set[int] = set()

    def node(self, n: osmium.osm.Node) -> None:
        if n.id in self.need_n:
            self.found_n.add(n.id)

    def way(self, w: osmium.osm.Way) -> None:
        if w.id in self.need_w:
            self.found_w.add(w.id)

    def relation(self, r: osmium.osm.Relation) -> None:
        if r.id in self.need_r:
            self.found_r.add(r.id)


def touches_extract_bbox(
    rel: IncompleteRel,
    ex: tuple[float, float, float, float],
    eps: float = 0.02,
) -> bool | None:
    """True if relation bbox is within eps of extract edge (supporting signal)."""
    if None in (rel.xmin, rel.ymin, rel.xmax, rel.ymax):
        return None
    xmin, ymin, xmax, ymax = ex
    return (
        abs(rel.xmin - xmin) <= eps
        or abs(rel.xmax - xmax) <= eps
        or abs(rel.ymin - ymin) <= eps
        or abs(rel.ymax - ymax) <= eps
    )


def fetch_incomplete(conn: Any) -> tuple[list[IncompleteRel], tuple[float, float, float, float], dict[str, int]]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT
              ST_XMin(g) AS xmin, ST_YMin(g) AS ymin,
              ST_XMax(g) AS xmax, ST_YMax(g) AS ymax
            FROM (SELECT ST_Extent(geometry)::geometry AS g FROM water.objects) e
            """
        )
        ext = cur.fetchone()
        extract_bbox = (
            float(ext["xmin"]),
            float(ext["ymin"]),
            float(ext["xmax"]),
            float(ext["ymax"]),
        )

        cur.execute(
            """
            SELECT
              (SELECT count(*) FROM water.objects) AS objects,
              (SELECT count(*) FROM water.object_members) AS members,
              (SELECT count(*) FROM water.objects WHERE osm_type = 'relation') AS relations
            """
        )
        fingerprint = {k: int(v) for k, v in cur.fetchone().items()}

        cur.execute(
            """
            WITH per_rel AS (
              SELECT
                m.parent_osm_id AS relation_osm_id,
                count(*) AS members_total,
                count(o.osm_id) AS members_present,
                count(*) - count(o.osm_id) AS members_missing,
                count(*) FILTER (
                  WHERE m.member_osm_type = 'way' AND o.osm_id IS NULL
                ) AS missing_ways,
                count(*) FILTER (
                  WHERE m.member_osm_type = 'node' AND o.osm_id IS NULL
                ) AS missing_nodes,
                count(*) FILTER (
                  WHERE m.member_osm_type = 'relation' AND o.osm_id IS NULL
                ) AS missing_relations
              FROM water.object_members m
              LEFT JOIN water.objects o
                ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
              WHERE m.parent_osm_type = 'relation'
              GROUP BY 1
              HAVING count(*) - count(o.osm_id) > 0
            )
            SELECT
              p.*,
              r.name,
              r.water_type,
              r.tags,
              ST_XMin(r.geometry) AS xmin,
              ST_YMin(r.geometry) AS ymin,
              ST_XMax(r.geometry) AS xmax,
              ST_YMax(r.geometry) AS ymax
            FROM per_rel p
            JOIN water.objects r
              ON r.osm_type = 'relation' AND r.osm_id = p.relation_osm_id
            ORDER BY p.members_missing DESC, p.relation_osm_id
            """
        )
        rows = cur.fetchall()

        incomplete: list[IncompleteRel] = []
        for row in rows:
            cur.execute(
                """
                SELECT m.member_osm_type, m.member_osm_id
                FROM water.object_members m
                LEFT JOIN water.objects o
                  ON o.osm_type = m.member_osm_type AND o.osm_id = m.member_osm_id
                WHERE m.parent_osm_type = 'relation'
                  AND m.parent_osm_id = %s
                  AND o.osm_id IS NULL
                ORDER BY m.seq
                """,
                (row["relation_osm_id"],),
            )
            missing = [(r["member_osm_type"], int(r["member_osm_id"])) for r in cur.fetchall()]
            tags = row["tags"]
            if isinstance(tags, str):
                tags = json.loads(tags)
            incomplete.append(
                IncompleteRel(
                    relation_osm_id=int(row["relation_osm_id"]),
                    name=row["name"],
                    water_type=row["water_type"],
                    tags=dict(tags or {}),
                    members_total=int(row["members_total"]),
                    members_present=int(row["members_present"]),
                    members_missing=int(row["members_missing"]),
                    missing_ways=int(row["missing_ways"]),
                    missing_nodes=int(row["missing_nodes"]),
                    missing_relations=int(row["missing_relations"]),
                    xmin=float(row["xmin"]) if row["xmin"] is not None else None,
                    ymin=float(row["ymin"]) if row["ymin"] is not None else None,
                    xmax=float(row["xmax"]) if row["xmax"] is not None else None,
                    ymax=float(row["ymax"]) if row["ymax"] is not None else None,
                    missing=missing,
                )
            )
    return incomplete, extract_bbox, fingerprint


def classify(
    incomplete: list[IncompleteRel],
    pbf_path: str,
    extract_bbox: tuple[float, float, float, float],
) -> dict[str, Any]:
    need_n: set[int] = set()
    need_w: set[int] = set()
    need_r: set[int] = set()
    for rel in incomplete:
        for mtype, mid in rel.missing:
            if mtype == "node":
                need_n.add(mid)
            elif mtype == "way":
                need_w.add(mid)
            elif mtype == "relation":
                need_r.add(mid)

    handler = PresenceHandler(need_n, need_w, need_r)
    handler.apply_file(pbf_path, locations=False)

    def id_in_pbf(mtype: str, mid: int) -> bool:
        if mtype == "node":
            return mid in handler.found_n
        if mtype == "way":
            return mid in handler.found_w
        if mtype == "relation":
            return mid in handler.found_r
        return False

    class_counts: Counter[str] = Counter()
    missing_member_counts: Counter[str] = Counter()
    missing_type_total: Counter[str] = Counter()
    details: list[dict[str, Any]] = []

    for rel in incomplete:
        in_pbf = 0
        out_pbf = 0
        for mtype, mid in rel.missing:
            missing_type_total[mtype] += 1
            if id_in_pbf(mtype, mid):
                in_pbf += 1
            else:
                out_pbf += 1

        if rel.members_missing == 0:
            classification = "unknown"
        elif out_pbf == rel.members_missing:
            classification = "extract_boundary"
        elif in_pbf == rel.members_missing:
            classification = "internal_missing"
        elif in_pbf > 0 and out_pbf > 0:
            classification = "mixed"
        else:
            classification = "unknown"

        class_counts[classification] += 1
        missing_member_counts[classification] += rel.members_missing
        touches = touches_extract_bbox(rel, extract_bbox)

        details.append(
            {
                "relation_osm_id": rel.relation_osm_id,
                "name": rel.name,
                "water_type": rel.water_type,
                "members_total": rel.members_total,
                "members_present": rel.members_present,
                "members_missing": rel.members_missing,
                "missing_ways": rel.missing_ways,
                "missing_nodes": rel.missing_nodes,
                "missing_relations": rel.missing_relations,
                "missing_in_pbf": in_pbf,
                "missing_absent_from_pbf": out_pbf,
                "classification": classification,
                "touches_extract_bbox_eps": touches,
                "bbox": [rel.xmin, rel.ymin, rel.xmax, rel.ymax],
                "tags": {
                    k: rel.tags.get(k)
                    for k in ("type", "waterway", "natural", "water", "name", "name:en")
                    if k in rel.tags
                },
            }
        )

    def pick_examples() -> dict[str, list[dict[str, Any]]]:
        by_missing = sorted(details, key=lambda d: (-d["members_missing"], d["relation_osm_id"]))
        by_size = sorted(details, key=lambda d: (-d["members_total"], d["relation_osm_id"]))
        interesting = [
            d
            for d in details
            if d["water_type"] in {"canal", "river", "river_area"}
            or (d["tags"] or {}).get("waterway") in {"canal", "river"}
        ]
        interesting = sorted(interesting, key=lambda d: (-d["members_missing"], d["relation_osm_id"]))
        return {
            "top_missing_members": by_missing[:5],
            "top_largest_incomplete": by_size[:5],
            "interesting_waterways": interesting[:3],
        }

    return {
        "extract_bbox": {
            "xmin": extract_bbox[0],
            "ymin": extract_bbox[1],
            "xmax": extract_bbox[2],
            "ymax": extract_bbox[3],
        },
        "pbf_lookup": {
            "missing_ids_queried": {
                "node": len(need_n),
                "way": len(need_w),
                "relation": len(need_r),
            },
            "found_in_pbf": {
                "node": len(handler.found_n),
                "way": len(handler.found_w),
                "relation": len(handler.found_r),
            },
        },
        "summary": {
            "incomplete_relations": len(incomplete),
            "missing_members": sum(r.members_missing for r in incomplete),
            "missing_by_type": dict(missing_type_total),
            "classification_relations": dict(class_counts),
            "classification_missing_members": dict(missing_member_counts),
        },
        "examples": pick_examples(),
        "all": details,
    }


def belomor_check(conn: Any) -> dict[str, Any]:
    with conn.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(
            """
            SELECT
              o.osm_id, o.name, o.water_type,
              GeometryType(o.geometry) AS geom_type,
              round(ST_Length(o.geometry::geography)::numeric, 1) AS length_m,
              count(m.*) AS members_total,
              count(mw.osm_id) AS members_present,
              count(m.*) - count(mw.osm_id) AS members_missing
            FROM water.objects o
            JOIN water.object_members m
              ON m.parent_osm_type = 'relation' AND m.parent_osm_id = o.osm_id
            LEFT JOIN water.objects mw
              ON mw.osm_type = m.member_osm_type AND mw.osm_id = m.member_osm_id
            WHERE o.osm_type = 'relation' AND o.osm_id = 9909116
            GROUP BY 1, 2, 3, 4, 5
            """
        )
        row = cur.fetchone()
        if not row:
            return {"error": "relation 9909116 not found"}
        out = dict(row)
        if out.get("length_m") is not None:
            out["length_m"] = float(out["length_m"])
        for k in ("osm_id", "members_total", "members_present", "members_missing"):
            if out.get(k) is not None:
                out[k] = int(out[k])
        return out


def _json_default(obj: Any) -> Any:
    if isinstance(obj, Decimal):
        return float(obj)
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--pbf",
        default=None,
        help="Local Karelia PBF (default: water-data/data/karelia_republic-latest.osm.pbf)",
    )
    parser.add_argument("--dsn", default=None)
    parser.add_argument(
        "--json-out",
        default=None,
        help="Optional path to write full JSON report (under data/ recommended)",
    )
    args = parser.parse_args(argv)

    root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    pbf = args.pbf or os.path.join(root, "data", "karelia_republic-latest.osm.pbf")
    if not os.path.isfile(pbf):
        print(f"PBF not found: {pbf}", file=sys.stderr)
        return 1

    dsn = args.dsn or default_dsn()
    parsed = urlparse(dsn)
    print(
        f"DSN {parsed.scheme}://{parsed.username}@***{parsed.hostname}:{parsed.port}{parsed.path}"
    )
    print(f"PBF {pbf}")

    conn = psycopg2.connect(dsn)
    try:
        incomplete, extract_bbox, fingerprint = fetch_incomplete(conn)
        belomor = belomor_check(conn)
    finally:
        conn.close()

    report = classify(incomplete, pbf, extract_bbox)
    report["dataset_fingerprint"] = fingerprint
    report["belomor"] = belomor
    report["method"] = (
        "Missing member ids looked up in local Karelia PBF. "
        "Absent from PBF => extract_boundary. Present in PBF but not in "
        "water.objects => internal_missing. No OSM API used."
    )

    # Compact stdout
    compact = {
        "dataset_fingerprint": report["dataset_fingerprint"],
        "belomor": report["belomor"],
        "summary": report["summary"],
        "pbf_lookup": report["pbf_lookup"],
        "extract_bbox": report["extract_bbox"],
        "examples": report["examples"],
        "method": report["method"],
    }
    print(json.dumps(compact, indent=2, ensure_ascii=False, default=_json_default))

    if args.json_out:
        out = args.json_out
        os.makedirs(os.path.dirname(os.path.abspath(out)) or ".", exist_ok=True)
        with open(out, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False, default=_json_default)
        print(f"Wrote full report: {out}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
