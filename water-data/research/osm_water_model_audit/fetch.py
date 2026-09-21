"""Download one OSM seed and its declared members.

Primary source: OSM API 0.6 (relation/way metadata + way node-id lists,
coordinates discarded). Overpass is an optional fast path with a short
timeout. No bbox catalog, no KNN, no shared-node expansion.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from typing import Any

USER_AGENT = "AquaRoute-research-osm-audit/1.0"
OSM_API = "https://api.openstreetmap.org/api/0.6"
WAY_BATCH = 80
REL_BATCH = 50

OVERPASS_ENDPOINTS = [
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]


def _request_json(url: str, *, data: bytes | None = None, timeout: int = 60) -> dict[str, Any]:
    headers = {"User-Agent": USER_AGENT}
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"
    last_err: Exception | None = None
    for attempt in range(4):
        req = urllib.request.Request(
            url, data=data, headers=headers, method="POST" if data else "GET"
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_err = exc
            if exc.code in (429, 502, 503, 504) and attempt < 3:
                time.sleep(2 ** attempt)
                continue
            raise
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            if attempt < 3:
                time.sleep(1.5 * (attempt + 1))
                continue
            raise
    raise RuntimeError(last_err)


def post_overpass(query: str, timeout: int = 25) -> dict[str, Any]:
    payload = query.encode("utf-8")
    last_err: Exception | None = None
    for url in OVERPASS_ENDPOINTS:
        try:
            return _request_json(url, data=payload, timeout=timeout)
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            time.sleep(0.5)
    raise RuntimeError(f"all Overpass endpoints failed: {last_err}")


def fetch_osm_api(path: str, timeout: int = 60) -> dict[str, Any]:
    url = f"{OSM_API}/{path}"
    payload = _request_json(url, timeout=timeout)
    elements = []
    for el in payload.get("elements") or []:
        if el.get("type") == "node":
            continue
        elements.append(el)
    payload["elements"] = elements
    return payload


def _chunks(ids: list[int], size: int) -> list[list[int]]:
    return [ids[i : i + size] for i in range(0, len(ids), size)]


def _merge_elements(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[tuple[str, int]] = set()
    out: list[dict[str, Any]] = []
    for payload in parts:
        for el in payload.get("elements") or []:
            if el.get("type") == "node":
                continue
            key = (str(el.get("type")), int(el.get("id") or 0))
            if key in seen:
                continue
            seen.add(key)
            out.append(el)
    return out


def _fetch_ways(way_ids: list[int], timeout: int = 60) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    unique = sorted({int(i) for i in way_ids if i})
    batches = _chunks(unique, WAY_BATCH)
    for bi, batch in enumerate(batches):
        if len(batches) > 5 and (bi == 0 or (bi + 1) % 10 == 0 or bi + 1 == len(batches)):
            print(f"    ways batch {bi + 1}/{len(batches)}", flush=True)
        q = ",".join(str(i) for i in batch)
        payload = fetch_osm_api(f"ways.json?ways={q}", timeout=timeout)
        elements.extend(payload.get("elements") or [])
        time.sleep(0.15)
    return elements


def _fetch_relations(rel_ids: list[int], timeout: int = 60) -> list[dict[str, Any]]:
    elements: list[dict[str, Any]] = []
    unique = sorted({int(i) for i in rel_ids if i})
    for batch in _chunks(unique, REL_BATCH):
        q = ",".join(str(i) for i in batch)
        payload = fetch_osm_api(f"relations.json?relations={q}", timeout=timeout)
        elements.extend(payload.get("elements") or [])
        time.sleep(0.15)
    return elements


def _member_ids(rel: dict[str, Any], member_type: str) -> list[int]:
    ids: list[int] = []
    for mem in rel.get("members") or []:
        if mem.get("type") == member_type:
            ids.append(int(mem.get("ref") or 0))
    return ids


def fetch_seed_osm_api(
    osm_type: str,
    osm_id: int,
    *,
    include_member_parents: bool,
    timeout: int = 60,
) -> dict[str, Any]:
    osm_type = osm_type.lower()
    parts: list[dict[str, Any]] = []
    if osm_type == "relation":
        seed = fetch_osm_api(f"relation/{osm_id}.json", timeout=timeout)
        parts.append(seed)
        rel = next((el for el in seed.get("elements") or [] if el.get("type") == "relation"), None)
        if rel:
            way_ids = _member_ids(rel, "way")
            rel_ids = _member_ids(rel, "relation")
            if way_ids:
                parts.append({"elements": _fetch_ways(way_ids, timeout=timeout)})
            if rel_ids:
                parts.append({"elements": _fetch_relations(rel_ids, timeout=timeout)})
            if include_member_parents and way_ids:
                # OSM has no batch "relations for many ways"; only do this for small sets.
                if len(way_ids) <= 40:
                    for wid in way_ids:
                        try:
                            parents = fetch_osm_api(f"way/{wid}/relations.json", timeout=timeout)
                            parts.append(parents)
                            time.sleep(0.1)
                        except urllib.error.HTTPError:
                            continue
                try:
                    rparents = fetch_osm_api(f"relation/{osm_id}/relations.json", timeout=timeout)
                    parts.append(rparents)
                except urllib.error.HTTPError:
                    pass
    elif osm_type == "way":
        parts.append(fetch_osm_api(f"way/{osm_id}.json", timeout=timeout))
        try:
            parts.append(fetch_osm_api(f"way/{osm_id}/relations.json", timeout=timeout))
        except urllib.error.HTTPError:
            pass
    else:
        parts.append(fetch_osm_api(f"node/{osm_id}.json", timeout=timeout))
    return {"elements": _merge_elements(parts)}


def _overpass_relation_query(osm_id: int, *, include_member_parents: bool) -> str:
    extra_parents = ""
    if include_member_parents:
        extra_parents = """
rel(bw.w)->.parents;
.parents out body;
rel(br.r)->.rparents;
.rparents out body;
"""
    return f"""
[out:json][timeout:25];
relation({osm_id})->.r;
.r out body;
way(r.r)->.w;
.w out body;
rel(r.r)->.rm;
.rm out tags;
{extra_parents}
"""


def _overpass_way_query(osm_id: int) -> str:
    return f"""
[out:json][timeout:25];
way({osm_id})->.w;
.w out body;
rel(bw.w)->.parents;
.parents out body;
"""


def fetch_seed(
    osm_type: str,
    osm_id: int,
    *,
    include_member_parents: bool = True,
    timeout: int = 60,
) -> tuple[dict[str, Any], str]:
    """Return (osm json with elements[], source label)."""
    osm_type = osm_type.lower()
    if osm_type not in ("relation", "way", "node"):
        raise ValueError(f"unsupported osm_type {osm_type}")

    # Prefer OSM API: Overpass public mirrors often hang from this environment.
    try:
        data = fetch_seed_osm_api(
            osm_type,
            osm_id,
            include_member_parents=include_member_parents,
            timeout=timeout,
        )
        if data.get("elements"):
            return data, "osm-api"
    except Exception:
        pass

    if osm_type == "relation":
        query = _overpass_relation_query(osm_id, include_member_parents=include_member_parents)
        data = post_overpass(query, timeout=min(25, timeout))
        return data, "overpass"
    if osm_type == "way":
        data = post_overpass(_overpass_way_query(osm_id), timeout=min(25, timeout))
        return data, "overpass"
    raise RuntimeError(f"failed to fetch {osm_type}/{osm_id}")
