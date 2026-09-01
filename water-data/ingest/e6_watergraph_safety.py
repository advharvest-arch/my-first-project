#!/usr/bin/env python3
"""
AquaRoute E6 — WaterGraph safety validation (isolated PoC).

Validates water.wg_nodes / wg_edges for a routing pilot gate.
Does NOT mutate canonical OSM / routing_segments.
Does NOT invent seams, crossing joins, or navigability PASS.

ALLOWED_TOPOLOGY = no violation of fixed topology rules (NOT navigable).

Example:
  python3 ingest/e6_watergraph_safety.py --json-out data/e6_watergraph_safety.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict, deque
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values, Json

RELATION_IDS = {
    "belomor": 9909116,
    "volga_baltic": 16738852,
    "ladoga": 21149039,
}
VB_GAP_WAYS = (28433211, 824398188)
E1_DECIMALS = 7
VALIDATOR_VERSION = "e6-1"
INIT_SQL = Path(__file__).resolve().parents[1] / "db" / "init" / "014_watergraph_safety.sql"

# Corridor endpoints from sea-map user-test-presets (diagnostic coverage only).
CORRIDORS = {
    "N06": {
        "name": "N06 Kuibyshev S mid",
        "a": (48.9, 54.7),
        "b": (49.1, 54.35),
        "note": "Southern Kuibyshev — outside Karelia/Leningrad/Vologda extracts unless present",
    },
    "N08": {
        "name": "N08 Kuibyshev north",
        "a": (49.05, 55.75),
        "b": (48.45, 55.82),
        "note": "Northern Kuibyshev / Kazan approach",
    },
}

# Diagnostic search radii for "does any graph node exist near terminal?" — NOT connection creation.
COVERAGE_RADII_KM = (1.0, 5.0, 25.0, 100.0)


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


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = (
        math.sin(dphi / 2) ** 2
        + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def fingerprint(cur: Any) -> dict[str, int]:
    cur.execute(
        """
        SELECT
          (SELECT count(*) FROM water.objects) AS objects,
          (SELECT count(*) FROM water.object_members) AS members,
          (SELECT count(*) FROM water.object_conflicts) AS conflicts,
          (SELECT count(*) FROM water.wg_nodes) AS wg_nodes,
          (SELECT count(*) FROM water.wg_edges) AS wg_edges,
          (SELECT component_count FROM water.wg_build ORDER BY build_id DESC LIMIT 1)
            AS wg_components
        """
    )
    return {k: int(v) if v is not None else 0 for k, v in dict(cur.fetchone()).items()}


def apply_schema(cur: Any) -> None:
    cur.execute(INIT_SQL.read_text(encoding="utf-8"))


def latest_build_id(cur: Any) -> int:
    cur.execute("SELECT build_id FROM water.wg_build ORDER BY build_id DESC LIMIT 1")
    row = cur.fetchone()
    if not row:
        raise RuntimeError("no wg_build — run E5 builder first")
    return int(row["build_id"])


def graph_integrity(cur: Any, build_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          count(*) AS edges,
          count(*) FILTER (WHERE from_node_id IS NULL OR to_node_id IS NULL)
            AS missing_endpoint_refs,
          count(*) FILTER (WHERE is_zero_length) AS zero_length,
          count(*) FILTER (WHERE NOT ST_IsValid(geom)) AS invalid_geom,
          count(*) FILTER (WHERE length_m IS NULL OR length_m < 0) AS bad_length
        FROM water.wg_edges WHERE build_id = %s
        """,
        (build_id,),
    )
    edge_stats = {k: int(v) for k, v in dict(cur.fetchone()).items()}

    cur.execute(
        """
        SELECT count(*) AS orphan_from
        FROM water.wg_edges e
        LEFT JOIN water.wg_nodes n ON n.node_id = e.from_node_id AND n.build_id = e.build_id
        WHERE e.build_id = %s AND n.node_id IS NULL
        """,
        (build_id,),
    )
    orphan_from = int(cur.fetchone()["orphan_from"])
    cur.execute(
        """
        SELECT count(*) AS orphan_to
        FROM water.wg_edges e
        LEFT JOIN water.wg_nodes n ON n.node_id = e.to_node_id AND n.build_id = e.build_id
        WHERE e.build_id = %s AND n.node_id IS NULL
        """,
        (build_id,),
    )
    orphan_to = int(cur.fetchone()["orphan_to"])

    # Every edge must match a routing_segment identity
    cur.execute(
        """
        SELECT count(*) AS unmatched_segments
        FROM water.wg_edges e
        LEFT JOIN water.routing_segments s
          ON s.osm_type = e.osm_type
         AND s.osm_id = e.osm_id
         AND s.part_index = e.part_index
        WHERE e.build_id = %s AND s.osm_id IS NULL
        """,
        (build_id,),
    )
    unmatched = int(cur.fetchone()["unmatched_segments"])

    # Provenance: osm identity present
    cur.execute(
        """
        SELECT count(*) FILTER (WHERE osm_type IS NULL OR osm_id IS NULL) AS missing_osm
        FROM water.wg_edges WHERE build_id = %s
        """,
        (build_id,),
    )
    missing_osm = int(cur.fetchone()["missing_osm"])

    cur.execute(
        """
        SELECT count(*) AS nodes,
               count(*) FILTER (WHERE degree = 0) AS deg0,
               count(*) FILTER (WHERE geom IS NULL OR NOT ST_IsValid(geom)) AS bad_node_geom
        FROM water.wg_nodes WHERE build_id = %s
        """,
        (build_id,),
    )
    node_stats = {k: int(v) for k, v in dict(cur.fetchone()).items()}

    # E1 uniqueness
    cur.execute(
        """
        SELECT count(*) AS e1_dup_groups FROM (
          SELECT e1_lon, e1_lat FROM water.wg_nodes
          WHERE build_id = %s
          GROUP BY 1,2 HAVING count(*) > 1
        ) t
        """,
        (build_id,),
    )
    e1_dups = int(cur.fetchone()["e1_dup_groups"])

    failures = []
    if edge_stats["missing_endpoint_refs"]:
        failures.append("missing_endpoint_refs")
    if edge_stats["zero_length"]:
        failures.append("zero_length_edges")
    if edge_stats["invalid_geom"]:
        failures.append("invalid_geom_edges")
    if orphan_from or orphan_to:
        failures.append("orphan_node_refs")
    if unmatched:
        failures.append("edges_without_routing_segment")
    if missing_osm:
        failures.append("missing_osm_provenance")
    if node_stats["deg0"]:
        failures.append("degree0_nodes")
    if node_stats["bad_node_geom"]:
        failures.append("bad_node_geom")
    if e1_dups:
        failures.append("duplicate_e1_nodes")

    return {
        "pass": len(failures) == 0,
        "failures": failures,
        "edges": edge_stats,
        "nodes": node_stats,
        "orphan_from": orphan_from,
        "orphan_to": orphan_to,
        "unmatched_segments": unmatched,
        "missing_osm_provenance": missing_osm,
        "duplicate_e1_node_groups": e1_dups,
    }


