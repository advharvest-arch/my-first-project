import json
import shutil
import zipfile
from pathlib import Path

from config import BASE_DIR, FLEET_DIR, OUTPUT_DIR, settings
from src.fleet.hub import generate_hub, generate_robots, generate_sitemap
from src.models import FleetProject, SessionLocal

SITE_DIR = OUTPUT_DIR / "site"
_PRIVATE_EXPORT_FILES = {"meta.json"}
_PRIVATE_EXPORT_DIRS = {"static"}


def _copy_public_project(src: Path, dst: Path) -> None:
    """Copy fleet project files for public hosting — no owner metadata."""
    dst.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        if item.name in _PRIVATE_EXPORT_FILES or item.name in _PRIVATE_EXPORT_DIRS:
            continue
        target = dst / item.name
        if item.is_dir():
            shutil.copytree(item, target)
        else:
            shutil.copy2(item, target)


def export_static_site() -> dict:
    """Export complete static site ready for upload to any hosting."""
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    fleet_site = SITE_DIR / "p"
    if fleet_site.exists():
        shutil.rmtree(fleet_site)
    fleet_site.mkdir(parents=True)

    session = SessionLocal()
    try:
        projects = session.query(FleetProject).filter(FleetProject.status == "active").all()
    finally:
        session.close()

    exported = 0
    for project in projects:
        src = FLEET_DIR / project.slug
        if not src.exists():
            continue
        dst = fleet_site / project.slug
        if dst.exists():
            shutil.rmtree(dst)
        _copy_public_project(src, dst)
        exported += 1

    hub = generate_hub(static=True)
    sitemap = generate_sitemap(static=False)
    robots = generate_robots()

    # Hosting configs
    vercel = {"rewrites": [{"source": "/p/:slug", "destination": "/p/:slug/index.html"}]}
    (SITE_DIR / "vercel.json").write_text(json.dumps(vercel, indent=2), encoding="utf-8")

    # Cloudflare Pages / Netlify
    redirects = "\n".join(f"/p/{p.slug} /p/{p.slug}/index.html 200" for p in projects)
    (SITE_DIR / "_redirects").write_text(redirects + "\n", encoding="utf-8")

    # Zip archive for easy upload
    zip_path = OUTPUT_DIR / "playbox-site.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file in SITE_DIR.rglob("*"):
            if file.is_file():
                zf.write(file, file.relative_to(SITE_DIR))

    return {
        "site_dir": str(SITE_DIR),
        "zip_path": str(zip_path),
        "projects_exported": exported,
        "hub": hub,
        "sitemap": sitemap,
        "robots": robots,
        "upload_instructions": _upload_instructions(),
    }


def _upload_instructions() -> str:
    return f"""
Статический сайт готов в: {SITE_DIR}
Архив для загрузки: {OUTPUT_DIR / 'playbox-site.zip'}

Варианты деплоя (бесплатно):
  1. Cloudflare Pages — перетащите папку site/ на dash.cloudflare.com
  2. Vercel — npx vercel {SITE_DIR}
  3. GitHub Pages — залейте содержимое site/ в репозиторий
  4. Любой VPS — скопируйте site/ в /var/www/html

После деплоя обновите PUBLIC_BASE_URL в .env на ваш домен.
"""
