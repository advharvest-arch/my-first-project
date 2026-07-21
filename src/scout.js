/**
 * Web Scout — поиск насущных потребностей людей в открытом интернете.
 *
 * Источники:
 * - FL.ru RSS (реальные заказы с бюджетом, RU)
 * - Hacker News Ask (Algolia)
 * - Stack Overflow / SO RU
 * - GitHub Issues
 * - Lobsters
 */

import { createHash } from "node:crypto";
import { loadJson, saveJson } from "./store.js";
import { getConfig } from "./config.js";
import { fetchRss } from "./rss.js";

const UA = "AdvHarvestAutopilot/1.0 (+need-discovery; educational)";

const NEED_HINT =
  /\b(need|needs|looking for|how (do|can|to)|help|recommend|struggling|want|seeking|anyone know|is there a|ищет|нужен|нужна|нужно|помог|как сделать|подскажите|ищу|рекоменд|не могу|проблема|требуется|зака[зж])\b/i;

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: "application/json", "User-Agent": UA },
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

function parseBudgetRub(text = "") {
  // Явный бюджет в заголовках FL: "Бюджет: 70 000 ₽"
  const explicit = String(text).match(/бюджет\s*[:\-]?\s*(\d[\d\s]{1,12})\s*(₽|руб|rub|&#8381;)?/i);
  if (explicit) return Number(explicit[1].replace(/\s/g, ""));

  const withCurrency = String(text).match(/(\d[\d\s]{2,12})\s*(₽|руб\.?|rub|&#8381;)/i);
  if (withCurrency) return Number(withCurrency[1].replace(/\s/g, ""));

  return 0;
}

function keywordBoost(text, keywords = []) {
  const lower = text.toLowerCase();
  let boost = 0;
  for (const kw of keywords) {
    if (kw && lower.includes(String(kw).toLowerCase())) boost += 2;
  }
  return Math.min(20, boost);
}

/** FL.ru — живые заказы = прямые денежные потребности */
export async function scoutFlRu({ limit = 40, keywords = [] } = {}) {
  const items = await fetchRss("https://www.fl.ru/rss/all.xml", { userAgent: UA });
  return items.slice(0, limit).map((it) => {
    const blob = `${it.title} ${it.description}`;
    const budget = parseBudgetRub(it.title) || parseBudgetRub(it.description);
    return {
      id: hashId("flru", it.guid || it.link || it.title),
      sourceId: "flru",
      sourceLabel: "FL.ru",
      title: it.title.replace(/\s*\(Бюджет:.*?\)\s*$/i, "").trim(),
      body: it.description.slice(0, 500),
      url: it.link,
      language: "ru",
      engagement: 20 + keywordBoost(blob, keywords) + (budget ? Math.min(30, Math.log10(budget) * 4) : 0),
      budgetEstimate: budget,
      createdAt: it.pubDate ? new Date(it.pubDate).toISOString() : new Date().toISOString(),
      rawTags: ["freelance", "paid_need"],
      monetizable: true,
    };
  });
}

export async function scoutHackerNews({ limit = 20, keywords = [] } = {}) {
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
        engagement:
          Number(hit.points || 0) +
          Number(hit.num_comments || 0) * 1.5 +
          12 +
          keywordBoost(blob, keywords),
        createdAt: hit.created_at || new Date().toISOString(),
        rawTags: ["ask_hn"],
      });
    }
  }
  return out.slice(0, limit);
}

export async function scoutStackExchange({
  sites = ["ru.stackoverflow", "stackoverflow"],
  pagesize = 8,
  keywords = [],
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
          q: site.startsWith("ru.")
            ? "нужно OR подскажите OR ищу OR как"
            : "how do I OR looking for OR need OR recommend",
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

    for (const endpoint of endpoints) {
      const data = await fetchJson(endpoint);
      for (const q of data.items || []) {
        const title = q.title || "";
        const ageDays = (Date.now() / 1000 - Number(q.creation_date || 0)) / 86400;
        const freshBoost = ageDays < 30 ? 8 : ageDays < 180 ? 3 : 0;
        if (!looksLikeNeed(title) && Number(q.score || 0) + freshBoost < 10) continue;

        out.push({
          id: hashId(site, String(q.question_id)),
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
            (ageDays < 7 ? 10 : 0) +
            keywordBoost(title, keywords),
          createdAt: new Date((q.creation_date || 0) * 1000).toISOString(),
          rawTags: q.tags || [],
        });
      }
    }
  }

  const seen = new Set();
  return out.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}

