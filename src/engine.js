/**
 * AdvHarvest Autopilot — ядро системы автозаработка
 *
 * Цикл денег:
 *   Scout → Score → Package → Monetize → Learn
 *
 * Модель дохода (легальная):
 * 1) Продажа квалифицированных лидов подрядчикам/бюро
 * 2) Комиссия с закрытых сделок (rev-share)
 * 3) Контент + партка услуг (SEO → заявки)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DATA = join(ROOT, "data");

function ensureData() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
}

export function loadJson(name, fallback) {
  ensureData();
  const path = join(DATA, name);
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(fallback, null, 2), "utf8");
    return structuredClone(fallback);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJson(name, value) {
  ensureData();
  writeFileSync(join(DATA, name), JSON.stringify(value, null, 2), "utf8");
}

/** Источники сигналов спроса (в проде — API тендеров, Avito, ЦИАН, RSS) */
export const SIGNAL_SOURCES = [
  { id: "tenders", name: "Госзакупки / тендеры", weight: 1.4 },
  { id: "classifieds", name: "Объявления (ремонт/стройка)", weight: 1.1 },
  { id: "seo_intent", name: "Поисковый спрос (SEO)", weight: 1.0 },
  { id: "partners", name: "Партнёрские входящие", weight: 1.3 },
];

/** Каналы монетизации */
export const MONETIZE_CHANNELS = {
  lead_sale: {
    id: "lead_sale",
    name: "Продажа лида",
    description: "Продаём квалифицированную заявку подрядчику/бюро",
    basePrice: 3500,
  },
  rev_share: {
    id: "rev_share",
    name: "Комиссия со сделки",
    description: "5–12% от закрытого контракта",
    rate: 0.07,
  },
  own_service: {
    id: "own_service",
    name: "Своя услуга",
    description: "КП / проектирование / каркас — прямая продажа",
    avgTicket: 180000,
  },
  content_ads: {
    id: "content_ads",
    name: "Контент + реклама",
    description: "SEO-статья → трафик → заявки / CPA",
    cpa: 800,
  },
};

/**
 * Оценка коммерческого потенциала сигнала.
 * Чем выше score — тем приоритетнее обработка.
 */
export function scoreSignal(signal, config = {}) {
  const budget = Number(signal.budgetEstimate || 0);
  const urgency = Number(signal.urgency || 0.5); // 0..1
  const fit = Number(signal.nicheFit || 0.5); // 0..1
  const competition = Number(signal.competition || 0.5); // 0..1 (ниже лучше)
  const source = SIGNAL_SOURCES.find((s) => s.id === signal.sourceId);
  const sourceWeight = source?.weight ?? 1;

  const budgetScore = Math.min(1, Math.log10(Math.max(budget, 10_000)) / 6);
  const raw =
    (0.35 * budgetScore +
      0.25 * urgency +
      0.25 * fit +
      0.15 * (1 - competition)) *
    sourceWeight;

  const score = Math.round(Math.min(100, raw * 100));
  const minScore = config.minScore ?? 55;

  return {
    score,
    pass: score >= minScore,
    rationale: buildRationale({ budget, urgency, fit, competition, score, source }),
  };
}

function buildRationale({ budget, urgency, fit, competition, score, source }) {
  const bits = [];
  if (budget >= 500_000) bits.push("крупный бюджет");
  else if (budget >= 100_000) bits.push("средний бюджет");
  else bits.push("малый бюджет");
  if (urgency >= 0.7) bits.push("высокая срочность");
  if (fit >= 0.7) bits.push("сильный fit ниши");
  if (competition <= 0.3) bits.push("низкая конкуренция");
  if (source) bits.push(`источник: ${source.name}`);
  bits.push(`score ${score}/100`);
  return bits.join(" · ");
}

