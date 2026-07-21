from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
OUTPUT_DIR = BASE_DIR / "output"
REPORTS_DIR = OUTPUT_DIR / "reports"
LANDINGS_DIR = OUTPUT_DIR / "landings"
FLEET_DIR = OUTPUT_DIR / "fleet"

for directory in (DATA_DIR, OUTPUT_DIR, REPORTS_DIR, LANDINGS_DIR, FLEET_DIR):
    directory.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    stripe_payment_link: str = ""
    scan_interval_hours: int = 6
    min_report_score: int = 60
    port: int = 8000
    database_url: str = f"sqlite:///{DATA_DIR / 'opportunities.db'}"

    # Fleet scaling — solutions over games
    fleet_target_size: int = 50
    fleet_min_score: int = 55
    fleet_rub_per_day_target: float = 100.0
    fleet_auto_scale: bool = True
    fleet_allow_games: bool = False
    fleet_require_pain: bool = True
    ad_slot_yandex: str = ""
    ad_slot_adsense: str = ""
    affiliate_base_url: str = ""
    public_base_url: str = "http://localhost:8000"


settings = Settings()
