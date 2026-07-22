const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Ошибка");
  return data;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "className") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on") && typeof v === "function")
      node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v == null || v === false) continue;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function refresh() {
  const data = await api("/api/commerce");
  document.getElementById("rev").textContent = money.format(data.stats.grossRevenue || 0);
  document.getElementById("paid").textContent = String(data.stats.ordersPaid || 0);
  document.getElementById("count").textContent = String(data.catalogCount || 0);
  document.getElementById("mode").textContent = data.mode || "auto";

  const root = document.getElementById("products");
  root.innerHTML = "";
  const products = data.topProducts || [];
  document.getElementById("store-meta").textContent = products.length
    ? `${products.length} активных продуктов`
    : "Нажмите «Запустить автозаработок»";

  if (!products.length) {
    root.append(el("p", { className: "empty", text: "Каталог пуст" }));
  } else {
    for (const p of products) {
      root.append(
        el("article", { className: "offer" }, [
          el("div", {}, [
            el("p", { className: "offer-title", text: p.title }),
            el("p", {
              className: "offer-meta",
              text: `${p.category?.label || ""} · demand ${p.demand} · продаж ${p.sales || 0}`,
            }),
            el("p", {
              className: "offer-pitch",
              text: `Цифровой пакет. Мгновенная выдача после оплаты.`,
            }),
          ]),
          el("div", { className: "offer-side" }, [
            el("div", { className: "offer-money", text: money.format(p.price) }),
            el("button", {
              className: "btn btn-small btn-primary",
              type: "button",
              text: "Купить сейчас",
              onClick: async () => {
                const result = await api("/api/checkout", {
                  method: "POST",
                  body: JSON.stringify({ productId: p.id }),
                });
                if (result.downloadPath) {
                  window.location.href = result.downloadPath;
                }
                await refresh();
              },
            }),
          ]),
        ])
      );
    }
  }

  const body = document.getElementById("orders");
  body.innerHTML = "";
  const orders = data.recentOrders || [];
  if (!orders.length) {
    body.append(el("tr", {}, [el("td", { colSpan: "5", className: "empty", text: "Продаж пока нет" })]));
    return;
  }
  for (const o of orders.slice(0, 20)) {
    body.append(
      el("tr", {}, [
        el("td", { text: o.status }),
        el("td", { text: o.productTitle }),
        el("td", { className: "mono", text: money.format(o.amount) }),
        el("td", {
          className: "mono",
          text: new Date(o.paidAt || o.createdAt).toLocaleString("ru-RU", {
            day: "2-digit",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          }),
        }),
        el(
          "td",
          {},
          o.delivery
            ? [
                el("a", {
                  className: "offer-link",
                  href: `/api/download/${o.id}/${o.delivery.token}`,
                  text: "файл",
                }),
              ]
            : ["—"]
        ),
      ])
    );
  }
}

document.getElementById("btn-earn").addEventListener("click", async () => {
  const btn = document.getElementById("btn-earn");
  btn.disabled = true;
  btn.textContent = "Зарабатываем…";
  try {
    const report = await api("/api/earn-cycle?force=1", { method: "POST" });
    alert(
      `Цикл: +${report.products.created} продуктов, продаж ${report.sales.count}, выручка ${report.sales.revenueLabel}`
    );
    await refresh();
  } catch (e) {
    alert(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Запустить автозаработок";
  }
});

refresh().catch((e) => {
  document.getElementById("products").innerHTML = `<p class="empty">${e.message}</p>`;
});
