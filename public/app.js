const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const channelNames = {
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
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function renderOffers(offers) {
  const root = document.getElementById("offers");
  root.innerHTML = "";

  if (!offers.length) {
    root.append(el("p", { className: "empty", text: "Пока пусто. Нажмите «Запустить цикл»." }));
    return;
  }

  for (const offer of offers) {
    const actions = el("div", { className: "offer-actions" });

    if (offer.status === "ready") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Approve",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(offer.id)}/approve`, { method: "POST" });
            await refresh();
          },
        })
      );
    }

    if (offer.status === "approved") {
      actions.append(
        el("button", {
          className: "btn btn-small btn-primary",
          text: "Realize",
          type: "button",
          onClick: async () => {
            await api(`/api/offers/${encodeURIComponent(offer.id)}/realize`, {
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
          el("p", { className: "offer-title", text: offer.title }),
          el("p", {
            className: "offer-meta",
            text: `${channelNames[offer.channelId] || offer.channelId} · ${offer.status}`,
          }),
          el("p", { className: "offer-pitch", text: offer.pitch }),
        ]),
        el("div", { className: "offer-side" }, [
          el("span", { className: `badge ${offer.status}`, text: offer.status }),
          el("div", {
            className: "offer-money",
            text: money.format(offer.realizedAmount ?? offer.expectedRevenue),
          }),
          actions,
        ]),
      ])
    );
  }
}

function renderLedger(ledger) {
  const body = document.getElementById("ledger-body");
  body.innerHTML = "";

  if (!ledger.length) {
    body.append(
      el("tr", {}, [
        el("td", { colSpan: "5", className: "empty", text: "Записей пока нет" }),
      ])
    );
    return;
  }

  for (const row of ledger.slice(0, 30)) {
    body.append(
      el("tr", {}, [
        el("td", { text: row.type === "realized" ? "реализовано" : "ожидаемо" }),
        el("td", { text: channelNames[row.channelId] || row.channelId }),
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
  document.getElementById("stat-expected").textContent = money.format(
    data.stats.expectedRevenueTotal || 0
  );
  document.getElementById("stat-realized").textContent = money.format(
    data.stats.realizedRevenueTotal || 0
  );
  document.getElementById("stat-cycles").textContent = String(data.stats.cycles || 0);
  document.getElementById("stat-threshold").textContent = String(data.config.minScore);
  document.getElementById("pipeline-meta").textContent =
    data.offers.length > 0
      ? `${data.offers.length} офферов · ниша: ${data.niche}`
      : "Запустите цикл, чтобы увидеть офферы";
  renderOffers(data.offers);
  renderLedger(data.ledger);
}

async function runCycle() {
  const buttons = [document.getElementById("btn-cycle"), document.getElementById("btn-cycle-hero")];
  for (const b of buttons) b.disabled = true;
  try {
    await api("/api/cycle", { method: "POST" });
    await refresh();
  } catch (err) {
    alert(err.message);
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

document.getElementById("btn-cycle").addEventListener("click", runCycle);
document.getElementById("btn-cycle-hero").addEventListener("click", runCycle);
document.getElementById("btn-reset").addEventListener("click", async () => {
  if (!confirm("Сбросить состояние автопилота?")) return;
  await api("/api/reset", { method: "POST" });
  await refresh();
});

refresh().catch((err) => {
  console.error(err);
  document.getElementById("offers").innerHTML =
    `<p class="empty">Не удалось загрузить данные: ${err.message}</p>`;
});
