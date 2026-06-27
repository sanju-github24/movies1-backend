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
  cricket:   "https://www.espncricinfo.com/rss/content/story/feeds/0.xml",
};

const FEED_FALLBACKS = {
  cricket: [
    "https://www.espncricinfo.com/rss/content/story/feeds/0.xml",
    "https://www.cricinfo.com/rss/content/story/feeds/0.xml",
  ],
};

const ALLOWED_ARTICLE_DOMAINS = ["filmibeat.com", "cricinfo.com", "espncricinfo.com"];

const cache = {};
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ─── Fetch (with automatic proxy fallback on block) ──────────────────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/125.0.0.0 Safari/537.36",
  "Accept":          "text/html,application/xhtml+xml,application/xml,application/rss+xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
  "Cache-Control":   "no-cache",
};

function proxyVariants(url) {
  const enc = encodeURIComponent(url);
  return [
    `https://api.allorigins.win/raw?url=${enc}`,
    `https://corsproxy.io/?url=${enc}`,
  ];
}

async function fetchDirect(url, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, Referer: "https://www.google.com/" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

async function fetchUrl(url) {
  let lastErr;
  try {
    return await fetchDirect(url);
  } catch (err) {
    lastErr = err;
    console.warn(`[rssProxy] Direct fetch blocked (${err.message}), trying proxies for ${url}`);
  }
  for (const proxied of proxyVariants(url)) {
    try {
      const text = await fetchDirect(proxied, 15000);
      if (text.trim().startsWith('{"error"')) throw new Error("Proxy returned error payload");
      console.log(`[rssProxy] Recovered via proxy mirror for ${url}`);
      return text;
    } catch (err) {
      lastErr = err;
      console.warn(`[rssProxy] Proxy mirror failed (${err.message}) for ${url}`);
    }
  }
  throw lastErr;
}

function isAllowedArticleUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return ALLOWED_ARTICLE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}
