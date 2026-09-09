"""In-memory OSM element store for research topology discovery.

Accepts OSM XML, OSM API / Overpass JSON, and a compact dict snapshot.
Does not write to the AquaRoute database.
"""

from __future__ import annotations

import json
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


@dataclass
class Member:
    type: str
    ref: int
    role: str = ""


@dataclass
class WayRec:
    osm_id: int
    nds: list[int] = field(default_factory=list)
    tags: dict[str, str] = field(default_factory=dict)
    coords: list[tuple[float, float]] | None = None


@dataclass
class RelRec:
    osm_id: int
    members: list[Member] = field(default_factory=list)
    tags: dict[str, str] = field(default_factory=dict)


class OsmStore:
    def __init__(self) -> None:
        self.nodes: dict[int, tuple[float, float]] = {}
        self.ways: dict[int, WayRec] = {}
        self.relations: dict[int, RelRec] = {}
        self.sources: list[str] = []

    def ingest_xml(self, path: Path | str) -> None:
        path = Path(path)
        root = ET.parse(path).getroot()
        for el in root.findall("node"):
            self.nodes[int(el.get("id"))] = (float(el.get("lon")), float(el.get("lat")))
        for el in root.findall("way"):
            nds = [int(nd.get("ref")) for nd in el.findall("nd")]
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            self._merge_way(int(el.get("id")), nds, tags, None)
        for el in root.findall("relation"):
            members = [
                Member(type=m.get("type") or "", ref=int(m.get("ref")), role=m.get("role") or "")
                for m in el.findall("member")
            ]
            tags = {t.get("k"): t.get("v") for t in el.findall("tag")}
            self._merge_rel(int(el.get("id")), members, tags)
        self.sources.append(str(path))

    def ingest_osm_json(self, obj: dict[str, Any], *, source: str = "json") -> None:
        for el in obj.get("elements") or []:
            t = el.get("type")
            i = el.get("id")
            if t is None or i is None:
                continue
            i = int(i)
            if t == "node":
                if "lon" in el and "lat" in el:
                    self.nodes[i] = (float(el["lon"]), float(el["lat"]))
            elif t == "way":
                nds = [int(n) for n in (el.get("nodes") or [])]
                tags = {str(k): str(v) for k, v in (el.get("tags") or {}).items()}
                coords = None
                if el.get("geometry"):
                    coords = [(float(p["lon"]), float(p["lat"])) for p in el["geometry"]]
                self._merge_way(i, nds, tags, coords)
            elif t == "relation":
                members = [
                    Member(
                        type=str(m.get("type") or ""),
                        ref=int(m["ref"]),
                        role=str(m.get("role") or ""),
                    )
                    for m in (el.get("members") or [])
                    if m.get("ref") is not None
                ]
                tags = {str(k): str(v) for k, v in (el.get("tags") or {}).items()}
                self._merge_rel(i, members, tags)
        self.sources.append(source)

    def ingest_json_path(self, path: Path | str) -> None:
        path = Path(path)
        self.ingest_osm_json(json.loads(path.read_text(encoding="utf-8")), source=str(path))

    def _merge_way(
        self,
        osm_id: int,
        nds: list[int],
        tags: dict[str, str],
        coords: list[tuple[float, float]] | None,
    ) -> None:
        prev = self.ways.get(osm_id)
        if prev is None:
            self.ways[osm_id] = WayRec(osm_id=osm_id, nds=nds, tags=dict(tags), coords=coords)
            return
        if nds:
            prev.nds = nds
        prev.tags.update(tags)
        if coords and not prev.coords:
            prev.coords = coords

    def _merge_rel(self, osm_id: int, members: list[Member], tags: dict[str, str]) -> None:
        prev = self.relations.get(osm_id)
        if prev is None:
            self.relations[osm_id] = RelRec(osm_id=osm_id, members=list(members), tags=dict(tags))
            return
        if members:
            prev.members = list(members)
        prev.tags.update(tags)

    def way_coords(self, way: WayRec) -> list[tuple[float, float]]:
        if way.coords:
            return list(way.coords)
        return [self.nodes[n] for n in way.nds if n in self.nodes]

    def way_node_ids(self, way_id: int) -> list[int]:
        way = self.ways.get(way_id)
        return list(way.nds) if way else []

    def relation_way_node_ids(self, rel_id: int) -> list[int]:
        rel = self.relations.get(rel_id)
        if rel is None:
            return []
        out: list[int] = []
        seen: set[int] = set()
        for m in rel.members:
            if m.type != "way":
                continue
            for nid in self.way_node_ids(m.ref):
                if nid not in seen:
                    seen.add(nid)
                    out.append(nid)
        return out

    def object_node_ids(self, osm_type: str, osm_id: int) -> list[int]:
        if osm_type == "way":
            return self.way_node_ids(osm_id)
        if osm_type == "relation":
            return self.relation_way_node_ids(osm_id)
        if osm_type == "node":
            return [osm_id] if osm_id in self.nodes else []
        return []

    def memberships_of(self, osm_type: str, osm_id: int) -> list[dict[str, Any]]:
        found: list[dict[str, Any]] = []
        for rid, rel in self.relations.items():
            for m in rel.members:
                if m.type == osm_type and m.ref == osm_id:
                    found.append({"relation": rid, "role": m.role})
        return found

    def to_compact_dict(self, *, keep_nodes: Iterable[int] | None = None) -> dict[str, Any]:
        if keep_nodes is None:
            node_ids = list(self.nodes)
        else:
            node_ids = [n for n in keep_nodes if n in self.nodes]
        return {
            "nodes": {str(nid): [self.nodes[nid][0], self.nodes[nid][1]] for nid in node_ids},
            "ways": {
                str(wid): {
                    "nds": way.nds,
                    "tags": way.tags,
                    "coords": way.coords,
                }
                for wid, way in self.ways.items()
            },
            "relations": {
                str(rid): {
                    "members": [{"type": m.type, "ref": m.ref, "role": m.role} for m in rel.members],
                    "tags": rel.tags,
                }
                for rid, rel in self.relations.items()
            },
            "sources": list(self.sources),
        }

    @classmethod
    def from_compact_dict(cls, data: dict[str, Any]) -> "OsmStore":
        store = cls()
        for nid, xy in (data.get("nodes") or {}).items():
            store.nodes[int(nid)] = (float(xy[0]), float(xy[1]))
        for wid, rec in (data.get("ways") or {}).items():
            coords = rec.get("coords")
            store.ways[int(wid)] = WayRec(
                osm_id=int(wid),
                nds=[int(n) for n in (rec.get("nds") or [])],
                tags=dict(rec.get("tags") or {}),
                coords=[(float(a), float(b)) for a, b in coords] if coords else None,
            )
        for rid, rec in (data.get("relations") or {}).items():
            members = [
                Member(type=m["type"], ref=int(m["ref"]), role=m.get("role") or "")
                for m in (rec.get("members") or [])
            ]
            store.relations[int(rid)] = RelRec(
                osm_id=int(rid), members=members, tags=dict(rec.get("tags") or {})
            )
        store.sources = list(data.get("sources") or ["compact-dict"])
        return store

    def dump_json(self, path: Path | str, *, keep_nodes: Iterable[int] | None = None) -> None:
        path = Path(path)
        path.write_text(
            json.dumps(self.to_compact_dict(keep_nodes=keep_nodes), ensure_ascii=False),
            encoding="utf-8",
        )
