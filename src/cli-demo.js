#!/usr/bin/env node
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
console.log("║  AdvHarvest — система: нужды → решения → деньги  ║");
console.log("╚══════════════════════════════════════════════════╝\n");

console.log("① Сканируем интернет (FL.ru / HN / SO / GitHub / Lobsters)…\n");
const scout = await getFreshNeeds({ force: true });
console.log(`   найдено: ${scout.count}`);
if (scout.bySource) {
  console.log(
    "   по источникам:",
    Object.entries(scout.bySource)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ")
  );
}
if (scout.errors?.length) {
  for (const e of scout.errors) console.log(`   ! ${e.source}: ${e.error}`);
}

console.log("\n② Score + планы + solution-пакеты\n");
const cycle = runNeedsCycle(scout.needs || []);
for (const r of cycle.results.filter((x) => x.action === "fulfill_plan").slice(0, 12)) {
  const bud = r.budgetEstimate ? `  budget ${formatMoney(r.budgetEstimate)}` : "";
  console.log(
    `  💡 ${String(r.score).padStart(3)}  ${r.mode.padEnd(11)}  ${r.title.slice(0, 58)}${bud}`
  );
  if (r.solutionFile) console.log(`     → ${r.solutionFile}`);
}

const ready = cycle.state.fulfillments
  .filter((f) => f.status === "ready")
  .sort((a, b) => b.expectedRevenue - a.expectedRevenue)
  .slice(0, 3);

console.log(`\n③ Approve топ-${ready.length} по ценности\n`);
for (const plan of ready) {
  approveFulfillment(plan.id);
  console.log(`  ✓ ${plan.modeId} · ${formatMoney(plan.expectedRevenue)} · ${plan.title.slice(0, 60)}`);
}

console.log("\n④ Fulfill\n");
let earned = 0;
for (const plan of ready) {
  const amount = Math.round(plan.expectedRevenue * (0.55 + Math.random() * 0.4));
  const { realized } = fulfillNeed(plan.id, amount);
  earned += realized;
  console.log(`  ✓ +${formatMoney(realized)}`);
}

const dash = getDashboard();
console.log("\n════════════════════════════════════════");
console.log(`  Найдено потребностей:  ${dash.stats.needsSeen}`);
console.log(`  Solution-пакетов:      ${dash.stats.solutionPacks}`);
console.log(`  Удовлетворено:         ${dash.stats.needsFulfilled}`);
console.log(`  Заработано в демо:     ${formatMoney(earned)}`);
console.log(`  Пайплайн:              ${formatMoney(dash.stats.expectedRevenueTotal)}`);
console.log("════════════════════════════════════════");
console.log("\nnpm start  |  npm run autopilot -- --once\n");
