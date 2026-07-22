/**
 * Фабрика цифровых продуктов из повторяющихся потребностей.
 * Цель: система сама упаковывает спрос в то, что можно продавать 24/7.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { categorize } from "./needs.js";
import { getConfig } from "./config.js";
import { loadJson, saveJson } from "./store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function productsDir() {
  const abs = join(ROOT, "workspace", "products");
  mkdirSync(abs, { recursive: true });
  return abs;
}

function hash(s) {
  return createHash("sha1").update(s).digest("hex").slice(0, 10);
}

function normalizeTopic(title = "") {
  return title
    .toLowerCase()
    .replace(/ask hn:\s*/i, "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9а-яё\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function topicKey(title) {
  const stop = new Set([
    "как", "what", "how", "the", "and", "для", "или", "нужен", "нужна", "need", "looking", "for", "a", "to", "на", "по", "с",
  ]);
  const words = normalizeTopic(title)
    .split(" ")
    .filter((w) => w.length > 2 && !stop.has(w))
    .slice(0, 6);
  return words.join("-") || "general";
}

/**
 * Кластеризация нужд → кандидаты в продукты.
 */
export function clusterNeedsIntoProducts(needs = []) {
  const buckets = new Map();
  for (const need of needs) {
    const cat = categorize(`${need.title} ${need.body || ""}`);
    const key = `${cat.id}::${topicKey(need.title)}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        category: cat,
        needs: [],
        budgetSum: 0,
        engagement: 0,
        paidCount: 0,
      });
    }
    const b = buckets.get(key);
    b.needs.push(need);
    b.budgetSum += Number(need.budgetEstimate || 0);
    b.engagement += Number(need.engagement || 0);
    if (need.monetizable || need.sourceId === "flru") b.paidCount += 1;
  }

  return [...buckets.values()]
    .map((b) => {
      const demand = b.needs.length * 10 + b.paidCount * 25 + Math.min(40, b.engagement / 5);
      const avgBudget = b.paidCount ? b.budgetSum / Math.max(1, b.needs.length) : 0;
      const price = suggestPrice(avgBudget, demand, b.category.id);
      const title = productTitle(b);
      return {
        clusterKey: b.key,
        category: b.category,
        title,
        slug: `prod_${hash(b.key)}`,
        demand: Math.round(demand),
        sampleNeeds: b.needs.slice(0, 5).map((n) => ({
          id: n.id,
          title: n.title,
          url: n.url,
          budgetEstimate: n.budgetEstimate || 0,
        })),
        price,
        currency: "RUB",
      };
    })
    .filter((p) => p.demand >= 15)
    .sort((a, b) => b.demand - a.demand);
}

function suggestPrice(avgBudget, demand, categoryId) {
  if (avgBudget >= 30000) return Math.min(9900, Math.round(avgBudget * 0.08));
  if (avgBudget >= 5000) return Math.min(4900, Math.max(990, Math.round(avgBudget * 0.12)));
  const base = {
    web_design: 1490,
    design_build: 2490,
    dev_tooling: 990,
    business: 1290,
    ops_infra: 1490,
    career: 790,
  }[categoryId] || 890;
  return Math.round(base * (1 + Math.min(1.5, demand / 80)));
}

function productTitle(bucket) {
  const sample = bucket.needs[0]?.title || "Решение";
  const short = sample.length > 70 ? sample.slice(0, 67) + "…" : sample;
  const kind = bucket.paidCount > 0 ? "Практический пакет" : "Гайд + шаблоны";
  return `${kind}: ${short}`;
}

/** Генерация содержимого цифрового продукта */
export function generateProductContent(candidate) {
  const examples = candidate.sampleNeeds
    .map((n, i) => `${i + 1}. ${n.title}${n.budgetEstimate ? ` (бюджет ~${n.budgetEstimate} ₽)` : ""}`)
    .join("\n");

  return `# ${candidate.title}

## Для кого
Люди и бизнесы с похожей потребностью в категории «${candidate.category.label}».

## Что внутри
1. Диагностика задачи за 15 минут
2. Пошаговый план работ
3. Чеклист приёмки результата
4. Шаблоны сообщений исполнителю / клиенту
5. Типовые ошибки и как их избежать

## Сигналы спроса (собрано автоматически)
${examples || "—"}

## Быстрый старт (30 минут)
1. Сформулируйте цель одним предложением
2. Отметьте в чеклисте, что уже есть / чего нет
3. Выберите путь: сделать самим / делегировать / купить готовое
4. Зафиксируйте срок и бюджет
5. Сделайте первый измеримый шаг сегодня

## Чеклист
- [ ] Цель ясна и измерима
- [ ] Ограничения и дедлайн записаны
- [ ] Есть минимальный scope v1
- [ ] Понятен критерий «готово»
- [ ] Есть план на первые 48 часов

## Шаблон брифа
\`\`\`
Цель:
Контекст:
Что уже есть:
Что нужно на выходе:
Срок:
Бюджет:
Ограничения:
\`\`\`

## Шаблон ответа клиенту / исполнителю
\`\`\`
Здравствуйте! По задаче «${candidate.sampleNeeds[0]?.title || candidate.title}»:
- могу закрыть scope v1 за фиксированную цену
- срок: 2–5 дней
- в результате вы получите: ...
Если ок — напишите 3 уточнения, и стартую.
\`\`\`

---
Автоматически собрано AdvHarvest Autopilot · demand score ${candidate.demand}
`;
}

export function materializeProduct(candidate) {
  const dir = productsDir();
  const file = `${candidate.slug}.md`;
  const abs = join(dir, file);
  const content = generateProductContent(candidate);
  writeFileSync(abs, content, "utf8");

  const product = {
    id: candidate.slug,
    title: candidate.title,
    category: candidate.category,
    price: candidate.price,
    currency: candidate.currency || "RUB",
    demand: candidate.demand,
    file,
    path: `workspace/products/${file}`,
    sampleNeeds: candidate.sampleNeeds,
    createdAt: new Date().toISOString(),
    sales: 0,
    revenue: 0,
    active: true,
  };
  return product;
}

export function loadCatalog() {
  return loadJson("catalog.json", { products: [], updatedAt: null });
}

export function saveCatalog(catalog) {
  catalog.updatedAt = new Date().toISOString();
  saveJson("catalog.json", catalog);
  return catalog;
}

/**
 * Создаёт/обновляет продукты в каталоге из списка нужд.
 * Уже существующие по slug — усиливает demand, не плодит дубли.
 */
export function syncCatalogFromNeeds(needs, { maxNew = 8 } = {}) {
  const catalog = loadCatalog();
  const candidates = clusterNeedsIntoProducts(needs).slice(0, maxNew * 2);
  let created = 0;
  const results = [];

  for (const c of candidates) {
    const existing = catalog.products.find((p) => p.id === c.slug);
    if (existing) {
      existing.demand = Math.max(existing.demand, c.demand);
      existing.sampleNeeds = c.sampleNeeds;
      existing.price = Math.max(existing.price, c.price);
      results.push({ action: "refresh", product: existing });
      continue;
    }
    if (created >= maxNew) continue;
    const product = materializeProduct(c);
    catalog.products.push(product);
    created += 1;
    results.push({ action: "create", product });
  }

  saveCatalog(catalog);
  return { created, refreshed: results.filter((r) => r.action === "refresh").length, catalog, results };
}

export function getProductById(id) {
  const catalog = loadCatalog();
  return catalog.products.find((p) => p.id === id) || null;
}

export function readProductFile(product) {
  const abs = join(ROOT, product.path);
  if (!existsSync(abs)) throw new Error("Файл продукта не найден");
  return readFileSync(abs, "utf8");
}

export function listProductFiles() {
  const dir = productsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md"));
}
