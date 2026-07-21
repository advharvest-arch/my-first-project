from dataclasses import dataclass, field


@dataclass
class RawSignal:
    title: str
    text: str
    source: str
    url: str = ""
    engagement: int = 0
    tags: list[str] = field(default_factory=list)


@dataclass
class TrendSignal:
    keyword: str
    interest: int
    rising: bool
    related_queries: list[str] = field(default_factory=list)
