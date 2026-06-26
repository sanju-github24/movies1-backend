/**
 * rssProxy.js — FilmiBeat RSS Proxy Router
 *
 * Mount this in your Express app:
 *   import rssProxy from './server/rssProxy.js';
 *   app.use('/api', rssProxy);
 *
 * Endpoints:
 *   GET /api/rss?feed=bollywood|tamil|telugu|kannada|malayalam|hollywood|tv|ott|all
 *   &count=20        max articles per feed (default 25)
 *   &search=akshay  keyword filter (server-side)
 *
 * Requires Node 18+ (uses native fetch for HTTP/2 + proper TLS, avoiding
 * Cloudflare blocks that affect the legacy https.get() module).
 */

import express from "express";
import { XMLParser } from "fast-xml-parser";

const router = express.Router();

// ─── Feed Registry ────────────────────────────────────────────────────────────
const FEED_MAP = {
  bollywood: "https://www.filmibeat.com/rss/feeds/bollywood-fb.xml",
  tamil:     "https://www.filmibeat.com/rss/feeds/tamil-fb.xml",
  telugu:    "https://www.filmibeat.com/rss/feeds/telugu-fb.xml",
  kannada:   "https://www.filmibeat.com/rss/feeds/kannada-fb.xml",
  malayalam: "https://www.filmibeat.com/rss/feeds/malayalam-fb.xml",
  hollywood: "https://www.filmibeat.com/rss/feeds/english-hollywood-fb.xml",
  tv:        "https://www.filmibeat.com/rss/feeds/television-fb.xml",
  ott:       "https://www.filmibeat.com/rss/feeds/ott-fb.xml",
};

// In-memory cache: { feedKey: { ts, data } }
const cache = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetch a URL using native fetch() (Node 18+).
 *
 * Why not https.get()?
 * filmibeat sits behind Cloudflare. Cloudflare prefers HTTP/2 and modern TLS
 * negotiation. Node's legacy https.get() speaks HTTP/1.1 only and lacks the
 * proper handshake, so Cloudflare randomly returns 403/530 for some feed paths.
 * Native fetch() behaves like a real browser request (HTTP/2, gzip, etc.)
 * and passes through without issues.
 */
async function fetchUrl(url, redirectCount = 0) {
  if (redirectCount > 5) throw new Error("Too many redirects");

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/125.0.0.0 Safari/537.36",
      "Accept":          "application/rss+xml, application/xml, text/xml, */*",
      "Accept-Language": "en-IN,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Referer":         "https://www.filmibeat.com/",
      "Cache-Control":   "no-cache",
    },
    redirect: "follow",   // native fetch handles redirects automatically
    signal: AbortSignal.timeout(12000),
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  }

  return res.text();
}

// ─── Parse ───────────────────────────────────────────────────────────────────

