#!/usr/bin/env node
import { loadJson, runCycle, formatMoney, resetState } from "./engine.js";

const fresh = process.argv.includes("--fresh");
if (fresh) {
  resetState();
  console.log("Состояние сброшено.\n");
}

const signals = loadJson("signals.json", []);
const report = runCycle(signals);

console.log("═══ AdvHarvest Autopilot — цикл ═══\n");
console.log(`Обработано сигналов: ${report.processed}`);
console.log(`Упаковано офферов:   ${report.packaged}`);
console.log(`Пропущено:           ${report.skipped}`);
console.log(`Ожидаемая выручка:   ${formatMoney(report.expectedThisCycle)}\n`);

for (const r of report.results) {
  if (r.action === "skip") {
    console.log(`✗ ${r.signalId}  skip  score=${r.score}  (${r.rationale})`);
  } else {
    console.log(
      `✓ ${r.signalId}  → ${r.channel}  score=${r.score}  ~${formatMoney(r.expectedRevenue)}`
    );
    console.log(`  ${r.rationale}`);
  }
}

console.log("\nИтого в системе:");
console.log(`  Ожидаемо:  ${formatMoney(report.state.stats.expectedRevenueTotal)}`);
console.log(`  Реализовано: ${formatMoney(report.state.stats.realizedRevenueTotal)}`);
console.log("\nДальше: npm start  → дашборд http://localhost:3847");
