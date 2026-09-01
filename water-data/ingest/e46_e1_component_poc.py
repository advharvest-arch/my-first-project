#!/usr/bin/env python3
"""
AquaRoute E4.6 — READ-ONLY E1 topology component PoC.

Apply E4.5 rule E1 only: exact endpoint match = connection candidate.
Build in-memory connected components from water.routing_segments.

Does NOT create graph tables/nodes/edges, mutate data, use tolerance,
stitch gaps, resolve crossings, or claim navigability.

Example:
  python3 ingest/e46_e1_component_poc.py --json-out data/e46_e1_components.json
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
from collections import Counter, defaultdict
from decimal import Decimal
from pathlib import Path
from typing import Any

import psycopg2
from psycopg2.extras import RealDictCursor

RELATION_IDS = {
    "belomor": 9909116,
    "volga_baltic": 16738852,
    "ladoga": 21149039,
}
VB_GAP_WAYS = (28433211, 824398188)
E1_DECIMALS = 7  # E4.5 exact endpoint identity


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


def e1_key(x: float, y: float) -> tuple[float, float]:
    return (round(float(x), E1_DECIMALS), round(float(y), E1_DECIMALS))


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
          (SELECT count(*) FROM water.object_conflicts) AS conflicts
        """
    )
    return {k: int(v) for k, v in dict(cur.fetchone()).items()}


class UnionFind:
    def __init__(self, n: int) -> None:
        self.parent = list(range(n))
        self.rank = [0] * n

    def find(self, x: int) -> int:
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra == rb:
            return
        if self.rank[ra] < self.rank[rb]:
            self.parent[ra] = rb
        elif self.rank[ra] > self.rank[rb]:
            self.parent[rb] = ra
        else:
            self.parent[rb] = ra
            self.rank[ra] += 1


def load_segments(cur: Any) -> list[dict[str, Any]]:
    cur.execute(
        """
        SELECT
          osm_type,
          osm_id,
          part_index,
          length_m,
          water_type,
          waterway,
          category,
          relevance,
          name,
          is_relation_member,
          parent_relation_ids,
          ST_X(start_point) AS sx,
          ST_Y(start_point) AS sy,
          ST_X(end_point) AS ex,
          ST_Y(end_point) AS ey
        FROM water.routing_segments
        WHERE start_point IS NOT NULL AND end_point IS NOT NULL
        ORDER BY osm_type, osm_id, part_index
        """
    )
    rows = []
    for i, r in enumerate(cur.fetchall()):
        d = dict(r)
        d["idx"] = i
        d["seg_key"] = f"{d['osm_type']}:{d['osm_id']}:{d['part_index']}"
        d["start_e1"] = e1_key(d["sx"], d["sy"])
        d["end_e1"] = e1_key(d["ex"], d["ey"])
        d["parent_relation_ids"] = list(d["parent_relation_ids"] or [])
        rows.append(d)
    return rows


def build_components(segs: list[dict[str, Any]]) -> dict[str, Any]:
    n = len(segs)
    uf = UnionFind(n)
    endpoint_to_segs: dict[tuple[float, float], list[int]] = defaultdict(list)
    for s in segs:
        endpoint_to_segs[s["start_e1"]].append(s["idx"])
        endpoint_to_segs[s["end_e1"]].append(s["idx"])

    # E1 edges: all segments sharing an exact endpoint key are mutually connected
    e1_edges = 0
    for _key, idxs in endpoint_to_segs.items():
        uniq = sorted(set(idxs))
        if len(uniq) < 2:
            continue
        base = uniq[0]
        for other in uniq[1:]:
            uf.union(base, other)
            e1_edges += 1

    root_members: dict[int, list[int]] = defaultdict(list)
    for i in range(n):
        root_members[uf.find(i)].append(i)

    components = []
    for root, members in root_members.items():
        components.append(
            {
                "root": root,
                "member_idxs": members,
                "size": len(members),
            }
        )
    components.sort(key=lambda c: (-c["size"], c["root"]))

    # Assign stable component ids by size rank
    for cid, c in enumerate(components):
        c["component_id"] = cid
        for i in c["member_idxs"]:
            segs[i]["component_id"] = cid

    size_hist = Counter(c["size"] for c in components)
    isolated = sum(1 for c in components if c["size"] == 1)
    nontrivial = sum(1 for c in components if c["size"] >= 2)

    return {
        "uf": uf,
        "endpoint_to_segs": endpoint_to_segs,
        "components": components,
        "e1_adjacency_links": e1_edges,
        "unique_exact_endpoints": len(endpoint_to_segs),
        "component_count": len(components),
        "nontrivial_component_count": nontrivial,
        "isolated_segments": isolated,
        "size_distribution": [
            {"size": size, "components": count}
            for size, count in sorted(size_hist.items())
        ],
    }


