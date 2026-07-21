#!/usr/bin/env python3
"""Money Engine CLI — turnkey auto-income system."""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main():
    parser = argparse.ArgumentParser(description="Money Engine — Turnkey Auto Income")
    parser.add_argument(
        "command",
        choices=["turnkey", "scan", "fleet", "serve", "start"],
        help="turnkey=full setup, scan/fleet=manual, serve/start=server",
    )
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--count", type=int, default=None, help="Fleet target size")
    parser.add_argument("--no-serve", action="store_true", help="Turnkey without starting server")
    parser.add_argument("--skip-scan", action="store_true", help="Skip niche scan if fleet exists")
    args = parser.parse_args()

    if args.command == "turnkey":
        from src.turnkey.setup import print_turnkey_report, run_turnkey

        result = asyncio.run(
            run_turnkey(fleet_size=args.count, skip_scan=args.skip_scan)
        )
        print_turnkey_report(result)
        if not args.no_serve:
            import uvicorn
            from config import settings

            port = args.port or settings.port
            print(f"🚀 Запуск сервера на http://0.0.0.0:{port}")
            uvicorn.run("src.api:app", host="0.0.0.0", port=port, reload=False)

    elif args.command == "scan":
        from src.pipeline import run_full_pipeline

        result = asyncio.run(run_full_pipeline())
        print("\n✅ Scan complete!")
        print(f"   Signals: {result['raw_signals']}")
        print(f"   Opportunities: {result['opportunities_found']}")
        if result.get("fleet"):
            f = result["fleet"]
            print(f"   Fleet: {f.get('active_projects', 0)} active")
            print(f"   Projected: {f.get('projected_rub_per_day', 0):.0f} ₽/day")

    elif args.command == "fleet":
        from src.fleet.scaler import scale_fleet

        result = scale_fleet(target_size=args.count)
        print(f"\n🚀 Fleet: {result['active_projects']} projects, {result.get('projected_rub_per_day', 0):.0f} ₽/day")

    elif args.command in ("serve", "start"):
        import uvicorn
        from config import settings

        port = args.port or settings.port
        uvicorn.run("src.api:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    main()