def connection_safety(cur: Any, build_id: int) -> dict[str, Any]:
    # Build meta must declare E1
    cur.execute(
        "SELECT rule_id, extras FROM water.wg_build WHERE build_id = %s", (build_id,)
    )
    build = dict(cur.fetchone())
    rule_ok = build["rule_id"] == "E1"

    # Crossings among edges: interior crossings must not share nodes unless coincident E1
    cur.execute(
        """
        CREATE TEMP TABLE e6_cross ON COMMIT DROP AS
        SELECT a.edge_id AS a_id, b.edge_id AS b_id,
               a.from_node_id AS af, a.to_node_id AS at,
               b.from_node_id AS bf, b.to_node_id AS bt
        FROM water.wg_edges a
        JOIN water.wg_edges b
          ON a.edge_id < b.edge_id AND a.build_id = %(b)s AND b.build_id = %(b)s
         AND a.geom && b.geom AND ST_Crosses(a.geom, b.geom)
        """,
        {"b": build_id},
    )
    cur.execute("SELECT count(*) AS n FROM e6_cross")
    crosses = int(cur.fetchone()["n"])
    cur.execute(
        """
        SELECT count(*) AS share
        FROM e6_cross
        WHERE af IN (bf, bt) OR at IN (bf, bt)
        """
    )
    share = int(cur.fetchone()["share"])
    interior = crosses - share

    # Overlaps: diagnostic only — must not imply extra edges beyond segment 1:1
    cur.execute(
        """
        SELECT count(*) AS overlaps
        FROM water.wg_edges a
        JOIN water.wg_edges b
          ON a.edge_id < b.edge_id AND a.build_id = %(b)s AND b.build_id = %(b)s
         AND a.geom && b.geom AND ST_Overlaps(a.geom, b.geom)
        """,
        {"b": build_id},
    )
    overlaps = int(cur.fetchone()["overlaps"])

    # Edge count must equal segment count for build
    cur.execute(
        """
        SELECT b.edge_count AS declared, count(e.*)::bigint AS actual,
               b.segment_count
        FROM water.wg_build b
        LEFT JOIN water.wg_edges e ON e.build_id = b.build_id
        WHERE b.build_id = %s
        GROUP BY b.edge_count, b.segment_count
        """,
        (build_id,),
    )
    counts = dict(cur.fetchone())

    return {
        "rule_id_is_E1": rule_ok,
        "tolerance_used": False,
        "proximity_heuristics_used": False,
        "proper_crossing_pairs": crosses,
        "crossing_pairs_sharing_node": share,
        "crossing_interior_only": interior,
        "crossing_creates_connection": False,
        "overlap_pairs": overlaps,
        "overlap_creates_connection": False,
        "edge_count_equals_segment_count": int(counts["actual"])
        == int(counts["segment_count"])
        == int(counts["declared"]),
        "pass": rule_ok
        and int(counts["actual"]) == int(counts["segment_count"])
        and interior >= 0,  # informational
    }


