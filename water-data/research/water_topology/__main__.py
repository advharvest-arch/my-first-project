"""CLI: python3 -m water_topology --seed relation/399081 ..."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Allow `python3 -m water_topology` from water-data/research/
if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from water_topology.discover import discover_water_graph, parse_seed
    from water_topology.dumps import load_compact_store, load_seliger_audit_dumps, save_compact_store
    from water_topology.export import write_outputs
    from water_topology.fetch import fetch_seed_and_bbox_catalog
    from water_topology.osm_store import OsmStore
    from water_topology.rings import reconstruct_relation_geometry
else:
    from .discover import discover_water_graph, parse_seed
    from .dumps import load_compact_store, load_seliger_audit_dumps, save_compact_store
    from .export import write_outputs
    from .fetch import fetch_seed_and_bbox_catalog
    from .osm_store import OsmStore
    from .rings import reconstruct_relation_geometry


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Research water topology discovery from an OSM seed (no DB/WRG)."
    )
    p.add_argument("--seed", default="relation/399081", help="relation/399081 or way/81753515")
    p.add_argument("--store", help="compact JSON/JSON.GZ snapshot of an OsmStore")
    p.add_argument("--from-seliger-dumps", action="store_true", help="load /tmp Seliger audit dumps")
    p.add_argument("--fetch", action="store_true", help="live OSM API + Overpass (not for CI)")
    p.add_argument("--out-dir", default="water-data/docs")
    p.add_argument("--stem", default="seliger-topology-discovery")
    p.add_argument("--save-store", help="write compact store snapshot (optionally .json.gz)")
    p.add_argument("--nearby-m", type=float, default=250.0)
    p.add_argument("--portage-m", type=float, default=100.0)
    args = p.parse_args(argv)

    seed_type, seed_id = parse_seed(args.seed)
    store: OsmStore
    if args.store:
        store = load_compact_store(Path(args.store))
    elif args.from_seliger_dumps:
        store = load_seliger_audit_dumps()
    elif args.fetch:
        store = OsmStore()
        fetch_seed_and_bbox_catalog(store, seed_type, seed_id, (56.90, 32.45, 57.72, 33.60))
    else:
        # Prefer a local snapshot next to the package, then audit dumps.
        fixture = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "seliger_store.json.gz"
        if fixture.exists():
            store = load_compact_store(fixture)
        else:
            store = load_seliger_audit_dumps()

    if args.fetch and not args.store and seed_type == "relation":
        geom, _meta = reconstruct_relation_geometry(store, seed_id)
        if geom is not None and not geom.is_empty:
            minx, miny, maxx, maxy = geom.bounds
            pad = 0.4
            fetch_seed_and_bbox_catalog(
                store, seed_type, seed_id, (miny - pad, minx - pad, maxy + pad, maxx + pad)
            )

    graph = discover_water_graph(
        (seed_type, seed_id),
        store,
        nearby_m=args.nearby_m,
        portage_m=args.portage_m,
    )
    paths = write_outputs(graph, Path(args.out_dir), store=store, stem=args.stem)
    if args.save_store:
        save_compact_store(store, Path(args.save_store))
        print("store", args.save_store)
    print("seed", graph.seed_key, graph.seed.get("name"))
    print("summary", graph.summary)
    for kind, path in paths.items():
        print(kind, path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
