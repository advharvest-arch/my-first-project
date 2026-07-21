#!/usr/bin/env node
import { getFreshNeeds } from "./scout.js";
import { runNeedsCycle, resetState, formatMoney, getDashboard } from "./engine.js";

const fresh = process.argv.includes("--fresh");
const force = process.argv.includes("--force") || fresh;

if (fresh) {
  resetState();
  console.log("Состояние сброшено.\n");
}

console.log("═══ AdvHarvest — поиск потребностей ═══\n");

const scout = await getFreshNeeds({ force, maxAgeMin: 20 });
console.log(
  `Источник: ${scout.fromCache ? "кэш" : "живой интернет"} · ${scout.count} · ${scout.fetchedAt}`
);
if (scout.bySource) {
  console.log(
    "По источникам:",
    Object.entries(scout.bySource)
      .map(([k, v]) => `${k}:${v}`)
      .join("  ")
  );
}
if (scout.errors?.length) {
  for (const e of scout.errors) console.log(`  ! ${e.source}: ${e.error}`);
}

const report = runNeedsCycle(scout.needs || []);

console.log(`\nОбработано: ${report.processed}`);
console.log(`Планов: ${report.planned}  skip: ${report.skipped}  deferred: ${report.deferred || 0}`);
console.log(`Ожидаемая ценность: ${formatMoney(report.expectedThisCycle)}\n`);

for (const r of report.results.filter((x) => x.action === "fulfill_plan").slice(0, 15)) {
  console.log(`✓ ${r.mode.padEnd(11)} ${String(r.score).padStart(3)}  ~${formatMoney(r.expectedRevenue)}`);
  console.log(`  ${r.title?.slice(0, 78)}`);
  console.log(`  ${r.url}`);
  if (r.solutionFile) console.log(`  file: workspace/solutions/${r.solutionFile}`);
}

const dash = getDashboard();
console.log("\nИтого:");
console.log(`  Потребностей: ${dash.stats.needsSeen}`);
console.log(`  Планов ready: ${dash.stats.fulfillmentsReady}`);
console.log(`  Solution packs: ${dash.stats.solutionPacks}`);
console.log(`  Ожидаемо: ${formatMoney(dash.stats.expectedRevenueTotal)}`);
console.log("\nДашборд: npm start → http://localhost:3847");
