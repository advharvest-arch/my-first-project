import json
from datetime import datetime
from pathlib import Path

from config import FLEET_DIR, OUTPUT_DIR, settings
from src.models import FleetProject, SessionLocal

SITE_DIR = OUTPUT_DIR / "site"


def generate_hub(static: bool = False) -> str:
    """Generate main hub page listing all fleet projects."""
    SITE_DIR.mkdir(parents=True, exist_ok=True)
    session = SessionLocal()
    try:
        projects = (
            session.query(FleetProject)
            .filter(FleetProject.status == "active")
            .order_by(FleetProject.estimated_rub_per_day.desc())
            .all()
        )
    finally:
        session.close()

    base = "." if static else settings.public_base_url.rstrip("/")
    total_projected = sum(p.estimated_rub_per_day for p in projects)

    cards = []
    for p in projects:
        link = f"{base}/p/{p.slug}/" if not static else f"./p/{p.slug}/"
        icon = {"ad_game": "🎮", "reward_game": "🏆", "micro_tool": "🔧", "affiliate": "💰"}.get(
            p.project_type, "📦"
        )
        cards.append(f"""
        <a href="{link}" class="card">
          <div class="card-icon">{icon}</div>
          <h3>{p.name}</h3>
          <p>{p.niche}</p>
          <span class="tag">{p.project_type}</span>
          <span class="rev">~{p.estimated_rub_per_day:.0f} ₽/день</span>
        </a>""")

    html = f"""<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Money Engine — Автоматический заработок</title>
  <meta name="description" content="Флот из {len(projects)} автоматических микропроектов для заработка">
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
    .rev {{ float: right; color: #22c55e; font-size: 0.8rem; font-weight: 700; }}
    .footer {{ text-align: center; color: #475569; font-size: 0.8rem; padding: 2rem; }}
  </style>
</head>
<body>
  <div class="hero">
    <h1>💰 <span>Money</span> Engine</h1>
    <p>Автоматический флот микропроектов — работает без вашего участия</p>
    <div class="metrics">
      <div class="metric"><div class="val">{len(projects)}</div><div class="lbl">Проектов</div></div>
      <div class="metric"><div class="val">{total_projected:.0f} ₽</div><div class="lbl">Прогноз / день</div></div>
      <div class="metric"><div class="val">{datetime.utcnow().strftime('%d.%m.%Y')}</div><div class="lbl">Обновлено</div></div>
    </div>
  </div>
  <div class="grid">{''.join(cards) if cards else '<p style="color:#64748b;text-align:center;grid-column:1/-1">Проекты ещё не созданы</p>'}</div>
  <p class="footer">Money Engine — turnkey auto-income system</p>
  <script src="/static/launch-button.js"></script>
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
        loc = f"{base}/p/{p.slug}/" if not static else f"{base}/p/{p.slug}/"
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
