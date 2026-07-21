/**
 * Web Scout — поиск насущных потребностей людей в открытом интернете.
 *
 * Источники (публичные API, без обхода блокировок / без логинов):
 * - Hacker News Ask (Algolia)
 * - Stack Overflow / Stack Overflow на русском
 * - GitHub Issues (открытые просьбы о помощи)
 *
 * При сбое сети — fallback на локальный кэш data/needs-cache.json.
 */

import { createHash } from "node:crypto";
import { loadJson, saveJson } from "./store.js";

const UA = "AdvHarvestAutopilot/1.0 (+need-discovery; educational)";

const NEED_HINT =
  /\b(need|needs|looking for|how (do|can|to)|help|recommend|struggling|want|seeking|anyone know|is there a|ищет|нужен|нужна|нужно|помог|как сделать|подскажите|ищу|рекоменд|не могу|проблема)\b/i;

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": UA,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function hashId(source, raw) {
  return `need_${createHash("sha1").update(`${source}:${raw}`).digest("hex").slice(0, 12)}`;
}

function stripHtml(html = "") {
  return String(html)
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeNeed(text) {
  return NEED_HINT.test(text);
}

/** Hacker News Ask — живые вопросы «что нужно / как сделать» */
export async function scoutHackerNews({ limit = 20 } = {}) {
  const queries = [
    "need OR looking for OR struggling OR recommend",
    "how do I OR how can I OR is there a tool",
    "help OR seeking OR want to build",
  ];
  const seen = new Set();
  const out = [];

  for (const query of queries) {
    const url =
      "https://hn.algolia.com/api/v1/search_by_date?" +
      new URLSearchParams({
        tags: "ask_hn",
        query,
        hitsPerPage: String(Math.ceil(limit / queries.length) + 2),
      });
    const data = await fetchJson(url);
    for (const hit of data.hits || []) {
      const title = hit.title || "";
      const text = stripHtml(hit.story_text || hit.comment_text || "");
      const blob = `${title} ${text}`;
      if (!looksLikeNeed(blob)) continue;
      const id = hashId("hn", String(hit.objectID));
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        sourceId: "hackernews",
        sourceLabel: "Hacker News Ask",
        title: title.replace(/^Ask HN:\s*/i, "").trim() || title,
        body: text.slice(0, 500),
        url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
        language: "en",
        engagement: Number(hit.points || 0) + Number(hit.num_comments || 0) * 1.5 + 12,
        createdAt: hit.created_at || new Date().toISOString(),
        rawTags: ["ask_hn"],
      });
    }
  }
  return out.slice(0, limit);
}