def summarize_component(
    segs: list[dict[str, Any]], member_idxs: list[int], top_examples: int = 8
) -> dict[str, Any]:
    members = [segs[i] for i in member_idxs]
    length_m = sum(float(m["length_m"] or 0.0) for m in members)
    osm_ids = {(m["osm_type"], m["osm_id"]) for m in members}
    water_types = Counter(m["water_type"] or "(null)" for m in members)
    categories = Counter(m["category"] or "(null)" for m in members)
    relevances = Counter(m["relevance"] or "(null)" for m in members)
    parent_rels: set[int] = set()
    for m in members:
        parent_rels.update(m["parent_relation_ids"])
    # representative: prefer named / HIGH / longer
    ranked = sorted(
        members,
        key=lambda m: (
            0 if m.get("name") else 1,
            0 if m.get("relevance") == "HIGH" else 1,
            -(float(m["length_m"] or 0)),
            m["osm_id"],
        ),
    )
    examples = [
        {
            "osm_type": m["osm_type"],
            "osm_id": m["osm_id"],
            "part_index": m["part_index"],
            "name": m.get("name"),
            "water_type": m.get("water_type"),
            "category": m.get("category"),
            "relevance": m.get("relevance"),
            "length_m": round(float(m["length_m"] or 0), 2),
        }
        for m in ranked[:top_examples]
    ]
    return {
        "segment_count": len(members),
        "total_length_m": round(length_m, 2),
        "total_length_km": round(length_m / 1000.0, 3),
        "unique_osm_identities": len(osm_ids),
        "water_type_counts": dict(water_types.most_common(12)),
        "category_counts": dict(categories.most_common(12)),
        "relevance_counts": dict(relevances.most_common(8)),
        "parent_relation_count": len(parent_rels),
        "parent_relation_ids_sample": sorted(parent_rels)[:20],
        "representative_objects": examples,
    }


def relation_subset(
    segs: list[dict[str, Any]], relation_id: int
) -> list[dict[str, Any]]:
    return [s for s in segs if relation_id in s["parent_relation_ids"]]


def analyze_relation_components(
    segs: list[dict[str, Any]], relation_id: int
) -> dict[str, Any]:
    """Components induced by E1 among segments that belong to this relation only.

    Global E1 may connect a Belomor way to a non-member neighbor; for relation PoC
    we also report the subgraph of member segments under E1 edges that stay
    within the member set (induced).
    """
    members = relation_subset(segs, relation_id)
    if not members:
        return {"member_segments": 0, "components": []}

    # Remap to local UF
    local_index = {m["idx"]: i for i, m in enumerate(members)}
    uf = UnionFind(len(members))
    ep: dict[tuple[float, float], list[int]] = defaultdict(list)
    for m in members:
        li = local_index[m["idx"]]
        ep[m["start_e1"]].append(li)
        ep[m["end_e1"]].append(li)
    for idxs in ep.values():
        uniq = sorted(set(idxs))
        if len(uniq) < 2:
            continue
        base = uniq[0]
        for other in uniq[1:]:
            uf.union(base, other)

    groups: dict[int, list[int]] = defaultdict(list)
    for i in range(len(members)):
        groups[uf.find(i)].append(i)
    comps = sorted((len(v), v) for v in groups.values())
    comps.reverse()

    # Global component ids among members
    global_cids = Counter(m["component_id"] for m in members)

    return {
        "member_segments": len(members),
        "induced_component_count": len(comps),
        "induced_largest_size": comps[0][0] if comps else 0,
        "induced_size_distribution": [
            {"size": size, "components": count}
            for size, count in sorted(Counter(s for s, _ in comps).items())
        ],
        "distinct_global_component_ids": len(global_cids),
        "global_component_id_counts_top": dict(global_cids.most_common(10)),
    }


