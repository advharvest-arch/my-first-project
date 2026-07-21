import re
from datetime import datetime
from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from config import LANDINGS_DIR, REPORTS_DIR
from src.analyzer.scorer import ScoredOpportunity

TEMPLATES_DIR = Path(__file__).resolve().parent.parent.parent / "templates"
env = Environment(
    loader=FileSystemLoader(str(TEMPLATES_DIR)),
    autoescape=select_autoescape(["html", "xml"]),
)


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:80] or "opportunity"


def generate_report(opportunity: ScoredOpportunity) -> str:
    slug = _slugify(opportunity.niche)
    report_path = REPORTS_DIR / f"{slug}.md"
    template = env.get_template("report.md.j2")

    content = template.render(
        opportunity=opportunity,
        generated_at=datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
    )
    report_path.write_text(content, encoding="utf-8")
    return str(report_path)


def generate_landing_page(opportunity: ScoredOpportunity, payment_link: str = "") -> str:
    slug = _slugify(opportunity.niche)
    landing_path = LANDINGS_DIR / f"{slug}.html"
    template = env.get_template("landing.html.j2")

    content = template.render(
        opportunity=opportunity,
        payment_link=payment_link,
        generated_at=datetime.utcnow().strftime("%Y-%m-%d"),
    )
    landing_path.write_text(content, encoding="utf-8")
    return str(landing_path)
