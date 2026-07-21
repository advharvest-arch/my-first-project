"""Map real user needs to deployable solution pages."""

from __future__ import annotations

import re
from dataclasses import dataclass

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
    r"\bfrustrated\b",
    r"\bautomate\b",
    r"\btime.?consuming\b",
    r"\bкак (?:сделать|найти|выбрать)\b",
    r"\bнужен\b",
    r"\bищу\b",
    r"\bпомогите\b",
    r"\bне могу найти\b",
    r"\bесть ли\b",
]

TOOL_KEYWORDS = (
    "tool",
    "app",
    "generator",
    "calculator",
    "converter",
    "template",
    "builder",
    "planner",
    "tracker",
    "checker",
    "analyzer",
    "калькулятор",
    "генератор",
    "конвертер",
    "шаблон",
    "планировщик",
)

SOLUTION_RULES: list[tuple[tuple[str, ...], str, str]] = [
    (("invoice", "bill", "receipt", "накладн", "счёт", "счет"), "invoice", "Калькулятор счёта"),
    (("budget", "expense", "spending", "бюджет", "расход", "трат"), "budget", "Планировщик бюджета"),
    (("resume", "cv", "резюме"), "resume", "Конструктор резюме"),
    (("password", "парол"), "password", "Генератор паролей"),
    (("json", "xml", "yaml"), "json", "Форматтер JSON"),
    (("convert", "converter", "unit", "конверт"), "convert", "Конвертер единиц"),
    (("meal", "recipe", "food", "питан", "рецепт", "меню"), "meal", "Планировщик питания"),
    (("tax", "налог"), "tax", "Калькулятор налога"),
    (("invoice", "quote", "estimate", "смет"), "quote", "Калькулятор сметы"),
    (("todo", "checklist", "task", "plan", "чеклист", "задач"), "checklist", "Чеклист задач"),
    (("compare", "review", "best", "vs", "alternative", "сравнен", "лучш"), "compare", "Сравнение вариантов"),
    (("text", "write", "writing", "текст", "письм"), "text", "Текстовый помощник"),
]


@dataclass
class SolutionSpec:
    project_type: str
    tool_mode: str
    display_name: str
    tagline: str


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.lower()).strip()


def has_pain_signal(text: str) -> bool:
    return any(re.search(pattern, text, re.I) for pattern in PAIN_PATTERNS)


def has_tool_intent(text: str) -> bool:
    normalized = _normalize(text)
    return any(keyword in normalized for keyword in TOOL_KEYWORDS)


def is_deployable(
    *,
    pain_point: str,
    niche: str,
    title: str,
    source: str,
    monetization_type: str,
    allow_games: bool = False,
) -> bool:
    if allow_games:
        return True

    combined = _normalize(f"{pain_point} {niche} {title}")

    if has_pain_signal(combined):
        return True
    if has_tool_intent(combined):
        return True
    if monetization_type in ("micro_saas", "freelance"):
        return True

    if source == "google_trends":
        return has_tool_intent(niche) or any(
            keyword in niche for keyword in ("how", "template", "generator", "calculator", "tool")
        )

    return False


def detect_tool_mode(niche: str, pain_point: str) -> tuple[str, str]:
    combined = _normalize(f"{niche} {pain_point}")
    for keywords, mode, label in SOLUTION_RULES:
        if any(keyword in combined for keyword in keywords):
            return mode, label
    return "solver", "Решение задачи"


def build_display_name(pain_point: str, niche: str, tool_label: str) -> str:
    pain = pain_point.strip()
    if pain and not pain.lower().startswith("growing interest") and len(pain) <= 80:
        cleaned = re.sub(r"^(ask hn:|show hn:)\s*", "", pain, flags=re.I).strip()
        if cleaned:
            return cleaned[:80]
    return tool_label if tool_label != "Решение задачи" else niche.title()


def build_solution(
    *,
    niche: str,
    pain_point: str,
    monetization_type: str,
    action_plan: str = "",
) -> SolutionSpec:
    tool_mode, tool_label = detect_tool_mode(niche, pain_point)
    display_name = build_display_name(pain_point, niche, tool_label)

    if tool_mode == "compare" or monetization_type == "affiliate":
        return SolutionSpec(
            project_type="affiliate",
            tool_mode="compare",
            display_name=display_name,
            tagline="Подборка и сравнение лучших вариантов",
        )

    if tool_mode == "checklist" or (
        action_plan and monetization_type in ("freelance", "content_seo", "digital_report")
    ):
        return SolutionSpec(
            project_type="checklist",
            tool_mode="checklist",
            display_name=display_name,
            tagline="Пошаговый план решения вашей задачи",
        )

    if tool_mode in ("text",) or monetization_type == "micro_saas":
        return SolutionSpec(
            project_type="micro_tool",
            tool_mode=tool_mode,
            display_name=display_name,
            tagline="Бесплатный онлайн-инструмент",
        )

    return SolutionSpec(
        project_type="solution",
        tool_mode=tool_mode,
        display_name=display_name,
        tagline="Готовое решение под вашу задачу",
    )


def pick_project_type(niche: str, monetization_type: str, pain_point: str = "", action_plan: str = "") -> str:
    return build_solution(
        niche=niche,
        pain_point=pain_point,
        monetization_type=monetization_type,
        action_plan=action_plan,
    ).project_type