export async function scoutGitHub({ perPage = 12, keywords = [] } = {}) {
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
        engagement: Number(issue.comments || 0) * 2 + 1 + keywordBoost(blob, keywords),
        createdAt: issue.created_at || new Date().toISOString(),
        rawTags: (issue.labels || []).map((l) => (typeof l === "string" ? l : l.name)).filter(Boolean),
        _blob: blob,
      };
    })
    .filter((n) => looksLikeNeed(n._blob) && n.title.length >= 12)
    .map(({ _blob, ...n }) => n);
}

export async function scoutLobsters({ limit = 15, keywords = [] } = {}) {
  const data = await fetchJson("https://lobste.rs/active.json");
  const list = Array.isArray(data) ? data : [];
  return list
    .filter((story) => {
      const blob = `${story.title || ""} ${(story.tags || []).join(" ")}`;
      return looksLikeNeed(blob) || (story.tags || []).includes("ask");
    })
    .slice(0, limit)
    .map((story) => ({
      id: hashId("lobsters", String(story.short_id || story.url)),
      sourceId: "lobsters",
      sourceLabel: "Lobsters",
      title: story.title || "",
      body: (story.tags || []).map((t) => `#${t}`).join(" "),
      url: story.url || `https://lobste.rs/s/${story.short_id}`,
      language: "en",
      engagement: Number(story.score || 0) + Number(story.comment_count || 0) + keywordBoost(story.title || "", keywords),
      createdAt: story.created_at || new Date().toISOString(),
      rawTags: story.tags || [],
    }));
}

export async function scoutWebNeeds(options = {}) {
  const cfg = getConfig();
  const scoutCfg = { ...cfg.scout, ...options };
  const enabled = scoutCfg.enabled || {};
  const keywords = cfg.keywordsBoost || [];
  const errors = [];
  const jobs = [];

  if (enabled.flru !== false) {
    jobs.push(["flru", scoutFlRu({ limit: scoutCfg.flLimit ?? 40, keywords })]);
  }
  if (enabled.hackernews !== false) {
    jobs.push(["hackernews", scoutHackerNews({ limit: scoutCfg.hnLimit ?? 16, keywords })]);
  }
  if (enabled.stackoverflow !== false || enabled.stackoverflow_ru !== false) {
    const sites = [];
    if (enabled.stackoverflow_ru !== false) sites.push("ru.stackoverflow");
    if (enabled.stackoverflow !== false) sites.push("stackoverflow");
    jobs.push(["stackexchange", scoutStackExchange({ sites, pagesize: scoutCfg.sePageSize ?? 8, keywords })]);
  }
  if (enabled.github !== false) {
    jobs.push(["github", scoutGitHub({ perPage: scoutCfg.ghPerPage ?? 8, keywords })]);
  }
  if (enabled.lobsters !== false) {
    jobs.push(["lobsters", scoutLobsters({ limit: scoutCfg.lobstersLimit ?? 15, keywords })]);
  }

  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const needs = [];
  settled.forEach((result, i) => {
    const source = jobs[i][0];
    if (result.status === "fulfilled") needs.push(...result.value);
    else errors.push({ source, error: String(result.reason?.message || result.reason) });
  });

  const uniq = [];
  const seenTitle = new Set();
  for (const n of needs) {
    const key = n.title.toLowerCase().replace(/\W+/g, " ").trim().slice(0, 80);
    if (!key || seenTitle.has(key)) continue;
    seenTitle.add(key);
    uniq.push(n);
  }

  uniq.sort((a, b) => {
    const pa = a.monetizable ? 50 : 0;
    const pb = b.monetizable ? 50 : 0;
    return pb + b.engagement - (pa + a.engagement);
  });

  const bySource = {};
  for (const n of uniq) bySource[n.sourceId] = (bySource[n.sourceId] || 0) + 1;

  const payload = {
    fetchedAt: new Date().toISOString(),
    count: uniq.length,
    bySource,
    errors,
    needs: uniq,
  };
  saveJson("needs-cache.json", payload);
  return payload;
}

export async function getFreshNeeds({ force = false, maxAgeMin } = {}) {
  const cfg = getConfig();
  const age = maxAgeMin ?? cfg.scout?.maxAgeMin ?? 20;
  const cache = loadJson("needs-cache.json", null);
  if (
    !force &&
    cache?.fetchedAt &&
    Date.now() - new Date(cache.fetchedAt).getTime() < age * 60_000 &&
    cache.needs?.length
  ) {
    return { ...cache, fromCache: true };
  }
  try {
    const fresh = await scoutWebNeeds();
    return { ...fresh, fromCache: false };
  } catch (err) {
    if (cache?.needs?.length) {
      return {
        ...cache,
        fromCache: true,
        errors: [{ source: "scout", error: String(err.message || err) }],
      };
    }
    throw err;
  }
}
