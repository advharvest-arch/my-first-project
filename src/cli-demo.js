#!/usr/bin/env node
/**
 * Демо: интернет → потребности → планы → approve → fulfill
 */
import { getFreshNeeds } from "./scout.js";
import {
  runNeedsCycle,
  approveFulfillment,
  fulfillNeed,
  formatMoney,
  resetState,
  getDashboard,
} from "./engine.js";

resetState();

console.log("╔══════════════════════════════════════════════════╗");
console.log("║  AdvHarvest — потребности людей → решения        ║");
console.log("╚══════════════════════════════════════════════════╝\n");

console.log("① Сканируем интернет (HN / StackOverflow / GitHub)…\n");
const scout = await getFreshNeeds({ force: true });
console.log(`   найдено потребностей: ${scout.count}`);
if (scout.errors?.length) {
  for (const e of scout.errors) console.log(`   ! ${e.source}: ${e.error}`);
}

console.log("\n② Score + план удовлетворения\n");
const cycle = runNeedsCycle(scout.needs || []);
for (const r of cycle.results.slice(0, 12)) {
  const mark = r.action === "fulfill_plan" ? "💡" : "·";
  console.log(
    `  ${mark} ${String(r.score).padStart(3)}  ${(r.mode || "skip").padEnd(11)}  ${(r.title || "").slice(0, 64)}`
  );
}

const ready = cycle.state.fulfillments
  .filter((f) => f.status === "ready")
  .sort((a, b) => b.score - a.score)
  .slice(0, 3);

console.log(`\n③ Approve топ-${ready.length} планов (human-in-the-loop)\n`);
for (const plan of ready) {
  approveFulfillment(plan.id);
  console.log(`  ✓ ${plan.modeId} · ${plan.title.slice(0, 70)}`);
  console.log(`    черновик ответа: ${plan.replyDraft.slice(0, 110)}…`);
}

console.log("\n④ Fulfill — отмечаем потребности закрытыми\n");
let earned = 0;
for (const plan of ready) {
  const factor = 0.55 + Math.random() * 0.45;
  const amount = Math.round(plan.expectedRevenue * factor);
  const { realized } = fulfillNeed(plan.id, amount);
  earned += realized;
  console.log(`  ✓ +${formatMoney(realized)}  ← ${plan.modeId}`);
}

const dash = getDashboard();
console.log("\n════════════════════════════════════════");
console.log(`  Найдено потребностей:  ${dash.stats.needsSeen}`);
console.log(`  Удовлетворено:         ${dash.stats.needsFulfilled}`);
console.log(`  Заработано в демо:     ${formatMoney(earned)}`);
console.log(`  Пайплайн ожидания:     ${formatMoney(dash.stats.expectedRevenueTotal)}`);
console.log("════════════════════════════════════════");
console.log("\nПринцип: сначала закрываем боль человека, деньги — следствие.\n");