function parseRSS(xml, feedKey) {
  const parser = new XMLParser({
    ignoreAttributes:    false,
    attributeNamePrefix: "@_",
    cdataPropName:       "__cdata",
  });

  const parsed  = parser.parse(xml);
  const channel = parsed?.rss?.channel || {};
  const items   = Array.isArray(channel.item)
    ? channel.item
    : channel.item ? [channel.item] : [];

  return items.map((item) => {
    // Thumbnail: media:content > media:thumbnail > enclosure > first <img> in body
    let thumbnail =
      item["media:content"]?.["@_url"] ||
      item["media:thumbnail"]?.["@_url"] ||
      item.enclosure?.["@_url"] ||
      "";

    if (!thumbnail) {
      const desc = item.description?.__cdata || item.description || "";
      const m    = desc.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) thumbnail = m[1];
    }

    const description =
      item.description?.__cdata ||
      item.description ||
      item["content:encoded"]?.__cdata ||
      "";

    const preview = description
      .replace(/<[^>]+>/g, " ")
      .replace(/&[a-z#0-9]+;/gi, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 200);

    const rawCategory =
      (Array.isArray(item.category) ? item.category[0] : item.category) || feedKey;

    return {
      id:        item.guid?.__cdata    || item.guid    || item.link || "",
      title:     item.title?.__cdata   || item.title   || "Untitled",
      link:      item.link?.__cdata    || item.link    || item.guid || "",
      pubDate:   item.pubDate?.__cdata || item.pubDate || item["dc:date"] || "",
      thumbnail,
      preview,
      category:  rawCategory?.replace?.(/\s+/g, "") || feedKey,
      source:    feedKey,
      feedLabel: feedKey,
    };
  });
}

// ─── Cache-aware feed getter ──────────────────────────────────────────────────

async function getFeed(feedKey, count = 25) {
  const now = Date.now();

  if (cache[feedKey] && now - cache[feedKey].ts < CACHE_TTL_MS) {
    return cache[feedKey].data.slice(0, count);
  }

  const url = FEED_MAP[feedKey];
  if (!url) throw new Error(`Unknown feed key: "${feedKey}"`);

  const xml      = await fetchUrl(url);
  const articles = parseRSS(xml, feedKey);

  cache[feedKey] = { ts: now, data: articles };
  console.log(`[rssProxy] Fetched "${feedKey}": ${articles.length} articles`);
  return articles.slice(0, count);
}

// ─── Route ───────────────────────────────────────────────────────────────────

router.get("/rss", async (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", `public, max-age=${CACHE_TTL_MS / 1000}`);

  const feedParam = (req.query.feed || "bollywood").toLowerCase();
  const count     = Math.min(parseInt(req.query.count, 10) || 25, 100);
  const search    = (req.query.search || "").toLowerCase();

  try {
    let articles = [];

    if (feedParam === "all") {
      const results = await Promise.allSettled(
        Object.keys(FEED_MAP).map((key) => getFeed(key, count))
      );
      const seen = new Set();
      results.forEach((r) => {
        if (r.status === "fulfilled") {
          r.value.forEach((a) => {
            if (!seen.has(a.link)) { seen.add(a.link); articles.push(a); }
          });
        } else {
          console.warn("[rssProxy] Feed failed during 'all':", r.reason?.message);
        }
      });
      articles.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
    } else {
      if (!FEED_MAP[feedParam]) {
        return res.status(400).json({
          success: false,
          error: `Unknown feed. Valid: ${Object.keys(FEED_MAP).join(", ")}, all`,
        });
      }
      articles = await getFeed(feedParam, count);
    }

    if (search) {
      articles = articles.filter((a) =>
        a.title.toLowerCase().includes(search)    ||
        a.preview.toLowerCase().includes(search)  ||
        a.category.toLowerCase().includes(search)
      );
    }

    res.json({ success: true, feed: feedParam, count: articles.length, articles });
  } catch (err) {
    console.error(`[rssProxy] Error for "${feedParam}":`, err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

// ─── Route: GET /api/rss/article ─────────────────────────────────────────────
// Fetches a FilmiBeat article page and extracts title, content, thumbnail.
// Used by the in-site news reader so users never leave the app.
//
// GET /api/rss/article?url=https://www.filmibeat.com/kannada/news/...
//
router.get("/rss/article", async (req, res) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, max-age=3600");

  const articleUrl = req.query.url;
  if (!articleUrl) {
    return res.status(400).json({ success: false, error: "Missing ?url= param" });
  }

  // Only allow filmibeat URLs for safety
  if (!articleUrl.includes("filmibeat.com")) {
    return res.status(403).json({ success: false, error: "Only filmibeat.com URLs allowed" });
  }

  try {
    const html = await fetchUrl(articleUrl);

    // ── Extract what we need with lightweight regex (no DOM parser needed) ──

    // Title: <h1 ...>...</h1> or <title>...</title>
    const h1Match  = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = (h1Match?.[1] || titleMatch?.[1] || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s*[-|].*$/, "") // strip "- FilmiBeat" suffix
      .trim();

    // Main thumbnail: og:image is the most reliable
    const ogImageMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    const thumbnail = ogImageMatch?.[1] || "";

    // Published date: look for datePublished or article:published_time
    const dateMatch = html.match(/datePublished["'\s:]+["']([^"']+)["']/i)
      || html.match(/article:published_time["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+itemprop=["']datePublished["']/i);
    const pubDate = dateMatch?.[1] || "";

    // Author
    const authorMatch = html.match(/["']author["'][^>]*>([^<]{2,60})<\//i)
      || html.match(/itemprop=["']author["'][^>]*>([\s\S]{2,60}?)<\//i);
    const author = authorMatch?.[1]?.replace(/<[^>]+>/g, "").trim() || "FilmiBeat";

    // Article body — filmibeat wraps content in .article-content or #article-content
    // Try several selectors in order of specificity
    let content = "";

    const selectors = [
      // Most specific: filmibeat article body div
      /<div[^>]+class=["'][^"']*article-desc[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<div/i,
      /<div[^>]+id=["']article-content["'][^>]*>([\s\S]*?)<\/div>\s*(?:<div|<aside|<section)/i,
      /<article[^>]*>([\s\S]*?)<\/article>/i,
      // Fallback: largest <div class="content..."> block
      /<div[^>]+class=["'][^"']*\bcontent\b[^"']*["'][^>]*>([\s\S]{500,}?)<\/div>\s*<(?:div|aside|footer)/i,
    ];

    for (const re of selectors) {
      const m = html.match(re);
      if (m?.[1] && m[1].length > 200) {
        content = m[1];
        break;
      }
    }

    // If nothing matched, grab all <p> tags from the page body as fallback
    if (!content) {
      const paragraphs = [...html.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
        .map(m => `<p>${m[1]}</p>`)
        .filter(p => p.replace(/<[^>]+>/g, "").trim().length > 40);
      content = paragraphs.slice(0, 30).join("\n");
    }

    // Strip scripts, styles, ads, social widgets from extracted content
    content = content
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/<ins[\s\S]*?<\/ins>/gi, "")           // ad slots
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<div[^>]+class=["'][^"']*(ad|social|share|related|widget|promo)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, "")
      .trim();

    if (!content) {
      return res.status(422).json({ success: false, error: "Could not extract article content" });
    }

    res.json({
      success: true,
      article: { title, thumbnail, pubDate, author, content, sourceUrl: articleUrl },
    });
  } catch (err) {
    console.error("[rssProxy] Article fetch error:", err.message);
    res.status(502).json({ success: false, error: err.message });
  }
});

router.options("/rss/article", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.sendStatus(204);
});

router.options("/rss", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.sendStatus(204);
});

export default router;