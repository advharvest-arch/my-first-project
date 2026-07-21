from datetime import datetime

from config import settings
from src.fleet.deployer import deploy_project
from src.fleet.solutions import build_solution, is_deployable
from src.fleet.types import FleetDeploySpec
from src.fleet.utils import slugify, theme_color_for
from src.models import FleetProject, Opportunity, SessionLocal, init_db


def _unique_slug(base: str, session) -> str:
    slug = slugify(base)
    candidate = slug
    counter = 1
    while session.query(FleetProject).filter(FleetProject.slug == candidate).first():
        counter += 1
        candidate = f"{slug}-{counter}"
    return candidate


def _spec_from_opportunity(opp: Opportunity, slug: str) -> FleetDeploySpec:
    solution = build_solution(
        niche=opp.niche,
        pain_point=opp.pain_point,
        monetization_type=opp.monetization_type,
        action_plan=opp.action_plan,
    )
    return FleetDeploySpec(
        slug=slug,
        name=solution.display_name,
        niche=opp.niche,
        project_type=solution.project_type,
        opportunity_score=opp.total_score,
        theme_color=theme_color_for(slug),
        pain_point=opp.pain_point,
        action_plan=opp.action_plan,
        tool_mode=solution.tool_mode,
        tagline=solution.tagline,
    )


def _spec_from_project(project: FleetProject, session) -> FleetDeploySpec:
    opp = (
        session.query(Opportunity)
        .filter(Opportunity.niche == project.niche)
        .order_by(Opportunity.total_score.desc())
        .first()
    )
    if opp:
        return _spec_from_opportunity(opp, project.slug)
    return FleetDeploySpec(
        slug=project.slug,
        name=project.name,
        niche=project.niche,
        project_type=project.project_type,
        opportunity_score=project.opportunity_score,
        theme_color=theme_color_for(project.slug),
        pain_point=project.niche,
        tagline="Полезное решение",
    )


def redeploy_fleet() -> dict:
    """Rebuild all active project pages with current settings (e.g. new ad IDs)."""
    init_db()
    session = SessionLocal()
    updated = 0
    try:
        for project in session.query(FleetProject).filter(FleetProject.status == "active").all():
            spec = _spec_from_project(project, session)
            deploy_path, public_url, estimated = deploy_project(spec)
            project.deploy_path = deploy_path
            project.public_url = public_url
            project.estimated_rub_per_day = estimated
            project.name = spec.name
            project.project_type = spec.project_type
            updated += 1
        session.commit()
    finally:
        session.close()
    return {"updated": updated}


def scale_fleet(target_size: int | None = None) -> dict:
    """Deploy solution pages from real user needs until fleet reaches target."""
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

        existing_niches = {p.niche.lower() for p in session.query(FleetProject).all()}

        opportunities = (
            session.query(Opportunity)
            .filter(Opportunity.total_score >= settings.fleet_min_score)
            .order_by(Opportunity.total_score.desc())
            .limit(needed * 5)
            .all()
        )

        for opp in opportunities:
            if deployed >= needed:
                break
            if opp.niche.lower() in existing_niches:
                skipped += 1
                continue

            if settings.fleet_require_pain and not is_deployable(
                pain_point=opp.pain_point,
                niche=opp.niche,
                title=opp.title,
                source=opp.source,
                monetization_type=opp.monetization_type,
                allow_games=settings.fleet_allow_games,
            ):
                skipped += 1
                continue

            slug = _unique_slug(opp.niche, session)
            spec = _spec_from_opportunity(opp, slug)
            deploy_path, public_url, estimated = deploy_project(spec)

            project = FleetProject(
                slug=slug,
                name=spec.name,
                niche=opp.niche,
                project_type=spec.project_type,
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
    """Clone best-performing solution types into new niches from opportunities."""
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
            if settings.fleet_require_pain and not is_deployable(
                pain_point=opp.pain_point,
                niche=opp.niche,
                title=opp.title,
                source=opp.source,
                monetization_type=opp.monetization_type,
                allow_games=settings.fleet_allow_games,
            ):
                continue
            slug = _unique_slug(f"{winner.project_type}-{opp.niche}", session)
            spec = _spec_from_opportunity(opp, slug)
            deploy_path, public_url, estimated = deploy_project(spec)
            session.add(
                FleetProject(
                    slug=slug,
                    name=spec.name,
                    niche=opp.niche,
                    project_type=spec.project_type,
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
