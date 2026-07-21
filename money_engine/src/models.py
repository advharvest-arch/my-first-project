from datetime import datetime
from enum import Enum

from sqlalchemy import DateTime, Float, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from config import settings


class MonetizationType(str, Enum):
    MICRO_SAAS = "micro_saas"
    DIGITAL_REPORT = "digital_report"
    AFFILIATE = "affiliate"
    FREELANCE = "freelance"
    CONTENT_SEO = "content_seo"


class Base(DeclarativeBase):
    pass


class Opportunity(Base):
    __tablename__ = "opportunities"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    title: Mapped[str] = mapped_column(String(500))
    niche: Mapped[str] = mapped_column(String(200), index=True)
    pain_point: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(100))
    source_url: Mapped[str] = mapped_column(String(1000), default="")
    demand_score: Mapped[float] = mapped_column(Float, default=0.0)
    competition_score: Mapped[float] = mapped_column(Float, default=0.0)
    monetization_score: Mapped[float] = mapped_column(Float, default=0.0)
    total_score: Mapped[float] = mapped_column(Float, default=0.0, index=True)
    monetization_type: Mapped[str] = mapped_column(String(50), default="")
    suggested_price_usd: Mapped[float] = mapped_column(Float, default=0.0)
    action_plan: Mapped[str] = mapped_column(Text, default="")
    report_path: Mapped[str] = mapped_column(String(500), default="")
    landing_path: Mapped[str] = mapped_column(String(500), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow
    )


class ProjectType(str, Enum):
    AD_GAME = "ad_game"
    MICRO_TOOL = "micro_tool"
    AFFILIATE = "affiliate"
    REWARD_GAME = "reward_game"


class FleetProject(Base):
    __tablename__ = "fleet_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    slug: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(300))
    niche: Mapped[str] = mapped_column(String(200), index=True)
    project_type: Mapped[str] = mapped_column(String(50), index=True)
    deploy_path: Mapped[str] = mapped_column(String(500))
    public_url: Mapped[str] = mapped_column(String(500), default="")
    status: Mapped[str] = mapped_column(String(30), default="active", index=True)
    opportunity_score: Mapped[float] = mapped_column(Float, default=0.0)
    page_views: Mapped[int] = mapped_column(Integer, default=0)
    ad_clicks: Mapped[int] = mapped_column(Integer, default=0)
    revenue_rub: Mapped[float] = mapped_column(Float, default=0.0)
    revenue_rub_today: Mapped[float] = mapped_column(Float, default=0.0)
    estimated_rub_per_day: Mapped[float] = mapped_column(Float, default=100.0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_view_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ScanRun(Base):
    __tablename__ = "scan_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sources_scanned: Mapped[int] = mapped_column(Integer, default=0)
    raw_signals: Mapped[int] = mapped_column(Integer, default=0)
    opportunities_found: Mapped[int] = mapped_column(Integer, default=0)
    reports_generated: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(50), default="running")
    error: Mapped[str] = mapped_column(Text, default="")
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


engine = create_engine(settings.database_url, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def init_db() -> None:
    Base.metadata.create_all(bind=engine)
