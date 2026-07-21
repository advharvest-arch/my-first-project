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
  lead_sale: "Продажа лида",
  rev_share: "Комиссия",
  own_service: "Своя услуга",
  content_ads: "Контент / CPA",
};

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
    else if (k === "html") node.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function renderFulfillments(items) {
  const root = document.getElementById("offers");
  root.innerHTML = "";

  if (!items.length) {
    root.append(
      el("p", {
        className: "empty",
        text: "Пока пусто. Нажмите «Найти потребности» — система сходит в интернет.",
      })
    );
    return;
  }

  for (const item of items) {
    const actions = el("div", { className: "offer-actions" });
    const id = item.id;

    if (item.status === "ready") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Approve",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(id)}/approve`, { method: "POST" });
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
            await api(`/api/offers/${encodeURIComponent(id)}/realize`, {
              method: "POST",
              body: JSON.stringify({}),
            });
            await refresh();
          },
        })
      );
    }

    const steps = (item.steps || []).map((s) => el("li", { text: s }));

    root.append(
      el("article", { className: "offer" }, [
        el("div", {}, [
          el("p", { className: "offer-title", text: item.title }),
          el("p", {
            className: "offer-meta",
            text: `${modeNames[item.modeId] || item.modeId} · ${item.category?.label || ""} · score ${item.score} · ${item.sourceLabel || ""}`,
          }),
          el("p", { className: "offer-pitch", text: item.needSummary || item.replyDraft }),
          item.replyDraft
            ? el("p", {
                className: "offer-draft",
                text: `Черновик ответа: ${item.replyDraft}`,
              })
            : null,
          steps.length ? el("ol", { className: "offer-steps" }, steps) : null,
          item.sourceUrl
            ? el("a", {
                className: "offer-link",
                href: item.sourceUrl,
                target: "_blank",
                rel: "noopener noreferrer",
                text: "Открыть источник",
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
    root.append(el("p", { className: "empty", text: "Ещё нет сохранённых потребностей" }));
    return;
  }
  for (const n of needs.slice(0, 20)) {
    root.append(
      el("a", {
        className: "need-row",
        href: n.url || "#",
        target: "_blank",
        rel: "noopener noreferrer",
      }, [
        el("span", { className: "need-src", text: n.sourceLabel || n.sourceId }),
        el("span", { className: "need-title", text: n.title }),
        el("span", {
          className: "need-eng",
          text: `♥ ${Math.round(n.engagement || 0)}`,
        }),
      ])
    );
  }
}

function renderLedger(ledger) {
  const body = document.getElementById("ledger-body");
  body.innerHTML = "";

  if (!ledger.length) {
    body.append(
      el("tr", {}, [el("td", { colSpan: "5", className: "empty", text: "Записей пока нет" })])
    );
    return;
  }

  for (const row of ledger.slice(0, 30)) {
    body.append(
      el("tr", {}, [
        el("td", {
          text: row.type === "realized" ? "реализовано" : "ожидаемо",
        }),
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
  document.getElementById("stat-needs").textContent = String(data.stats.needsSeen || 0);
  document.getElementById("stat-ready").textContent = String(data.stats.fulfillmentsReady || 0);
  document.getElementById("stat-fulfilled").textContent = String(data.stats.needsFulfilled || 0);
  document.getElementById("stat-expected").textContent = money.format(
    data.stats.expectedRevenueTotal || 0
  );

  const cacheHint = data.cacheMeta?.fetchedAt
    ? `последний скаут: ${new Date(data.cacheMeta.fetchedAt).toLocaleString("ru-RU")}`
    : "сканирование ещё не запускалось";

  document.getElementById("pipeline-meta").textContent =
    data.fulfillments.length > 0
      ? `${data.fulfillments.length} планов · ${cacheHint}`
      : `Нажмите «Найти потребности» · ${cacheHint}`;

  document.getElementById("needs-meta").textContent =
    data.needs.length > 0
      ? `${data.needs.length} из сети · ${data.niche}`
      : "Появятся после сканирования";

  renderFulfillments(data.fulfillments);
  renderNeeds(data.needs);
  renderLedger(data.ledger);
}

async function runCycle() {
  const buttons = [document.getElementById("btn-cycle"), document.getElementById("btn-cycle-hero")];
  for (const b of buttons) {
    b.disabled = true;
    b.textContent = "Сканируем…";
  }
  try {
    const report = await api("/api/cycle?force=1", { method: "POST" });
    const err = report.scout?.errors?.length
      ? ` (часть источников: ${report.scout.errors.map((e) => e.source).join(", ")})`
      : "";
    document.getElementById("pipeline-meta").textContent =
      `Найдено в сети: ${report.scout?.count ?? 0} · планов: ${report.planned}${err}`;
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    for (const b of buttons) {
      b.disabled = false;
      b.textContent = b.id === "btn-cycle-hero" ? "Сканировать интернет" : "Найти потребности";
    }
  }
}

document.getElementById("btn-cycle").addEventListener("click", runCycle);
document.getElementById("btn-cycle-hero").addEventListener("click", runCycle);
document.getElementById("btn-reset").addEventListener("click", async () => {
  if (!confirm("Сбросить состояние?")) return;
  await api("/api/reset", { method: "POST" });
  await refresh();
});

refresh().catch((err) => {
  console.error(err);
  document.getElementById("offers").innerHTML =
    `<p class="empty">Не удалось загрузить данные: ${err.message}</p>`;
});
