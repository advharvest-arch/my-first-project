from src.collectors.base import RawSignal, TrendSignal
from src.collectors.hackernews import fetch_hackernews_signals
from src.collectors.reddit import fetch_reddit_signals
from src.collectors.trends import fetch_trend_signals


async def collect_all_signals() -> tuple[list[RawSignal], list[TrendSignal]]:
    reddit = await fetch_reddit_signals()
    hn = await fetch_hackernews_signals()
    trends = fetch_trend_signals()
    return reddit + hn, trends
