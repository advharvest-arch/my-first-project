#!/usr/bin/env node
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getDashboard,
  loadJson,
  runCycle,
  approveOffer,
  realizeOffer,
  resetState,
  formatMoney,
} from "./engine.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT || 3847);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

    if (req.method === "POST" && url.pathname === "/api/cycle") {
      const signals = loadJson("signals.json", []);
      const report = runCycle(signals);
      return json(res, 200, {
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
