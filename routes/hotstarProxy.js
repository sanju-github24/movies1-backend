/* Hotstar's live streams, proxied from the Delhi box.
 *
 * Hotstar serves Indian home connections only. Every datacenter is refused —
 * this box included, with Hotstar's own status 475 — so, like the Vercel
 * proxy this stands in front of, requests go out through public proxies on
 * Indian consumer networks. What this adds is that it never sleeps: Vercel
 * hunts the list again on every cold start, which is the fifteen to twenty-
 * five seconds a Hotstar channel used to spend on "Starting". Here a few
 * proxies Hotstar is known to accept are kept checked and ready, and the
 * search for the next one happens in the background, not in front of a viewer.
 *
 * Those proxies are strangers' machines: fine for a public stream signed with
 * a token that expires in hours, and nothing private goes through them.
 *
 *   GET /api/hs-proxy?url=<encoded>[&cookie=][&ref=][&ua=]   same as Vercel's
 *   GET /api/hs-proxy/health                                 { ready, proxies }
 */
import express from "express";
import { Readable } from "stream";
import { ProxyAgent } from "undici";

const router = express.Router();

// Only Hotstar, so this is not an open relay on a domain we own.
const allowed = (h) => h === "hotstar.com" || h.endsWith(".hotstar.com");

const PROXY_LIST =
  "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/in/http.txt";

/* A check that needs no token. Without one Hotstar answers a home connection
   403 and a datacenter 475, so anything but 475 says Hotstar will serve this
   proxy once the request carries a real token. */
const PROBE_URL = "https://jcevents.hotstar.com/bpk-tv/JS_ColorsHD/JioHotstar/JS_ColorsHD.m3u8";
const HOTSTAR_HEADERS = {
  "User-Agent": "Virat Kohli",
  Referer: "https://www.hotstar.com/",
  Origin: "https://www.hotstar.com",
  Accept: "*/*",
};
const BLOCKED = 475;

const KEEP = 4;                     // proxies held ready
const RECHECK_MS = 60_000;          // how often the ready ones are re-checked
const BAD_FOR_MS = 20 * 60_000;     // a proxy that failed is left alone this long

// ── the pool ─────────────────────────────────────────────────
let list = [], listAt = 0;
const ready = [];                   // checked and accepted, best first
const bad = new Map();              // proxy -> when it failed
const agents = new Map();           // proxy -> ProxyAgent, so connections are reused

function agentFor(p) {
  let a = agents.get(p);
  if (!a) { a = new ProxyAgent({ uri: `http://${p}`, connectTimeout: 6000 }); agents.set(p, a); }
  return a;
}

function get(url, headers, proxy, ms) {
  return fetch(url, { headers, dispatcher: agentFor(proxy), signal: AbortSignal.timeout(ms) });
}

async function proxyList() {
  if (list.length && Date.now() - listAt < 15 * 60_000) return list;
  try {
    const txt = await (await fetch(PROXY_LIST, { signal: AbortSignal.timeout(10_000) })).text();
    const fresh = txt.split("\n").map((l) => l.trim())
      .filter((l) => /^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(l));
    if (fresh.length) { list = fresh; listAt = Date.now(); }
  } catch { /* keep whatever we had */ }
  return list;
}

function drop(p) {
  const i = ready.indexOf(p);
  if (i !== -1) ready.splice(i, 1);
  bad.set(p, Date.now());
  const a = agents.get(p);
  agents.delete(p);
  a?.close().catch(() => {});
  if (ready.length < KEEP) topUp();
}

async function probe(p) {
  const r = await get(PROBE_URL, HOTSTAR_HEADERS, p, 7000);
  r.body?.cancel().catch(() => {});
  if (r.status === BLOCKED || r.status >= 500) throw new Error(String(r.status));
  return p;
}

/* Most of a public list is dead, so candidates are checked sixteen at a time
   and every one that passes is kept, not just the first. */
let topping = null;
function topUp() {
  topping ||= (async () => {
    const all = await proxyList();
    const now = Date.now();
    const candidates = all.filter((p) => !ready.includes(p) && !(now - (bad.get(p) || 0) < BAD_FOR_MS));
    for (let i = 0; i < candidates.length && ready.length < KEEP; i += 16) {
      const batch = candidates.slice(i, i + 16);
      const results = await Promise.allSettled(batch.map(probe));
      results.forEach((r, j) => {
        if (r.status === "fulfilled") { if (!ready.includes(r.value)) ready.push(r.value); }
        else bad.set(batch[j], Date.now());
      });
    }
  })().finally(() => { topping = null; });
  return topping;
}

async function recheck() {
  for (const p of [...ready]) {
    try { await probe(p); } catch { drop(p); }
  }
  if (ready.length < KEEP) topUp();
}

// Warm from the moment the server starts, and stay warm.
topUp();
setInterval(recheck, RECHECK_MS).unref();

