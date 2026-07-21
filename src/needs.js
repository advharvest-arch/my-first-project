/**
 * Анализ потребностей и план их удовлетворения.
 *
 * Идея: насущная потребность → способ закрыть боль → способ заработать
 * на полезном решении (не на обмане).
 */

import { buildProposal } from "./proposal.js";

export const FULFILL_MODES = {
  guide: {
    id: "guide",
    name: "Полезный гайд / ответ",
    description: "Закрыть потребность контентом: пошаговый ответ, чеклист, сравнение",
    baseValue: 1500,
  },
  micro_tool: {
    id: "micro_tool",
    name: "Микро-инструмент / шаблон",
    description: "Собрать простой инструмент, шаблон или скрипт и предложить его",
    baseValue: 12000,
  },
  service: {
    id: "service",
    name: "Сделать под ключ",
    description: "Предложить услугу: сделать за человека то, что он не может сам",
    baseValue: 35000,
  },
  matchmaker: {
    id: "matchmaker",
    name: "Свести с исполнителем",
    description: "Если сами не делаем — передать лид специалисту за комиссию",
    baseValue: 5000,
  },
};

const CATEGORY_RULES = [
  {
    id: "dev_tooling",
    label: "Разработка / инструменты",
    re: /\b(api|code|app|tool|script|github|library|framework|database|deploy|cli|бот|скрипт|код|программ|api)\b/i,
  },
  {
    id: "business",
    label: "Бизнес / продажи",
    re: /\b(business|startup|customer|sales|marketing|crm|invoice|pricing|клиент|продаж|маркет|бизнес|стартап)\b/i,
  },
  {
    id: "career",
    label: "Карьера / обучение",
    re: /\b(job|career|learn|course|interview|resume|работ|карьер|обуч|курс|собесед)\b/i,
  },
  {
    id: "ops_infra",
    label: "Инфра / DevOps",
    re: /\b(server|docker|kubernetes|aws|ci\/cd|nginx|hosting|сервер|хостинг|деплой)\b/i,
  },
  {
    id: "web_design",
    label: "Сайты / дизайн",
    re: /\b(сайт|лендинг|landing|website|wordpress|bitrix|битрикс|вёрстк|верстк|дизайн|ui|ux)\b/i,
  },
  {
    id: "design_build",
    label: "Стройка / проектирование",
    re: /\b(build|house|frame|construction|architect|каркас|строит|проект|чертёж|чертеж|металл|апс|соуэ|план дома)\b/i,
  },
  {
    id: "life_admin",
    label: "Быт / админ",
    re: /\b(password|bookmark|file|organize|automate|password|файл|парол|автоматиз|закладк)\b/i,
  },
];

const URGENCY_HINTS =
  /\b(urgent|asap|struggling|broken|failing|stuck|deadline|сейчас|срочно|не работает|не могу|застрял|горит)\b/i;

/**
 * Эвристическая оценка «насущности» потребности.
 */