/** Stack Exchange — свежие вопросы с болью + сильные unanswered */
export async function scoutStackExchange({
  sites = ["ru.stackoverflow", "stackoverflow"],
  pagesize = 8,
} = {}) {
  const out = [];
  for (const site of sites) {
    const endpoints = [
      `https://api.stackexchange.com/2.3/search/advanced?` +
        new URLSearchParams({
          order: "desc",
          sort: "activity",
          accepted: "False",
          site,
          pagesize: String(pagesize),
          q: site.startsWith("ru.") ? "нужно OR подскажите OR ищу OR как" : "how do I OR looking for OR need OR recommend",
          filter: "default",
        }),
      `https://api.stackexchange.com/2.3/questions/unanswered?` +
        new URLSearchParams({
          order: "desc",
          sort: "votes",
          site,
          pagesize: String(Math.max(3, Math.floor(pagesize / 2))),
          filter: "default",
        }),
    ];

    for (const unanswered of endpoints) {
      const data = await fetchJson(unanswered);
      for (const q of data.items || []) {
        const title = q.title || "";
        const ageDays = (Date.now() / 1000 - Number(q.creation_date || 0)) / 86400;
        const freshBoost = ageDays < 30 ? 8 : ageDays < 180 ? 3 : 0;
        if (!looksLikeNeed(title) && Number(q.score || 0) + freshBoost < 10) continue;

        const id = hashId(site, String(q.question_id));
        out.push({
          id,
          sourceId: site.startsWith("ru.") ? "stackoverflow_ru" : "stackoverflow",
          sourceLabel: site.startsWith("ru.") ? "Stack Overflow RU" : "Stack Overflow",
          title,
          body: (q.tags || []).map((t) => `#${t}`).join(" "),
          url: q.link,
          language: site.startsWith("ru.") ? "ru" : "en",
          engagement:
            Number(q.score || 0) * 2 +
            Number(q.view_count || 0) / 80 +
            freshBoost +
            (ageDays < 7 ? 10 : 0),
          createdAt: new Date((q.creation_date || 0) * 1000).toISOString(),
          rawTags: q.tags || [],
        });
      }
    }
  }

  // дедуп внутри SE
  const seen = new Set();
  return out.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

/** GitHub — открытые issues с просьбами о помощи / инструментах */
export async function scoutGitHub({ perPage = 12 } = {}) {
  const q =
    '("looking for" OR "need help with" OR "is there a way" OR "нужна помощь" OR "подскажите как") is:issue is:open -label:wontfix';
  const url =
    "https://api.github.com/search/issues?" +
    new URLSearchParams({ q, per_page: String(perPage), sort: "updated", order: "desc" });
  const data = await fetchJson(url);
  return (data.items || [])
    .map((issue) => {
      const title = issue.title || "";
      const body = stripHtml((issue.body || "").slice(0, 400));
      const blob = `${title} ${body}`;
      return {
        id: hashId("github", String(issue.id)),
        sourceId: "github",
        sourceLabel: "GitHub Issues",
        title,
        body,
        url: issue.html_url,
        language: /[а-яё]/i.test(blob) ? "ru" : "en",
        engagement: Number(issue.comments || 0) * 2 + 1,
        createdAt: issue.created_at || new Date().toISOString(),
        rawTags: (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
        _blob: blob,
      };
    })
    .filter((n) => looksLikeNeed(n._blob) && n.title.length >= 12)
    .map(({ _blob, ...n }) => n);
}

/**
 * Полный проход по сети. Ошибки источников глотаем по одному —
 * система должна работать даже если 1–2 API недоступны.
 */
export async function scoutWebNeeds(options = {}) {
  const errors = [];
  const batches = await Promise.allSettled([
    scoutHackerNews({ limit: options.hnLimit ?? 18 }),
    scoutStackExchange({
      pagesize: options.sePageSize ?? 8,
      sites: options.sites ?? ["ru.stackoverflow", "stackoverflow"],
    }),
    scoutGitHub({ perPage: options.ghPerPage ?? 10 }),
  ]);

  const needs = [];
  const labels = ["hackernews", "stackexchange", "github"];
  batches.forEach((result, i) => {
    if (result.status === "fulfilled") needs.push(...result.value);
    else errors.push({ source: labels[i], error: String(result.reason?.message || result.reason) });
  });

  // дедуп по нормализованному title
  const uniq = [];
  const seenTitle = new Set();
  for (const n of needs) {
    const key = n.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 80);
    if (!key || seenTitle.has(key)) continue;
    seenTitle.add(key);
    uniq.push(n);
  }

  uniq.sort((a, b) => b.engagement - a.engagement);

  const payload = {
    fetchedAt: new Date().toISOString(),
    count: uniq.length,
    errors,
    needs: uniq,
  };
  saveJson("needs-cache.json", payload);
  return payload;
}

/** Кэш или свежий scrape */
export async function getFreshNeeds({ force = false, maxAgeMin = 30 } = {}) {
  const cache = loadJson("needs-cache.json", null);
  if (
    !force &&
    cache?.fetchedAt &&
    Date.now() - new Date(cache.fetchedAt).getTime() < maxAgeMin * 60_000 &&
    cache.needs?.length
  ) {
    return { ...cache, fromCache: true };
  }
  try {
    const fresh = await scoutWebNeeds();
    return { ...fresh, fromCache: false };
  } catch (err) {
    if (cache?.needs?.length) {
      return { ...cache, fromCache: true, errors: [{ source: "scout", error: String(err.message || err) }] };
    }
    throw err;
  }
}
