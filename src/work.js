#!/usr/bin/env node
/**
 * Рабочая очередь: что делать прямо сейчас.
 *
 *   npm run work
 *   npm run work -- --approve 3 --paid
 */
import {
  getWorkQueue,
  batchApprove,
  formatMoney,
  getDashboard,
} from "./engine.js";

const args = process.argv.slice(2);
function flag(name) {
  return args.includes(`--${name}`);
}
function opt(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return args[i + 1];
  return fallback;
}

if (flag("approve")) {
  const limit = Number(opt("approve", 3));
  const result = batchApprove({ limit, paidOnly: flag("paid"), minScore: Number(opt("min-score", 0)) });
  console.log(`Approved: ${result.count}`);
  for (const a of result.approved) {
    console.log(`  ✓ ${a.modeId} · ${formatMoney(a.expectedRevenue)} · ${a.title.slice(0, 70)}`);
  }
  console.log("");
}

const queue = getWorkQueue(Number(opt("limit", 12)));
const dash = getDashboard();

console.log("═══ AdvHarvest — очередь работы ═══\n");
console.log(
  `ready/approved в очереди: ${queue.count} · packs: ${dash.stats.solutionPacks} · expected: ${formatMoney(
    dash.stats.expectedRevenueTotal
  )}\n`
);

if (!queue.items.length) {
  console.log("Очередь пуста. Запустите: npm run cycle -- --force");
  process.exit(0);
}

for (const [i, item] of queue.items.entries()) {
  console.log(`${i + 1}. [${item.status}] ${item.modeId} · score ${item.score} · ${formatMoney(item.expectedRevenue)}`);
  console.log(`   ${item.title}`);
  if (item.budgetEstimate) console.log(`   бюджет источника: ${formatMoney(item.budgetEstimate)}`);
  console.log(`   → ${item.nextAction}`);
  if (item.message) console.log(`   msg: ${item.message.slice(0, 140)}…`);
  if (item.sourceUrl) console.log(`   url: ${item.sourceUrl}`);
  if (item.solutionFile) console.log(`   file: workspace/solutions/${item.solutionFile}`);
  console.log("");
}

console.log("Подсказка: npm run work -- --approve 3 --paid");
