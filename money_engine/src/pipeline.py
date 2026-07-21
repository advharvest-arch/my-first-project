from datetime import datetime

from config import settings
from src.analyzer.scorer import analyze_signals
from src.collectors.runner import collect_all_signals
from src.generator.reports import generate_landing_page, generate_report
from src.models import Opportunity, ScanRun, SessionLocal, init_db


async def run_full_pipeline() -> dict:
    init_db()
    session = SessionLocal()
    scan = ScanRun(status="running")
    session.add(scan)
    session.commit()

    try:
        raw_signals, trend_signals = await collect_all_signals()
        scan.raw_signals = len(raw_signals) + len(trend_signals)
        scan.sources_scanned = 3
        session.commit()

        scored = analyze_signals(raw_signals, trend_signals)
        scan.opportunities_found = len(scored)
        reports_generated = 0

        for item in scored:
            existing = (
                session.query(Opportunity)
                .filter(Opportunity.title == item.title)
                .first()
            )
            if existing:
                existing.demand_score = item.demand_score
                existing.competition_score = item.competition_score
                existing.monetization_score = item.monetization_score
                existing.total_score = item.total_score
                existing.updated_at = datetime.utcnow()
                opportunity = existing
            else:
                opportunity = Opportunity(
                    title=item.title,
                    niche=item.niche,
                    pain_point=item.pain_point,
                    source=item.source,
                    source_url=item.source_url,
                    demand_score=item.demand_score,
                    competition_score=item.competition_score,
                    monetization_score=item.monetization_score,
                    total_score=item.total_score,
                    monetization_type=item.monetization_type,
                    suggested_price_usd=item.suggested_price_usd,
                    action_plan=item.action_plan,
                )
                session.add(opportunity)
                session.flush()

            if item.total_score >= settings.min_report_score:
                report_path = generate_report(item)
                landing_path = generate_landing_page(
                    item, payment_link=settings.stripe_payment_link
                )
                opportunity.report_path = report_path
                opportunity.landing_path = landing_path
                reports_generated += 1

        scan.reports_generated = reports_generated
        scan.status = "completed"
        scan.finished_at = datetime.utcnow()
        session.commit()

        fleet_result = None
        if settings.fleet_auto_scale:
            from src.fleet.scaler import scale_fleet

            fleet_result = scale_fleet()

        top = (
            session.query(Opportunity)
            .order_by(Opportunity.total_score.desc())
            .limit(10)
            .all()
        )

        return {
            "status": "completed",
            "raw_signals": scan.raw_signals,
            "opportunities_found": scan.opportunities_found,
            "reports_generated": scan.reports_generated,
            "fleet": fleet_result,
            "top_opportunities": [
                {
                    "title": o.title,
                    "niche": o.niche,
                    "score": o.total_score,
                    "type": o.monetization_type,
                    "price_usd": o.suggested_price_usd,
                    "report": o.report_path,
                    "landing": o.landing_path,
                }
                for o in top
            ],
        }
    except Exception as exc:
        scan.status = "failed"
        scan.error = str(exc)
        scan.finished_at = datetime.utcnow()
        session.commit()
        raise
    finally:
        session.close()
