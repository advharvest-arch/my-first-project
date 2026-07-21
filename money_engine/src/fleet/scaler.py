from datetime import datetime

from config import settings
from src.fleet.deployer import deploy_project
from src.fleet.types import FleetDeploySpec
from src.fleet.utils import pick_project_type, slugify, theme_color_for
from src.models import FleetProject, Opportunity, SessionLocal, init_db


def _unique_slug(base: str, session) -> str:
    slug = slugify(base)
    candidate = slug
    counter = 1
    while session.query(FleetProject).filter(FleetProject.slug == candidate).first():
        counter += 1
        candidate = f"{slug}-{counter}"
    return candidate


def redeploy_fleet() -> dict:
    """Rebuild all active project pages with current settings (e.g. new ad IDs)."""
    init_db()
    session = SessionLocal()
    updated = 0
    try:
        for project in session.query(FleetProject).filter(FleetProject.status == "active").all():
            spec = FleetDeploySpec(
                slug=project.slug,
                name=project.name,
                niche=project.niche,
                project_type=project.project_type,
                opportunity_score=project.opportunity_score,
                theme_color=theme_color_for(project.slug),
            )
            deploy_path, public_url, estimated = deploy_project(spec)
            project.deploy_path = deploy_path
            project.public_url = public_url
            project.estimated_rub_per_day = estimated
            updated += 1
        session.commit()
    finally:
        session.close()
    return {"updated": updated}


def scale_fleet(target_size: int | None = None) -> dict:
    """Auto-deploy micro-projects from top opportunities until fleet reaches target."""
    init_db()
    target = target_size or settings.fleet_target_size
    session = SessionLocal()

    try:
        active = session.query(FleetProject).filter(FleetProject.status == "active").count()
        needed = max(0, target - active)
        deployed = 0
        skipped = 0

        if needed == 0:
            return {
                "status": "ok",
                "active_projects": active,
                "deployed": 0,
                "message": f"Fleet already at target ({active}/{target})",
            }

        existing_niches = {
            p.niche.lower()
            for p in session.query(FleetProject).all()
        }

        opportunities = (
            session.query(Opportunity)
            .filter(Opportunity.total_score >= settings.fleet_min_score)
            .order_by(Opportunity.total_score.desc())
            .limit(needed * 3)
            .all()
        )

        for opp in opportunities:
            if deployed >= needed:
                break
            if opp.niche.lower() in existing_niches:
                skipped += 1
                continue

            project_type = pick_project_type(opp.niche, opp.monetization_type)
            slug = _unique_slug(opp.niche, session)
            spec = FleetDeploySpec(
                slug=slug,
                name=opp.niche.title(),
                niche=opp.niche,
                project_type=project_type,
                opportunity_score=opp.total_score,
                theme_color=theme_color_for(slug),
            )

            deploy_path, public_url, estimated = deploy_project(spec)

            project = FleetProject(
                slug=slug,
                name=spec.name,
                niche=opp.niche,
                project_type=project_type,
                deploy_path=deploy_path,
                public_url=public_url,
                status="active",
                opportunity_score=opp.total_score,
                estimated_rub_per_day=estimated,
            )
            session.add(project)
            existing_niches.add(opp.niche.lower())
            deployed += 1

        session.commit()
        active_now = session.query(FleetProject).filter(FleetProject.status == "active").count()
        total_revenue_today = sum(
            p.revenue_rub_today for p in session.query(FleetProject).filter(FleetProject.status == "active")
        )
        projected = sum(
            p.estimated_rub_per_day for p in session.query(FleetProject).filter(FleetProject.status == "active")
        )

        return {
            "status": "ok",
            "active_projects": active_now,
            "deployed": deployed,
            "skipped": skipped,
            "target": target,
            "revenue_rub_today": round(total_revenue_today, 2),
            "projected_rub_per_day": round(projected, 2),
        }
    finally:
        session.close()


def prune_fleet(min_views: int = 0, days_idle: int = 14) -> dict:
    """Pause dead projects to keep fleet lean."""
    session = SessionLocal()
    try:
        cutoff = datetime.utcnow()
        paused = 0
        for project in session.query(FleetProject).filter(FleetProject.status == "active").all():
            idle = (
                project.last_view_at is None
                and (cutoff - project.created_at).days >= days_idle
            ) or (project.page_views <= min_views and (cutoff - project.created_at).days >= days_idle)
            if idle:
                project.status = "paused"
                paused += 1
        session.commit()
        return {"paused": paused}
    finally:
        session.close()


def clone_top_performers(count: int = 3) -> dict:
    """Clone best-earning project types into new niches from opportunities."""
    session = SessionLocal()
    try:
        top = (
            session.query(FleetProject)
            .filter(FleetProject.status == "active")
            .order_by(FleetProject.revenue_rub.desc())
            .limit(count)
            .all()
        )
        cloned = 0
        for winner in top:
            opp = (
                session.query(Opportunity)
                .filter(Opportunity.niche != winner.niche)
                .order_by(Opportunity.total_score.desc())
                .first()
            )
            if not opp:
                continue
            slug = _unique_slug(f"{winner.project_type}-{opp.niche}", session)
            spec = FleetDeploySpec(
                slug=slug,
                name=f"{opp.niche.title()} {winner.project_type.replace('_', ' ').title()}",
                niche=opp.niche,
                project_type=winner.project_type,
                opportunity_score=opp.total_score,
                theme_color=theme_color_for(slug),
            )
            deploy_path, public_url, estimated = deploy_project(spec)
            session.add(
                FleetProject(
                    slug=slug,
                    name=spec.name,
                    niche=opp.niche,
                    project_type=winner.project_type,
                    deploy_path=deploy_path,
                    public_url=public_url,
                    status="active",
                    opportunity_score=opp.total_score,
                    estimated_rub_per_day=estimated,
                )
            )
            cloned += 1
        session.commit()
        return {"cloned": cloned}
    finally:
        session.close()
