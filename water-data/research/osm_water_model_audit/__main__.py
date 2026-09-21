"""CLI: python3 -m osm_water_model_audit --out-dir ../../docs"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

if __package__ is None or __package__ == "":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from osm_water_model_audit.assemble import assemble_object
    from osm_water_model_audit.fetch import fetch_seed
    from osm_water_model_audit.report import build_report, write_report
    from osm_water_model_audit.seeds import SEEDS
else:
    from .assemble import assemble_object
    from .fetch import fetch_seed
    from .report import build_report, write_report
    from .seeds import SEEDS


def _load_offline(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict) and "seeds" in data:
        return data
    raise ValueError("offline JSON must be {seeds: [{key, osm_type, osm_id, elements}, ...]}")


def main(argv: list[str] | None = None) -> int:
    root = Path(__file__).resolve().parents[3]
    p = argparse.ArgumentParser(
        description="Research OSM water-model audit (tags/roles only, no topology)."
    )
    p.add_argument(
        "--out-dir",
        default=str(root / "docs"),
        help="Directory for osm-water-model-audit.md/.json",
    )
    p.add_argument(
        "--from-json",
        help="Offline OSM JSON dump (no network). Tests use this.",
    )
    p.add_argument("--sleep", type=float, default=1.5, help="Pause between live seed fetches")
    p.add_argument("--timeout", type=int, default=180)
    args = p.parse_args(argv)

    objects = []
    if args.from_json:
        bundle = _load_offline(Path(args.from_json))
        by_key = {s["key"]: s for s in bundle["seeds"]}
        for seed in SEEDS:
            item = by_key.get(seed["key"])
            if item is None:
                rec = assemble_object(
                    seed["osm_type"],
                    seed["osm_id"],
                    [],
                    seed_key=seed["key"],
                    seed_label=seed["label"],
                    fetch_source="offline-missing",
                )
                rec["error"] = "offline-missing"
                objects.append(rec)
                continue
            objects.append(
                assemble_object(
                    item.get("osm_type") or seed["osm_type"],
                    int(item.get("osm_id") or seed["osm_id"]),
                    item.get("elements") or [],
                    seed_key=seed["key"],
                    seed_label=seed["label"],
                    fetch_source="offline",
                )
            )
    else:
        for i, seed in enumerate(SEEDS):
            print(
                f"fetch {i + 1}/{len(SEEDS)} {seed['osm_type']}/{seed['osm_id']} ({seed['key']})",
                flush=True,
            )
            try:
                data, source = fetch_seed(
                    seed["osm_type"],
                    seed["osm_id"],
                    include_member_parents=True,
                    timeout=args.timeout,
                )
                obj = assemble_object(
                    seed["osm_type"],
                    seed["osm_id"],
                    data.get("elements") or [],
                    seed_key=seed["key"],
                    seed_label=seed["label"],
                    fetch_source=source,
                )
                objects.append(obj)
                print(
                    f"  -> {obj.get('classification')} members={obj.get('member_count')} "
                    f"source={obj.get('fetch_source')} err={obj.get('error')}",
                    flush=True,
                )
            except Exception as exc:  # noqa: BLE001 — record and continue other seeds
                objects.append(
                    {
                        "seed_key": seed["key"],
                        "seed_label": seed["label"],
                        "osm_type": seed["osm_type"],
                        "osm_id": seed["osm_id"],
                        "error": str(exc),
                        "fetch_source": "failed",
                        "tags": {},
                        "geometry_type": None,
                        "classification": None,
                        "membership": [],
                        "members": [],
                    }
                )
            if i + 1 < len(SEEDS):
                time.sleep(args.sleep)

    report = build_report(objects)
    md_path, json_path = write_report(report, Path(args.out_dir))
    print(md_path)
    print(json_path)
    print("fetched", report["stats"]["fetched"], "missing", report["stats"]["missing"])
    print("check_way_180396592", report["check_way_180396592"]["ok"])
    return 0 if report["stats"]["missing"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
