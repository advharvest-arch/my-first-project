"""Load a local OSM extract into OsmStore (offline / regression)."""

from __future__ import annotations

import gzip
import json
from pathlib import Path

from .osm_store import OsmStore

DEFAULT_SELIGER_XML = Path("/tmp/seliger-osm/relation-399081-full.osm")
DEFAULT_SELIGER_AUDIT = Path("/tmp/seliger-audit")


def load_store_from_paths(paths: list[Path]) -> OsmStore:
    store = OsmStore()
    for path in paths:
        if not path.exists():
            continue
        if path.suffix == ".gz" or str(path).endswith(".json.gz"):
            data = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
            if "elements" in data:
                store.ingest_osm_json(data, source=str(path))
            elif "nodes" in data and "ways" in data:
                extra = OsmStore.from_compact_dict(data)
                _merge_store(store, extra)
            continue
        if path.suffix == ".osm" or path.suffix == ".xml":
            store.ingest_xml(path)
            continue
        if path.suffix == ".json":
            data = json.loads(path.read_text(encoding="utf-8"))
            if "elements" in data:
                store.ingest_osm_json(data, source=str(path))
            elif "nodes" in data and "ways" in data:
                extra = OsmStore.from_compact_dict(data)
                _merge_store(store, extra)
            continue
    return store


def _merge_store(dst: OsmStore, src: OsmStore) -> None:
    dst.nodes.update(src.nodes)
    for wid, way in src.ways.items():
        dst._merge_way(wid, way.nds, way.tags, way.coords)
    for rid, rel in src.relations.items():
        dst._merge_rel(rid, rel.members, rel.tags)
    dst.sources.extend(src.sources)


def load_compact_store(path: Path) -> OsmStore:
    path = Path(path)
    if path.suffix == ".gz" or str(path).endswith(".json.gz"):
        data = json.loads(gzip.decompress(path.read_bytes()).decode("utf-8"))
    else:
        data = json.loads(path.read_text(encoding="utf-8"))
    if "elements" in data:
        store = OsmStore()
        store.ingest_osm_json(data, source=str(path))
        return store
    return OsmStore.from_compact_dict(data)


def save_compact_store(store: OsmStore, path: Path) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    blob = json.dumps(store.to_compact_dict(), ensure_ascii=False).encode("utf-8")
    if str(path).endswith(".gz"):
        path.write_bytes(gzip.compress(blob, compresslevel=9))
    else:
        path.write_bytes(blob)


def load_seliger_audit_dumps(
    xml_path: Path = DEFAULT_SELIGER_XML,
    audit_dir: Path = DEFAULT_SELIGER_AUDIT,
) -> OsmStore:
    """Rehydrate the store used by the Seliger water-system audit.

    Discovery itself does not read names from the audit markdown; this only
    loads OSM elements already fetched into local dumps.
    """
    paths: list[Path] = []
    if xml_path.exists():
        paths.append(xml_path)
    if audit_dir.exists():
        for name in (
            "hop-ways-body.json",
            "known-geom.json",
            "extra-geom.json",
            "touch-399081.json",
            "hop2.json",
            "catalog-center.json",
            "named-search.json",
        ):
            p = audit_dir / name
            if p.exists():
                paths.append(p)
        full = audit_dir / "full"
        if full.exists():
            paths.extend(sorted(full.glob("*.json")))
    if not paths:
        raise FileNotFoundError(
            f"no Seliger OSM dumps at {xml_path} / {audit_dir}; "
            "pass --store or --fetch"
        )
    return load_store_from_paths(paths)
