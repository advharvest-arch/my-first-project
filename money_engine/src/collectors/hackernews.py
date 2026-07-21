import httpx

from src.collectors.base import RawSignal


async def fetch_hackernews_signals(limit: int = 40) -> list[RawSignal]:
    signals: list[RawSignal] = []

    async with httpx.AsyncClient(timeout=20.0) as client:
        try:
            top_ids = await client.get(
                "https://hacker-news.firebaseio.com/v0/topstories.json"
            )
            top_ids.raise_for_status()
            story_ids = top_ids.json()[:limit]
        except Exception:
            return signals

        for story_id in story_ids:
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

            signals.append(
                RawSignal(
                    title=title,
                    text=(item.get("text") or "")[:2000],
                    source="hackernews",
                    url=item.get("url") or f"https://news.ycombinator.com/item?id={story_id}",
                    engagement=int(item.get("score", 0) + item.get("descendants", 0)),
                    tags=["tech", "startup"],
                )
            )

    return signals