export function scoreNeed(need, config = {}) {
  const text = `${need.title || ""} ${need.body || ""}`;
  const engagement = Number(need.engagement || 0);
  const engScore = Math.min(1, Math.log10(engagement + 1) / 2.2);
  const urgency = URGENCY_HINTS.test(text) ? 0.85 : 0.45 + engScore * 0.2;
  const clarity = Math.min(1, (need.title || "").length / 60);
  const actionable = /\b(how|tool|recommend|looking for|need|как|нужен|ищу|подсказ)\b/i.test(text)
    ? 0.8
    : 0.45;

  // свежесть: запросы за последние 14 дней важнее архивной боли
  let freshness = 0.45;
  if (need.createdAt) {
    const ageDays = (Date.now() - new Date(need.createdAt).getTime()) / 86400000;
    if (ageDays <= 3) freshness = 1;
    else if (ageDays <= 14) freshness = 0.85;
    else if (ageDays <= 60) freshness = 0.6;
    else freshness = 0.3;
  }

  const category = categorize(text);
  const nicheBoost =
    config.preferNiche && category.id === "design_build"
      ? 1.15
      : category.id === "dev_tooling" || category.id === "business"
        ? 1.08
        : 1;

  // FL.ru / платный заказ = сильный сигнал реальной потребности
  const sourceBoost =
    need.sourceId === "flru"
      ? 1.25
      : need.sourceId === "hackernews"
        ? 1.12
        : 1;

  const budget = Number(need.budgetEstimate || 0);
  const budgetScore = budget > 0 ? Math.min(1, Math.log10(Math.max(budget, 1000)) / 5.5) : 0;

  const raw =
    (0.24 * urgency +
      0.18 * engScore +
      0.16 * actionable +
      0.1 * clarity +
      0.18 * freshness +
      0.14 * budgetScore) *
    nicheBoost *
    sourceBoost;
  const score = Math.round(Math.min(100, raw * 100));
  const minScore = config.minNeedScore ?? 48;

  return {
    score,
    pass: score >= minScore,
    urgency: Math.round(urgency * 100) / 100,
    category,
    rationale: [
      category.label,
      need.sourceId === "flru" ? "платный заказ" : null,
      budget ? `бюджет ~${budget}` : null,
      urgency >= 0.7 ? "высокая срочность" : "обычная срочность",
      freshness >= 0.85 ? "свежий запрос" : freshness <= 0.35 ? "старый запрос" : "средняя свежесть",
      `вовлечённость ${Math.round(engagement)}`,
      `score ${score}/100`,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

export function categorize(text) {
  for (const rule of CATEGORY_RULES) {
    if (rule.re.test(text)) return { id: rule.id, label: rule.label };
  }
  return { id: "general", label: "Общий запрос" };
}

/** Выбор способа удовлетворить потребность */
export function chooseFulfillment(need, scored) {
  const text = `${need.title} ${need.body || ""}`;
  const cat = scored.category.id;
  const budget = Number(need.budgetEstimate || 0);

  const wantsTool =
    /\b(looking for (a )?(tool|app|library|service|script)|is there (a|an) (tool|app|way|library)|ищу (сервис|инструмент|программ|скрипт))\b/i.test(
      text
    );
  const wantsHire =
    /\b(hire|freelancer|paid|budget|сделать|под ключ|нужен (специалист|подрядчик|разработчик)|looking for (a )?(dev|developer|designer|freelancer)|требуется|зака[зж])\b/i.test(
      text
    );
  const isOpinion =
    /\b(what do you think|opinions?|worth(while)?|should I|почему|стоит ли|как вы считаете|wrong|dystopian)\b/i.test(
      text
    );

  // Платные заказы с бирж — почти всегда услуга или matchmaker
  if (need.monetizable || need.sourceId === "flru") {
    if (budget >= 15000 || scored.score >= 65) return FULFILL_MODES.service;
    return FULFILL_MODES.matchmaker;
  }

  if (wantsTool) return FULFILL_MODES.micro_tool;
  if (wantsHire || cat === "design_build") {
    return scored.score >= 70 ? FULFILL_MODES.service : FULFILL_MODES.matchmaker;
  }
  if (isOpinion) return FULFILL_MODES.guide;
  if (cat === "dev_tooling" && scored.urgency >= 0.7 && /\b(how|fix|error|fail|не работает|ошибк)\b/i.test(text)) {
    return FULFILL_MODES.service;
  }
  if (scored.score >= 78 && engagementHigh(need) && cat === "dev_tooling") {
    return FULFILL_MODES.micro_tool;
  }
  return FULFILL_MODES.guide;
}

function engagementHigh(need) {
  return Number(need.engagement || 0) >= 15;
}

export function estimateFulfillmentValue(need, mode, scored) {
  const budget = Number(need.budgetEstimate || 0);
  if (budget > 0 && (mode.id === "service" || mode.id === "matchmaker")) {
    const rate = mode.id === "service" ? 0.55 : 0.12;
    const closeProb = mode.id === "service" ? 0.22 : 0.35;
    return {
      expected: Math.round(budget * rate * closeProb * (0.8 + scored.score / 200)),
      currency: "RUB",
      unit: mode.name,
      closeProb,
    };
  }

  const mult = 0.7 + scored.score / 100;
  const eng = 1 + Math.min(1.5, Math.log10(Number(need.engagement || 1) + 1) / 2);
  const expected = Math.round(mode.baseValue * mult * eng);
  return {
    expected,
    currency: "RUB",
    unit: mode.name,
    closeProb: mode.id === "guide" ? 0.35 : mode.id === "matchmaker" ? 0.4 : 0.25,
  };
}

/** Конкретный план: как удовлетворить эту потребность */
export function planFulfillment(need, scored, mode, value) {
  const stepsByMode = {
    guide: [
      "Сформулировать проблему одним предложением",
      "Собрать 3–5 рабочих шагов / альтернатив",
      "Опубликовать ответ по ссылке источника + короткую версию у себя",
      "Добавить CTA: шаблон / консультация / инструмент",
    ],
    micro_tool: [
      "Выделить повторяемую боль из формулировки",
      "Сделать MVP (скрипт, таблица, чеклист, лендинг)",
      "Ответить автору с бесплатным куском + платной полной версией",
      "Упаковать в продукт для похожих запросов",
    ],
    service: [
      "Уточнить scope и дедлайн одним сообщением",
      "Предложить фикс-цену и срок",
      "Сделать минимальный результат за 48ч",
      "Запросить кейс/отзыв и апселл сопровождения",
    ],
    matchmaker: [
      "Зафиксировать бриф потребности",
      "Найти 2–3 исполнителей в нише",
      "Передать лид за комиссию / фикс",
      "Проконтролировать закрытие и собрать feedback",
    ],
  };

  const replyDraft = buildReplyDraft(need, mode);
  const proposal = buildProposal(need, mode, scored, value);

  return {
    id: `ful_${need.id}_${Date.now().toString(36)}`,
    needId: need.id,
    modeId: mode.id,
    title: need.title,
    needSummary: summarizeNeed(need),
    category: scored.category,
    score: scored.score,
    urgency: scored.urgency,
    sourceUrl: need.url,
    sourceLabel: need.sourceLabel,
    language: need.language,
    steps: stepsByMode[mode.id],
    replyDraft: proposal.message || replyDraft,
    proposal,
    status: "ready", // ready → approved → fulfilled
    expectedRevenue: value.expected,
    currency: value.currency,
    rationale: scored.rationale,
    createdAt: new Date().toISOString(),
  };
}

function summarizeNeed(need) {
  const body = (need.body || "").trim();
  if (!body) return need.title;
  return `${need.title} — ${body.slice(0, 160)}${body.length > 160 ? "…" : ""}`;
}

function buildReplyDraft(need, mode) {
  const lang = need.language === "ru" ? "ru" : "en";
  if (lang === "ru") {
    const map = {
      guide: `Здравствуйте! Вижу задачу: «${need.title}». Могу дать короткий рабочий план и чеклист, который уже помогал в похожих случаях. Если нужно — разверну в пошаговый гайд под ваш контекст.`,
      micro_tool: `Похоже, вам нужен готовый инструмент под «${need.title}». Могу собрать простой MVP (скрипт/шаблон) и отдать первую рабочую версию быстро. Напишите ограничения — сделаю прототип.`,
      service: `Могу взять «${need.title}» под ключ: зафиксируем scope, срок и цену, первый результат — в течение 48 часов. Готовы обсудить детали?`,
      matchmaker: `Если нужно срочно закрыть «${need.title}», могу подобрать проверенного исполнителя под задачу и сопроводить передачу брифа.`,
    };
    return map[mode.id];
  }
  const map = {
    guide: `Hi — saw your ask: “${need.title}”. I can share a concrete step-by-step approach that works for similar cases, plus a short checklist. Want me to tailor it to your setup?`,
    micro_tool: `It looks like you need a small tool for “${need.title}”. I can ship a minimal working MVP (script/template) quickly. Tell me constraints and I’ll prototype.`,
    service: `I can take on “${need.title}” end-to-end: clear scope, fixed price, first useful result within 48h. Open to a quick brief?`,
    matchmaker: `If you need “${need.title}” handled ASAP, I can match you with a specialist and help hand off a clean brief.`,
  };
  return map[mode.id];
}
