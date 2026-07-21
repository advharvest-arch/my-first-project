import json
import shutil
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import BASE_DIR, FLEET_DIR, settings
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


def _ad_snippet(slot_id: str = "", network: str = "yandex") -> str:
    if network == "yandex" and settings.ad_slot_yandex:
        bid = settings.ad_slot_yandex
        return (
            '<script>window.yaContextCb=window.yaContextCb||[]</script>'
            '<script src="https://yandex.ru/ads/system/context.js" async></script>'
            f'<div id="yandex_rtb_{bid}" style="min-height:90px"></div>'
            "<script>window.yaContextCb.push(()=>{Ya.Context.AdvManager.render({"
            f'"blockId":"{bid}","renderTo":"yandex_rtb_{bid}"'
            "})})</script>"
        )
    if settings.ad_slot_adsense:
        return (
            '<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client='
            f'{settings.ad_slot_adsense}" crossorigin="anonymous"></script>'
            '<ins class="adsbygoogle" style="display:block" data-ad-client="'
            f'{settings.ad_slot_adsense}" data-ad-slot="auto" data-ad-format="auto"></ins>'
            "<script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>"
        )
    return '<div style="color:#64748b;font-size:0.8rem">Рекламный блок — добавьте AD_SLOT_YANDEX в .env</div>'


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
        ad_snippet=_ad_snippet(),
        affiliate_url=settings.affiliate_base_url or "https://ya.ru",
        public_url=public_url,
        track_url=track_url,
        project_slug=spec.slug,
        launch_button='<script src="/static/launch-button.js"></script>',
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
