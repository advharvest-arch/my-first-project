import json
import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import FLEET_DIR, settings
from src.fleet.types import FleetDeploySpec
from src.fleet.utils import theme_color_for

TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent / "templates" / "fleet"
env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
)

TEMPLATE_MAP = {
    "ad_game": "ad_game.html.j2",
    "reward_game": "reward_game.html.j2",
    "micro_tool": "micro_tool.html.j2",
    "affiliate": "affiliate.html.j2",
}

ESTIMATED_RUB = {
    "ad_game": 120.0,
    "reward_game": 150.0,
    "micro_tool": 80.0,
    "affiliate": 100.0,
}


def deploy_project(spec: FleetDeploySpec) -> tuple[str, str, float]:
    """Deploy a fleet project. Returns (deploy_path, public_url, estimated_rub_per_day)."""
    project_dir = FLEET_DIR / spec.slug
    if project_dir.exists():
        shutil.rmtree(project_dir)
    project_dir.mkdir(parents=True)

    template_name = TEMPLATE_MAP.get(spec.project_type, "ad_game.html.j2")
    template = env.get_template(template_name)

    public_url = f"{settings.public_base_url.rstrip('/')}/p/{spec.slug}/"
    track_url = f"{settings.public_base_url.rstrip('/')}/api/fleet/track"

    html = template.render(
        spec=spec,
        theme=spec.theme_color or theme_color_for(spec.slug),
        ad_yandex=settings.ad_slot_yandex,
        ad_adsense=settings.ad_slot_adsense,
        affiliate_url=settings.affiliate_base_url or "#",
        public_url=public_url,
        track_url=track_url,
        project_slug=spec.slug,
    )
    (project_dir / "index.html").write_text(html, encoding="utf-8")

    meta = {
        "slug": spec.slug,
        "name": spec.name,
        "niche": spec.niche,
        "type": spec.project_type,
        "public_url": public_url,
        "estimated_rub_per_day": ESTIMATED_RUB.get(spec.project_type, 100.0),
    }
    (project_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    return str(project_dir), public_url, ESTIMATED_RUB.get(spec.project_type, 100.0)
