import asyncio
import shutil
from pathlib import Path

from config import BASE_DIR, settings
from src.fleet.hub import generate_hub, generate_robots, generate_sitemap
from src.fleet.scaler import scale_fleet
from src.fleet.tracker import fleet_stats
from src.models import init_db
from src.pipeline import run_full_pipeline
from src.turnkey.export import export_static_site

ENV_EXAMPLE = BASE_DIR / ".env.example"
ENV_FILE = BASE_DIR / ".env"


def ensure_env() -> bool:
    """Create .env from example if missing. Returns True if created."""
    if ENV_FILE.exists():
        return False
    if ENV_EXAMPLE.exists():
        shutil.copy(ENV_EXAMPLE, ENV_FILE)
    else:
        ENV_FILE.write_text(
            "FLEET_TARGET_SIZE=50\nFLEET_AUTO_SCALE=true\nPUBLIC_BASE_URL=http://localhost:8000\nPORT=8000\n",
            encoding="utf-8",
        )
    return True


async def run_turnkey(fleet_size: int | None = None, skip_scan: bool = False) -> dict:
    """Full turnkey setup: env → scan → fleet → export → hub."""
    created_env = ensure_env()
    init_db()

    target = fleet_size or settings.fleet_target_size
    steps: list[str] = []

    if created_env:
        steps.append("Создан файл .env с настройками по умолчанию")

    from src.models import FleetProject, SessionLocal
    session = SessionLocal()
    existing = session.query(FleetProject).filter(FleetProject.status == "active").count()
    session.close()

    if skip_scan and existing >= target:
        steps.append(f"Флот уже готов ({existing} проектов), пропуск сканирования")
        scan_result = {"opportunities_found": 0}
        fleet_result = {"active_projects": existing, "deployed": 0}
    else:
        if not skip_scan:
            steps.append("Сканирование ниш (Reddit, HN, Trends)...")
            scan_result = await run_full_pipeline()
            fleet_result = scan_result.get("fleet", {})
        else:
            scan_result = {"opportunities_found": 0}
            fleet_result = {}

        if fleet_result.get("active_projects", 0) < target:
            steps.append(f"Масштабирование флота до {target} проектов...")
            fleet_result = scale_fleet(target)

    steps.append("Генерация главной страницы и SEO...")
    hub = generate_hub(static=False)
    sitemap = generate_sitemap()
    robots = generate_robots()

    steps.append("Экспорт статического сайта для хостинга...")
    export_result = export_static_site()

    stats = fleet_stats()

    return {
        "status": "ready",
        "steps_completed": steps,
        "fleet": fleet_result,
        "stats": stats,
        "export": export_result,
        "dashboard_url": f"{settings.public_base_url.rstrip('/')}/",
        "site_dir": export_result["site_dir"],
        "zip_path": export_result["zip_path"],
        "next_steps": [
            f"1. Запустите: ./start.sh  (или python3 main.py start)",
            f"2. Откройте дашборд: {settings.public_base_url}/",
            f"3. Добавьте рекламу в .env: AD_SLOT_YANDEX или AD_SLOT_ADSENSE",
            f"4. Загрузите {export_result['site_dir']} на хостинг для реального трафика",
        ],
    }


def print_turnkey_report(result: dict) -> None:
    stats = result.get("stats", {})
    fleet = result.get("fleet", {})
    print("\n" + "=" * 55)
    print("  💰 MONEY ENGINE — ГОТОВО ПОД КЛЮЧ")
    print("=" * 55)
    print(f"\n  Проектов в флоте:     {stats.get('active_projects', 0)}")
    print(f"  Прогноз дохода:       {stats.get('projected_rub_per_day', 0):.0f} ₽/день")
    print(f"  Среднее на проект:    {stats.get('avg_rub_per_project', 0):.0f} ₽/день")
    print(f"\n  Дашборд:              {result.get('dashboard_url')}")
    print(f"  Статический сайт:     {result.get('site_dir')}")
    print(f"  Архив для загрузки:   {result.get('zip_path')}")
    print("\n  Следующие шаги:")
    for step in result.get("next_steps", []):
        print(f"    {step}")
    print("\n" + "=" * 55 + "\n")
