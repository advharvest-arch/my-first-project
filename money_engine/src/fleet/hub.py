import json
from datetime import datetime
from pathlib import Path

from config import FLEET_DIR, OUTPUT_DIR, settings
from src.models import FleetProject, SessionLocal

SITE_DIR = OUTPUT_DIR / "site"

TYPE_LABELS = {
    "ad_game": "Игра",
    "reward_game": "Игра",
    "micro_tool": "Утилита",
    "affiliate": "Подборка",
}

TYPE_SUBTITLE = {
    "ad_game": "Бесплатная игра в браузере",
    "reward_game": "Игра на память",
    "micro_tool": "Полезный онлайн-инструмент",
    "affiliate": "Лучшие предложения",
}


def generate_hub(static: bool = False) -> str:
    """Generate public-facing hub — no owner/money info."""
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    session = SessionLocal()
    try:
        projects = (
            session.query(FleetProject)
            .filter(FleetProject.status == "active")
            .order_by(FleetProject.name)
            .all()
        )
    finally:
        session.close()

    base = "." if static else settings.public_base_url.rstrip("/")

    cards = []
    for p in projects:
        link = f"{base}/p/{p.slug}/" if not static else f"./p/{p.slug}/"
        icon = {"ad_game": "🎮", "reward_game": "🎯", "micro_tool": "🔧", "affiliate": "⭐"}.get(
            p.project_type, "🎮"
        )
        label = TYPE_LABELS.get(p.project_type, "Игра")
        subtitle = TYPE_SUBTITLE.get(p.project_type, "Бесплатно")
        cards.append(f"""
        <a href="{link}" class="card">
          <div class="card-icon">{icon}</div>
          <h3>{p.name}</h3>
          <p>{subtitle}</p>
          <span class="tag">{label}</span>
        </a>""")

    html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PlayBox — бесплатные онлайн-игры и утилиты</title>
  <meta name="description" content="PlayBox — бесплатные мини-игры и онлайн-утилиты. Играй в браузере без регистрации.">
  <style>
    * {{ box-sizing: border-box; margin: 0; padding: 0; }}
    body {{ font-family: system-ui, sans-serif; background: #0b1120; color: #e2e8f0; }}
    .hero {{ text-align: center; padding: 3rem 1.5rem 2rem; background: linear-gradient(180deg, #1e293b, #0b1120); }}
    .hero h1 {{ font-size: 2rem; font-weight: 900; }}
    .hero h1 span {{ color: #22c55e; }}
    .hero p {{ color: #94a3b8; margin-top: 0.5rem; }}
    .metrics {{ display: flex; justify-content: center; gap: 2rem; margin-top: 1.5rem; flex-wrap: wrap; }}
    .metric {{ text-align: center; }}
    .metric .val {{ font-size: 1.8rem; font-weight: 800; color: #22c55e; }}
    .metric .lbl {{ font-size: 0.75rem; color: #64748b; text-transform: uppercase; }}
    .grid {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; max-width: 1100px; margin: 2rem auto; padding: 0 1rem 3rem; }}
    .card {{ background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 1.25rem; text-decoration: none; color: inherit; transition: border-color 0.2s, transform 0.2s; display: block; }}
    .card:hover {{ border-color: #22c55e; transform: translateY(-2px); }}
    .card-icon {{ font-size: 2rem; margin-bottom: 0.5rem; }}
    .card h3 {{ font-size: 1rem; margin-bottom: 0.25rem; }}
    .card p {{ color: #64748b; font-size: 0.85rem; margin-bottom: 0.75rem; }}
    .tag {{ display: inline-block; background: #1e3a5f; color: #93c5fd; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; }}
    .footer {{ text-align: center; color: #475569; font-size: 0.8rem; padding: 2rem; }}
  </style>
</head>
<body>
  <div class="hero">
    <h1>🎮 <span>Play</span>Box</h1>
    <p>Бесплатные онлайн-игры и утилиты — играй прямо в браузере</p>
    <div class="metrics">
      <div class="metric"><div class="val">{len(projects)}</div><div class="lbl">Игр и утилит</div></div>
      <div class="metric"><div class="val">0 ₽</div><div class="lbl">Всё бесплатно</div></div>
    </div>
  </div>
  <div class="grid">{''.join(cards) if cards else '<p style="color:#64748b;text-align:center;grid-column:1/-1">Скоро появятся новые игры</p>'}</div>
  <p class="footer">PlayBox — бесплатные онлайн-игры</p>
</body>
</html>"""

    hub_path = SITE_DIR / "index.html"
    hub_path.write_text(html, encoding="utf-8")
    return str(hub_path)


def generate_sitemap(static: bool = False) -> str:
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    base = settings.public_base_url.rstrip("/")
    session = SessionLocal()
    try:
        projects = session.query(FleetProject).filter(FleetProject.status == "active").all()
    finally:
        session.close()

    urls = [f"  <url><loc>{base}/</loc><priority>1.0</priority></url>"]
    for p in projects:
        loc = f"{base}/p/{p.slug}/"
        urls.append(f"  <url><loc>{loc}</loc><priority>0.8</priority></url>")

    sitemap = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
    sitemap += "\n".join(urls) + "\n</urlset>"
    path = SITE_DIR / "sitemap.xml"
    path.write_text(sitemap, encoding="utf-8")
    return str(path)


def generate_robots() -> str:
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    base = settings.public_base_url.rstrip("/")
    content = f"User-agent: *\nAllow: /\nSitemap: {base}/sitemap.xml\n"
    path = SITE_DIR / "robots.txt"
    path.write_text(content, encoding="utf-8")
    return str(path)
