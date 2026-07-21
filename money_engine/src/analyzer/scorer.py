import re
from dataclasses import dataclass

from src.collectors.base import RawSignal, TrendSignal
from src.models import MonetizationType

PAIN_PATTERNS = [
    r"\bhow (?:do|can|to)\b",
    r"\blooking for\b",
    r"\bneed (?:a|an|help|advice)\b",
    r"\bstruggling with\b",
    r"\bany (?:tool|app|solution|recommendation)\b",
    r"\balternative to\b",
    r"\btoo expensive\b",
    r"\bwish there was\b",
    r"\bcan't find\b",
    r"\bproblem with\b",
    r"\bpain point\b",
    r"\bfrustrated\b",
    r"\bmanual(?:ly)?\b",
    r"\bautomate\b",
    r"\btime.?consuming\b",
]

MONEY_PATTERNS = [
    r"\bpay\b",
    r"\$\d+",
    r"\bpricing\b",
    r"\bsubscription\b",
    r"\bmrr\b",
    r"\brevenue\b",
    r"\bmonetize\b",
    r"\baffiliate\b",
    r"\bfreelance\b",
    r"\bclient\b",
    r"\bsell\b",
    r"\bmarket\b",
]

SAAS_KEYWORDS = {"api", "saas", "tool", "software", "app", "platform", "dashboard", "automation"}
AFFILIATE_KEYWORDS = {"best", "review", "compare", "vs", "alternative", "top", "cheap"}
CONTENT_KEYWORDS = {"guide", "tutorial", "how to", "template", "course", "checklist"}
FREELANCE_KEYWORDS = {"hire", "freelancer", "agency", "consulting", "service", "done for you"}


@dataclass
class ScoredOpportunity:
    title: str
    niche: str
    pain_point: str
    source: str
    source_url: str
    demand_score: float
    competition_score: float
    monetization_score: float
    total_score: float
    monetization_type: str
    suggested_price_usd: float
    action_plan: str


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def _count_patterns(text: str, patterns: list[str]) -> int:
    return sum(1 for pattern in patterns if re.search(pattern, text, re.I))


def _extract_niche(title: str, text: str) -> str:
    combined = _normalize(f"{title} {text}")

    how_match = re.search(r"how (?:to|do i|can i)\s+([a-z][a-z\s]{3,40})", combined, re.I)
    if how_match:
        return how_match.group(1).strip()[:60]

    ask_match = re.search(r"(?:ask hn|show hn):\s*(.+)", combined, re.I)
    if ask_match:
        return ask_match.group(1).strip()[:60]

    quoted = re.findall(r'"([^"]{4,50})"', combined)
    if quoted:
        return quoted[0][:60]

    words = re.findall(r"[a-z]{4,}", combined)
    stop = {
        "that", "this", "with", "from", "have", "what", "when", "your", "about",
        "would", "could", "should", "there", "their", "they", "them", "been",
        "just", "like", "some", "into", "more", "than", "also", "need", "want",
        "year", "after", "before", "being", "first", "still", "over", "under",
    }
    filtered = [w for w in words if w not in stop]
    if len(filtered) >= 2:
        return " ".join(filtered[:4])
    if filtered:
        return filtered[0]
    return "general problem"


def _detect_monetization(text: str) -> tuple[str, float]:
    normalized = _normalize(text)
    scores = {
        MonetizationType.MICRO_SAAS: sum(1 for kw in SAAS_KEYWORDS if kw in normalized),
        MonetizationType.AFFILIATE: sum(1 for kw in AFFILIATE_KEYWORDS if kw in normalized),
        MonetizationType.CONTENT_SEO: sum(1 for kw in CONTENT_KEYWORDS if kw in normalized),
        MonetizationType.FREELANCE: sum(1 for kw in FREELANCE_KEYWORDS if kw in normalized),
        MonetizationType.DIGITAL_REPORT: 1,
    }
    best = max(scores, key=scores.get)
    if scores[best] <= 1 and _count_patterns(normalized, PAIN_PATTERNS) >= 2:
        return MonetizationType.MICRO_SAAS.value, 72.0
    return best.value, min(95.0, 55.0 + scores[best] * 8)


def _suggest_price(monetization_type: str, demand: float) -> float:
    base = {
        MonetizationType.MICRO_SAAS.value: 19.0,
        MonetizationType.DIGITAL_REPORT.value: 29.0,
        MonetizationType.AFFILIATE.value: 0.0,
        MonetizationType.FREELANCE.value: 150.0,
        MonetizationType.CONTENT_SEO.value: 9.0,
    }
    multiplier = 1 + (demand / 100) * 0.5
    return round(base.get(monetization_type, 19.0) * multiplier, 2)


