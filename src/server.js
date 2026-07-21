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
      return json(res, 200, getDashboard());
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
      const limit = Number(url.searchParams.get("limit") || 20);
      return json(res, 200, getWorkQueue(limit));
    }

    if (req.method === "GET" && url.pathname === "/api/fulfillments") {
      const query = Object.fromEntries(url.searchParams.entries());
      return json(res, 200, { fulfillments: getFilteredFulfillments(query) });
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
      const scout = await getFreshNeeds({ force, maxAgeMin: 15 });
      return json(res, 200, scout);
    }

    if (req.method === "POST" && url.pathname === "/api/cycle") {
      const force = url.searchParams.get("force") !== "0";
      const scout = await getFreshNeeds({ force, maxAgeMin: 15 });
      const report = runNeedsCycle(scout.needs || []);
      return json(res, 200, {
        scout: {
          count: scout.count,
          fromCache: scout.fromCache,
          fetchedAt: scout.fetchedAt,
          bySource: scout.bySource,
          errors: scout.errors,
        },
        ...report,
        expectedThisCycleLabel: formatMoney(report.expectedThisCycle),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      return json(res, 200, resetState());
    }

    const approveMatch = url.pathname.match(/^\/api\/offers\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch) {
      const offer = approveOffer(decodeURIComponent(approveMatch[1]));
      return json(res, 200, offer);
    }

    const realizeMatch = url.pathname.match(/^\/api\/offers\/([^/]+)\/realize$/);
    if (req.method === "POST" && realizeMatch) {
      const body = await readBody(req);
      const result = realizeOffer(decodeURIComponent(realizeMatch[1]), body.amount);
      return json(res, 200, result);
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
  if (url.pathname.startsWith("/api/")) {
    return handleApi(req, res, url);
  }
  return serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log(`AdvHarvest Autopilot → http://localhost:${PORT}`);
});
