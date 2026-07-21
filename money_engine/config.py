from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
OUTPUT_DIR = BASE_DIR / "output"
REPORTS_DIR = OUTPUT_DIR / "reports"
LANDINGS_DIR = OUTPUT_DIR / "landings"

for directory in (DATA_DIR, OUTPUT_DIR, REPORTS_DIR, LANDINGS_DIR):
    directory.mkdir(parents=True, exist_ok=True)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    stripe_payment_link: str = ""
    scan_interval_hours: int = 6
    min_report_score: int = 60
    port: int = 8000
    database_url: str = f"sqlite:///{DATA_DIR / 'opportunities.db'}"


settings = Settings()