/* The request itself goes through the best ready proxy; one that fails is
   dropped and the next tried at once, so the player sees a slower fetch
   rather than an error. With none ready it waits briefly for the background
   search before giving up. */
async function fetchThroughPool(url, headers) {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (!ready.length) await Promise.race([topUp(), new Promise((r) => setTimeout(r, 12_000))]);
    const p = ready[0];
    if (!p) return null;
    try {
      const res = await get(url, headers, p, 12_000);
      if (res.status === BLOCKED) { res.body?.cancel().catch(() => {}); drop(p); continue; }
      return { res, proxy: p };
    } catch {
      drop(p);
    }
  }
  return null;
}

// ── routes ───────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "X-Proxy-Via, X-Proxy-Upstream, Content-Range");
}

router.options("*", (req, res) => { cors(res); res.status(204).end(); });

router.get("/health", (req, res) => {
  cors(res);
  res.setHeader("Cache-Control", "no-store");
  res.json({ ready: ready.length > 0, proxies: ready.length });
});

router.get("/", async (req, res) => {
  cors(res);
  const { url: target, cookie = "", ref = "", ua = "" } = req.query;
  if (!target) return res.status(400).send("Missing ?url=");

  let targetUrl;
  try { targetUrl = new URL(target); } catch { return res.status(400).send("Invalid url"); }
  if (!allowed(targetUrl.hostname)) return res.status(403).send("Host not allowed");

  let refOrigin = targetUrl.origin;
  if (ref) { try { refOrigin = new URL(ref).origin; } catch { /* keep the target's */ } }

  const headers = {
    "User-Agent": ua || HOTSTAR_HEADERS["User-Agent"],
    Referer: ref || HOTSTAR_HEADERS.Referer,
    Origin: refOrigin,
    Accept: "*/*",
    ...(cookie ? { Cookie: cookie } : {}),
    ...(req.headers.range ? { Range: req.headers.range } : {}),
  };

  const hit = await fetchThroughPool(targetUrl.toString(), headers);
  /* No proxy Hotstar accepts right now. Said plainly, so the player moves to
     the Vercel proxy instead of reading this box's own 475 as the stream. */
  if (!hit) return res.status(503).send("No Indian proxy available right now");
  const { res: upstream, proxy } = hit;
  res.setHeader("X-Proxy-Via", proxy);

  // A refusal is not a playlist, whatever the path says.
  if (!upstream.ok) {
    const body = await upstream.text();
    res.setHeader("X-Proxy-Upstream", String(upstream.status));
    return res.status(upstream.status).send(body.slice(0, 2000));
  }

  const ct = upstream.headers.get("content-type") || "";
  const lower = targetUrl.pathname.toLowerCase();
  const isPlaylist = lower.endsWith(".m3u8") || ct.includes("mpegurl");
  const isDash = lower.endsWith(".mpd") || ct.includes("dash+xml");

  /* A DASH manifest names its segments in templates, so the player resolves
     them against wherever it fetched the manifest — here. An absolute BaseURL
     back to the real directory makes them real Hotstar URLs, which the
     player's request filter then wraps on the way out. */
  if (isDash) {
    let xml = await upstream.text();
    const dir = targetUrl.href.slice(0, targetUrl.href.lastIndexOf("/") + 1);
    if (!/<BaseURL>\s*https?:/i.test(xml)) xml = xml.replace(/(<MPD\b[^>]*>)/i, `$1<BaseURL>${dir}</BaseURL>`);
    res.setHeader("Content-Type", "application/dash+xml");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).send(xml);
  }

  if (isPlaylist) {
    const text = await upstream.text();
    const proto = req.get("x-forwarded-proto") || req.protocol;
    const base = `${proto}://${req.get("host")}${req.baseUrl}`;
    const extras =
      (cookie ? "&cookie=" + encodeURIComponent(cookie) : "") +
      (ref ? "&ref=" + encodeURIComponent(ref) : "") +
      (ua ? "&ua=" + encodeURIComponent(ua) : "");

    // A child with no query of its own inherits the parent's.
    const parentQuery = targetUrl.search;
    const toAbs = (r) => {
      const u = new URL(r, targetUrl);
      if (!u.search && parentQuery) u.search = parentQuery;
      return u.toString();
    };
    const wrap = (abs) => base + "?url=" + encodeURIComponent(abs) + extras;

    const body = text.split("\n").map((line) => {
      const t = line.trim();
      if (!t) return line;
      if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(toAbs(u))}"`);
      return wrap(toAbs(t));
    }).join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).send(body);
  }

  // Segments and keys: streamed through as they arrive, with CORS added.
  res.status(upstream.status === 206 ? 206 : 200);
  res.setHeader("Content-Type", ct || "application/octet-stream");
  res.setHeader("Cache-Control", upstream.headers.get("cache-control") || "no-cache");
  for (const h of ["content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(h);
    if (v) res.setHeader(h, v);
  }
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
});

export default router;