def belomor_poc(segs: list[dict[str, Any]]) -> dict[str, Any]:
    rid = RELATION_IDS["belomor"]
    induced = analyze_relation_components(segs, rid)
    ok = (
        induced["member_segments"] == 29
        and induced["induced_component_count"] == 1
        and induced["induced_largest_size"] == 29
    )
    return {
        "relation_id": rid,
        **induced,
        "expected_single_component_of_29": True,
        "E1_chain_preserved": ok,
        "note": "Expect one induced E1 component of all 29 Belomor member segments.",
    }


def volga_baltic_poc(segs: list[dict[str, Any]]) -> dict[str, Any]:
    rid = RELATION_IDS["volga_baltic"]
    induced = analyze_relation_components(segs, rid)
    by_id = {
        s["osm_id"]: s
        for s in segs
        if s["osm_type"] == "way" and s["osm_id"] in VB_GAP_WAYS
    }
    a = by_id.get(VB_GAP_WAYS[0])
    b = by_id.get(VB_GAP_WAYS[1])
    would_e1 = False
    gap_m = None
    same_component = None
    if a and b:
        ends_a = {a["start_e1"], a["end_e1"]}
        ends_b = {b["start_e1"], b["end_e1"]}
        would_e1 = bool(ends_a & ends_b)
        gap_m = min(
            haversine_m(a["ex"], a["ey"], b["sx"], b["sy"]),
            haversine_m(a["ex"], a["ey"], b["ex"], b["ey"]),
            haversine_m(a["sx"], a["sy"], b["sx"], b["sy"]),
            haversine_m(a["sx"], a["sy"], b["ex"], b["ey"]),
        )
        same_component = a["component_id"] == b["component_id"]
    return {
        "relation_id": rid,
        **induced,
        "gap_seq_53_54": {
            "ways": list(VB_GAP_WAYS),
            "would_E1_connect": would_e1,
            "same_global_component": same_component,
            "min_endpoint_gap_m": round(gap_m, 3) if gap_m is not None else None,
            "min_endpoint_gap_km": round(gap_m / 1000.0, 3) if gap_m is not None else None,
            "stitched": False,
        },
        "note": "Gap ~8.77 km must remain a break under E1-only connectivity.",
    }


def ladoga_poc(segs: list[dict[str, Any]]) -> dict[str, Any]:
    rid = RELATION_IDS["ladoga"]
    induced = analyze_relation_components(segs, rid)
    return {
        "relation_id": rid,
        **induced,
        "interpreted_as_navigation_routes": False,
        "seq_chain_as_centerline": False,
        "note": (
            "E1 components among Ladoga multipolygon ring segments are geometric "
            "endpoint clusters only — NOT navigation routes / centerlines."
        ),
    }


def crossing_safety(cur: Any, segs: list[dict[str, Any]]) -> dict[str, Any]:
    """Proper crossings must not create E1 edges by themselves.

    An E1 edge exists only when endpoints share exact coordinates.
    We sample proper-crossing pairs and count how many also share an E1 endpoint
    (allowed) vs connect only via interior intersection (must NOT unite components
    unless they separately share E1 — which interior-only crossings won't).
    """
    key_to_idx = {s["seg_key"]: s["idx"] for s in segs}
    cur.execute(
        """
        CREATE TEMP TABLE e46_seg ON COMMIT DROP AS
        SELECT
          (osm_type || ':' || osm_id::text || ':' || part_index::text) AS seg_key,
          geometry,
          start_point,
          end_point
        FROM water.routing_segments
        """
    )
    cur.execute("CREATE INDEX ON e46_seg USING GIST (geometry)")
    cur.execute(
        """
        SELECT a.seg_key AS a_key, b.seg_key AS b_key
        FROM e46_seg a
        JOIN e46_seg b
          ON a.seg_key < b.seg_key
         AND a.geometry && b.geometry
         AND ST_Crosses(a.geometry, b.geometry)
        """
    )
    pairs = cur.fetchall()
    share_e1 = 0
    interior_only = 0
    for p in pairs:
        a = segs[key_to_idx[p["a_key"]]]
        b = segs[key_to_idx[p["b_key"]]]
        ends_a = {a["start_e1"], a["end_e1"]}
        ends_b = {b["start_e1"], b["end_e1"]}
        if ends_a & ends_b:
            share_e1 += 1
        else:
            interior_only += 1
            # Safety: interior-only crossing pairs must not be same component
            # *because of the crossing*. They might still share a path via other
            # E1 links — that is allowed. We only assert the PoC never used
            # ST_Crosses as an edge (algorithmic guarantee + count).
    return {
        "proper_crossing_pairs": len(pairs),
        "crossing_pairs_that_also_share_E1_endpoint": share_e1,
        "crossing_pairs_interior_only": interior_only,
        "algorithm_uses_crossing_as_edge": False,
        "note": (
            "Connections are created only from shared E1 endpoint keys. "
            "ST_Crosses is never an adjacency rule."
        ),
    }


