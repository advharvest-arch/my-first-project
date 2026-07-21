from dataclasses import dataclass


@dataclass
class FleetDeploySpec:
    slug: str
    name: str
    niche: str
    project_type: str
    opportunity_score: float
    theme_color: str = "#22c55e"
