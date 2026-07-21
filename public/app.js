const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const modeNames = {
  guide: "Гайд / ответ",
  micro_tool: "Микро-инструмент",
  service: "Услуга под ключ",
  matchmaker: "Подбор исполнителя",
};

let cachedFulfillments = [];

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка API");
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === false || v == null) continue;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function renderQueue(queue) {
  const root = document.getElementById("queue-list");
  root.innerHTML = "";
  const items = queue?.items || [];
  document.getElementById("queue-meta").textContent = items.length
    ? `${items.length} задач · сначала approved и paid`
    : "Очередь пуста — запустите цикл";

  if (!items.length) {
    root.append(el("p", { className: "empty", text: "Пока нечего делать" }));
    return;
  }

  for (const item of items) {
    const actions = el("div", { className: "offer-actions" });
    if (item.status === "ready") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Approve",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(item.fulfillmentId)}/approve`, {
              method: "POST",
            });
            await refresh();
          },
        })
      );
    }
    if (item.status === "approved") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Fulfill",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(item.fulfillmentId)}/realize`, {
              method: "POST",
              body: JSON.stringify({}),
            });
            await refresh();
          },
        })
      );
    }
    if (item.message) {
      actions.append(
        el("button", {
          className: "btn btn-small btn-ghost",
          text: "Copy msg",
          type: "button",
          onClick: async () => {
            await navigator.clipboard.writeText(item.message);
          },
        })
      );
    }

    root.append(
      el("article", { className: "queue-item" }, [
        el("div", {}, [
          el("p", { className: "offer-title", text: item.title }),
          el("p", {
            className: "offer-meta",
            text: `${modeNames[item.modeId] || item.modeId} · ${item.sourceLabel || ""} · score ${item.score}${
              item.paid ? " · PAID" : ""
            }`,
          }),
          el("p", { className: "offer-pitch", text: `→ ${item.nextAction}` }),
          item.message ? el("p", { className: "offer-draft", text: item.message }) : null,
          item.sourceUrl
            ? el("a", {
                className: "offer-link",
                href: item.sourceUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                text: "Открыть заказ / тред",
              })
            : null,
        ]),
        el("div", { className: "offer-side" }, [
          el("span", {
            className: `badge ${item.status}`,
            text: item.status,
          }),
          el("div", {
            className: "offer-money",
            text: money.format(item.expectedRevenue || 0),
          }),
          actions,
        ]),
      ])
    );
  }
}

function applyFilters(items) {
  const q = document.getElementById("filter-q").value.trim().toLowerCase();
  const status = document.getElementById("filter-status").value;
  const mode = document.getElementById("filter-mode").value;
  const paid = document.getElementById("filter-paid").checked;
  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (mode && item.modeId !== mode) return false;
    if (paid && !/fl\.ru/i.test(item.sourceLabel || "")) return false;
    if (q) {
      const blob = `${item.title} ${item.needSummary || ""} ${item.replyDraft || ""}`.toLowerCase();
      if (!blob.includes(q)) return false;
    }
    return true;
  });
}

function renderFulfillments(items) {
  const root = document.getElementById("offers");
  root.innerHTML = "";
  const filtered = applyFilters(items);
  if (!filtered.length) {
    root.append(el("p", { className: "empty", text: "Нет планов по фильтру" }));
    return;
  }

  for (const item of filtered) {
    const actions = el("div", { className: "offer-actions" });
    if (item.status === "ready") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Approve",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(item.id)}/approve`, { method: "POST" });
            await refresh();
          },
        })
      );
    }
    if (item.status === "approved") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Fulfill",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(item.id)}/realize`, {
              method: "POST",
              body: JSON.stringify({}),
            });
            await refresh();
          },
        })
      );
    }

    root.append(
      el("article", { className: "offer" }, [
        el("div", {}, [
          el("p", { className: "offer-title", text: item.title }),
          el("p", {
            className: "offer-meta",
            text: `${modeNames[item.modeId] || item.modeId} · ${item.category?.label || ""} · score ${item.score} · ${item.sourceLabel || ""}`,
          }),
          el("p", { className: "offer-pitch", text: item.needSummary || "" }),
          item.proposal?.price
            ? el("p", {
                className: "offer-meta",
                text: `КП: ${money.format(item.proposal.price.amount)} · срок ${item.proposal.timeline || "—"}`,
              })
            : null,
          item.replyDraft
            ? el("p", { className: "offer-draft", text: item.replyDraft })
            : null,
          item.solutionFile
            ? el("button", {
                className: "offer-link btn-link",
                type: "button",
                text: `Solution: ${item.solutionFile}`,
                onClick: () => openSolution(item.solutionFile),
              })
            : null,
          item.sourceUrl
            ? el("a", {
                className: "offer-link",
                href: item.sourceUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                text: "Источник",
              })
            : null,
        ]),
        el("div", { className: "offer-side" }, [
          el("span", {
            className: `badge ${item.status === "fulfilled" ? "realized" : item.status}`,
            text: item.status,
          }),
          el("div", {
            className: "offer-money",
            text: money.format(item.realizedAmount ?? item.expectedRevenue),
          }),
          actions,
        ]),
      ])
    );
  }
}

function renderNeeds(needs) {
  const root = document.getElementById("needs-list");
  root.innerHTML = "";
  if (!needs.length) {
    root.append(el("p", { className: "empty", text: "Ещё нет потребностей" }));
    return;
  }
  for (const n of needs.slice(0, 30)) {
    root.append(
      el(
        "a",
        {
          className: "need-row",
          href: n.url || "#",
          target: "_blank",
          rel: "noopener noreferrer",
        },
        [
          el("span", { className: "need-src", text: n.sourceLabel || n.sourceId }),
          el("span", { className: "need-title", text: n.title }),
          el("span", {
            className: "need-eng",
            text: n.budgetEstimate
              ? money.format(n.budgetEstimate)
              : `♥ ${Math.round(n.engagement || 0)}`,
          }),
        ]
      )
    );
  }
}

