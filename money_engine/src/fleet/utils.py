import hashlib
import re

from src.fleet.solutions import pick_project_type as _pick_project_type


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:60] or "project"


def pick_project_type(
    niche: str,
    monetization_type: str,
    pain_point: str = "",
    action_plan: str = "",
) -> str:
    return _pick_project_type(niche, monetization_type, pain_point, action_plan)


def theme_color_for(slug: str) -> str:
    digest = hashlib.md5(slug.encode()).hexdigest()
    hue = int(digest[:2], 16) % 360
    return f"hsl({hue}, 65%, 45%)"
