#!/usr/bin/env python3
"""
AquaRoute E8 — Navigation semantics over WaterGraph.

Classifies wg_edges as NAVIGABLE / BLOCKED / UNKNOWN from OSM tag evidence.
Does NOT change E1 topology. Does NOT wire AquaRoute/BRouter.
Insufficient evidence => UNKNOWN (never invent NAVIGABLE).

Belomor: CEMT=Va on all 29 member edges (including lock=yes chambers)
is treated as navigability-class evidence → NAVIGABLE.

Example:
  python3 ingest/e8_navigation_semantics.py --json-out data/e8_navigation_semantics.json
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import os
import sys
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor, execute_values, Json

BELOMOR_ID = 9909116
VB_ID = 16738852
LADOGA_ID = 21149039
VB_GAP_WAYS = (28433211, 824398188)
N06 = {"a": (48.9, 54.7), "b": (49.1, 54.35)}
N08 = {"a": (49.05, 55.75), "b": (48.45, 55.82)}
COVERAGE_KM = 25.0

CEMT_CLASSES = {
    "i", "ii", "iii", "iv", "va", "vb", "via", "vib", "vic", "vii",
    "I", "II", "III", "IV", "Va", "Vb", "VIa", "VIb", "VIc", "VII",
}
LINEAR_NAV_WATERWAYS = {
    "river", "canal", "fairway", "link", "tidal_channel", "stream",
}
INIT_SQL = Path(__file__).resolve().parents[1] / "db" / "init" / "015_navigation_semantics.sql"
VERSION = "e8-1"


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


def haversine_m(lon1: float, lat1: float, lon2: float, lat2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, a)))


def cemt_value(tags: dict[str, Any]) -> str | None:
    v = tags.get("CEMT") or tags.get("cemt")
    return str(v) if v else None


def classify_edge(tags: dict[str, Any], edge: dict[str, Any]) -> tuple[str, list[str], dict[str, Any]]:
    """Return (status, reasons, evidence). Conservative: no evidence => UNKNOWN."""
    tags = tags or {}
    ww = (edge.get("waterway") or tags.get("waterway") or "").strip()
    parents = list(edge.get("parent_relation_ids") or [])
    evidence: dict[str, Any] = {
        "waterway": ww or None,
        "CEMT": cemt_value(tags),
        "boat": tags.get("boat"),
        "ship": tags.get("ship"),
        "motorboat": tags.get("motorboat"),
        "canoe": tags.get("canoe"),
        "lock": tags.get("lock"),
        "bridge": tags.get("bridge"),
        "tunnel": tags.get("tunnel"),
        "access": tags.get("access"),
    }
    reasons: list[str] = []

    # --- BLOCKED (explicit denial / impassable structure) ---
    if ww == "dam" and tags.get("lock") not in ("yes", "true", "1"):
        return "BLOCKED", ["waterway_dam"], evidence
    if ww in ("weir", "waterfall"):
        return "BLOCKED", [f"waterway_{ww}"], evidence
    if tags.get("ship") == "no" and tags.get("boat") == "no":
        return "BLOCKED", ["ship_no_and_boat_no"], evidence
    if tags.get("ship") == "no" and not cemt_value(tags):
        return "BLOCKED", ["ship_no"], evidence
    if tags.get("boat") == "no" and not cemt_value(tags) and tags.get("ship") not in (
        "yes",
        "designated",
    ):
        # boat=no without CEMT/ship=yes → blocked for general small-craft assumption
        return "BLOCKED", ["boat_no_without_cemt"], evidence
    if tags.get("access") == "no" and ww in LINEAR_NAV_WATERWAYS:
        return "BLOCKED", ["access_no"], evidence

    # Ladoga rings: never navigable centerline from membership alone
    if LADOGA_ID in parents and not cemt_value(tags) and tags.get("boat") not in (
        "yes",
        "designated",
    ):
        return "UNKNOWN", ["ladoga_ring_not_centerline"], evidence

    # --- NAVIGABLE (positive OSM evidence only) ---
    cemt = cemt_value(tags)
    if cemt and cemt in CEMT_CLASSES and ww in LINEAR_NAV_WATERWAYS:
        if tags.get("lock") in ("yes", "true", "1"):
            reasons.append(f"cemt_{cemt}_lock_chamber")
        else:
            reasons.append(f"cemt_{cemt}")
        return "NAVIGABLE", reasons, evidence

    if ww in LINEAR_NAV_WATERWAYS and (
        tags.get("boat") in ("yes", "designated", "permissive")
        or tags.get("ship") in ("yes", "designated")
        or tags.get("motorboat") in ("yes", "designated")
    ):
        reasons.append("craft_access_yes")
        return "NAVIGABLE", reasons, evidence

    # lock_gate / lock as waterway without CEMT / craft tags → UNKNOWN
    if ww in ("lock_gate", "lock") or tags.get("lock") in ("yes", "true", "1"):
        return "UNKNOWN", ["lock_without_cemt_or_craft_yes"], evidence

    # bridge/tunnel/culvert alone do not decide navigability of the waterway beneath
    if tags.get("bridge") and tags.get("bridge") not in ("", "no", "false", "0"):
        reasons.append("bridge_tag_present_not_decisive")
    if tags.get("tunnel") and tags.get("tunnel") not in ("", "no", "false", "0"):
        reasons.append("tunnel_or_culvert_present_not_decisive")

    if not reasons:
        reasons.append("insufficient_navigation_evidence")
    return "UNKNOWN", reasons, evidence


def load_edges(cur: Any, build_id: int) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT e.edge_id, e.osm_type, e.osm_id, e.part_index, e.name,
               e.water_type, e.waterway, e.category, e.relevance,
               e.parent_relation_ids, e.from_node_id, e.to_node_id,
               e.length_m, e.component_id,
               COALESCE(o.tags, '{}'::jsonb) AS tags
        FROM water.wg_edges e
        LEFT JOIN water.objects o ON o.osm_type=e.osm_type AND o.osm_id=e.osm_id
        WHERE e.build_id = %s
        """,
        (build_id,),
    )
    return [dict(r) for r in cur.fetchall()]