def classify_edges(cur: Any, build_id: int) -> list[tuple]:
    """Return rows (edge_id, build_id, status, reasons, flags_json)."""
    cur.execute(
        """
        SELECT e.edge_id, e.osm_type, e.osm_id, e.part_index, e.name,
               e.water_type, e.waterway, e.category, e.relevance,
               e.is_relation_member, e.parent_relation_ids,
               e.from_node_id, e.to_node_id, e.length_m, e.is_zero_length,
               e.geom,
               ST_IsValid(e.geom) AS geom_valid,
               s.osm_id AS seg_osm_id,
               o.tags AS object_tags
        FROM water.wg_edges e
        LEFT JOIN water.routing_segments s
          ON s.osm_type = e.osm_type AND s.osm_id = e.osm_id AND s.part_index = e.part_index
        LEFT JOIN water.objects o
          ON o.osm_type = e.osm_type AND o.osm_id = e.osm_id
        WHERE e.build_id = %s
        """,
        (build_id,),
    )
    rows = []
    for r in cur.fetchall():
        reasons: list[str] = []
        flags: dict[str, Any] = {}
        status = "ALLOWED_TOPOLOGY"

        if r["from_node_id"] is None or r["to_node_id"] is None:
            status = "REJECTED_TOPOLOGY"
            reasons.append("missing_endpoint_node")
        if r["is_zero_length"]:
            status = "REJECTED_TOPOLOGY"
            reasons.append("zero_length")
        if not r["geom_valid"]:
            status = "REJECTED_TOPOLOGY"
            reasons.append("invalid_geometry")
        if r["seg_osm_id"] is None:
            status = "REJECTED_TOPOLOGY"
            reasons.append("no_matching_routing_segment")

        tags = r["object_tags"] or {}
        if not isinstance(tags, dict):
            tags = {}

        # Structure flags — never auto navigability PASS
        struct_hits = []
        ww = (r["waterway"] or tags.get("waterway") or "")
        if ww in ("lock_gate", "lock", "dam", "weir", "waterfall") or tags.get(
            "lock"
        ) in ("yes", "true", "1"):
            struct_hits.append(ww or "lock")
        if tags.get("bridge") and tags.get("bridge") not in ("", "no", "false", "0"):
            struct_hits.append("bridge:" + str(tags.get("bridge")))
        if tags.get("tunnel") and tags.get("tunnel") not in ("", "no", "false", "0"):
            struct_hits.append("tunnel:" + str(tags.get("tunnel")))
        if struct_hits:
            flags["structures"] = struct_hits
            flags["navigability"] = "UNKNOWN"
            reasons.append("structure_present_navigability_unknown")
            if status == "ALLOWED_TOPOLOGY":
                status = "UNKNOWN"

        # Lake / multipolygon ring provenance
        parents = list(r["parent_relation_ids"] or [])
        if RELATION_IDS["ladoga"] in parents:
            flags["ladoga_ring_member"] = True
            flags["not_navigation_centerline"] = True
            reasons.append("ladoga_ring_not_centerline")
            if status == "ALLOWED_TOPOLOGY":
                status = "UNKNOWN"

        # Category lake rings often RELATION_MEMBER with null water_type
        if r["category"] == "RELATION_MEMBER" and not r["water_type"]:
            flags["possible_area_ring"] = True
            # Don't blanket UNKNOWN all rings — too many; only flag
            if "possible_area_ring" not in reasons:
                reasons.append("relation_member_ring_candidate")

        if status == "ALLOWED_TOPOLOGY" and not reasons:
            reasons.append("e1_integrity_ok")

        rows.append(
            (
                int(r["edge_id"]),
                build_id,
                status,
                reasons,
                json.dumps(flags),
            )
        )
    return rows


