import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJson, saveJson } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PATH = join(__dirname, "..", "config", "default.json");

export function loadDefaultConfigFile() {
  return JSON.parse(readFileSync(DEFAULT_PATH, "utf8"));
}

export function getConfig() {
  const base = loadDefaultConfigFile();
  const overlay = loadJson("config.json", {});
  return deepMerge(base, overlay || {});
}

export function saveConfigOverlay(partial) {
  const current = loadJson("config.json", {});
  const next = deepMerge(current || {}, partial || {});
  saveJson("config.json", next);
  return getConfig();
}

function deepMerge(a, b) {
  if (Array.isArray(b)) return b.slice();
  if (b && typeof b === "object") {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b)) {
      out[k] = deepMerge(a?.[k], v);
    }
    return out;
  }
  return b === undefined ? a : b;
}

export function configExists() {
  return existsSync(DEFAULT_PATH);
}