/** Выбор оптимального канала монетизации */
export function chooseChannel(signal, scored) {
  const budget = Number(signal.budgetEstimate || 0);

  if (signal.preferOwnService && scored.score >= 70 && budget >= 80_000) {
    return MONETIZE_CHANNELS.own_service;
  }
  if (budget >= 1_000_000 && scored.score >= 75) {
    return MONETIZE_CHANNELS.rev_share;
  }
  if (signal.sourceId === "seo_intent") {
    return MONETIZE_CHANNELS.content_ads;
  }
  return MONETIZE_CHANNELS.lead_sale;
}

/** Оценка ожидаемой выручки по каналу */
export function estimateRevenue(signal, channel) {
  const budget = Number(signal.budgetEstimate || 0);
  const closeProb = Math.min(0.45, 0.12 + Number(signal.nicheFit || 0.5) * 0.25);

  switch (channel.id) {
    case "lead_sale": {
      const price = Math.round(
        channel.basePrice * (0.8 + Math.min(budget / 1_000_000, 1.5))
      );
      return { expected: price, currency: "RUB", closeProb: 0.55, unit: "продажа лида" };
    }
    case "rev_share": {
      const expected = Math.round(budget * channel.rate * closeProb);
      return { expected, currency: "RUB", closeProb, unit: "комиссия" };
    }
    case "own_service": {
      const ticket = Math.min(channel.avgTicket, budget * 0.4 || channel.avgTicket);
      const expected = Math.round(ticket * closeProb);
      return { expected, currency: "RUB", closeProb, unit: "своя услуга" };
    }
    case "content_ads": {
      const expected = channel.cpa;
      return { expected, currency: "RUB", closeProb: 0.3, unit: "CPA/статья" };
    }
    default:
      return { expected: 0, currency: "RUB", closeProb: 0, unit: "—" };
  }
}

/** Упаковка оффера / КП / контента */
export function packageOffer(signal, channel, revenue) {
  const title =
    channel.id === "content_ads"
      ? `SEO: ${signal.title}`
      : `Оффер: ${signal.title}`;

  const pitch = {
    lead_sale: `Квалифицированный лид: ${signal.city || "РФ"}, бюджет ~${formatMoney(
      signal.budgetEstimate
    )}. Клиент ищет: ${signal.need}. Готовы передать контакты после предоплаты.`,
    rev_share: `Партнёрство: приводим клиента на проект «${signal.title}». Комиссия ${(
      MONETIZE_CHANNELS.rev_share.rate * 100
    ).toFixed(0)}% от контракта при закрытии.`,
    own_service: `Коммерческое предложение по «${signal.title}». Объём: ${signal.need}. Срок ответа 24ч. Ориентир бюджета: ${formatMoney(
      signal.budgetEstimate
    )}.`,
    content_ads: `Статья под запрос «${signal.keywords || signal.title}» → CTA на заявку. Цель: ${formatMoney(
      revenue.expected
    )} CPA.`,
  };

  return {
    id: `pkg_${signal.id}_${Date.now().toString(36)}`,
    signalId: signal.id,
    channelId: channel.id,
    title,
    pitch: pitch[channel.id] || pitch.lead_sale,
    status: "ready",
    expectedRevenue: revenue.expected,
    currency: revenue.currency,
    createdAt: new Date().toISOString(),
  };
}

export function formatMoney(n) {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}

/**
 * Один полный цикл автопилота по списку сигналов.
 * Human-in-the-loop: офферы создаются со статусом ready,
 * «отправка» клиенту — только после approve.
 */
