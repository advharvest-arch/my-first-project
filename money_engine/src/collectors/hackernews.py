import httpx

from src.collectors.base import RawSignal

PAIN_TITLE_PATTERNS = (
    "ask hn",
    "how do",
    "how to",
    "how can",
    "looking for",
    "need a",
    "need an",
    "any tool",
    "any app",
    "alternative to",
    "recommend",
    "best way",
    "struggling",
)


async def fetch_hackernews_signals(limit: int = 40) -> list[RawSignal]:
    signals: list[RawSignal] = []

    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            top_ids = await client.get(
                "https://hacker-news.firebaseio.com/v0/askstories.json"
            )
            top_ids.raise_for_status()
            story_ids = top_ids.json()[:limit]
        except Exception:
            story_ids = []

        if len(story_ids) < limit // 2:
            try:
                top_resp = await client.get(
                    "https://hacker-news.firebaseio.com/v0/topstories.json"
                )
                top_resp.raise_for_status()
                story_ids = list(dict.fromkeys(story_ids + top_resp.json()[:limit]))
            except Exception:
                return signals

        for story_id in story_ids[:limit]:
            try:
                item_resp = await client.get(
                    f"https://hacker-news.firebaseio.com/v0/item/{story_id}.json"
                )
                item_resp.raise_for_status()
                item = item_resp.json()
            except Exception:
                continue

            title = (item or {}).get("title", "").strip()
            if not title:
                continue

            title_lower = title.lower()
            text = (item.get("text") or "")[:2000]
            combined = f"{title_lower} {text.lower()}"
            is_ask = title_lower.startswith("ask hn")
            has_pain = any(pattern in combined for pattern in PAIN_TITLE_PATTERNS)
            if not is_ask and not has_pain:
                continue

            signals.append(
                RawSignal(
                    title=title,
                    text=text,
                    source="hackernews",
                    url=item.get("url") or f"https://news.ycombinator.com/item?id={story_id}",
                    engagement=int(item.get("score", 0) + item.get("descendants", 0)),
                    tags=["tech", "user_need"],
                )
            )

    return signals
