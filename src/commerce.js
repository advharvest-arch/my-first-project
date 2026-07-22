/**
 * Автопродажи: заказы, оплата, выдача цифрового продукта.
 *
 * Режимы:
 * 1) demo/auto — система сама симулирует покупки по demand (показывает автозаработок)
 * 2) live — реальные оплаты через Stripe (если задан STRIPE_SECRET_KEY)
 */

import { createHash, randomBytes } from "node:crypto";
import { loadJson, saveJson } from "./store.js";
import { getProductById, loadCatalog, saveCatalog, readProductFile } from "./products.js";
import { getConfig } from "./config.js";

export function loadCommerce() {
  return loadJson("commerce.json", {
    orders: [],
    customers: [],
    stats: {
      grossRevenue: 0,
      ordersPaid: 0,
      ordersPending: 0,
      autoSales: 0,
    },
  });
}

function saveCommerce(state) {
  saveJson("commerce.json", state);
  return state;
}

function orderId() {
  return `ord_${Date.now().toString(36)}_${randomBytes(3).toString("hex")}`;
}

export function createOrder({ productId, email = "buyer@auto.local", source = "store" }) {
  const product = getProductById(productId);
  if (!product || !product.active) throw new Error("Продукт не найден или выключен");

  const state = loadCommerce();
  const order = {
    id: orderId(),
    productId: product.id,
    productTitle: product.title,
    amount: product.price,
    currency: product.currency || "RUB",
    email,
    source,
    status: "pending",
    createdAt: new Date().toISOString(),
    paidAt: null,
    delivery: null,
  };
  state.orders.unshift(order);
  state.stats.ordersPending += 1;
  saveCommerce(state);
  return order;
}

/** Мгновенная «оплата» + автовыдача файла */
export function payAndDeliver(orderId, { provider = "demo", externalId = null } = {}) {
  const state = loadCommerce();
  const order = state.orders.find((o) => o.id === orderId);
  if (!order) throw new Error("Заказ не найден");
  if (order.status === "paid") return order;

  const product = getProductById(order.productId);
  if (!product) throw new Error("Продукт заказа исчез из каталога");

  const content = readProductFile(product);
  const token = createHash("sha256").update(`${order.id}:${product.id}`).digest("hex").slice(0, 24);

  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.provider = provider;
  order.externalId = externalId;
  order.delivery = {
    token,
    path: product.path,
    deliveredAt: new Date().toISOString(),
    bytes: Buffer.byteLength(content, "utf8"),
  };

  state.stats.ordersPaid += 1;
  state.stats.ordersPending = Math.max(0, state.stats.ordersPending - 1);
  state.stats.grossRevenue += order.amount;
  if (provider === "auto" || provider === "demo") state.stats.autoSales += 1;

  // обновить продажи в каталоге
  const catalog = loadCatalog();
  const p = catalog.products.find((x) => x.id === product.id);
  if (p) {
    p.sales = (p.sales || 0) + 1;
    p.revenue = (p.revenue || 0) + order.amount;
    saveCatalog(catalog);
  }

  saveCommerce(state);
  return { order, downloadPath: `/api/download/${order.id}/${token}` };
}

export function getOrder(orderId) {
  return loadCommerce().orders.find((o) => o.id === orderId) || null;
}

export function verifyDownload(orderId, token) {
  const order = getOrder(orderId);
  if (!order || order.status !== "paid") throw new Error("Нет доступа");
  if (!order.delivery || order.delivery.token !== token) throw new Error("Неверный токен");
  const product = getProductById(order.productId);
  const content = readProductFile(product);
  return { order, product, content };
}

/**
 * Автопилот продаж: чем выше demand, тем выше шанс «покупки».
 * Это симуляция рынка для замкнутого автозаработка в демо.
 * В live-режиме заменяется реальными Stripe webhook'ами.
 */
export function runAutoSales({ maxSales = 3 } = {}) {
  const cfg = getConfig();
  const mode = process.env.COMMERCE_MODE || cfg.commerce?.mode || "auto";
  const catalog = loadCatalog();
  const active = catalog.products.filter((p) => p.active).sort((a, b) => b.demand - a.demand);
  if (!active.length) return { mode, sold: [], revenue: 0 };

  const sold = [];
  let revenue = 0;

  for (const product of active) {
    if (sold.length >= maxSales) break;
    const chance = Math.min(0.85, 0.15 + product.demand / 120);
    if (mode === "auto" || mode === "demo") {
      if (Math.random() > chance) continue;
    } else {
      // live: автопродажи выключены — только реальные платежи
      continue;
    }

    const order = createOrder({
      productId: product.id,
      email: `auto+${Date.now().toString(36)}@advharvest.local`,
      source: "autosale",
    });
    const result = payAndDeliver(order.id, { provider: "auto" });
    sold.push(result);
    revenue += order.amount;
  }

  return { mode, sold, revenue, attempted: active.length };
}

export function getCommerceDashboard() {
  const state = loadCommerce();
  const catalog = loadCatalog();
  return {
    stats: state.stats,
    recentOrders: state.orders.slice(0, 30),
    topProducts: catalog.products
      .slice()
      .sort((a, b) => (b.revenue || 0) - (a.revenue || 0) || b.demand - a.demand)
      .slice(0, 20),
    catalogCount: catalog.products.length,
    mode: process.env.COMMERCE_MODE || getConfig().commerce?.mode || "auto",
  };
}

/** Stripe Checkout Session (если есть ключ) */
export async function createStripeCheckout(productId, successUrl, cancelUrl) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY не задан — используйте demo/auto режим");

  const product = getProductById(productId);
  if (!product) throw new Error("Продукт не найден");
  const order = createOrder({ productId, email: "stripe@pending", source: "stripe" });

  // сумма в копейках
  const unitAmount = Math.round(product.price * 100);
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", `${successUrl}?order=${order.id}`);
  body.set("cancel_url", cancelUrl);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", "rub");
  body.set("line_items[0][price_data][unit_amount]", String(unitAmount));
  body.set("line_items[0][price_data][product_data][name]", product.title.slice(0, 120));
  body.set("metadata[orderId]", order.id);
  body.set("client_reference_id", order.id);

  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "Stripe error");

  const state = loadCommerce();
  const o = state.orders.find((x) => x.id === order.id);
  if (o) {
    o.externalId = data.id;
    o.provider = "stripe";
    saveCommerce(state);
  }
  return { orderId: order.id, url: data.url, sessionId: data.id };
}
