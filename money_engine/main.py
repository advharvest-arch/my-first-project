#!/usr/bin/env python3
"""Money Engine CLI — run scans, start server, or both."""

import argparse
import asyncio
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


def main():
    parser = argparse.ArgumentParser(description="Money Engine — Automated Niche Discovery")
    parser.add_argument("command", choices=["scan", "serve", "start"], help="scan=one-time, serve=API only, start=API+scheduler")
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args()

    if args.command == "scan":
        from src.pipeline import run_full_pipeline

        result = asyncio.run(run_full_pipeline())
        print(f"\n✅ Scan complete!")
        print(f"   Signals: {result['raw_signals']}")
        print(f"   Opportunities: {result['opportunities_found']}")
        print(f"   Reports: {result['reports_generated']}")
        print("\nTop opportunities:")
        for i, opp in enumerate(result["top_opportunities"][:5], 1):
            print(f"  {i}. [{opp['score']}] {opp['niche']} — ${opp['price_usd']} ({opp['type']})")

    elif args.command in ("serve", "start"):
        import uvicorn
        from config import settings

        port = args.port or settings.port
        uvicorn.run("src.api:app", host="0.0.0.0", port=port, reload=False)


if __name__ == "__main__":
    main()