export function runCycle(signals, options = {}) {
  const state = loadJson("state.json", defaultState());
  const config = { ...state.config, ...options };
  const results = [];
  let expectedTotal = 0;

  for (const signal of signals) {
    if (state.processedSignalIds.includes(signal.id)) continue;

    const scored = scoreSignal(signal, config);
    if (!scored.pass) {
      results.push({
        signalId: signal.id,
        action: "skip",
        score: scored.score,
        rationale: scored.rationale,
      });
      state.processedSignalIds.push(signal.id);
      continue;
    }

    const channel = chooseChannel(signal, scored);
    const revenue = estimateRevenue(signal, channel);
    const offer = packageOffer(signal, channel, revenue);

    state.offers.push(offer);
    state.ledger.push({
      id: `led_${offer.id}`,
      offerId: offer.id,
      type: "expected",
      amount: revenue.expected,
      currency: "RUB",
      channelId: channel.id,
      at: new Date().toISOString(),
      note: scored.rationale,
    });

    expectedTotal += revenue.expected;
    state.processedSignalIds.push(signal.id);

    results.push({
      signalId: signal.id,
      action: "package",
      score: scored.score,
      channel: channel.id,
      expectedRevenue: revenue.expected,
      offerId: offer.id,
      rationale: scored.rationale,
    });
  }

  state.stats.cycles += 1;
  state.stats.lastCycleAt = new Date().toISOString();
  state.stats.expectedRevenueTotal = state.ledger
    .filter((l) => l.type === "expected")
    .reduce((s, l) => s + l.amount, 0);
  state.stats.realizedRevenueTotal = state.ledger
    .filter((l) => l.type === "realized")
    .reduce((s, l) => s + l.amount, 0);

  saveJson("state.json", state);

  return {
    processed: results.length,
    packaged: results.filter((r) => r.action === "package").length,
    skipped: results.filter((r) => r.action === "skip").length,
    expectedThisCycle: expectedTotal,
    results,
    state,
  };
}

export function approveOffer(offerId) {
  const state = loadJson("state.json", defaultState());
  const offer = state.offers.find((o) => o.id === offerId);
  if (!offer) throw new Error(`Оффер не найден: ${offerId}`);
  if (offer.status !== "ready") throw new Error(`Оффер уже в статусе ${offer.status}`);

  offer.status = "approved";
  offer.approvedAt = new Date().toISOString();
  saveJson("state.json", state);
  return offer;
}

/** Симуляция закрытия сделки (в проде — вебхук CRM / платёжки) */
export function realizeOffer(offerId, amount) {
  const state = loadJson("state.json", defaultState());
  const offer = state.offers.find((o) => o.id === offerId);
  if (!offer) throw new Error(`Оффер не найден: ${offerId}`);

  const realized = Number(amount ?? offer.expectedRevenue);
  offer.status = "realized";
  offer.realizedAt = new Date().toISOString();
  offer.realizedAmount = realized;

  state.ledger.push({
    id: `led_real_${offer.id}`,
    offerId: offer.id,
    type: "realized",
    amount: realized,
    currency: "RUB",
    channelId: offer.channelId,
    at: new Date().toISOString(),
    note: "Закрытие сделки",
  });

  state.stats.realizedRevenueTotal = state.ledger
    .filter((l) => l.type === "realized")
    .reduce((s, l) => s + l.amount, 0);

  // Learn: подкручиваем порог, если конверсия хорошая
  const realizedCount = state.offers.filter((o) => o.status === "realized").length;
  const approvedCount = state.offers.filter((o) =>
    ["approved", "realized"].includes(o.status)
  ).length;
  if (approvedCount >= 3) {
    const rate = realizedCount / approvedCount;
    if (rate >= 0.4) state.config.minScore = Math.max(45, state.config.minScore - 2);
    if (rate < 0.2) state.config.minScore = Math.min(80, state.config.minScore + 3);
  }

  saveJson("state.json", state);
  return { offer, realized };
}

export function defaultState() {
  return {
    config: {
      minScore: 55,
      niche: "строительство / каркасы / проектирование",
      currency: "RUB",
    },
    processedSignalIds: [],
    offers: [],
    ledger: [],
    stats: {
      cycles: 0,
      lastCycleAt: null,
      expectedRevenueTotal: 0,
      realizedRevenueTotal: 0,
    },
  };
}

export function getDashboard() {
  const state = loadJson("state.json", defaultState());
  const signals = loadJson("signals.json", []);
  return {
    niche: state.config.niche,
    stats: state.stats,
    config: state.config,
    offers: state.offers.slice().reverse(),
    ledger: state.ledger.slice().reverse(),
    signals,
    channels: Object.values(MONETIZE_CHANNELS),
    sources: SIGNAL_SOURCES,
  };
}

export function resetState() {
  saveJson("state.json", defaultState());
  return defaultState();
}