def _build_action_plan(monetization_type: str, niche: str, pain: str) -> str:
    plans = {
        MonetizationType.MICRO_SAAS.value: (
            f"1. Validate '{niche}' with a 1-page landing + waitlist.\n"
            f"2. Build MVP solving: {pain[:120]}.\n"
            f"3. Launch on Product Hunt + niche subreddits.\n"
            f"4. Price at $9-29/mo, iterate from first 10 users."
        ),
        MonetizationType.DIGITAL_REPORT.value: (
            f"1. Auto-generate weekly '{niche}' intelligence report.\n"
            f"2. Sell on Gumroad/Stripe at $19-49.\n"
            f"3. Promote via LinkedIn + niche communities.\n"
            f"4. Upsell to monthly subscription."
        ),
        MonetizationType.AFFILIATE.value: (
            f"1. Create comparison content for '{niche}'.\n"
            f"2. Target long-tail SEO keywords.\n"
            f"3. Join affiliate programs (Impact, PartnerStack).\n"
            f"4. Automate content updates weekly."
        ),
        MonetizationType.FREELANCE.value: (
            f"1. Package '{niche}' as fixed-price service.\n"
            f"2. Auto-find leads on Reddit/Upwork.\n"
            f"3. Use templates for proposals.\n"
            f"4. Scale with subcontractors."
        ),
        MonetizationType.CONTENT_SEO.value: (
            f"1. Build SEO hub around '{niche}'.\n"
            f"2. Publish 2 articles/week (automated drafts + review).\n"
            f"3. Monetize via ads + digital products.\n"
            f"4. Compound traffic over 3-6 months."
        ),
    }
    return plans.get(monetization_type, plans[MonetizationType.DIGITAL_REPORT.value])


def score_raw_signal(signal: RawSignal, trend_boost: dict[str, int]) -> ScoredOpportunity | None:
    combined = _normalize(f"{signal.title} {signal.text}")
    pain_hits = _count_patterns(combined, PAIN_PATTERNS)
    money_hits = _count_patterns(combined, MONEY_PATTERNS)

    if pain_hits == 0 and money_hits == 0 and signal.engagement < 20:
        return None

    # Skip pure news headlines without user need signals
    if pain_hits == 0 and money_hits == 0 and not re.search(
        r"\b(tool|app|template|generator|calculator|how to|alternative)\b", combined, re.I
    ):
        return None

    niche = _extract_niche(signal.title, signal.text)
    niche_key = niche.replace(" ", "")

    demand = min(100.0, 35.0 + pain_hits * 18 + min(signal.engagement, 300) / 3)
    demand += trend_boost.get(niche_key, 0) * 0.35
    demand = min(100.0, demand)

    competition = max(15.0, 65.0 - pain_hits * 9 - (12 if money_hits else 0))
    monetization_type, monetization = _detect_monetization(combined)
    monetization = min(100.0, monetization + money_hits * 5)

    total = demand * 0.4 + (100 - competition) * 0.25 + monetization * 0.35
    if total < 45:
        return None

    pain_point = signal.title if pain_hits else f"Growing interest in {niche}"
    price = _suggest_price(monetization_type, demand)

    return ScoredOpportunity(
        title=signal.title[:500],
        niche=niche,
        pain_point=pain_point,
        source=signal.source,
        source_url=signal.url,
        demand_score=round(demand, 1),
        competition_score=round(competition, 1),
        monetization_score=round(monetization, 1),
        total_score=round(total, 1),
        monetization_type=monetization_type,
        suggested_price_usd=price,
        action_plan=_build_action_plan(monetization_type, niche, pain_point),
    )


def score_trend_signal(trend: TrendSignal) -> ScoredOpportunity | None:
    keyword = trend.keyword.lower()
    if not any(
        token in keyword
        for token in (
            "how", "tool", "app", "template", "generator", "calculator",
            "converter", "builder", "planner", "tracker", "resume", "invoice",
            "budget", "tax", "meal", "password",
        )
    ):
        return None

    demand = min(100.0, 40.0 + trend.interest * 0.6 + (15 if trend.rising else 0))
    competition = 55.0 if trend.rising else 45.0
    monetization_type = MonetizationType.CONTENT_SEO.value
    monetization = 68.0 if trend.rising else 60.0
    total = demand * 0.45 + (100 - competition) * 0.2 + monetization * 0.35

    return ScoredOpportunity(
        title=f"Rising demand: {trend.keyword}",
        niche=trend.keyword,
        pain_point=f"Search interest growing for '{trend.keyword}'",
        source="google_trends",
        source_url="https://trends.google.com",
        demand_score=round(demand, 1),
        competition_score=round(competition, 1),
        monetization_score=round(monetization, 1),
        total_score=round(total, 1),
        monetization_type=monetization_type,
        suggested_price_usd=_suggest_price(monetization_type, demand),
        action_plan=_build_action_plan(monetization_type, trend.keyword, trend.keyword),
    )


def analyze_signals(
    raw_signals: list[RawSignal], trend_signals: list[TrendSignal]
) -> list[ScoredOpportunity]:
    trend_boost = {
        t.keyword.replace(" ", ""): t.interest for t in trend_signals
    }

    opportunities: list[ScoredOpportunity] = []
    seen_titles: set[str] = set()

    for signal in raw_signals:
        scored = score_raw_signal(signal, trend_boost)
        if scored and scored.title.lower() not in seen_titles:
            seen_titles.add(scored.title.lower())
            opportunities.append(scored)

    for trend in trend_signals[:15]:
        scored = score_trend_signal(trend)
        if not scored:
            continue
        key = scored.title.lower()
        if key not in seen_titles:
            seen_titles.add(key)
            opportunities.append(scored)

    opportunities.sort(key=lambda item: item.total_score, reverse=True)
    return opportunities[:50]