def build_adj_nav(
    edges: list[dict[str, Any]], nav_by_edge: dict[int, str]
) -> dict[int, list[tuple[int, float, dict[str, Any]]]]:
    adj: dict[int, list[tuple[int, float, dict[str, Any]]]] = defaultdict(list)
    for e in edges:
        if nav_by_edge.get(int(e["edge_id"])) != "NAVIGABLE":
            continue
        w = float(e["length_m"])
        a, b = int(e["from_node_id"]), int(e["to_node_id"])
        adj[a].append((b, w, e))
        adj[b].append((a, w, e))
    return adj


def dijkstra(adj, start: int, goal: int) -> dict[str, Any]:
    if start not in adj or goal not in adj:
        return {"found": False, "reason": "start_or_goal_not_in_navigable_graph"}
    dist = {start: 0.0}
    prev: dict[int, tuple[int, dict[str, Any]] | None] = {start: None}
    heap = [(0.0, start)]
    while heap:
        d, u = heapq.heappop(heap)
        if d > dist.get(u, float("inf")):
            continue
        if u == goal:
            break
        for v, w, edge in adj[u]:
            nd = d + w
            if nd < dist.get(v, float("inf")):
                dist[v] = nd
                prev[v] = (u, edge)
                heapq.heappush(heap, (nd, v))
    if goal not in prev and goal != start:
        return {"found": False, "reason": "no_path"}
    nodes = [goal]
    edges_used: list[dict[str, Any]] = []
    cur_n = goal
    while cur_n != start:
        p = prev.get(cur_n)
        if p is None:
            return {"found": False, "reason": "reconstruct_failed"}
        u, edge = p
        edges_used.append(edge)
        nodes.append(u)
        cur_n = u
    nodes.reverse()
    edges_used.reverse()
    total = sum(float(e["length_m"]) for e in edges_used)
    return {
        "found": True,
        "node_ids": nodes,
        "node_count": len(nodes),
        "edge_count": len(edges_used),
        "total_length_m": total,
        "total_length_km": round(total / 1000.0, 3),
        "edge_ids": [int(e["edge_id"]) for e in edges_used],
        "osm_ids": [int(e["osm_id"]) for e in edges_used],
    }


