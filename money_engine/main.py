#!/usr/bin/env python3
"""Money Engine CLI — scan niches, deploy fleet, run server."""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main():
    parser = argparse.ArgumentParser(description="Money Engine — Automated Income Fleet")
    parser.add_argument(
        "command",
        choices=["scan", "fleet", "serve", "start"],
        help="scan=find niches, fleet=deploy projects, serve/start=API+scheduler",
    )
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--count", type=int, default=None, help="Fleet target size")
    args = parser.parse_args()

    if args.command == "scan":
        from src.pipeline import run_full_pipeline

        result = asyncio.run(run_full_pipeline())
        print("\n✅ Scan complete!")
        print(f"   Signals: {result['raw_signals']}")
        print(f"   Opportunities: {result['opportunities_found']}")
        print(f"   Reports: {result['reports_generated']}")
        if result.get("fleet"):
            f = result["fleet"]
            print(f"   Fleet: {f.get('active_projects', 0)} active, deployed {f.get('deployed', 0)}")
            print(f"   Projected: {f.get('projected_rub_per_day', 0):.0f} ₽/day")
        print("\nTop opportunities:")
        for i, opp in enumerate(result["top_opportunities"][:5], 1):
            print(f"  {i}. [{opp['score']}] {opp['niche']} ({opp['type']})")

    elif args.command == "fleet":
        from src.fleet.scaler import scale_fleet

        result = scale_fleet(target_size=args.count)
        print("\n🚀 Fleet scaled!")
        print(f"   Active projects: {result['active_projects']}")
        print(f"   Deployed now: {result.get('deployed', 0)}")
        print(f"   Target: {result.get('target', '?')}")
        print(f"   Projected: {result.get('projected_rub_per_day', 0):.0f} ₽/day")
        print(f"   Formula: {result['active_projects']} projects × ~100₽ = {result.get('projected_rub_per_day', 0):.0f} ₽/day")

    elif args.command in ("serve", "start"):
        import uvicorn
        from config import settings

        port = args.port or settings.port
        uvicorn.run("src.api:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    main()
