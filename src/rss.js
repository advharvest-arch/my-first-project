/**
 * Минимальный RSS 2.0 парсер без зависимостей.
 */

export async function fetchRss(url, { timeoutMs = 15000, userAgent } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/rss+xml, application/xml, text/xml, */*",
        "User-Agent": userAgent || "AdvHarvestAutopilot/1.0 (+rss; research)",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const xml = await res.text();
    return parseRss(xml);
  } finally {
    clearTimeout(t);
  }
}

export function parseRss(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of blocks) {
    items.push({
      title: decode(inner(block, "title")),
      link: decode(inner(block, "link") || attr(block, "link", "href")),
      description: stripHtml(decode(inner(block, "description") || inner(block, "content:encoded"))),
      pubDate: decode(inner(block, "pubDate") || inner(block, "dc:date") || ""),
      guid: decode(inner(block, "guid") || ""),
      category: decode(inner(block, "category") || ""),
    });
  }
  return items;
}

function inner(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : "";
}

function attr(block, tag, name) {
  const re = new RegExp(`<${tag}[^>]*\\s${name}=["']([^"']+)["'][^>]*/?>`, "i");
  const m = block.match(re);
  return m ? m[1] : "";
}

function decode(s = "") {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8381;/g, "₽")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")
    .trim();
}

function stripHtml(html = "") {
  return String(html)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
