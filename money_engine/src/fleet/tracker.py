from datetime import datetime

from src.models import FleetProject, SessionLocal

# Estimated revenue per event (RUB) — conservative, updated when real data flows in
RUB_PER_VIEW = 0.05
RUB_PER_AD_CLICK = 2.5


def track_event(slug: str, event: str = "view") -> dict:
    session = SessionLocal()
    try:
        project = session.query(FleetProject).filter(FleetProject.slug == slug).first()
        if not project:
            return {"ok": False, "error": "project not found"}

        earned = 0.0
        if event == "view":
            project.page_views += 1
            earned = RUB_PER_VIEW
        elif event == "ad_click":
            project.ad_clicks += 1
            earned = RUB_PER_AD_CLICK
        elif event == "reward":
            earned = 0.1

        project.revenue_rub += earned
        project.revenue_rub_today += earned
        project.last_view_at = datetime.utcnow()
        session.commit()

        return {
            "ok": True,
            "slug": slug,
            "event": event,
            "earned_rub": round(earned, 2),
            "total_rub": round(project.revenue_rub, 2),
        }
    finally:
        session.close()


def fleet_stats() -> dict:
    session = SessionLocal()
    try:
        projects = session.query(FleetProject).all()
        active = [p for p in projects if p.status == "active"]
        return {
            "total_projects": len(projects),
            "active_projects": len(active),
            "paused_projects": len(projects) - len(active),
            "total_page_views": sum(p.page_views for p in projects),
            "total_ad_clicks": sum(p.ad_clicks for p in projects),
            "revenue_rub_total": round(sum(p.revenue_rub for p in projects), 2),
            "revenue_rub_today": round(sum(p.revenue_rub_today for p in active), 2),
            "projected_rub_per_day": round(sum(p.estimated_rub_per_day for p in active), 2),
            "avg_rub_per_project": round(
                sum(p.estimated_rub_per_day for p in active) / max(len(active), 1), 2
            ),
        }
    finally:
        session.close()
