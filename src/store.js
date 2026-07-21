import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
export const DATA = join(ROOT, "data");

function ensureData() {
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
}

export function loadJson(name, fallback) {
  ensureData();
  const path = join(DATA, name);
  if (!existsSync(path)) {
    if (fallback === null || fallback === undefined) return fallback;
    writeFileSync(path, JSON.stringify(fallback, null, 2), "utf8");
    return structuredClone(fallback);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveJson(name, value) {
  ensureData();
  writeFileSync(join(DATA, name), JSON.stringify(value, null, 2), "utf8");
}
