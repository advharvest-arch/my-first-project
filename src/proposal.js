/**
 * Генерация коммерческих предложений и рабочих брифов.
 */

export function buildProposal(need, mode, scored, value) {
  const budget = Number(need.budgetEstimate || 0);
  const lang = need.language === "ru" ? "ru" : "en";
  const price = suggestPrice(need, mode, value);
  const timeline = suggestTimeline(mode, scored);

  if (lang === "ru") {
    return {
      headline: commercialHeadlineRu(need, mode),
      price,
      timeline,
      scope: scopeBulletsRu(need, mode),
      message: messageRu(need, mode, price, timeline),
      nextAction: nextActionRu(mode),
    };
  }

  return {
    headline: commercialHeadlineEn(need, mode),
    price,
    timeline,
    scope: scopeBulletsEn(need, mode),
    message: messageEn(need, mode, price, timeline),
    nextAction: nextActionEn(mode),
  };
}

function suggestPrice(need, mode, value) {
  const budget = Number(need.budgetEstimate || 0);
  if (budget > 0) {
    if (mode.id === "service") {
      return {
        amount: Math.round(budget * 0.85),
        currency: "RUB",
        note: "ориентир 85% от бюджета заказчика",
      };
    }
    if (mode.id === "matchmaker") {
      return {
        amount: Math.max(3000, Math.round(budget * 0.1)),
        currency: "RUB",
        note: "комиссия / фикс за передачу лида",
      };
    }
  }
  return {
    amount: value.expected,
    currency: value.currency || "RUB",
    note: "оценка по модели ценности",
  };
}

function suggestTimeline(mode, scored) {
  if (mode.id === "guide") return scored.urgency >= 0.7 ? "сегодня" : "24 часа";
  if (mode.id === "micro_tool") return "2–5 дней";
  if (mode.id === "service") return scored.urgency >= 0.7 ? "48 часов (MVP)" : "3–7 дней";
  return "1–2 дня на подбор";
}

function commercialHeadlineRu(need, mode) {
  const map = {
    guide: `Разбор: ${need.title}`,
    micro_tool: `Инструмент под задачу: ${need.title}`,
    service: `КП: ${need.title}`,
    matchmaker: `Подбор исполнителя: ${need.title}`,
  };
  return map[mode.id] || need.title;
}

function commercialHeadlineEn(need, mode) {
  const map = {
    guide: `Guide: ${need.title}`,
    micro_tool: `Tool for: ${need.title}`,
    service: `Proposal: ${need.title}`,
    matchmaker: `Specialist match: ${need.title}`,
  };
  return map[mode.id] || need.title;
}

function scopeBulletsRu(need, mode) {
  const base = [
    `Исходная потребность: ${need.title}`,
    need.body ? `Контекст: ${need.body.slice(0, 180)}` : null,
    need.budgetEstimate ? `Бюджет в источнике: ~${need.budgetEstimate} ₽` : null,
  ].filter(Boolean);

  const extra = {
    guide: ["Короткий рабочий план", "Чеклист / альтернативы", "CTA на платную помощь"],
    micro_tool: ["MVP под одну боль", "Инструкция запуска", "Путь к платной версии"],
    service: ["Фиксированный scope", "Промежуточный результат", "Критерии приёмки"],
    matchmaker: ["Бриф для исполнителя", "2–3 кандидата", "Сопровождение передачи"],
  };
  return [...base, ...(extra[mode.id] || [])];
}

function scopeBulletsEn(need, mode) {
  const base = [
    `Need: ${need.title}`,
    need.body ? `Context: ${need.body.slice(0, 180)}` : null,
  ].filter(Boolean);
  const extra = {
    guide: ["Actionable steps", "Checklist / options", "CTA for paid help"],
    micro_tool: ["Single-pain MVP", "Run instructions", "Path to paid version"],
    service: ["Fixed scope", "Interim deliverable", "Acceptance criteria"],
    matchmaker: ["Brief for specialist", "2–3 candidates", "Handoff support"],
  };
  return [...base, ...(extra[mode.id] || [])];
}

function messageRu(need, mode, price, timeline) {
  const priceLabel = `${price.amount.toLocaleString("ru-RU")} ₽`;
  if (mode.id === "service") {
    return [
      `Здравствуйте! Готов закрыть задачу «${need.title}».`,
      `Scope: фиксируем результат и критерии приёмки.`,
      `Срок: ${timeline}. Ориентир по цене: ${priceLabel}.`,
      `Если ок — пришлю уточняющие 3 вопроса и стартую.`,
    ].join(" ");
  }
  if (mode.id === "matchmaker") {
    return [
      `Здравствуйте! По задаче «${need.title}» могу подобрать исполнителя.`,
      `Соберу бриф, найду 2–3 варианта и передам контакты.`,
      `Стоимость подбора: ${priceLabel}, срок: ${timeline}.`,
    ].join(" ");
  }
  if (mode.id === "micro_tool") {
    return [
      `Вижу повторяемую боль в «${need.title}».`,
      `Могу собрать простой MVP-инструмент. Срок: ${timeline}, ориентир: ${priceLabel}.`,
      `Напишите ограничения — сделаю прототип.`,
    ].join(" ");
  }
  return [
    `Здравствуйте! По запросу «${need.title}» подготовлю короткий рабочий разбор и чеклист.`,
    `Срок: ${timeline}. Если понадобится сделать под ключ — оценю отдельно.`,
  ].join(" ");
}

function messageEn(need, mode, price, timeline) {
  const priceLabel = `${price.amount} ${price.currency}`;
  if (mode.id === "service") {
    return `Hi! I can take on “${need.title}”. Fixed scope + acceptance criteria. Timeline: ${timeline}. Price ballpark: ${priceLabel}. If that works, I’ll send 3 clarifying questions and start.`;
  }
  if (mode.id === "matchmaker") {
    return `Hi! For “${need.title}” I can prepare a brief and match 2–3 specialists. Matching fee: ${priceLabel}. Turnaround: ${timeline}.`;
  }
  if (mode.id === "micro_tool") {
    return `Looks like a repeatable pain in “${need.title}”. I can ship a small MVP tool. Timeline: ${timeline}. Ballpark: ${priceLabel}. Share constraints and I’ll prototype.`;
  }
  return `Hi — for “${need.title}” I can share a concise actionable breakdown + checklist. Timeline: ${timeline}. Happy to quote a done-for-you option if needed.`;
}

function nextActionRu(mode) {
  const map = {
    guide: "Написать и опубликовать ответ по ссылке источника",
    micro_tool: "Собрать MVP и отправить автору демо-ссылку",
    service: "Отправить КП на площадке / в личку и зафиксировать предоплату",
    matchmaker: "Собрать бриф и разослать 2–3 исполнителям",
  };
  return map[mode.id] || "Связаться с автором потребности";
}

function nextActionEn(mode) {
  const map = {
    guide: "Write and post the answer on the source thread",
    micro_tool: "Build MVP and send a demo link to the author",
    service: "Send the proposal and lock a deposit",
    matchmaker: "Write a brief and contact 2–3 specialists",
  };
  return map[mode.id] || "Contact the need author";
}