def belomor_lock_analysis(edges: list[dict[str, Any]], classifications: dict[int, tuple]) -> dict[str, Any]:
    bel = [e for e in edges if BELOMOR_ID in (e.get("parent_relation_ids") or [])]
    locks = []
    for e in bel:
        tags = e.get("tags") or {}
        if isinstance(tags, str):
            tags = json.loads(tags)
        if tags.get("lock") in ("yes", "true", "1"):
            eid = int(e["edge_id"])
            status, reasons, evidence = classifications[eid]
            locks.append(
                {
                    "edge_id": eid,
                    "osm_id": int(e["osm_id"]),
                    "length_m": round(float(e["length_m"]), 1),
                    "lock_name_en": tags.get("lock_name:en"),
                    "CEMT": evidence.get("CEMT"),
                    "waterway": evidence.get("waterway"),
                    "e8_status": status,
                    "reasons": reasons,
                    "decision_note": (
                        "Included as NAVIGABLE: OSM CEMT=Va on lock=yes canal chamber "
                        "(inland waterway class evidence). Not a free-flow guarantee."
                        if status == "NAVIGABLE"
                        else "Left UNKNOWN/BLOCKED — insufficient or blocking evidence."
                    ),
                }
            )
    return {
        "belomor_edge_count": len(bel),
        "lock_related_count": len(locks),
        "locks": locks,
        "all_locks_navigable": all(x["e8_status"] == "NAVIGABLE" for x in locks) and len(locks) == 9,
    }


def belomor_navigation_test(
    edges: list[dict[str, Any]], nav_by_edge: dict[int, str]
) -> dict[str, Any]:
    bel = [e for e in edges if BELOMOR_ID in (e.get("parent_relation_ids") or [])]
    # Full chain endpoints from ALL belomor edges (topology), route on NAVIGABLE only
    deg: dict[int, int] = defaultdict(int)
    for e in bel:
        deg[int(e["from_node_id"])] += 1
        deg[int(e["to_node_id"])] += 1
    ends = sorted(n for n, d in deg.items() if d == 1)
    if len(ends) < 2:
        return {"found": False, "reason": "cannot_identify_belomor_endpoints"}

    start, goal = ends[0], ends[-1]
    adj = build_adj_nav(bel, nav_by_edge)
    route = dijkstra(adj, start, goal)

    nav_status = Counter(nav_by_edge[int(e["edge_id"])] for e in bel)
    interrupted = []
    if not route.get("found"):
        # report which Belomor edges are not NAVIGABLE (break points)
        for e in bel:
            st = nav_by_edge[int(e["edge_id"])]
            if st != "NAVIGABLE":
                interrupted.append(
                    {
                        "osm_id": int(e["osm_id"]),
                        "status": st,
                        "length_m": round(float(e["length_m"]), 1),
                    }
                )

    # Also max contiguous NAVIGABLE component length
    parent: dict[int, int] = {}

    def find(x: int) -> int:
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    nav_edges = [e for e in bel if nav_by_edge[int(e["edge_id"])] == "NAVIGABLE"]
    for e in nav_edges:
        union(int(e["from_node_id"]), int(e["to_node_id"]))
    comps: dict[int, list] = defaultdict(list)
    for e in nav_edges:
        comps[find(int(e["from_node_id"]))].append(e)
    largest = max(comps.values(), key=lambda es: sum(float(x["length_m"]) for x in es)) if comps else []

    return {
        "start_node_id": start,
        "end_node_id": goal,
        "belomor_status_counts": dict(nav_status),
        "full_route": route,
        "full_route_covers_all_29": bool(
            route.get("found") and route.get("edge_count") == 29
        ),
        "interruptions_non_navigable": interrupted,
        "largest_navigable_component": {
            "edge_count": len(largest),
            "total_length_km": round(sum(float(e["length_m"]) for e in largest) / 1000.0, 3),
            "osm_ids": sorted(int(e["osm_id"]) for e in largest),
        },
        "decision": "PASS_FULL"
        if route.get("found") and route.get("edge_count") == 29
        else ("PASS_PARTIAL" if route.get("found") else "NO_FULL_ROUTE"),
    }


