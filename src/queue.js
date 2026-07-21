/**
 * Фильтры качества потребностей + рабочая очередь.
 */

const SPAM_RE =
  /(оставить отзыв|накрутка|голосование|лайки|подписчик|crypto pump|airdrop|onlyfans)/i;

export function isSpamNeed(need) {
  const text = `${need.title || ""} ${need.body || ""}`;
  if (SPAM_RE.test(text)) return true;
  // совсем копеечные «заказы» на биржах
  if (need.sourceId === "flru" && Number(need.budgetEstimate || 0) > 0 && need.budgetEstimate < 500) {
    return true;
  }
  return false;
}

export function passesQualityGates(need, config = {}) {
  if (isSpamNeed(need)) return { ok: false, reason: "spam_or_too_cheap" };
  const minBudget = Number(config.minPaidBudget ?? 1000);
  if (config.paidOnly && !need.monetizable && need.sourceId !== "flru") {
    return { ok: false, reason: "paid_only" };
  }
  if (
    (need.monetizable || need.sourceId === "flru") &&
    Number(need.budgetEstimate || 0) > 0 &&
    need.budgetEstimate < minBudget
  ) {
    return { ok: false, reason: "below_min_budget" };
  }
  return { ok: true };
}

/**
 * Очередь работы: что делать прямо сейчас.
 * Сортировка: approved → ready, затем ценность / score, платные выше.
 */
export function buildWorkQueue(state, { limit = 20 } = {}) {
  const needsById = Object.fromEntries((state.needs || []).map((n) => [n.id, n]));
  const items = (state.fulfillments || [])
    .filter((f) => f.status === "ready" || f.status === "approved")
    .map((f) => {
      const need = needsById[f.needId] || {};
      const paid = !!(need.monetizable || need.sourceId === "flru" || need.budgetEstimate);
      const priority =
        (f.status === "approved" ? 1000 : 0) +
        (paid ? 300 : 0) +
        Number(f.expectedRevenue || 0) / 1000 +
        Number(f.score || 0);
      return {
        fulfillmentId: f.id,
        status: f.status,
        title: f.title,
        modeId: f.modeId,
        score: f.score,
        expectedRevenue: f.expectedRevenue,
        currency: f.currency,
        sourceLabel: f.sourceLabel,
        sourceUrl: f.sourceUrl,
        solutionFile: f.solutionFile,
        nextAction: f.proposal?.nextAction || defaultNext(f),
        message: f.proposal?.message || f.replyDraft,
        price: f.proposal?.price || null,
        timeline: f.proposal?.timeline || null,
        budgetEstimate: need.budgetEstimate || 0,
        paid,
        priority,
        category: f.category,
      };
    })
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);

  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
}

function defaultNext(f) {
  if (f.status === "approved") return "Выполнить и нажать Fulfill";
  return "Approve и отправить сообщение автору";
}

export function filterFulfillments(fulfillments, query = {}) {
  let list = fulfillments.slice();
  if (query.status) list = list.filter((f) => f.status === query.status);
  if (query.mode) list = list.filter((f) => f.modeId === query.mode);
  if (query.source) {
    list = list.filter((f) =>
      String(f.sourceLabel || "")
        .toLowerCase()
        .includes(String(query.source).toLowerCase())
    );
  }
  if (query.q) {
    const q = String(query.q).toLowerCase();
    list = list.filter(
      (f) =>
        f.title?.toLowerCase().includes(q) ||
        f.needSummary?.toLowerCase().includes(q) ||
        f.replyDraft?.toLowerCase().includes(q)
    );
  }
  if (query.paid === "1" || query.paid === "true") {
    list = list.filter((f) => /fl\.ru/i.test(f.sourceLabel || "") || f.proposal?.price?.amount);
  }
  return list;
}
