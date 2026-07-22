#!/usr/bin/env node
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDashboard,
  runNeedsCycle,
  approveOffer,
  realizeOffer,
  resetState,
  formatMoney,
  batchApprove,
  getWorkQueue,
  getFilteredFulfillments,
} from "./engine.js";
import { getFreshNeeds } from "./scout.js";
import { getConfig, saveConfigOverlay } from "./config.js";
import { listSolutionPacks, readSolutionPack } from "./solutions.js";
import { syncCatalogFromNeeds, loadCatalog, getProductById } from "./products.js";
import {
  createOrder,
  payAndDeliver,
  verifyDownload,
  runAutoSales,
  getCommerceDashboard,
  createStripeCheckout,
} from "./commerce.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3847);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function handleApi(req, res, url) {
  try {
    if (req.method === "GET" && url.pathname === "/api/dashboard") {
      const base = getDashboard();
      const commerce = getCommerceDashboard();
      return json(res, 200, { ...base, commerce });
    }

    if (req.method === "GET" && url.pathname === "/api/commerce") {
      return json(res, 200, getCommerceDashboard());
    }

    if (req.method === "GET" && url.pathname === "/api/catalog") {
      return json(res, 200, loadCatalog());
    }

    if (req.method === "POST" && url.pathname === "/api/earn-cycle") {
      const force = url.searchParams.get("force") !== "0";
      const scout = await getFreshNeeds({ force, maxAgeMin: 10 });
      const plans = runNeedsCycle(scout.needs || []);
      const sync = syncCatalogFromNeeds(scout.needs || [], {
        maxNew: Number(getConfig().commerce?.maxNewProductsPerCycle || 6),
      });
      const sales = runAutoSales({
        maxSales: Number(getConfig().commerce?.maxAutoSalesPerCycle || 4),
      });
      return json(res, 200, {
        scout: {
          count: scout.count,
          bySource: scout.bySource,
          errors: scout.errors,
          fromCache: scout.fromCache,
        },
        plans: { planned: plans.planned, skipped: plans.skipped },
        products: { created: sync.created, refreshed: sync.refreshed, total: sync.catalog.products.length },
        sales: {
          count: sales.sold.length,
          revenue: sales.revenue,
          revenueLabel: formatMoney(sales.revenue),
          mode: sales.mode,
          orders: sales.sold.map((s) => s.order),
        },
        commerce: getCommerceDashboard(),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/checkout") {
      const body = await readBody(req);
      const productId = body.productId;
      if (!productId) throw new Error("productId обязателен");

      if (process.env.STRIPE_SECRET_KEY && body.provider === "stripe") {
        const origin = `${url.protocol}//${req.headers.host}`;
        const session = await createStripeCheckout(
          productId,
          body.successUrl || `${origin}/store.html?paid=1`,
          body.cancelUrl || `${origin}/store.html?cancel=1`
        );
        return json(res, 200, session);
      }

      const order = createOrder({
        productId,
        email: body.email || "buyer@store.local",
        source: "store",
      });
      // demo: мгновенная оплата и выдача
      const result = payAndDeliver(order.id, { provider: body.instant === false ? "pending" : "demo" });
      return json(res, 200, result);
    }

    const dl = url.pathname.match(/^\/api\/download\/([^/]+)\/([^/]+)$/);
    if (req.method === "GET" && dl) {
      const { order, product, content } = verifyDownload(decodeURIComponent(dl[1]), dl[2]);
      const buf = Buffer.from(content, "utf8");
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${product.id}.md"`,
        "Content-Length": buf.length,
      });
      return res.end(buf);
    }

    if (req.method === "GET" && url.pathname === "/api/config") {
      return json(res, 200, getConfig());
    }

    if (req.method === "POST" && url.pathname === "/api/config") {
      const body = await readBody(req);
      return json(res, 200, saveConfigOverlay(body));
    }

    if (req.method === "GET" && url.pathname === "/api/solutions") {
      return json(res, 200, { solutions: listSolutionPacks() });
    }

    const solMatch = url.pathname.match(/^\/api\/solutions\/([^/]+)$/);
    if (req.method === "GET" && solMatch) {
      return json(res, 200, readSolutionPack(decodeURIComponent(solMatch[1])));
    }

    if (req.method === "GET" && url.pathname === "/api/queue") {
      return json(res, 200, getWorkQueue(Number(url.searchParams.get("limit") || 20)));
    }

    if (req.method === "GET" && url.pathname === "/api/fulfillments") {
      return json(res, 200, {
        fulfillments: getFilteredFulfillments(Object.fromEntries(url.searchParams.entries())),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/batch-approve") {
      const body = await readBody(req);
      return json(
        res,
        200,
        batchApprove({
          limit: Number(body.limit || 5),
          paidOnly: !!body.paidOnly,
          minScore: Number(body.minScore || 0),
        })
      );
    }

    if (req.method === "POST" && url.pathname === "/api/scout") {
      const force = url.searchParams.get("force") === "1";
      return json(res, 200, await getFreshNeeds({ force, maxAgeMin: 15 }));
    }

    if (req.method === "POST" && url.pathname === "/api/cycle") {
      // backward compatible: now runs full earn cycle
      const force = url.searchParams.get("force") !== "0";
      const scout = await getFreshNeeds({ force, maxAgeMin: 15 });
      const report = runNeedsCycle(scout.needs || []);
      const sync = syncCatalogFromNeeds(scout.needs || []);
      const sales = runAutoSales({ maxSales: 4 });
      return json(res, 200, {
        scout: {
          count: scout.count,
          fromCache: scout.fromCache,
          fetchedAt: scout.fetchedAt,
          bySource: scout.bySource,
          errors: scout.errors,
        },
        ...report,
        products: sync,
        sales,
        expectedThisCycleLabel: formatMoney(report.expectedThisCycle),
        earnedThisCycleLabel: formatMoney(sales.revenue),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      return json(res, 200, resetState());
    }

    const approveMatch = url.pathname.match(/^\/api\/offers\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      return json(res, 200, approveOffer(decodeURIComponent(approveMatch[1])));
    }

    const realizeMatch = url.pathname.match(/^\/api\/offers\/([^/]+)\/realize$/);
    if (req.method === "POST" && realizeMatch) {
      const body = await readBody(req);
      return json(res, 200, realizeOffer(decodeURIComponent(realizeMatch[1]), body.amount));
    }

    // product detail
    const prodMatch = url.pathname.match(/^\/api\/products\/([^/]+)$/);
    if (req.method === "GET" && prodMatch) {
      const p = getProductById(decodeURIComponent(prodMatch[1]));
      if (!p) return json(res, 404, { error: "Not found" });
      return json(res, 200, p);
    }

    return json(res, 404, { error: "Not found" });
  } catch (err) {
    return json(res, 400, { error: err.message || String(err) });
  }
}

function serveStatic(res, pathname) {
  let filePath = join(PUBLIC, pathname === "/" ? "index.html" : pathname);
  if (!filePath.startsWith(PUBLIC) || !existsSync(filePath)) {
    res.writeHead(404).end("Not found");
    return;
  }
  const data = readFileSync(filePath);
  res.writeHead(200, { "Content-Type": MIME[extname(filePath)] || "application/octet-stream" });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) return handleApi(req, res, url);
  return serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`AdvHarvest AUTO-EARN → http://localhost:${PORT}`);
  console.log(`Store → http://localhost:${PORT}/store.html`);
});
