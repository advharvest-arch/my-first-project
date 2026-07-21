#!/usr/bin/env node
/**
 * Демо полного денежного цикла без внешних API.
 */
import {
  loadJson,
  runCycle,
  approveOffer,
  realizeOffer,
  formatMoney,
  resetState,
  getDashboard,
} from "./engine.js";

resetState();
const signals = loadJson("signals.json", []);

console.log("╔══════════════════════════════════════════════╗");
console.log("║     AdvHarvest Autopilot — DEMO ЗАРАБОТКА    ║");
console.log("╚══════════════════════════════════════════════╝\n");

console.log("① Scout + Score + Package\n");
const cycle = runCycle(signals);
for (const r of cycle.results) {
  const mark = r.action === "package" ? "💰" : "·";
  console.log(
    `  ${mark} ${r.signalId.padEnd(8)} ${String(r.action).padEnd(8)} score ${String(r.score).padStart(3)}  ${
      r.expectedRevenue ? formatMoney(r.expectedRevenue) : "—"
    }`
  );
}

const ready = cycle.state.offers.filter((o) => o.status === "ready");
console.log(`\n② Approve топ-офферов (human-in-the-loop): ${ready.length} шт.\n`);

const top = ready
  .slice()
  .sort((a, b) => b.expectedRevenue - a.expectedRevenue)
  .slice(0, 3);

for (const offer of top) {
  approveOffer(offer.id);
  console.log(`  ✓ approved  ${offer.title}`);
  console.log(`    ${offer.pitch.slice(0, 100)}…`);
}

console.log("\n③ Realize (симуляция закрытия сделок)\n");
let earned = 0;
for (const offer of top) {
  // Консервативно: 60–100% от expected
  const factor = 0.6 + Math.random() * 0.4;
  const amount = Math.round(offer.expectedRevenue * factor);
  const { realized } = realizeOffer(offer.id, amount);
  earned += realized;
  console.log(`  ✓ +${formatMoney(realized)}  ← ${offer.channelId} / ${offer.title}`);
}

const dash = getDashboard();
console.log("\n════════════════════════════════════════");
console.log(`  Заработано в демо:     ${formatMoney(earned)}`);
console.log(`  Ожидаемый пайплайн:    ${formatMoney(dash.stats.expectedRevenueTotal)}`);
console.log(`  Реализовано всего:     ${formatMoney(dash.stats.realizedRevenueTotal)}`);
console.log(`  Порог score (learn):   ${dash.config.minScore}`);
console.log("════════════════════════════════════════");
console.log("\nЭто легальная модель: лиды → офферы → сделки / комиссии.");
console.log("Запуск дашборда: npm start\n");
