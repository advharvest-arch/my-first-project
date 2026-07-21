#!/usr/bin/env node
/**
 * Autopilot daemon: периодический scout → cycle.
 * Не публикует ответы сам — только готовит планы и solution-пакеты.
 *
 *   node src/autopilot.js
 *   node src/autopilot.js --once
 *   INTERVAL_SEC=300 node src/autopilot.js
 */

import { getFreshNeeds } from "./scout.js";
import { runNeedsCycle, formatMoney, getDashboard } from "./engine.js";
import { getConfig } from "./config.js";

const once = process.argv.includes("--once");

async function tick() {
  const cfg = getConfig();
  const started = Date.now();
  console.log(`\n── cycle ${new Date().toISOString()} ──`);

  const scout = await getFreshNeeds({ force: true });
  console.log(
    `scout: ${scout.count} needs` +
      (scout.bySource
        ? ` [${Object.entries(scout.bySource)
            .map(([k, v]) => `${k}:${v}`)
            .join(", ")}]`
        : "")
  );
  if (scout.errors?.length) {
    for (const e of scout.errors) console.log(`  ! ${e.source}: ${e.error}`);
  }

  const report = runNeedsCycle(scout.needs || [], {
    maxPlansPerCycle: cfg.autopilot?.maxPlansPerCycle ?? 25,
  });

  console.log(
    `plans: +${report.planned}  skip: ${report.skipped}  deferred: ${report.deferred || 0}  value: ${formatMoney(
      report.expectedThisCycle
    )}`
  );

  const top = report.results
    .filter((r) => r.action === "fulfill_plan")
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  for (const r of top) {
    console.log(`  • [${r.mode}] ${r.score}  ${r.title.slice(0, 70)}`);
    if (r.solutionFile) console.log(`    → workspace/solutions/${r.solutionFile}`);
  }

  const dash = getDashboard();
  console.log(
    `totals: needs=${dash.stats.needsSeen} ready=${dash.stats.fulfillmentsReady} packs=${dash.stats.solutionPacks} expected=${formatMoney(
      dash.stats.expectedRevenueTotal
    )} (${Date.now() - started}ms)`
  );
  return report;
}

async function main() {
  const cfg = getConfig();
  const intervalSec = Number(process.env.INTERVAL_SEC || cfg.autopilot?.intervalSec || 900);

  console.log("AdvHarvest Autopilot daemon");
  console.log(`interval: ${intervalSec}s · once=${once}`);

  await tick();
  if (once) return;

  setInterval(() => {
    tick().catch((err) => console.error("cycle error:", err.message || err));
  }, intervalSec * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