def run(dsn: str, skip_crossings: bool = False, top_n: int = 15) -> dict[str, Any]:
    report: dict[str, Any] = {
        "stage": "E4.6",
        "title": "READ-ONLY E1 topology component PoC",
        "e1_definition": (
            f"Endpoints connected iff round(lon,{E1_DECIMALS}) and "
            f"round(lat,{E1_DECIMALS}) match. No spatial tolerance."
        ),
        "constraints": [
            "in-memory only — no graph tables/nodes/edges",
            "no 1m/5m/10m connections",
            "no crossing-as-edge",
            "no navigability / lake routing / directionality / structure snap",
        ],
    }
    with psycopg2.connect(dsn) as conn:
        conn.autocommit = False
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical"] = fingerprint(cur)
            segs = load_segments(cur)
            report["total_segments"] = len(segs)
            report["total_endpoint_rows"] = len(segs) * 2

            built = build_components(segs)
            report["unique_exact_endpoints"] = built["unique_exact_endpoints"]
            report["e1_adjacency_links"] = built["e1_adjacency_links"]
            report["component_count"] = built["component_count"]
            report["nontrivial_component_count"] = built["nontrivial_component_count"]
            report["isolated_segments"] = built["isolated_segments"]
            report["component_size_distribution"] = built["size_distribution"]

            # Compress large size_distribution: keep all + summary buckets
            dist = built["size_distribution"]
            buckets = Counter()
            for row in dist:
                s = row["size"]
                c = row["components"]
                if s == 1:
                    buckets["1"] += c
                elif s == 2:
                    buckets["2"] += c
                elif s <= 5:
                    buckets["3-5"] += c
                elif s <= 10:
                    buckets["6-10"] += c
                elif s <= 50:
                    buckets["11-50"] += c
                elif s <= 100:
                    buckets["51-100"] += c
                elif s <= 1000:
                    buckets["101-1000"] += c
                else:
                    buckets["1001+"] += c
            report["component_size_buckets"] = dict(buckets)

            top = []
            for c in built["components"][:top_n]:
                summary = summarize_component(segs, c["member_idxs"])
                summary["component_id"] = c["component_id"]
                top.append(summary)
            report["largest_components"] = top

            report["belomor"] = belomor_poc(segs)
            report["volga_baltic"] = volga_baltic_poc(segs)
            report["ladoga"] = ladoga_poc(segs)

            if skip_crossings:
                report["crossing_safety"] = {"skipped": True}
            else:
                report["crossing_safety"] = crossing_safety(cur, segs)

            conn.rollback()

    with psycopg2.connect(dsn) as conn:
        with conn.cursor(cursor_factory=RealDictCursor) as cur:
            report["canonical_after"] = fingerprint(cur)
    return report


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dsn", default=None)
    ap.add_argument("--json-out", type=Path, default=None)
    ap.add_argument("--skip-crossings", action="store_true")
    ap.add_argument("--top-n", type=int, default=15)
    args = ap.parse_args()

    report = run(
        args.dsn or default_dsn(),
        skip_crossings=args.skip_crossings,
        top_n=args.top_n,
    )
    text = json.dumps(report, indent=2, ensure_ascii=False, default=_json_default)
    print(text)
    if args.json_out:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text + "\n", encoding="utf-8")

    if report["canonical"] != report["canonical_after"]:
        print("ERROR: canonical fingerprint changed", file=sys.stderr)
        return 2
    if not report["belomor"].get("E1_chain_preserved"):
        print("ERROR: Belomor expected single E1 component of 29", file=sys.stderr)
        return 3
    gap = report["volga_baltic"]["gap_seq_53_54"]
    if gap.get("would_E1_connect"):
        print("ERROR: VB gap incorrectly E1-connected", file=sys.stderr)
        return 4
    if report["ladoga"].get("interpreted_as_navigation_routes"):
        print("ERROR: Ladoga marked as navigation routes", file=sys.stderr)
        return 5
    cs = report.get("crossing_safety") or {}
    if cs.get("algorithm_uses_crossing_as_edge"):
        print("ERROR: crossing used as edge", file=sys.stderr)
        return 6
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