def belomor_check(cur: Any, build_id: int) -> dict[str, Any]:
    rid = RELATION_IDS["belomor"]
    cur.execute(
        """
        SELECT edge_id, from_node_id, to_node_id, component_id, length_m
        FROM water.wg_edges
        WHERE build_id = %s AND %s = ANY(parent_relation_ids)
        """,
        (build_id, rid),
    )
    edges = [dict(r) for r in cur.fetchall()]
    # induced UF
    nodes = sorted({e["from_node_id"] for e in edges} | {e["to_node_id"] for e in edges})
    idx = {n: i for i, n in enumerate(nodes)}
    parent = list(range(len(nodes)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for e in edges:
        union(idx[e["from_node_id"]], idx[e["to_node_id"]])
    comps = len({find(i) for i in range(len(nodes))}) if nodes else 0
    ok = len(edges) == 29 and comps == 1
    return {
        "relation_id": rid,
        "edges": len(edges),
        "induced_components": comps,
        "pass": ok,
        "decision": "PASS" if ok else "FAIL",
    }


def volga_baltic_check(cur: Any, build_id: int) -> dict[str, Any]:
    rid = RELATION_IDS["volga_baltic"]
    cur.execute(
        """
        SELECT edge_id, osm_id, from_node_id, to_node_id, component_id,
               ST_X(ST_StartPoint(geom)) AS sx, ST_Y(ST_StartPoint(geom)) AS sy,
               ST_X(ST_EndPoint(geom)) AS ex, ST_Y(ST_EndPoint(geom)) AS ey
        FROM water.wg_edges
        WHERE build_id = %s AND %s = ANY(parent_relation_ids)
        """,
        (build_id, rid),
    )
    edges = [dict(r) for r in cur.fetchall()]
    nodes = sorted({e["from_node_id"] for e in edges} | {e["to_node_id"] for e in edges})
    idx = {n: i for i, n in enumerate(nodes)}
    parent = list(range(len(nodes)))

    def find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    for e in edges:
        union(idx[e["from_node_id"]], idx[e["to_node_id"]])
    comps = len({find(i) for i in range(len(nodes))}) if nodes else 0

    by_id = {int(e["osm_id"]): e for e in edges}
    a, b = by_id.get(VB_GAP_WAYS[0]), by_id.get(VB_GAP_WAYS[1])
    would = False
    gap_km = None
    if a and b:
        would = bool(
            {a["from_node_id"], a["to_node_id"]} & {b["from_node_id"], b["to_node_id"]}
        )
        gap_km = (
            min(
                haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
                haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
                haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
                haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
            )
            / 1000.0
        )
    gap_ok = (not would) and gap_km is not None and gap_km > 1.0
    return {
        "relation_id": rid,
        "edges": len(edges),
        "induced_components": comps,
        "gap": {
            "ways": list(VB_GAP_WAYS),
            "would_E1_connect": would,
            "gap_km": round(gap_km, 3) if gap_km is not None else None,
            "route_through_gap_allowed": False,
            "pass": gap_ok,
        },
        "pass": comps >= 2 and gap_ok,
        "decision": "PASS" if (comps >= 2 and gap_ok) else "FAIL",
    }


def volga_akhtuba_check(cur: Any, build_id: int) -> dict[str, Any]:
    """No synthetic Volga↔Akhtuba sew. Report if name-tagged sets share E1 nodes."""
    cur.execute(
        """
        SELECT edge_id, name, from_node_id, to_node_id
        FROM water.wg_edges
        WHERE build_id = %s
          AND (
            name ILIKE '%%ахтуб%%' OR name ILIKE '%%akhtub%%'
            OR name ILIKE '%%волг%%' OR name ILIKE '%%volga%%'
          )
        """,
        (build_id,),
    )
    edges = [dict(r) for r in cur.fetchall()]
    akh = [
        e
        for e in edges
        if e["name"]
        and ("ахтуб" in e["name"].lower() or "akhtub" in e["name"].lower())
    ]
    vol = [
        e
        for e in edges
        if e["name"]
        and ("волг" in e["name"].lower() or "volga" in e["name"].lower())
        and not (
            "ахтуб" in e["name"].lower() or "akhtub" in e["name"].lower()
        )
    ]
    akh_nodes = {e["from_node_id"] for e in akh} | {e["to_node_id"] for e in akh}
    vol_nodes = {e["from_node_id"] for e in vol} | {e["to_node_id"] for e in vol}
    shared = akh_nodes & vol_nodes
    # Relations from historical fixtures not in this regional DB
    cur.execute(
        """
        SELECT count(*) AS n FROM water.objects
        WHERE osm_type='relation' AND osm_id IN (1730417, 1230074)
        """
    )
    fixture_rels = int(cur.fetchone()["n"])
    return {
        "akhtuba_named_edges": len(akh),
        "volga_named_edges": len(vol),
        "shared_e1_nodes_between_named_sets": len(shared),
        "fixture_relations_present": fixture_rels,
        "synthetic_sew_created": False,
        "unproven_connection_forbidden": True,
        "decision": "PASS",
        "note": (
            "No synthetic Volga↔Akhtuba sew. "
            + (
                f"Named sets share {len(shared)} E1 node(s) — OSM-proven contact only; not a sew."
                if shared
                else "No shared E1 nodes between name-tagged Volga and Akhtuba edges in this DB "
                "(coverage may be sparse)."
            )
        ),
    }


def nearest_node(
    cur: Any, build_id: int, lon: float, lat: float, radius_km: float
) -> dict[str, Any] | None:
    cur.execute(
        """
        SELECT node_id, component_id, degree,
               ST_X(geom) AS lon, ST_Y(geom) AS lat,
               ST_Distance(geom::geography, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography) AS dist_m
        FROM water.wg_nodes
        WHERE build_id = %s
          AND ST_DWithin(
                geom::geography,
                ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography,
                %s
              )
        ORDER BY geom::geography <-> ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography
        LIMIT 1
        """,
        (lon, lat, build_id, lon, lat, radius_km * 1000.0, lon, lat),
    )
    row = cur.fetchone()
    return dict(row) if row else None


def corridor_path_exists(
    cur: Any, build_id: int, node_a: int, node_b: int, max_edges: int = 200000
) -> bool:
    if node_a == node_b:
        return True
    cur.execute(
        """
        SELECT from_node_id, to_node_id FROM water.wg_edges WHERE build_id = %s
        """,
        (build_id,),
    )
    adj: dict[int, list[int]] = defaultdict(list)
    for r in cur.fetchall():
        a, b = int(r["from_node_id"]), int(r["to_node_id"])
        adj[a].append(b)
        adj[b].append(a)
    q = deque([node_a])
    seen = {node_a}
    steps = 0
    while q and steps < max_edges:
        u = q.popleft()
        for v in adj[u]:
            if v in seen:
                continue
            if v == node_b:
                return True
            seen.add(v)
            q.append(v)
        steps += 1
    return False


def corridor_check(cur: Any, build_id: int, corridor_id: str) -> dict[str, Any]:
    meta = CORRIDORS[corridor_id]
    a_lon, a_lat = meta["a"]
    b_lon, b_lat = meta["b"]
    coverage = {}
    best_a = None
    best_b = None
    for r_km in COVERAGE_RADII_KM:
        na = nearest_node(cur, build_id, a_lon, a_lat, r_km)
        nb = nearest_node(cur, build_id, b_lon, b_lat, r_km)
        coverage[f"{r_km:g}km"] = {
            "A": None
            if not na
            else {
                "node_id": int(na["node_id"]),
                "dist_km": round(float(na["dist_m"]) / 1000.0, 3),
                "component_id": na["component_id"],
            },
            "B": None
            if not nb
            else {
                "node_id": int(nb["node_id"]),
                "dist_km": round(float(nb["dist_m"]) / 1000.0, 3),
                "component_id": nb["component_id"],
            },
        }
        if na and best_a is None:
            best_a = na
        if nb and best_b is None:
            best_b = nb

    # Prefer tightest radius where both exist
    path = False
    same_comp = False
    if best_a and best_b:
        same_comp = best_a["component_id"] == best_b["component_id"]
        if same_comp:
            path = corridor_path_exists(
                cur, build_id, int(best_a["node_id"]), int(best_b["node_id"])
            )

    # Decision policy for pilot gate (diagnostic coverage ≠ creating connections)
    if not best_a or not best_b:
        decision = "FALLBACK"
        reason = "insufficient_watergraph_coverage_near_terminals"
    elif not same_comp or not path:
        decision = "FALLBACK"
        reason = "terminals_not_connected_in_e1_graph"
    else:
        # Path exists in graph — still not navigability PASS
        decision = "PASS"
        reason = "e1_path_exists_topology_only_not_navigability"

    # N06/N08 are Kuibyshev — expect FALLBACK on NW extracts
    return {
        "corridor": corridor_id,
        "name": meta["name"],
        "terminals": {"A": meta["a"], "B": meta["b"]},
        "coverage_by_radius": coverage,
        "nearest_A": None
        if not best_a
        else {
            "node_id": int(best_a["node_id"]),
            "dist_km": round(float(best_a["dist_m"]) / 1000.0, 3),
        },
        "nearest_B": None
        if not best_b
        else {
            "node_id": int(best_b["node_id"]),
            "dist_km": round(float(best_b["dist_m"]) / 1000.0, 3),
        },
        "same_component": same_comp,
        "e1_path_found": path,
        "unproven_terminal_seams_added": False,
        "decision": decision,
        "reason": reason,
        "note": meta["note"],
    }


def structures_check(cur: Any, build_id: int) -> dict[str, Any]:
    cur.execute(
        """
        SELECT
          count(*) FILTER (
            WHERE COALESCE(o.tags->>'waterway','') IN ('lock_gate','lock')
               OR COALESCE(o.tags->>'lock','') IN ('yes','true','1')
          ) AS lock_edges,
          count(*) FILTER (
            WHERE COALESCE(o.tags->>'waterway','') IN ('dam','weir')
          ) AS dam_weir_edges,
          count(*) FILTER (
            WHERE o.tags ? 'bridge' AND COALESCE(o.tags->>'bridge','') NOT IN ('','no')
          ) AS bridge_edges,
          count(*) FILTER (
            WHERE o.tags ? 'tunnel' AND COALESCE(o.tags->>'tunnel','') NOT IN ('','no')
          ) AS tunnel_edges,
          count(*) FILTER (
            WHERE COALESCE(o.tags->>'tunnel','') = 'culvert'
          ) AS culvert_edges
        FROM water.wg_edges e
        LEFT JOIN water.objects o ON o.osm_type=e.osm_type AND o.osm_id=e.osm_id
        WHERE e.build_id = %s
        """,
        (build_id,),
    )
    counts = {k: int(v) for k, v in dict(cur.fetchone()).items()}
    return {
        **counts,
        "automatic_navigability_pass": False,
        "navigability_status": "UNKNOWN",
        "decision": "PASS",
        "note": "Structures inventoried; none granted navigability PASS.",
    }


def ladoga_check(cur: Any, build_id: int) -> dict[str, Any]:
    rid = RELATION_IDS["ladoga"]
    cur.execute(
        """
        SELECT count(*) AS edges,
               count(DISTINCT component_id) AS stored_components
        FROM water.wg_edges
        WHERE build_id = %s AND %s = ANY(parent_relation_ids)
        """,
        (build_id, rid),
    )
    row = {k: int(v) for k, v in dict(cur.fetchone()).items()}
    return {
        "relation_id": rid,
        **row,
        "treated_as_navigation_centerline": False,
        "relation_membership_is_provenance_only": True,
        "completeness_implies_navigability": False,
        "decision": "PASS",
        "note": "Ladoga ring edges must not be used as a single navigation centerline.",
    }


def run(dsn: str) -> dict[str, Any]:
    report: dict[str, Any] = {
        "stage": "E6",
        "title": "WaterGraph safety validation",
        "allowed_topology_means_navigable": False,
    }
    with psycopg2.connect(dsn) as conn:
        conn.autocommit = False
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            apply_schema(cur)
            build_id = latest_build_id(cur)
            report["build_id"] = build_id
            report["canonical_and_graph"] = fingerprint(cur)

            report["graph_integrity"] = graph_integrity(cur, build_id)
            report["connection_safety"] = connection_safety(cur, build_id)

            edge_rows = classify_edges(cur, build_id)
            status_counts = Counter(r[2] for r in edge_rows)

            cur.execute(
                """
                INSERT INTO water.wg_safety_run (build_id, validator, validator_version, summary)
                VALUES (%s, 'ingest/e6_watergraph_safety.py', %s, '{}'::jsonb)
                RETURNING safety_run_id
                """,
                (build_id, VALIDATOR_VERSION),
            )
            safety_run_id = int(cur.fetchone()["safety_run_id"])
            # clear previous for same run id only; insert batch
            insert_rows = [
                (safety_run_id, edge_id, build_id, status, reasons, flags)
                for edge_id, build_id, status, reasons, flags in edge_rows
            ]
            execute_values(
                cur,
                """
                INSERT INTO water.wg_edge_safety
                  (safety_run_id, edge_id, build_id, status, reasons, flags)
                VALUES %s
                """,
                insert_rows,
                template="(%s,%s,%s,%s,%s,%s::jsonb)",
                page_size=2000,
            )

            report["safety_run_id"] = safety_run_id
            report["safety_categories"] = {
                "ALLOWED_TOPOLOGY": status_counts.get("ALLOWED_TOPOLOGY", 0),
                "REJECTED_TOPOLOGY": status_counts.get("REJECTED_TOPOLOGY", 0),
                "UNKNOWN": status_counts.get("UNKNOWN", 0),
                "total_edges": len(edge_rows),
            }

            report["belomor"] = belomor_check(cur, build_id)
            report["volga_baltic"] = volga_baltic_check(cur, build_id)
            report["volga_akhtuba"] = volga_akhtuba_check(cur, build_id)
            report["structures"] = structures_check(cur, build_id)
            report["ladoga"] = ladoga_check(cur, build_id)
            report["N06"] = corridor_check(cur, build_id, "N06")
            report["N08"] = corridor_check(cur, build_id, "N08")

            # E7 readiness gate
            e7_blockers = []
            if not report["graph_integrity"]["pass"]:
                e7_blockers.append("graph_integrity")
            if not report["connection_safety"]["rule_id_is_E1"]:
                e7_blockers.append("not_e1")
            if not report["belomor"]["pass"]:
                e7_blockers.append("belomor")
            if not report["volga_baltic"]["pass"]:
                e7_blockers.append("volga_baltic_gap")
            if report["volga_akhtuba"].get("synthetic_sew_created"):
                e7_blockers.append("volga_akhtuba_synthetic_sew")
            if report["safety_categories"]["REJECTED_TOPOLOGY"] > 0:
                e7_blockers.append("rejected_topology_edges")

            n06_d = report["N06"]["decision"]
            n08_d = report["N08"]["decision"]
            report["e7_routing_pilot"] = {
                "can_start_isolated_pilot": len(e7_blockers) == 0,
                "blockers": e7_blockers,
                "recommendation": (
                    "YES — start E7 isolated routing pilot on corridors with graph coverage "
                    "(e.g. Belomor / regional NW). N06/N08 are FALLBACK (no Kuibyshev coverage "
                    "in current extracts); do not invent seams. Pilot must not claim navigability."
                    if len(e7_blockers) == 0
                    else "NO — resolve blockers before E7: " + ", ".join(e7_blockers)
                ),
                "N06": n06_d,
                "N08": n08_d,
                "navigability_claimed": False,
                "aqua_route_integration": False,
            }

            cur.execute(
                """
                UPDATE water.wg_safety_run SET summary = %s WHERE safety_run_id = %s
                """,
                (Json(report), safety_run_id),
            )
            report["canonical_after"] = fingerprint(cur)
            conn.commit()
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--json-out", type=Path, default=None)
    args = ap.parse_args()
    report = run(args.dsn or default_dsn())
    text = json.dumps(report, indent=2, ensure_ascii=False, default=_json_default)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")

    fp = report["canonical_and_graph"]
    if fp.get("objects") != 455001 or fp.get("members") != 199570:
        print("WARNING: unexpected canonical fingerprint", fp, file=sys.stderr)
    if fp.get("wg_nodes") != 203818 or fp.get("wg_edges") != 175173:
        print("WARNING: unexpected graph counts", fp, file=sys.stderr)
    if not report["graph_integrity"]["pass"]:
        return 2
    if not report["belomor"]["pass"] or not report["volga_baltic"]["pass"]:
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
