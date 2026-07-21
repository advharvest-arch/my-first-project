from pytrends.request import TrendReq

from src.collectors.base import TrendSignal

SEED_KEYWORDS = [
    "invoice generator",
    "resume builder",
    "budget calculator",
    "meal planner",
    "password generator",
    "json formatter",
    "tax calculator",
    "unit converter",
    "project management tool",
    "time tracker app",
    "expense tracker",
    "habit tracker",
    "todo list app",
    "pdf converter",
    "image compressor",
    "qr code generator",
    "mortgage calculator",
    "calorie calculator",
    "pomodoro timer",
    "note taking app",
]


def fetch_trend_signals() -> list[TrendSignal]:
    signals: list[TrendSignal] = []

    try:
        pytrends = TrendReq(hl="en-US", tz=360)
        pytrends.build_payload(SEED_KEYWORDS[:5], timeframe="today 3-m")
        related = pytrends.related_queries()

        for keyword, data in related.items():
            rising_df = data.get("rising")
            if rising_df is None or rising_df.empty:
                continue

            for _, row in rising_df.head(5).iterrows():
                query = str(row.get("query", "")).strip()
                if not query:
                    continue
                signals.append(
                    TrendSignal(
                        keyword=query,
                        interest=int(row.get("value", 0) or 0),
                        rising=True,
                        related_queries=[keyword],
                    )
                )
    except Exception:
        pass

    if not signals:
        for keyword in SEED_KEYWORDS:
            signals.append(
                TrendSignal(
                    keyword=keyword,
                    interest=50,
                    rising=False,
                    related_queries=[],
                )
            )

    return signals
