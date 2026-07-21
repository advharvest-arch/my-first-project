from datetime import datetime

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from config import FLEET_DIR, LANDINGS_DIR, OUTPUT_DIR, settings
from src.fleet.scaler import clone_top_performers, prune_fleet, scale_fleet
from src.fleet.tracker import fleet_stats, track_event
from src.models import FleetProject, Opportunity, ScanRun, SessionLocal, init_db
from src.pipeline import run_full_pipeline

app = FastAPI(title="Money Engine", version="1.0.0")

init_db()


@app.on_event("startup")
async def startup() -> None:
    from src.scheduler import start_scheduler

    start_scheduler()


@app.get("/api/health")
async def health():
    return {"status": "ok", "service": "money-engine"}


@app.post("/api/scan")
async def trigger_scan():
    result = await run_full_pipeline()
    return result


@app.get("/api/opportunities")
async def list_opportunities(limit: int = 20):
    session = SessionLocal()
    try:
        items = (
            session.query(Opportunity)
            .order_by(Opportunity.total_score.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": o.id,
                "title": o.title,
                "niche": o.niche,
                "pain_point": o.pain_point,
                "source": o.source,
                "source_url": o.source_url,
                "demand_score": o.demand_score,
                "competition_score": o.competition_score,
                "monetization_score": o.monetization_score,
                "total_score": o.total_score,
                "monetization_type": o.monetization_type,
                "suggested_price_usd": o.suggested_price_usd,
                "action_plan": o.action_plan,
                "report_path": o.report_path,
                "landing_path": o.landing_path,
                "created_at": o.created_at.isoformat() if o.created_at else None,
            }
            for o in items
        ]
    finally:
        session.close()


@app.get("/api/stats")
async def stats():
    session = SessionLocal()
    try:
        total = session.query(Opportunity).count()
        high_value = session.query(Opportunity).filter(Opportunity.total_score >= 75).count()
        last_scan = session.query(ScanRun).order_by(ScanRun.started_at.desc()).first()
        fleet = fleet_stats()
        return {
            "total_opportunities": total,
            "high_value_opportunities": high_value,
            "last_scan": {
                "status": last_scan.status if last_scan else None,
                "started_at": last_scan.started_at.isoformat() if last_scan and last_scan.started_at else None,
                "opportunities_found": last_scan.opportunities_found if last_scan else 0,
                "reports_generated": last_scan.reports_generated if last_scan else 0,
            },
            "scan_interval_hours": settings.scan_interval_hours,
            "fleet": fleet,
        }
    finally:
        session.close()


class TrackPayload(BaseModel):
    slug: str
    event: str = "view"


@app.post("/api/fleet/track")
async def fleet_track(payload: TrackPayload):
    return track_event(payload.slug, payload.event)


@app.post("/api/fleet/scale")
async def fleet_scale(target: int | None = None):
    return scale_fleet(target)


@app.post("/api/fleet/prune")
async def fleet_prune():
    return prune_fleet()


@app.post("/api/fleet/clone")
async def fleet_clone(count: int = 3):
    return clone_top_performers(count)


@app.get("/api/fleet/projects")
async def fleet_projects(limit: int = 50):
    session = SessionLocal()
    try:
        items = (
            session.query(FleetProject)
            .order_by(FleetProject.revenue_rub.desc())
            .limit(limit)
            .all()
        )
        return [
            {
                "id": p.id,
                "slug": p.slug,
                "name": p.name,
                "niche": p.niche,
                "project_type": p.project_type,
                "status": p.status,
                "public_url": p.public_url,
                "page_views": p.page_views,
                "ad_clicks": p.ad_clicks,
                "revenue_rub": p.revenue_rub,
                "revenue_rub_today": p.revenue_rub_today,
                "estimated_rub_per_day": p.estimated_rub_per_day,
                "opportunity_score": p.opportunity_score,
            }
            for p in items
        ]
    finally:
        session.close()


@app.get("/p/{slug}")
@app.get("/p/{slug}/")
async def serve_fleet_project(slug: str):
    path = FLEET_DIR / slug / "index.html"
    if path.exists():
        return FileResponse(path, media_type="text/html")
    return {"error": "project not found"}


SITE_DIR = OUTPUT_DIR / "site"
if SITE_DIR.exists():
    app.mount("/site", StaticFiles(directory=str(SITE_DIR), html=True), name="site")