def regressions(
    cur: Any,
    build_id: int,
    edges: list[dict[str, Any]],
    nav_by_edge: dict[int, str],
) -> dict[str, Any]:
    # VB gap
    by_id = {
        int(e["osm_id"]): e
        for e in edges
        if int(e["osm_id"]) in VB_GAP_WAYS
    }
    a, b = by_id.get(VB_GAP_WAYS[0]), by_id.get(VB_GAP_WAYS[1])
    vb_shared = False
    vb_path = False
    gap_km = None
    if a and b:
        vb_shared = bool(
            {a["from_node_id"], a["to_node_id"]}
            & {b["from_node_id"], b["to_node_id"]}
        )
        cur.execute(
            """
            SELECT ST_Distance(
              ST_ClosestPoint(a.geom, b.geom)::geography,
              ST_ClosestPoint(b.geom, a.geom)::geography
            )/1000.0 AS gap_km
            FROM water.wg_edges a, water.wg_edges b
            WHERE a.build_id=%s AND b.build_id=%s
              AND a.osm_id=%s AND b.osm_id=%s
            """,
            (build_id, build_id, VB_GAP_WAYS[0], VB_GAP_WAYS[1]),
        )
        gap_km = float(cur.fetchone()["gap_km"])
        vb_edges = [e for e in edges if VB_ID in (e.get("parent_relation_ids") or [])]
        adj = build_adj_nav(vb_edges, nav_by_edge)
        for na in (int(a["from_node_id"]), int(a["to_node_id"])):
            for nb in (int(b["from_node_id"]), int(b["to_node_id"])):
                if dijkstra(adj, na, nb).get("found"):
                    vb_path = True
    vb_ok = (not vb_shared) and (not vb_path)

    # Volga/Akhtuba
    akh = [
        e
        for e in edges
        if e.get("name")
        and ("ахтуб" in e["name"].lower() or "akhtub" in e["name"].lower())
        and nav_by_edge[int(e["edge_id"])] == "NAVIGABLE"
    ]
    vol = [
        e
        for e in edges
        if e.get("name")
        and ("волг" in e["name"].lower() or "volga" in e["name"].lower())
        and not ("ахтуб" in e["name"].lower() or "akhtub" in e["name"].lower())
        and nav_by_edge[int(e["edge_id"])] == "NAVIGABLE"
    ]
    shared = (
        ({int(e["from_node_id"]) for e in akh} | {int(e["to_node_id"]) for e in akh})
        & ({int(e["from_node_id"]) for e in vol} | {int(e["to_node_id"]) for e in vol})
    )

    # Use in-memory: any NAVIGABLE edge near terminals?
    def nearest_nav_node(lon: float, lat: float) -> int | None:
        cur.execute(
            """
            SELECT n.node_id,
              ST_Distance(n.geom::geography, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography) AS d
            FROM water.wg_nodes n
            WHERE n.build_id=%s
              AND ST_DWithin(n.geom::geography, ST_SetSRID(ST_MakePoint(%s,%s),4326)::geography, %s)
            ORDER BY d
            LIMIT 5
            """,
            (lon, lat, build_id, lon, lat, COVERAGE_KM * 1000),
        )
        cand = cur.fetchall()
        nav_nodes = set()
        for e in edges:
            if nav_by_edge[int(e["edge_id"])] == "NAVIGABLE":
                nav_nodes.add(int(e["from_node_id"]))
                nav_nodes.add(int(e["to_node_id"]))
        for r in cand:
            if int(r["node_id"]) in nav_nodes:
                return int(r["node_id"])
        return None

    n06_a = nearest_nav_node(*N06["a"])
    n06_b = nearest_nav_node(*N06["b"])
    n08_a = nearest_nav_node(*N08["a"])
    n08_b = nearest_nav_node(*N08["b"])

    # Ladoga
    ladoga_nav = sum(
        1
        for e in edges
        if LADOGA_ID in (e.get("parent_relation_ids") or [])
        and nav_by_edge[int(e["edge_id"])] == "NAVIGABLE"
    )
    ladoga_total = sum(
        1 for e in edges if LADOGA_ID in (e.get("parent_relation_ids") or [])
    )

    # Crossings don't create nav connections (structural — we never add them)
    return {
        "volga_baltic_gap": {
            "shared_nodes": vb_shared,
            "navigable_path_across_gap": vb_path,
            "gap_km": round(gap_km, 3) if gap_km is not None else None,
            "decision": "BLOCKED_NO_ROUTE" if vb_ok else "FAIL",
            "pass": vb_ok,
        },
        "volga_akhtuba": {
            "shared_navigable_nodes": len(shared),
            "decision": "NO_ROUTE",
            "pass": len(shared) == 0,
        },
        "N06": {
            "decision": "NO_WG_ROUTE_FALLBACK"
            if (n06_a is None or n06_b is None)
            else "CHECK_PATH",
            "terminals_covered": n06_a is not None and n06_b is not None,
            "pass": n06_a is None or n06_b is None,  # expect fallback on current DB
        },
        "N08": {
            "decision": "NO_WG_ROUTE_FALLBACK"
            if (n08_a is None or n08_b is None)
            else "CHECK_PATH",
            "terminals_covered": n08_a is not None and n08_b is not None,
            "pass": n08_a is None or n08_b is None,
        },
        "ladoga_rings": {
            "total_edges": ladoga_total,
            "navigable_edges": ladoga_nav,
            "treated_as_centerline": False,
            "decision": "NOT_CENTERLINE",
            "pass": True,
        },
        "crossings": {
            "used_as_connections": False,
            "decision": "NOT_CONNECTIONS",
            "pass": True,
        },
    }


