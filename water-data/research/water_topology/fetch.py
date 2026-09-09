"""Optional live OSM/Overpass fetch for research topology discovery.

Not used by regression tests (those load a local store). Does not write to DB.
"""

from __future__ import annotations

import json
import time
import urllib.request
from typing import Any

from .osm_store import OsmStore

OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

OSM_API = "https://api.openstreetmap.org/api/0.6"


def post_overpass(query: str, timeout: int = 180) -> dict[str, Any]:
    data = query.encode("utf-8")
    last_err: Exception | None = None
    for url in OVERPASS_ENDPOINTS:
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception as exc:  # noqa: BLE001 — try next mirror
            last_err = exc
            time.sleep(2)
    raise RuntimeError(f"all Overpass endpoints failed: {last_err}")


def fetch_osm_full(osm_type: str, osm_id: int, timeout: int = 120) -> dict[str, Any]:
    url = f"{OSM_API}/{osm_type}/{osm_id}/full.json"
    req = urllib.request.Request(url, headers={"User-Agent": "AquaRoute-research-topology-discovery/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_seed_and_bbox_catalog(
    store: OsmStore,
    osm_type: str,
    osm_id: int,
    bbox: tuple[float, float, float, float],
) -> None:
    """bbox = (south, west, north, east). Tag-only catalog + seed /full.

    Names are not queried. Catalog is every water/waterway in the bbox.
    """
    store.ingest_osm_json(fetch_osm_full(osm_type, osm_id), source=f"osm-api/{osm_type}/{osm_id}/full")
    s, w, n, e = bbox
    query = f"""
[out:json][timeout:180];
(
  way["natural"="water"]({s},{w},{n},{e});
  way["water"]({s},{w},{n},{e});
  way["landuse"="reservoir"]({s},{w},{n},{e});
  way["waterway"~"^(river|stream|canal)$"]({s},{w},{n},{e});
  relation["natural"="water"]({s},{w},{n},{e});
  relation["water"]({s},{w},{n},{e});
  relation["landuse"="reservoir"]({s},{w},{n},{e});
  relation["waterway"~"^(river|stream|canal)$"]({s},{w},{n},{e});
  relation["type"="multipolygon"]["water"]({s},{w},{n},{e});
  relation["type"="waterway"]({s},{w},{n},{e});
);
out body;
"""
    store.ingest_osm_json(post_overpass(query), source="overpass-bbox-catalog")
    # Ways that share nodes with the seed (direct OSM topology), no name filter.
    if osm_type == "relation":
        touch = f"""
[out:json][timeout:180];
rel({osm_id});
>> -> .sel;
(
  way(bn.sel)["natural"="water"];
  way(bn.sel)["landuse"="reservoir"];
  way(bn.sel)["waterway"~"^(river|stream|canal)$"];
);
(._; rel(bw););
out body;
"""
        store.ingest_osm_json(post_overpass(touch), source="overpass-seed-touch")
    elif osm_type == "way":
        touch = f"""
[out:json][timeout:180];
way({osm_id});
> -> .sel;
(
  way(bn.sel)["natural"="water"];
  way(bn.sel)["landuse"="reservoir"];
  way(bn.sel)["waterway"~"^(river|stream|canal)$"];
);
(._; rel(bw););
out body;
"""
        store.ingest_osm_json(post_overpass(touch), source="overpass-seed-touch")
