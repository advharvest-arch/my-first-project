#!/usr/bin/env python3
"""
AquaRoute E3.11 — read-only water-data composition inventory.

Does NOT mutate canonical tables. Prints JSON summary for the E3.11 report.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

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


def q(cur: Any, sql: str, params: tuple | None = None) -> list[dict]:
    cur.execute(sql, params or ())
    return [dict(r) for r in cur.fetchall()]


def one(cur: Any, sql: str, params: tuple | None = None) -> dict:
    rows = q(cur, sql, params)
    return rows[0] if rows else {}


# Routing relevance labels for inventory categories (classification only).
RELEVANCE = {
    "waterway_river": "HIGH",
    "waterway_canal": "HIGH",
    "waterway_stream": "MEDIUM",
    "waterway_fairway_link": "HIGH",
    "waterway_drain": "LOW",
    "waterway_ditch": "LOW",
    "waterway_lock_dam_weir": "HIGH",
    "waterway_other": "MEDIUM",
    "water_lake": "HIGH",
    "water_reservoir": "HIGH",
    "water_river_area": "MEDIUM",
    "water_pond_oxbow": "LOW",
    "water_other_polygon": "LOW",
    "relation_waterway": "HIGH",
    "relation_multipolygon_water": "HIGH",
    "relation_route": "MEDIUM",
    "relation_other": "LOW",
    "node_amenities": "MEDIUM",
    "import_noise_nonwater": "IGNORE",
}


def build_report(cur: Any) -> dict[str, Any]:
    fp = one(
        cur,
        """
        SELECT
          (SELECT count(*) FROM water.objects) AS objects,
          (SELECT count(*) FROM water.object_members) AS members,
          (SELECT count(*) FROM (
             SELECT osm_type, osm_id FROM water.objects GROUP BY 1,2 HAVING count(*)>1
           ) t) AS identity_dups,
          (SELECT count(*) FROM water.object_members m
           LEFT JOIN water.objects o
             ON o.osm_type=m.parent_osm_type AND o.osm_id=m.parent_osm_id
           WHERE o.id IS NULL) AS orphan_parents,
          (SELECT count(*) FROM water.objects WHERE NOT ST_IsValid(geometry)) AS invalid_geom
        """,
    )

    by_osm = q(cur, "SELECT osm_type, count(*)::bigint AS n FROM water.objects GROUP BY 1 ORDER BY n DESC")
    by_wt = q(
        cur,
        "SELECT COALESCE(water_type,'(null)') AS water_type, count(*)::bigint AS n "
        "FROM water.objects GROUP BY 1 ORDER BY n DESC",
    )
    by_gtype = q(
        cur,
        "SELECT GeometryType(geometry) AS gtype, count(*)::bigint AS n "
        "FROM water.objects GROUP BY 1 ORDER BY n DESC",
    )
    by_waterway = q(
        cur,
        "SELECT COALESCE(tags->>'waterway','(none)') AS waterway, count(*)::bigint AS n "
        "FROM water.objects GROUP BY 1 ORDER BY n DESC LIMIT 40",
    )
    by_water = q(
        cur,
        """
        SELECT COALESCE(tags->>'water','(none)') AS water, count(*)::bigint AS n
        FROM water.objects
        WHERE tags->>'natural'='water' OR tags ? 'water' OR tags->>'landuse'='reservoir'
        GROUP BY 1 ORDER BY n DESC LIMIT 30
        """,
    )
    rel_types = q(
        cur,
        """
        SELECT COALESCE(tags->>'type','(none)') AS rel_type, count(*)::bigint AS n
        FROM water.objects WHERE osm_type='relation'
        GROUP BY 1 ORDER BY n DESC
        """,
    )
    rel_complete = q(
        cur,
        """
        WITH rels AS (
          SELECT o.osm_id, COALESCE(o.tags->>'type','(none)') AS rel_type,
            (SELECT count(*) FROM water.object_members m
             WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id) AS listed,
            (SELECT count(*) FROM water.object_members m
             WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id
               AND EXISTS (
                 SELECT 1 FROM water.objects x
                 WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
               )) AS present
          FROM water.objects o WHERE o.osm_type='relation'
        )
        SELECT rel_type,
          count(*)::bigint AS n,
          count(*) FILTER (WHERE present=listed AND listed>0)::bigint AS complete,
          count(*) FILTER (WHERE present<listed)::bigint AS incomplete
        FROM rels GROUP BY 1 ORDER BY n DESC
        """,
    )
    examples = q(
        cur,
        """
        SELECT o.osm_id, o.name, o.water_type, o.tags->>'type' AS rel_type,
               o.tags->>'waterway' AS waterway, GeometryType(o.geometry) AS gtype,
          (SELECT count(*) FROM water.object_members m
           WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id) AS listed,
          (SELECT count(*) FROM water.object_members m
           WHERE m.parent_osm_type='relation' AND m.parent_osm_id=o.osm_id
             AND EXISTS (
               SELECT 1 FROM water.objects x
               WHERE x.osm_type=m.member_osm_type AND x.osm_id=m.member_osm_id
             )) AS present
        FROM water.objects o
        WHERE o.osm_type='relation' AND o.osm_id IN (9909116, 21149039, 16738852)
        ORDER BY o.osm_id
        """,
    )

    cats = one(
        cur,
        """
        SELECT
          count(*) FILTER (WHERE tags->>'waterway'='river') AS waterway_river,
          count(*) FILTER (WHERE tags->>'waterway'='canal') AS waterway_canal,
          count(*) FILTER (WHERE tags->>'waterway'='stream') AS waterway_stream,
          count(*) FILTER (WHERE tags->>'waterway' IN ('drain')) AS waterway_drain,
          count(*) FILTER (WHERE tags->>'waterway' IN ('ditch')) AS waterway_ditch,
          count(*) FILTER (WHERE tags->>'waterway' IN ('fairway','link','tidal_channel')) AS waterway_fairway_link,
          count(*) FILTER (WHERE tags->>'waterway' IN ('lock_gate','dam','weir','waterfall','sluice_gate','lock')
                            OR tags->>'lock'='yes') AS waterway_lock_dam_weir,
          count(*) FILTER (WHERE water_type='lake' OR tags->>'water'='lake') AS water_lake,
          count(*) FILTER (WHERE water_type='reservoir' OR tags->>'water'='reservoir'
                            OR tags->>'landuse'='reservoir') AS water_reservoir,
          count(*) FILTER (WHERE water_type='river_area' OR tags->>'water'='river') AS water_river_area,
          count(*) FILTER (WHERE tags->>'water' IN ('pond','oxbow')) AS water_pond_oxbow,
          count(*) FILTER (WHERE osm_type='relation' AND tags->>'type'='waterway') AS relation_waterway,
          count(*) FILTER (WHERE osm_type='relation' AND tags->>'type'='multipolygon'
                            AND (tags->>'natural'='water' OR tags ? 'water'
                                 OR tags->>'landuse'='reservoir')) AS relation_multipolygon_water,
          count(*) FILTER (WHERE osm_type='relation' AND tags->>'type'='route') AS relation_route,
          count(*) FILTER (WHERE tags->>'natural' IN ('wood','wetland','bare_rock','scrub','grassland','heath')
                            AND NOT (tags ? 'waterway') AND tags->>'natural' IS DISTINCT FROM 'water')
            AS import_noise_nonwater,
          count(*) FILTER (WHERE tags ? 'boat' OR tags ? 'canoe' OR tags ? 'motorboat'
                            OR tags ? 'CEMT' OR tags ? 'cemt') AS navigability_tagged,
          count(*) FILTER (WHERE tags->>'name' IS NOT NULL) AS named_objects
        FROM water.objects
        """,
    )

    category_relevance = []
    for key, n in cats.items():
        if key in RELEVANCE:
            category_relevance.append(
                {"category": key, "count": int(n), "relevance": RELEVANCE[key]}
            )

    # Rough Russia-scale estimate (no downloads): based on current ~422k objects
    # from Karelia+Leningrad (~293MB PBF with overlap). NW FD Geofabrik ~620MB
    # cited in prior E3.4 notes. These are order-of-magnitude only.
    scale = {
        "basis": {
            "current_objects": int(fp["objects"]),
            "current_regions": ["karelia_republic", "leningrad_oblast"],
            "current_pbf_mb_approx": 103 + 190,
            "note": "Rough ratio from extract size / water density; NOT a measured count.",
        },
        "estimates_objects_order_of_magnitude": {
            "northwestern_fd": "0.7e6 – 1.5e6",
            "european_russia": "3e6 – 10e6",
            "all_russia_including_ditch_drain": "10e6 – 40e6+",
            "all_russia_HIGH_only_excl_ditch_drain": "1e6 – 5e6",
        },
        "caveats": [
            "Water density varies strongly (Karelia lakes vs steppe).",
            "Importer currently keeps collateral non-water members (wood, etc.).",
            "Overlap between extracts means PBF-MB is not proportional to unique objects.",
            "Do not use these numbers for capacity planning without a measured pilot.",
        ],
    }

    return {
        "fingerprint": {k: int(v) for k, v in fp.items()},
        "by_osm_type": by_osm,
        "by_water_type": by_wt,
        "by_geometry_type": by_gtype,
        "by_waterway_tag": by_waterway,
        "by_water_tag": by_water,
        "relations_by_type": rel_types,
        "relations_completeness": rel_complete,
        "examples": examples,
        "category_counts_with_relevance": category_relevance,
        "routing_relevance_legend": {
            "HIGH": "Directly useful for future water routing",
            "MEDIUM": "Snap / topology / validation",
            "LOW": "Reference / optional context",
            "IGNORE": "Should not be required in a routing-oriented extract",
        },
        "tag_tiers": {
            "essential": [
                "waterway",
                "natural",
                "water",
                "landuse=reservoir",
                "name",
                "type",
                "boat",
                "lock",
                "tunnel",
                "intermittent",
            ],
            "useful": [
                "name:ru",
                "name:en",
                "width",
                "CEMT",
                "cemt",
                "canoe",
                "motorboat",
                "maxdraft",
                "maxwidth",
                "maxheight",
                "layer",
                "bridge",
                "rapids",
                "seasonal",
                "gvr:code",
                "wikidata",
            ],
            "audit_only": [
                "source",
                "source:position",
                "source:tracer",
                "mml:class",
                "fixme",
                "note",
                "wikipedia",
                "leaf_type",
                "kpoos_id",
            ],
        },
        "geometry_roles": {
            "LINESTRING": "Primary centerline for river/stream/canal/fairway ways",
            "MULTILINESTRING": "Assembled waterway relations (Belomor, Volga-Baltic) / incomplete MP shells",
            "POLYGON": "Rare closed water areas on ways",
            "MULTIPOLYGON": "Lake/reservoir/riverbank area relations and closed ways",
            "POINT": "Nodes: lock_gate, fuel, access_point, milestones (snap/amenities)",
        },
        "coverage_from_current_db": {
            "water_object_catalog": "YES — water.objects identity + tags + geometry",
            "water_centerline_dataset": "PARTIAL — river/canal/stream lines present; ditch/drain dominate volume",
            "lake_reservoir_polygon_dataset": "YES — mostly MULTIPOLYGON; some large lakes still MULTILINESTRING shells",
            "relation_dataset": "YES — members + completeness; occurrence policy E3.10",
            "endpoint_snap_dataset": "PARTIAL — nodes sparse; endpoints of lines not precomputed",
            "navigability_attributes": "PARTIAL — boat/CEMT/canoe sparse (~1.3k boat tags)",
            "watergraph": "NO — intentionally not built",
        },
        "russia_scale_estimate": scale,
        "proposed_canonical_additions": {
            "keep": [
                "water.objects",
                "water.object_members",
                "water.import_batches",
                "water.object_batch_links",
                "water.object_conflicts",
                "water.data_sources",
            ],
            "missing_for_future_watergraph_input": [
                {
                    "need": "osm_version + osm_timestamp on objects/staging",
                    "why": "deterministic freshness across overlapping extracts",
                    "e311_action": "document only — do not add yet",
                },
                {
                    "need": "routing_class / relevance flag (generated view OK)",
                    "why": "filter HIGH/MEDIUM without deleting LOW/IGNORE rows",
                    "e311_action": "propose view/materialized classification — not created automatically",
                },
                {
                    "need": "optional water.object_endpoints (or compute at graph build)",
                    "why": "snap candidates from centerline ends; can wait for WaterGraph stage",
                    "e311_action": "defer — do not create tables in E3.11",
                },
                {
                    "need": "navigability overlay (sparse attributes)",
                    "why": "boat/CEMT/lock metadata keyed by osm identity",
                    "e311_action": "tags already in objects; separate table not required yet",
                },
            ],
            "not_needed_now": [
                "graph edge tables",
                "synthetic geometries",
                "frontend/routing wiring",
            ],
        },
    }


def main() -> int:
    ap = argparse.ArgumentParser(description="E3.11 read-only water-data inventory")
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--json-out", default=None)
    args = ap.parse_args()
    with psycopg2.connect(args.dsn or default_dsn()) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report = build_report(cur)
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
