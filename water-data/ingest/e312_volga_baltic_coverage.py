#!/usr/bin/env python3
"""
AquaRoute E3.12 — Volga–Baltic (relation 16738852) coverage forensics.

Read-only. Uses DB + already-downloaded Karelia/Leningrad PBFs.
Does NOT download new extracts. Does NOT mutate canonical tables.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from decimal import Decimal
from pathlib import Path
from typing import Any

import osmium
import psycopg2
from psycopg2.extras import RealDictCursor

REL = 16738852


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


class RelDump(osmium.SimpleHandler):
    def __init__(self, rel_id: int):
        super().__init__()
        self.rel_id = rel_id
        self.rel: dict[str, Any] | None = None

    def relation(self, r: Any) -> None:
        if r.id != self.rel_id:
            return
        self.rel = {
            "version": r.version,
            "timestamp": str(r.timestamp),
            "n_members": len(r.members),
            "tags": {t.k: t.v for t in r.tags},
        }


class IdIndex(osmium.SimpleHandler):
    def __init__(self, want: set[tuple[str, int]]):
        super().__init__()
        self.want = want
        self.hit: set[tuple[str, int]] = set()

    def node(self, n: Any) -> None:
        if ("node", n.id) in self.want:
            self.hit.add(("node", n.id))

    def way(self, w: Any) -> None:
        if ("way", w.id) in self.want:
            self.hit.add(("way", w.id))

    def relation(self, r: Any) -> None:
        if ("relation", r.id) in self.want:
            self.hit.add(("relation", r.id))


class WayLocator(osmium.SimpleHandler):
    def __init__(self, want: set[int]):
        super().__init__()
        self.want = want
        self.found: dict[int, dict[str, Any]] = {}

    def way(self, w: Any) -> None:
        if w.id not in self.want:
            return
        lons, lats = [], []
        for n in w.nodes:
            if n.location.valid():
                lons.append(n.location.lon)
                lats.append(n.location.lat)
        info: dict[str, Any] = {
            "version": w.version,
            "tags": {t.k: t.v for t in w.tags},
        }
        if lons:
            info.update(
                {
                    "xmin": min(lons),
                    "xmax": max(lons),
                    "ymin": min(lats),
                    "ymax": max(lats),
                }
            )
        else:
            info["coords"] = "unknown"
        self.found[w.id] = info


def in_bbox(
    xmin: float, ymin: float, xmax: float, ymax: float, box: dict[str, float]
) -> bool:
    return not (
        xmax < box["xmin"]
        or xmin > box["xmax"]
        or ymax < box["ymin"]
        or ymin > box["ymax"]
    )


def analyze(dsn: str, karelia: Path, leningrad: Path) -> dict[str, Any]:
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
            fp = {k: int(v) for k, v in dict(cur.fetchone()).items()}

            cur.execute(
                """
                SELECT osm_id, name, water_type, tags->>'type' AS rel_type,
                       tags->>'waterway' AS waterway,
                       GeometryType(geometry) AS gtype,
                       round(ST_XMin(geometry)::numeric,5) AS xmin,
                       round(ST_YMin(geometry)::numeric,5) AS ymin,
                       round(ST_XMax(geometry)::numeric,5) AS xmax,
                       round(ST_YMax(geometry)::numeric,5) AS ymax,
                       ST_NPoints(geometry) AS npoints,
                       round(ST_Length(geometry::geography)::numeric,1) AS length_m
                FROM water.objects
                WHERE osm_type='relation' AND osm_id=%s
                """,
                (REL,),
            )
            rel = dict(cur.fetchone())

            cur.execute(
                """
                SELECT m.seq, m.member_osm_type, m.member_osm_id, m.member_role,
                  EXISTS (
                    SELECT 1 FROM water.objects o
                    WHERE o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                  ) AS present,
                  (
                    SELECT string_agg(b.batch_key, ',' ORDER BY b.id)
                    FROM water.object_batch_links obl
                    JOIN water.import_batches b ON b.id=obl.batch_id
                    WHERE obl.osm_type=m.member_osm_type AND obl.osm_id=m.member_osm_id
                      AND obl.link_role='object'
                  ) AS member_batches
                FROM water.object_members m
                WHERE m.parent_osm_type='relation' AND m.parent_osm_id=%s
                ORDER BY m.seq
                """,
                (REL,),
            )
            members = [dict(r) for r in cur.fetchall()]

            cur.execute(
                """
                WITH links AS (
                  SELECT o.geometry,
                    bool_or(b.batch_key='e34-karelia-republic') AS k,
                    bool_or(b.batch_key='e38-leningrad-oblast') AS l
                  FROM water.objects o
                  JOIN water.object_batch_links obl
                    ON obl.osm_type=o.osm_type AND obl.osm_id=o.osm_id
                   AND obl.link_role='object'
                  JOIN water.import_batches b ON b.id=obl.batch_id
                  WHERE b.batch_key IN ('e34-karelia-republic','e38-leningrad-oblast')
                  GROUP BY o.geometry
                )
                SELECT
                  min(ST_XMin(geometry)) FILTER (WHERE k AND NOT l) AS k_xmin,
                  min(ST_YMin(geometry)) FILTER (WHERE k AND NOT l) AS k_ymin,
                  max(ST_XMax(geometry)) FILTER (WHERE k AND NOT l) AS k_xmax,
                  max(ST_YMax(geometry)) FILTER (WHERE k AND NOT l) AS k_ymax,
                  min(ST_XMin(geometry)) FILTER (WHERE l AND NOT k) AS l_xmin,
                  min(ST_YMin(geometry)) FILTER (WHERE l AND NOT k) AS l_ymin,
                  max(ST_XMax(geometry)) FILTER (WHERE l AND NOT k) AS l_xmax,
                  max(ST_YMax(geometry)) FILTER (WHERE l AND NOT k) AS l_ymax
                FROM links
                """
            )
            bb = dict(cur.fetchone())
            k_box = {
                "xmin": float(bb["k_xmin"]),
                "ymin": float(bb["k_ymin"]),
                "xmax": float(bb["k_xmax"]),
                "ymax": float(bb["k_ymax"]),
            }
            l_box = {
                "xmin": float(bb["l_xmin"]),
                "ymin": float(bb["l_ymin"]),
                "xmax": float(bb["l_xmax"]),
                "ymax": float(bb["l_ymax"]),
            }

            cur.execute(
                """
                SELECT
                  round(min(ST_XMin(o.geometry))::numeric,5) AS xmin,
                  round(min(ST_YMin(o.geometry))::numeric,5) AS ymin,
                  round(max(ST_XMax(o.geometry))::numeric,5) AS xmax,
                  round(max(ST_YMax(o.geometry))::numeric,5) AS ymax
                FROM water.object_members m
                JOIN water.objects o
                  ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                WHERE m.parent_osm_id=%s
                """,
                (REL,),
            )
            present_bbox = dict(cur.fetchone())

            # control relations
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
                     )) AS present
                FROM water.objects o
                WHERE o.osm_type='relation'
                  AND o.osm_id IN (9909116, 21149039, 16738852)
                ORDER BY o.osm_id
                """
            )
            controls = [dict(r) for r in cur.fetchall()]

            # last present centroid (context only for where the gap begins)
            cur.execute(
                """
                SELECT m.seq, m.member_osm_id,
                  round(ST_X(ST_Centroid(o.geometry))::numeric,5) AS lon,
                  round(ST_Y(ST_Centroid(o.geometry))::numeric,5) AS lat,
                  round(ST_XMin(o.geometry)::numeric,5) AS xmin,
                  round(ST_XMax(o.geometry)::numeric,5) AS xmax,
                  round(ST_YMin(o.geometry)::numeric,5) AS ymin,
                  round(ST_YMax(o.geometry)::numeric,5) AS ymax
                FROM water.object_members m
                JOIN water.objects o
                  ON o.osm_type=m.member_osm_type AND o.osm_id=m.member_osm_id
                WHERE m.parent_osm_id=%s
                ORDER BY m.seq DESC
                LIMIT 1
                """,
                (REL,),
            )
            last_present = dict(cur.fetchone())

    want = {(m["member_osm_type"], int(m["member_osm_id"])) for m in members}

    rd_k, rd_l = RelDump(REL), RelDump(REL)
    rd_k.apply_file(str(karelia), locations=False)
    rd_l.apply_file(str(leningrad), locations=False)

    ix_k, ix_l = IdIndex(want), IdIndex(want)
    ix_k.apply_file(str(karelia), locations=False)
    ix_l.apply_file(str(leningrad), locations=False)

    # Locate the missing ways that exist in a local PBF
    need_ways = {
        int(m["member_osm_id"])
        for m in members
        if not m["present"]
        and (
            (m["member_osm_type"], int(m["member_osm_id"])) in ix_k.hit
            or (m["member_osm_type"], int(m["member_osm_id"])) in ix_l.hit
        )
    }
    loc_found: dict[int, dict[str, Any]] = {}
    for label, path, hit in (
        ("karelia", karelia, ix_k.hit),
        ("leningrad", leningrad, ix_l.hit),
    ):
        subset = {
            wid
            for wid in need_ways
            if ("way", wid) in hit and wid not in loc_found
        }
        if not subset:
            continue
        loc = WayLocator(subset)
        loc.apply_file(str(path), locations=True)
        for wid, info in loc.found.items():
            info["from_pbf"] = label
            loc_found[wid] = info

    table = []
    missing_class: Counter[str] = Counter()
    for m in members:
        key = (m["member_osm_type"], int(m["member_osm_id"]))
        row: dict[str, Any] = {
            "seq": int(m["seq"]),
            "member_type": m["member_osm_type"],
            "member_id": int(m["member_osm_id"]),
            "role": m["member_role"] or "",
            "present": bool(m["present"]),
            "member_batches": m["member_batches"],
            "in_karelia_pbf": key in ix_k.hit,
            "in_leningrad_pbf": key in ix_l.hit,
        }
        if not m["present"]:
            in_k, in_l = row["in_karelia_pbf"], row["in_leningrad_pbf"]
            if in_k and in_l:
                cls = "in_both_pbfs_but_not_in_water_objects"
            elif in_k:
                cls = "in_karelia_pbf_only_not_imported_as_water"
            elif in_l:
                cls = "in_leningrad_pbf_only_not_imported_as_water"
            else:
                cls = "absent_from_both_extract_pbfs"
            row["location_class"] = cls
            missing_class[cls] += 1
            info = loc_found.get(int(m["member_osm_id"]))
            if info and "xmin" in info:
                row["coords"] = {
                    k: info[k] for k in ("xmin", "ymin", "xmax", "ymax")
                }
                row["pbf_tags"] = info.get("tags")
                row["overlaps_karelia_bbox"] = in_bbox(
                    info["xmin"], info["ymin"], info["xmax"], info["ymax"], k_box
                )
                row["overlaps_leningrad_bbox"] = in_bbox(
                    info["xmin"], info["ymin"], info["xmax"], info["ymax"], l_box
                )
            else:
                row["coords"] = "unknown"
                row["overlaps_karelia_bbox"] = None
                row["overlaps_leningrad_bbox"] = None
        table.append(row)

    # gaps
    gaps = []
    run = None
    for m in members:
        if not m["present"]:
            if run is None:
                run = {
                    "start_seq": int(m["seq"]),
                    "end_seq": int(m["seq"]),
                    "n": 0,
                }
            run["end_seq"] = int(m["seq"])
            run["n"] += 1
        elif run is not None:
            gaps.append(run)
            run = None
    if run:
        gaps.append(run)

    present_n = sum(1 for m in members if m["present"])
    missing_n = len(members) - present_n

    return {
        "fingerprint": fp,
        "relation": rel,
        "counts": {
            "total": len(members),
            "present": present_n,
            "missing": missing_n,
        },
        "completeness_policy": (
            "complete iff every relation member exists in water.objects; "
            "assembled relation geometry alone does NOT imply complete"
        ),
        "extract_bbox_only_region_objects": {
            "karelia": k_box,
            "leningrad": l_box,
        },
        "present_members_bbox": present_bbox,
        "last_present_member_context": last_present,
        "missing_class_counts": dict(missing_class),
        "gaps": gaps,
        "pbf_relation": {
            "karelia": {
                "present": rd_k.rel is not None,
                "n_members": (rd_k.rel or {}).get("n_members"),
                "version": (rd_k.rel or {}).get("version"),
            },
            "leningrad": {
                "present": rd_l.rel is not None,
                "n_members": (rd_l.rel or {}).get("n_members"),
                "version": (rd_l.rel or {}).get("version"),
            },
        },
        "control_relations": controls,
        "members": table,
        "coverage_strategy": {
            "A_one_more_regional_pbf": (
                "Likely YES as next experiment: Volga–Baltic continues east of "
                "present tail (~35.8E / 61.1N) into Vologda Oblast corridor "
                "(Vytegra → Belozersk → …). Candidate: "
                "download.openstreetmap.fr …/vologda_oblast-latest.osm.pbf (~52MB HEAD)."
            ),
            "B_overlap_buffer": (
                "Useful: regional extracts clip ways at borders; overlap/buffer "
                "or multi-region merge (E3.7) already required. One region alone "
                "may still leave a southern remnant toward Yaroslavl/Rybinsk."
            ),
            "C_federal_extract": (
                "NW federal district ~710MB — sufficient geographically for much "
                "of the canal but oversized for a single-relation experiment."
            ),
            "D_planet_or_russia": "NOT required for this relation.",
            "E_without_mass_russia": (
                "YES: (1) targeted Vologda (then maybe Yaroslavl) regional PBF "
                "via staging→merge; OR (2) OSM API relation/16738852/full like "
                "Belomor E3.3 — restores members without Russia-wide import. "
                "Neither downloaded in E3.12."
            ),
            "recommended_next_source": (
                "vologda_oblast-latest.osm.pbf (openstreetmap.fr) as first "
                "targeted extract; optional follow-up yaroslavl_oblast if still "
                "incomplete; OSM API full relation as minimal alternative"
            ),
            "downloaded_in_e312": False,
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="E3.12 Volga–Baltic coverage forensics")
    ap.add_argument("--dsn", default=None)
    ap.add_argument(
        "--karelia",
        default=str(Path(__file__).resolve().parents[1] / "data/karelia_republic-latest.osm.pbf"),
    )
    ap.add_argument(
        "--leningrad",
        default=str(
            Path(__file__).resolve().parents[1]
            / "data/leningrad_oblast-latest.osm.pbf"
        ),
    )
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()
    report = analyze(args.dsn or default_dsn(), Path(args.karelia), Path(args.leningrad))
    text = json.dumps(report, ensure_ascii=False, indent=2, default=_json_default)
    print(text)
    if args.json_out:
        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text + "\n")
        print(f"\nwrote {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
