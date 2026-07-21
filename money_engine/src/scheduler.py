import asyncio
import logging

from apscheduler.schedulers.background import BackgroundScheduler

from config import settings

logger = logging.getLogger(__name__)
scheduler = BackgroundScheduler()


def _run_scan_job():
    from src.pipeline import run_full_pipeline

    logger.info("Starting scheduled scan...")
    try:
        asyncio.get_event_loop().run_until_complete(run_full_pipeline())
        logger.info("Scheduled scan completed.")
    except RuntimeError:
        asyncio.run(run_full_pipeline())
        logger.info("Scheduled scan completed.")
    except Exception as exc:
        logger.error("Scheduled scan failed: %s", exc)


def start_scheduler() -> None:
    if scheduler.running:
        return

    scheduler.add_job(
        _run_scan_job,
        "interval",
        hours=settings.scan_interval_hours,
        id="niche_scan",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Scheduler started — scanning every %d hours", settings.scan_interval_hours)
