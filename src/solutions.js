/**
 * Генерация пакетов решений в workspace/solutions/
 * Каждый план удовлетворения → markdown-файл с брифом, шагами и черновиком ответа.
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfig } from "./config.js";
import { FULFILL_MODES } from "./needs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function solutionsRoot() {
  const cfg = getConfig();
  const rel = cfg.fulfillment?.solutionsDir || "workspace/solutions";
  const abs = join(ROOT, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}

function safeName(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "need";
}

export function writeSolutionPack(plan, need = null) {
  const dir = solutionsRoot();
  const mode = FULFILL_MODES[plan.modeId] || { name: plan.modeId };
  const file = `${plan.createdAt?.slice(0, 10) || "draft"}_${safeName(plan.title)}_${plan.id.slice(-6)}.md`;
  const path = join(dir, file);

  const steps = (plan.steps || []).map((s, i) => `${i + 1}. ${s}`).join("\n");
  const md = `# ${plan.title}

## Мета
- **ID плана:** ${plan.id}
- **Потребность:** ${plan.needId}
- **Способ:** ${mode.name} (\`${plan.modeId}\`)
- **Категория:** ${plan.category?.label || "—"}
- **Score:** ${plan.score}
- **Срочность:** ${plan.urgency}
- **Источник:** [${plan.sourceLabel || "link"}](${plan.sourceUrl || "#"})
- **Язык:** ${plan.language || "—"}
- **Ожидаемая ценность:** ${plan.expectedRevenue} ${plan.currency || "RUB"}
- **Статус:** ${plan.status}
- **Создано:** ${plan.createdAt}

## Суть потребности
${plan.needSummary || plan.title}

${need?.body ? `### Детали из источника\n${need.body}\n` : ""}
${need?.budgetEstimate ? `**Бюджет в источнике:** ~${need.budgetEstimate} ₽\n` : ""}

## План удовлетворения
${steps}

## Черновик ответа человеку
> ${plan.replyDraft || "—"}

## Чеклист исполнения
- [ ] Изучить источник и уточнить scope
- [ ] Выполнить шаги плана
- [ ] Отправить ответ / оффер (после Approve)
- [ ] Зафиксировать результат (Fulfill)
- [ ] Собрать отзыв / кейс

## Заметки
_Пишите сюда ход работы._

---
Сгенерировано AdvHarvest Autopilot
`;

  writeFileSync(path, md, "utf8");
  return { path, file, relative: join("workspace/solutions", file) };
}

export function listSolutionPacks() {
  const dir = solutionsRoot();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((file) => {
      const path = join(dir, file);
      const content = readFileSync(path, "utf8");
      const title = content.match(/^#\s+(.+)$/m)?.[1] || file;
      const status = content.match(/\*\*Статус:\*\*\s*(.+)$/m)?.[1]?.trim() || "—";
      const mode = content.match(/\*\*Способ:\*\*\s*(.+)$/m)?.[1]?.trim() || "—";
      return { file, title, status, mode, path, relative: `workspace/solutions/${file}` };
    });
}

export function readSolutionPack(file) {
  const path = join(solutionsRoot(), file);
  if (!existsSync(path) || file.includes("..") || file.includes("/")) {
    throw new Error("Файл решения не найден");
  }
  return { file, content: readFileSync(path, "utf8"), relative: `workspace/solutions/${file}` };
}
