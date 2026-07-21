import xml.etree.ElementTree as ET

import httpx

from src.collectors.base import RawSignal

HEADERS = {
    "User-Agent": "MoneyEngine/1.0 (niche research; +https://github.com)"
}

SUBREDDITS = [
    "Entrepreneur",
    "SaaS",
    "smallbusiness",
    "startups",
    "freelance",
    "productivity",
    "personalfinance",
    "LifeProTips",
    "sysadmin",
    "excel",
    "Notion",
    "learnprogramming",
    "webdev",
    "marketing",
    "AskProgramming",
]


async def _fetch_rss(client: httpx.AsyncClient, subreddit: str, limit: int) -> list[RawSignal]:
    signals: list[RawSignal] = []
    url = f"https://www.reddit.com/r/{subreddit}/new.rss?limit={limit}"
    try:
        response = await client.get(url, headers=HEADERS, follow_redirects=True)
        response.raise_for_status()
        root = ET.fromstring(response.content)
        ns = {"atom": "http://www.w3.org/2005/Atom"}
        for entry in root.findall("atom:entry", ns)[:limit]:
            title = (entry.findtext("atom:title", default="", namespaces=ns) or "").strip()
            link_el = entry.find("atom:link", ns)
            link = link_el.get("href", "") if link_el is not None else ""
            content = (entry.findtext("atom:content", default="", namespaces=ns) or "").strip()
            if not title:
                continue
            signals.append(
                RawSignal(
                    title=title,
                    text=content[:2000],
                    source=f"reddit/r/{subreddit}",
                    url=link,
                    engagement=30,
                    tags=[subreddit, "community_pain"],
                )
            )
    except Exception:
        pass
    return signals


async def fetch_reddit_signals(limit_per_sub: int = 8) -> list[RawSignal]:
    signals: list[RawSignal] = []

    async with httpx.AsyncClient(timeout=20.0) as client:
        for subreddit in SUBREDDITS:
            rss_signals = await _fetch_rss(client, subreddit, limit_per_sub)
            signals.extend(rss_signals)

    return signals