function renderSolutions(solutions) {
  const root = document.getElementById("solutions-list");
  root.innerHTML = "";
  if (!solutions?.length) {
    root.append(el("p", { className: "empty", text: "Пакетов пока нет" }));
    return;
  }
  for (const s of solutions.slice(0, 20)) {
    root.append(
      el(
        "button",
        {
          className: "solution-row",
          type: "button",
          onClick: () => openSolution(s.file),
        },
        [
          el("span", { className: "need-src", text: s.mode }),
          el("span", { className: "need-title", text: s.title }),
          el("span", { className: "need-eng", text: s.status }),
        ]
      )
    );
  }
}

async function openSolution(file) {
  const preview = document.getElementById("solution-preview");
  preview.hidden = false;
  preview.textContent = "Загрузка…";
  try {
    const data = await api(`/api/solutions/${encodeURIComponent(file)}`);
    preview.textContent = data.content;
    preview.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    preview.textContent = err.message;
  }
}

function renderSources(bySource = {}) {
  const root = document.getElementById("sources-breakdown");
  root.innerHTML = "";
  const entries = Object.entries(bySource);
  if (!entries.length) {
    root.append(el("span", { className: "source-chip", text: "источники появятся после скана" }));
    return;
  }
  for (const [k, v] of entries) {
    root.append(el("span", { className: "source-chip", text: `${k}: ${v}` }));
  }
}

function renderLedger(ledger) {
  const body = document.getElementById("ledger-body");
  body.innerHTML = "";
  if (!ledger.length) {
    body.append(el("tr", {}, [el("td", { colSpan: "5", className: "empty", text: "Пусто" })]));
    return;
  }
  for (const row of ledger.slice(0, 30)) {
    body.append(
      el("tr", {}, [
        el("td", { text: row.type === "realized" ? "реализовано" : "ожидаемо" }),
        el("td", { text: modeNames[row.channelId] || row.channelId }),
        el("td", { className: "mono", text: money.format(row.amount) }),
        el("td", {
          className: "mono",
          text: new Date(row.at).toLocaleString("ru-RU", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
        }),
        el("td", { text: row.note || "—" }),
      ])
    );
  }
}

async function refresh() {
  const data = await api("/api/dashboard");
  cachedFulfillments = data.fulfillments || [];
  document.getElementById("stat-needs").textContent = String(data.stats.needsSeen || 0);
  document.getElementById("stat-ready").textContent = String(data.stats.fulfillmentsReady || 0);
  document.getElementById("stat-packs").textContent = String(
    data.stats.solutionPacks || data.solutions?.length || 0
  );
  document.getElementById("stat-expected").textContent = money.format(
    data.stats.expectedRevenueTotal || 0
  );

  const cacheHint = data.cacheMeta?.fetchedAt
    ? `скаут: ${new Date(data.cacheMeta.fetchedAt).toLocaleString("ru-RU")}`
    : "ещё не сканировали";

  document.getElementById("pipeline-meta").textContent =
    `${data.fulfillments.length} планов · ${cacheHint}`;
  document.getElementById("needs-meta").textContent =
    data.needs.length > 0 ? `${data.needs.length} из сети · ${data.niche}` : "Ждём скан";

  renderSources(data.cacheMeta?.bySource);
  renderQueue(data.queue);
  renderFulfillments(cachedFulfillments);
  renderNeeds(data.needs);
  renderSolutions(data.solutions);
  renderLedger(data.ledger);
}

async function runCycle() {
  const buttons = [document.getElementById("btn-cycle"), document.getElementById("btn-cycle-hero")];
  for (const b of buttons) {
    b.disabled = true;
    b.textContent = "Работаем…";
  }
  try {
    const report = await api("/api/cycle?force=1", { method: "POST" });
    document.getElementById("pipeline-meta").textContent =
      `Сеть: ${report.scout?.count ?? 0} · планов +${report.planned} · ${report.expectedThisCycleLabel}`;
    renderSources(report.scout?.bySource);
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    for (const b of buttons) {
      b.disabled = false;
      b.textContent = b.id === "btn-cycle-hero" ? "Запустить сейчас" : "Сканировать + цикл";
    }
  }
}

async function batchApprove(paidOnly) {
  await api("/api/batch-approve", {
    method: "POST",
    body: JSON.stringify({ limit: paidOnly ? 3 : 5, paidOnly }),
  });
  await refresh();
}

document.getElementById("btn-cycle").addEventListener("click", runCycle);
document.getElementById("btn-cycle-hero").addEventListener("click", runCycle);
document.getElementById("btn-batch").addEventListener("click", () => batchApprove(false));
document.getElementById("btn-batch-paid").addEventListener("click", () => batchApprove(true));
document.getElementById("btn-reset").addEventListener("click", async () => {
  if (!confirm("Сбросить состояние?")) return;
  await api("/api/reset", { method: "POST" });
  document.getElementById("solution-preview").hidden = true;
  await refresh();
});

for (const id of ["filter-q", "filter-status", "filter-mode", "filter-paid"]) {
  document.getElementById(id).addEventListener("input", () => renderFulfillments(cachedFulfillments));
  document.getElementById(id).addEventListener("change", () => renderFulfillments(cachedFulfillments));
}

refresh().catch((err) => {
  document.getElementById("offers").innerHTML = `<p class="empty">Ошибка: ${err.message}</p>`;
});