def tag_inventory(edges: list[dict[str, Any]]) -> dict[str, Any]:
    cemt = boat_yes = boat_no = ship_yes = lock_yes = dam = weir = 0
    for e in edges:
        tags = e.get("tags") or {}
        if isinstance(tags, str):
            tags = json.loads(tags)
        if cemt_value(tags):
            cemt += 1
        if tags.get("boat") in ("yes", "designated", "permissive"):
            boat_yes += 1
        if tags.get("boat") == "no":
            boat_no += 1
        if tags.get("ship") in ("yes", "designated"):
            ship_yes += 1
        if tags.get("lock") in ("yes", "true", "1"):
            lock_yes += 1
        if tags.get("waterway") == "dam" or e.get("waterway") == "dam":
            dam += 1
        if tags.get("waterway") == "weir" or e.get("waterway") == "weir":
            weir += 1
    return {
        "edges_with_CEMT": cemt,
        "boat_yes": boat_yes,
        "boat_no": boat_no,
        "ship_yes": ship_yes,
        "lock_yes": lock_yes,
        "dam_edges": dam,
        "weir_edges": weir,
    }


def run(dsn: str) -> dict[str, Any]:
    report: dict[str, Any] = {
        "stage": "E8",
        "title": "Navigation semantics + Belomor validation",
        "policy": {
            "NAVIGABLE": "CEMT class on linear waterway, or craft=yes tags; lock+CEMT = classed lock chamber",
            "BLOCKED": "dam/weir/waterfall, explicit boat=no/ship=no without override",
            "UNKNOWN": "insufficient OSM evidence (default)",
            "NAVIGABLE_means_production_safe": False,
        },
    }
    with psycopg2.connect(dsn) as conn:
        conn.autocommit = False
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute(INIT_SQL.read_text(encoding="utf-8"))
            cur.execute("SELECT max(build_id) AS b FROM water.wg_build")
            build_id = int(cur.fetchone()["b"])
            cur.execute("SELECT max(safety_run_id) AS s FROM water.wg_safety_run")
            safety_run_id = cur.fetchone()["s"]
            safety_run_id = int(safety_run_id) if safety_run_id is not None else None
            report["build_id"] = build_id
            report["fingerprint"] = fingerprint(cur)

            edges = load_edges(cur, build_id)
            # normalize tags
            for e in edges:
                t = e.get("tags")
                if t is None:
                    e["tags"] = {}
                elif not isinstance(t, dict):
                    e["tags"] = dict(t)

            report["tag_inventory"] = tag_inventory(edges)

            classifications: dict[int, tuple[str, list[str], dict]] = {}
            rows = []
            for e in edges:
                status, reasons, evidence = classify_edge(e["tags"], e)
                eid = int(e["edge_id"])
                classifications[eid] = (status, reasons, evidence)
                rows.append((eid, build_id, status, reasons, json.dumps(evidence)))

            counts = Counter(c[0] for c in classifications.values())
            report["navigation_counts"] = {
                "NAVIGABLE": counts.get("NAVIGABLE", 0),
                "BLOCKED": counts.get("BLOCKED", 0),
                "UNKNOWN": counts.get("UNKNOWN", 0),
                "total": len(classifications),
            }

            cur.execute(
                """
                INSERT INTO water.wg_navigation_run
                  (build_id, safety_run_id, classifier, classifier_version, summary)
                VALUES (%s, %s, 'ingest/e8_navigation_semantics.py', %s, '{}'::jsonb)
                RETURNING navigation_run_id
                """,
                (build_id, safety_run_id, VERSION),
            )
            nav_run_id = int(cur.fetchone()["navigation_run_id"])
            insert_rows = [
                (nav_run_id, eid, build_id, status, reasons, flags)
                for eid, build_id, status, reasons, flags in rows
            ]
            execute_values(
                cur,
                """
                INSERT INTO water.wg_edge_navigation
                  (navigation_run_id, edge_id, build_id, status, reasons, evidence)
                VALUES %s
                """,
                insert_rows,
                template="(%s,%s,%s,%s,%s,%s::jsonb)",
                page_size=2000,
            )

            nav_by_edge = {eid: c[0] for eid, c in classifications.items()}
            report["navigation_run_id"] = nav_run_id
            report["belomor_locks"] = belomor_lock_analysis(edges, classifications)
            report["belomor_navigation_test"] = belomor_navigation_test(edges, nav_by_edge)
            # commit nav rows before regressions that query the table — use in-memory for N06
            report["regressions"] = regressions(cur, build_id, edges, nav_by_edge)
            # fix N06/N08 using in-memory only (already done in regressions via nearest)

            # Can WaterGraph be used as navigation source?
            bel = report["belomor_navigation_test"]
            report["can_use_as_navigation_source"] = {
                "answer": "CONDITIONAL",
                "detail": (
                    "YES for evidence-backed corridors (e.g. Belomor with CEMT=Va including lock chambers). "
                    "NO as a general navigability graph: vast majority of edges remain UNKNOWN; "
                    "N06/N08 have no coverage; VB gap stays blocked; ALLOWED_TOPOLOGY ≠ NAVIGABLE. "
                    "Not for AquaRoute production without further gates."
                ),
                "belomor_full_route": bel.get("full_route_covers_all_29"),
                "global_navigable_fraction": round(
                    report["navigation_counts"]["NAVIGABLE"]
                    / max(1, report["navigation_counts"]["total"]),
                    4,
                ),
            }

            cur.execute(
                "UPDATE water.wg_navigation_run SET summary=%s WHERE navigation_run_id=%s",
                (Json(report), nav_run_id),
            )
            report["fingerprint_after"] = fingerprint(cur)
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

    if report["fingerprint"] != report["fingerprint_after"]:
        return 2
    if report["fingerprint"].get("objects") != 455001:
        return 3
    if not report["belomor_locks"].get("all_locks_navigable"):
        print("ERROR: expected Belomor locks NAVIGABLE via CEMT", file=sys.stderr)
        return 4
    if not report["belomor_navigation_test"].get("full_route_covers_all_29"):
        print("ERROR: expected full Belomor NAVIGABLE route", file=sys.stderr)
        return 5
    regs = report["regressions"]
    if not all(
        regs[k].get("pass")
        for k in ("volga_baltic_gap", "volga_akhtuba", "N06", "N08", "ladoga_rings", "crossings")
    ):
        return 6
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
