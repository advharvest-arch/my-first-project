import hashlib
import re


def slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return slug[:60] or "project"


def pick_project_type(niche: str, monetization_type: str) -> str:
    normalized = niche.lower()
    if any(kw in normalized for kw in ("tool", "app", "generator", "calculator", "converter")):
        return "micro_tool"
    if monetization_type in ("affiliate",) or any(
        kw in normalized for kw in ("best", "review", "cheap", "buy", "deal")
    ):
        return "affiliate"
    if any(kw in normalized for kw in ("game", "play", "coin", "tap", "click")):
        return "reward_game"
    # Default: ad-monetized mini game — best time-on-site for ad revenue
    return "ad_game"


def theme_color_for(slug: str) -> str:
    digest = hashlib.md5(slug.encode()).hexdigest()
    hue = int(digest[:2], 16) % 360
    return f"hsl({hue}, 65%, 45%)"
