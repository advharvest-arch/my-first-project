from datetime import datetime

from fastapi import FastAPI
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles

from config import LANDINGS_DIR, OUTPUT_DIR, settings
from src.models import Opportunity, ScanRun, SessionLocal, init_db
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
        }
    finally:
        session.close()


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
  <title>Money Engine — Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0b1120; color: #e2e8f0; }
    header { background: #1e293b; border-bottom: 1px solid #334155; padding: 1.25rem 2rem; display: flex; justify-content: space-between; align-items: center; }
    header h1 { font-size: 1.25rem; font-weight: 700; }
    header h1 span { color: #22c55e; }
    .btn { background: #22c55e; color: #052e16; border: none; padding: 0.6rem 1.25rem; border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 0.9rem; }
    .btn:hover { background: #16a34a; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    main { max-width: 1200px; margin: 0 auto; padding: 2rem; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 1.25rem; }
    .stat .value { font-size: 2rem; font-weight: 800; color: #f8fafc; }
    .stat .label { color: #64748b; font-size: 0.8rem; text-transform: uppercase; margin-top: 0.25rem; }
    table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 10px; overflow: hidden; }
    th { background: #0f172a; color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; padding: 0.75rem 1rem; text-align: left; }
    td { padding: 0.75rem 1rem; border-top: 1px solid #334155; font-size: 0.9rem; }
    tr:hover td { background: #263348; }
    .score { font-weight: 700; }
    .score.high { color: #22c55e; }
    .score.mid { color: #eab308; }
    .tag { display: inline-block; background: #1e3a5f; color: #93c5fd; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
    .link { color: #60a5fa; text-decoration: none; }
    .link:hover { text-decoration: underline; }
    #status { color: #94a3b8; font-size: 0.85rem; }
    .empty { text-align: center; padding: 3rem; color: #64748b; }
  </style>
</head>
<body>
  <header>
    <h1>💰 <span>Money</span> Engine</h1>
    <div style="display:flex;gap:1rem;align-items:center;">
      <span id="status">Загрузка...</span>
      <button class="btn" id="scanBtn" onclick="runScan()">Запустить сканирование</button>
    </div>
  </header>
  <main>
    <div class="stats" id="stats"></div>
    <table>
      <thead>
        <tr>
          <th>Ниша</th>
          <th>Тип</th>
          <th>Оценка</th>
          <th>Цена $</th>
          <th>Источник</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody id="tableBody">
        <tr><td colspan="6" class="empty">Нет данных — нажмите «Запустить сканирование»</td></tr>
      </tbody>
    </table>
  </main>
  <script>
    async function loadStats() {
      const res = await fetch('/api/stats');
      const data = await res.json();
      document.getElementById('stats').innerHTML = `
        <div class="stat"><div class="value">${data.total_opportunities}</div><div class="label">Ниш найдено</div></div>
        <div class="stat"><div class="value">${data.high_value_opportunities}</div><div class="label">Высокий потенциал</div></div>
        <div class="stat"><div class="value">${data.last_scan?.reports_generated ?? 0}</div><div class="label">Отчётов создано</div></div>
        <div class="stat"><div class="value">${data.scan_interval_hours}ч</div><div class="label">Авто-сканирование</div></div>
      `;
      const ls = data.last_scan;
      document.getElementById('status').textContent = ls?.started_at
        ? `Последний скан: ${new Date(ls.started_at).toLocaleString('ru')} — ${ls.status}`
        : 'Сканирование ещё не запускалось';
    }

    async function loadOpportunities() {
      const res = await fetch('/api/opportunities?limit=30');
      const items = await res.json();
      const tbody = document.getElementById('tableBody');
      if (!items.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="empty">Нет данных — нажмите «Запустить сканирование»</td></tr>';
        return;
      }
      tbody.innerHTML = items.map(o => {
        const scoreClass = o.total_score >= 75 ? 'high' : o.total_score >= 60 ? 'mid' : '';
        const reportLink = o.report_path ? `<a class="link" href="/reports/${o.report_path.split('/').pop()}" target="_blank">Отчёт</a>` : '';
        const landingLink = o.landing_path ? `<a class="link" href="/landings/${o.landing_path.split('/').pop()}" target="_blank">Лендинг</a>` : '';
        return `<tr>
          <td><strong>${o.niche}</strong><br><small style="color:#64748b">${o.title.substring(0,60)}...</small></td>
          <td><span class="tag">${o.monetization_type}</span></td>
          <td class="score ${scoreClass}">${o.total_score}</td>
          <td>$${o.suggested_price_usd}</td>
          <td>${o.source}</td>
          <td>${reportLink} ${landingLink}</td>
        </tr>`;
      }).join('');
    }

    async function runScan() {
      const btn = document.getElementById('scanBtn');
      btn.disabled = true;
      btn.textContent = 'Сканирование...';
      document.getElementById('status').textContent = 'Сканирование запущено...';
      try {
        await fetch('/api/scan', { method: 'POST' });
        await loadStats();
        await loadOpportunities();
      } catch(e) {
        document.getElementById('status').textContent = 'Ошибка: ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Запустить сканирование';
      }
    }

    loadStats();
    loadOpportunities();
    setInterval(() => { loadStats(); loadOpportunities(); }, 30000);
  </script>
</body>
</html>"""


@app.get("/", response_class=HTMLResponse)
async def dashboard():
    return DASHBOARD_HTML
