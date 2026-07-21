#!/usr/bin/env node
/**
 * Поиск насущных потребностей в интернете + планы их удовлетворения.
 */
import { getFreshNeeds } from "./scout.js";
import { runNeedsCycle, resetState, formatMoney, getDashboard } from "./engine.js";

const fresh = process.argv.includes("--fresh");
const force = process.argv.includes("--force") || fresh;

if (fresh) {
  resetState();
  console.log("Состояние сброшено.\n");
}

console.log("═══ AdvHarvest — поиск потребностей в сети ═══\n");

const scout = await getFreshNeeds({ force, maxAgeMin: 20 });
console.log(
  `Источник: ${scout.fromCache ? "кэш" : "живой интернет"} · найдено ${scout.count} · ${scout.fetchedAt}`
);
if (scout.errors?.length) {
  for (const e of scout.errors) console.log(`  ! ${e.source}: ${e.error}`);
}

const report = runNeedsCycle(scout.needs || []);

console.log(`\nОбработано: ${report.processed}`);
console.log(`Планов удовлетворения: ${report.planned}`);
console.log(`Пропущено: ${report.skipped}`);
console.log(`Ожидаемая ценность: ${formatMoney(report.expectedThisCycle)}\n`);

for (const r of report.results.slice(0, 15)) {
  if (r.action === "skip") {
    console.log(`· skip  ${r.score}  ${r.title?.slice(0, 70)}`);
  } else {
    console.log(`✓ ${r.mode.padEnd(11)} ${String(r.score).padStart(3)}  ~${formatMoney(r.expectedRevenue)}`);
    console.log(`  ${r.title?.slice(0, 78)}`);
    console.log(`  ${r.url}`);
  }
}

const dash = getDashboard();
console.log("\nИтого:");
console.log(`  Потребностей в базе: ${dash.stats.needsSeen}`);
console.log(`  Планов ready:        ${dash.stats.fulfillmentsReady}`);
console.log(`  Ожидаемо:            ${formatMoney(dash.stats.expectedRevenueTotal)}`);
console.log("\nДашборд: npm start → http://localhost:3847");