@app.get("/hub")
@app.get("/hub/")
async def serve_hub():
    hub = SITE_DIR / "index.html"
    if hub.exists():
        return FileResponse(hub, media_type="text/html")
    from src.fleet.hub import generate_hub
    generate_hub()
    return FileResponse(SITE_DIR / "index.html", media_type="text/html")


@app.post("/api/turnkey")
async def api_turnkey(count: int | None = None):
    from src.turnkey.setup import run_turnkey
    return await run_turnkey(fleet_size=count)


@app.get("/api/scans")
async def scan_history(limit: int = 10):
    session = SessionLocal()
    try:
        scans = session.query(ScanRun).order_by(ScanRun.started_at.desc()).limit(limit).all()
        return [
            {
                "id": s.id,
                "status": s.status,
                "sources_scanned": s.sources_scanned,
                "raw_signals": s.raw_signals,
                "opportunities_found": s.opportunities_found,
                "reports_generated": s.reports_generated,
                "error": s.error,
                "started_at": s.started_at.isoformat() if s.started_at else None,
                "finished_at": s.finished_at.isoformat() if s.finished_at else None,
            }
            for s in scans
        ]
    finally:
        session.close()


@app.get("/reports/{filename}")
async def get_report(filename: str):
    path = OUTPUT_DIR / "reports" / filename
    if path.exists():
        return FileResponse(path, media_type="text/markdown")
    return {"error": "not found"}


@app.get("/landings/{filename}")
async def get_landing(filename: str):
    path = LANDINGS_DIR / filename
    if path.exists():
        return FileResponse(path, media_type="text/html")
    return {"error": "not found"}


