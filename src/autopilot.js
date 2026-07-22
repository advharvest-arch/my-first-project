#!/usr/bin/env node
/**
 * Автопилот заработка:
 *   Scout → Products → Auto-sales → Revenue
 */
import { getFreshNeeds } from "./scout.js";
import { syncCatalogFromNeeds } from "./products.js";
import { runAutoSales, getCommerceDashboard } from "./commerce.js";
import { getConfig } from "./config.js";
import { runNeedsCycle, formatMoney } from "./engine.js";

const once = process.argv.includes("--once");

function money(n) {
  return formatMoney(n);
}

async function tick() {
  const cfg = getConfig();
  console.log(`\n── auto-earn ${new Date().toISOString()} ──`);

  const scout = await getFreshNeeds({ force: true });
  console.log(`needs: ${scout.count}`);

  // параллельно: планы удовлетворения (опционально) + каталог продуктов
  runNeedsCycle(scout.needs || [], { maxPlansPerCycle: cfg.autopilot?.maxPlansPerCycle ?? 10 });
  const sync = syncCatalogFromNeeds(scout.needs || [], {
    maxNew: cfg.commerce?.maxNewProductsPerCycle ?? 6,
  });
  console.log(`products: +${sync.created} new, ${sync.refreshed} refreshed, catalog=${sync.catalog.products.length}`);

  const sales = runAutoSales({ maxSales: cfg.commerce?.maxAutoSalesPerCycle ?? 4 });
  console.log(`autosales: ${sales.sold.length} orders, +${money(sales.revenue)} (mode=${sales.mode})`);
  for (const s of sales.sold) {
    console.log(`  💰 ${money(s.order.amount)} ← ${s.order.productTitle.slice(0, 60)}`);
  }

  const dash = getCommerceDashboard();
  console.log(
    `totals: revenue=${money(dash.stats.grossRevenue)} paid_orders=${dash.stats.ordersPaid} products=${dash.catalogCount}`
  );
  return { scout, sync, sales, dash };
}

async function main() {
  const cfg = getConfig();
  const intervalSec = Number(process.env.INTERVAL_SEC || cfg.autopilot?.intervalSec || 900);
  console.log("AdvHarvest AUTO-EARN");
  console.log(`mode=${process.env.COMMERCE_MODE || cfg.commerce?.mode || "auto"} interval=${intervalSec}s`);

  await tick();
  if (once) return;
  setInterval(() => tick().catch((e) => console.error(e)), intervalSec * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
