/**
 * Smoke tests — без зависимостей.
 * Запуск: npm test
 */
import assert from "node:assert/strict";
import { scoreNeed, chooseFulfillment, estimateFulfillmentValue, planFulfillment } from "./needs.js";
import { isSpamNeed, passesQualityGates, buildWorkQueue } from "./queue.js";
import { buildProposal } from "./proposal.js";
import { parseRss } from "./rss.js";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

test("spam filter catches review farming", () => {
  assert.equal(isSpamNeed({ title: "оставить отзыв в яндекс", body: "" }), true);
});

test("quality gate rejects tiny FL budgets", () => {
  const r = passesQualityGates(
    { title: "мелкий заказ", sourceId: "flru", budgetEstimate: 200, monetizable: true },
    { minPaidBudget: 1000 }
  );
  assert.equal(r.ok, false);
});

test("FL need scores high and becomes service", () => {
  const need = {
    id: "t1",
    title: "Нужен лендинг для автосервиса",
    body: "Сделать под ключ два лендинга",
    sourceId: "flru",
    monetizable: true,
    budgetEstimate: 40000,
    engagement: 30,
    createdAt: new Date().toISOString(),
    language: "ru",
  };
  const scored = scoreNeed(need, { minNeedScore: 40 });
  assert.ok(scored.score >= 60);
  const mode = chooseFulfillment(need, scored);
  assert.equal(mode.id, "service");
  const value = estimateFulfillmentValue(need, mode, scored);
  assert.ok(value.expected > 0);
  const plan = planFulfillment(need, scored, mode, value);
  assert.ok(plan.proposal?.message);
  assert.ok(plan.proposal.price.amount > 0);
});

test("proposal builds RU commercial message", () => {
  const need = {
    title: "Интеграция 1С",
    body: "нужен программист",
    language: "ru",
    budgetEstimate: 80000,
  };
  const mode = { id: "service", name: "Услуга" };
  const proposal = buildProposal(need, mode, { score: 80, urgency: 0.8 }, { expected: 10000, currency: "RUB" });
  assert.match(proposal.message, /Здравствуйте/);
  assert.ok(proposal.price.amount > 0);
});

test("RSS parser extracts items", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[Тест заказ]]></title><link>https://x.test/1</link>
    <description>Описание</description></item>
  </channel></rss>`;
  const items = parseRss(xml);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Тест заказ");
});

test("work queue prioritizes approved + paid", () => {
  const q = buildWorkQueue({
    needs: [
      { id: "n1", sourceId: "flru", monetizable: true, budgetEstimate: 50000 },
      { id: "n2", sourceId: "hackernews" },
    ],
    fulfillments: [
      {
        id: "f2",
        needId: "n2",
        status: "ready",
        title: "Ask",
        modeId: "guide",
        score: 90,
        expectedRevenue: 1000,
      },
      {
        id: "f1",
        needId: "n1",
        status: "approved",
        title: "Paid",
        modeId: "service",
        score: 70,
        expectedRevenue: 20000,
        proposal: { nextAction: "Отправить КП", message: "hi" },
      },
    ],
  });
  assert.equal(q.items[0].fulfillmentId, "f1");
});

console.log(`\n${passed} tests passed`);