DASHBOARD_HTML = """<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Money Engine — Fleet Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b1120; color: #e2e8f0; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 1.25rem 2rem; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 1rem; }
    header h1 { font-size: 1.25rem; font-weight: 700; }
    header h1 span { color: #22c55e; }
    .btn { background: #22c55e; color: #052e16; border: none; padding: 0.6rem 1.25rem; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.9rem; }
    .btn:hover { background: #16a34a; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn.secondary { background: #334155; color: #e2e8f0; }
    main { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    h2 { font-size: 1.1rem; margin: 2rem 0 1rem; color: #94a3b8; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 1rem; margin-bottom: 1rem; }
    .stat { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 1.25rem; }
    .stat .value { font-size: 1.8rem; font-weight: 800; color: #f8fafc; }
    .stat .value.green { color: #22c55e; }
    .stat .label { color: #64748b; font-size: 0.75rem; text-transform: uppercase; margin-top: 0.25rem; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; margin-bottom: 2rem; }
    th { background: #0f172a; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; padding: 0.75rem 1rem; text-align: left; }
    td { padding: 0.75rem 1rem; border-top: 1px solid #334155; font-size: 0.85rem; }
    tr:hover td { background: #263348; }
    .tag { display: inline-block; background: #1e3a5f; color: #93c5fd; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.7rem; }
    .tag.game { background: #3b1f5f; color: #d8b4fe; }
    .tag.tool { background: #1f3b2f; color: #86efac; }
    .link { color: #60a5fa; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    #status { color: #94a3b8; font-size: 0.85rem; }
    .empty { text-align: center; padding: 2rem; color: #64748b; }
    .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
    .proj-active { color: #22c55e; }
    .proj-paused { color: #64748b; }
  </style>
</head>
<body>
  <header>
    <h1>💰 <span>Money</span> Engine — Fleet</h1>
    <div class="actions">
      <span id="status">Загрузка...</span>
      <button class="btn secondary" id="scaleBtn" onclick="scaleFleet()">Масштабировать флот</button>
      <button class="btn" id="scanBtn" onclick="runScan()">Скан + деплой</button>
    </div>
  </header>
  <main>
    <h2>Флот проектов (автозаработок)</h2>
    <div class="stats" id="fleetStats"></div>
    <table>
      <thead><tr>
        <th>Проект</th><th>Тип</th><th>Статус</th><th>Просмотры</th><th>₽ сегодня</th><th>₽/день (прогноз)</th><th>Ссылка</th>
      </tr></thead>
      <tbody id="fleetBody"><tr><td colspan="7" class="empty">Флот пуст — нажмите «Масштабировать флот»</td></tr></tbody>
    </table>

    <h2>Найденные ниши</h2>
    <div class="stats" id="stats"></div>
    <table>
      <thead><tr><th>Ниша</th><th>Тип</th><th>Оценка</th><th>Источник</th></tr></thead>
      <tbody id="tableBody"><tr><td colspan="4" class="empty">Нет данных</td></tr></tbody>
    </table>
  </main>
  <script>
    async function loadAll() {
      const [statsRes, fleetRes, projRes] = await Promise.all([
        fetch('/api/stats'), fetch('/api/fleet/projects?limit=50'), fetch('/api/opportunities?limit=20')
      ]);
      const data = await statsRes.json();
      const fleet = data.fleet || {};
      document.getElementById('fleetStats').innerHTML = `
        <div class="stat"><div class="value green">${fleet.active_projects||0}</div><div class="label">Активных проектов</div></div>
        <div class="stat"><div class="value green">${(fleet.revenue_rub_today||0).toFixed(0)} ₽</div><div class="label">Доход сегодня</div></div>
        <div class="stat"><div class="value">${(fleet.projected_rub_per_day||0).toFixed(0)} ₽</div><div class="label">Прогноз ₽/день</div></div>
        <div class="stat"><div class="value">${fleet.total_page_views||0}</div><div class="label">Просмотров</div></div>
        <div class="stat"><div class="value">${(fleet.avg_rub_per_project||0).toFixed(0)} ₽</div><div class="label">Среднее на проект</div></div>
      `;
      document.getElementById('stats').innerHTML = `
        <div class="stat"><div class="value">${data.total_opportunities}</div><div class="label">Ниш</div></div>
        <div class="stat"><div class="value">${data.high_value_opportunities}</div><div class="label">Высокий потенциал</div></div>
      `;
      const ls = data.last_scan;
      document.getElementById('status').textContent = ls?.started_at
        ? `Скан: ${new Date(ls.started_at).toLocaleString('ru')} — ${ls.status} | ${fleet.active_projects||0} проектов`
        : `${fleet.active_projects||0} проектов в флоте`;

      const projects = await projRes.json();
      const fb = document.getElementById('fleetBody');
      if (!projects.length) {
        fb.innerHTML = '<tr><td colspan="7" class="empty">Флот пуст — нажмите «Масштабировать флот»</td></tr>';
      } else {
        fb.innerHTML = projects.map(p => {
          const tc = p.project_type.includes('game') ? 'game' : p.project_type === 'micro_tool' ? 'tool' : '';
          return `<tr>
            <td><strong>${p.name}</strong><br><small style="color:#64748b">${p.niche}</small></td>
            <td><span class="tag ${tc}">${p.project_type}</span></td>
            <td class="${p.status==='active'?'proj-active':'proj-paused'}">${p.status}</td>
            <td>${p.page_views}</td>
            <td>${p.revenue_rub_today.toFixed(1)} ₽</td>
            <td>${p.estimated_rub_per_day.toFixed(0)} ₽</td>
            <td><a class="link" href="/p/${p.slug}/" target="_blank">Открыть</a></td>
          </tr>`;
        }).join('');
      }

      const items = await (await fetch('/api/opportunities?limit=20')).json();
      const tbody = document.getElementById('tableBody');
      tbody.innerHTML = items.length ? items.map(o => `<tr>
        <td><strong>${o.niche}</strong></td>
        <td><span class="tag">${o.monetization_type}</span></td>
        <td>${o.total_score}</td>
        <td>${o.source}</td>
      </tr>`).join('') : '<tr><td colspan="4" class="empty">Нет данных</td></tr>';
    }

    async function scaleFleet() {
      const btn = document.getElementById('scaleBtn');
      btn.disabled = true; btn.textContent = 'Деплой...';
      try { await fetch('/api/fleet/scale', {method:'POST'}); await loadAll(); }
      finally { btn.disabled = false; btn.textContent = 'Масштабировать флот'; }
    }

    async function runScan() {
      const btn = document.getElementById('scanBtn');
      btn.disabled = true; btn.textContent = 'Работаю...';
      try { await fetch('/api/scan', {method:'POST'}); await loadAll(); }
      finally { btn.disabled = false; btn.textContent = 'Скан + деплой'; }
    }

    loadAll();
    setInterval(loadAll, 30000);
  </script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return DASHBOARD_HTML
