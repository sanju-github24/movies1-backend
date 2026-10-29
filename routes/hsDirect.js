/* Hotstar live, straight from the Delhi box — no borrowed proxies.
 *
 * Hotstar's live CDN (live-jiol.cdn.hotstar.com) serves this box directly:
 * tested 2026-10-20, a signed link got its master, cookie, variant and
 * segments here exactly as from a home Jio line. (Other Hotstar hosts still
 * refuse it, with a 47x; those stay on /api/hs-proxy and its pool.)
 *
 * A signed link (?hdnea=…) is good for the master playlist only. Fetching it
 * sets a cookie, hdntl, that every variant and segment of the session needs —
 * and segments accept only that cookie (not the token in the URL), and allow
 * only hotstar.com to read them from a browser. So everything passes through
 * here, and the cookie stays here:
 *
 *   GET /api/hs-direct/m?u=<signed master URL>   the master, rewritten
 *   GET /api/hs-direct/s/<sid>/<path>            a variant or segment of it
 *
 * <sid> names the stream's session directory, not the viewer: everyone
 * watching the same match asks for the same segment at the same address,
 * so Cloudflare (in front of this host) can cache a segment once and serve
 * it to all of them. Segments say so (s-maxage); playlists, which change
 * every few seconds, say not to. That is what keeps this box's bandwidth to
 * roughly one copy of the stream per Cloudflare location rather than one per
 * viewer — given a Cache Rule for /api/hs-direct/s/* on the zone.
 *
 * The cookie is refreshed from any response that sets a new one, and when a
 * request is refused the master is fetched again with the signed link, which
 * is good for half an hour.
 */
import express from "express";
import crypto from "crypto";
import { Readable } from "stream";

const router = express.Router();

// Only Hotstar's live CDNs, so this is not an open relay on a domain we own.
const HOSTS = /^live-[a-z0-9-]+\.cdn\.hotstar\.com$/i;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Referer: "https://www.hotstar.com/",
  Origin: "https://www.hotstar.com",
};

const sessions = new Map();   // sid -> { host, master, cookie, at }
const SESSION_TTL = 6 * 3600e3;

const sidOf = (host, dir) => crypto.createHash("sha1").update(`${host}${dir}`).digest("hex").slice(0, 16);
const cookieFrom = (res) => {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [res.headers.get("set-cookie") || ""];
  for (const c of all) { const m = /(?:^|,\s*)(hdntl=[^;]+)/.exec(c || ""); if (m) return m[1]; }
  return "";
};

function cors(res) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Expose-Headers", "Content-Length, Content-Range");
}

/* Every address in a playlist — a variant, a rendition (URI="…"), a segment,
   a key or init map — becomes one of ours. Hotstar writes variants relative
   and segments as absolute paths; both resolve against the playlist's own URL. */
function rewrite(text, playlistUrl, sid) {
  const ours = (ref) => {
    const abs = new URL(ref, playlistUrl);
    return `/api/hs-direct/s/${sid}${abs.pathname}${abs.search}`;
  };
  return text.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${ours(u)}"`);
    return ours(t);
  }).join("\n");
}

async function fetchMaster(s) {
  const r = await fetch(s.master, { headers: HEADERS, redirect: "follow", signal: AbortSignal.timeout(15000) });
  const c = cookieFrom(r);
  if (c) s.cookie = c;
  s.at = Date.now();
  return r;
}

router.options("*", (req, res) => { cors(res); res.set("Access-Control-Allow-Headers", "Range"); res.sendStatus(204); });

router.get("/m", async (req, res) => {
  cors(res);
  let u;
  try { u = new URL(String(req.query.u || "")); } catch { return res.status(400).send("Give the signed master link as ?u="); }
  if (u.protocol !== "https:" || !HOSTS.test(u.hostname)) return res.status(400).send("Only Hotstar live links");
  const dir = u.pathname.replace(/[^/]+$/, "");
  const sid = sidOf(u.hostname, dir);
  const s = sessions.get(sid) || { host: u.hostname };
  s.master = u.href;            // the newest signed link wins
  sessions.set(sid, s);
  try {
    const r = await fetchMaster(s);
    if (!r.ok) {
      r.body?.cancel().catch(() => {});
      return res.status(r.status).send(r.status === 403 ? "Hotstar refused the link — it has expired or is not signed" : `Hotstar answered ${r.status}`);
    }
    const body = await r.text();
    res.set("Content-Type", "application/vnd.apple.mpegurl");
    res.set("Cache-Control", "no-store");
    res.send(rewrite(body, r.url || u.href, sid));
  } catch (e) {
    res.status(502).send(`Hotstar is not answering: ${e.message}`);
  }
});

router.get("/s/:sid/*", async (req, res) => {
  cors(res);
  const s = sessions.get(req.params.sid);
  if (!s || Date.now() - s.at > SESSION_TTL) return res.status(410).send("Session gone — open the stream again");
  const path = req.originalUrl.slice(`/api/hs-direct/s/${req.params.sid}`.length);
  const target = `https://${s.host}${path}`;
  const isList = /\.m3u8(\?|$)/i.test(path);

  const ask = () => fetch(target, {
    headers: { ...HEADERS, Cookie: s.cookie, ...(req.headers.range ? { Range: req.headers.range } : {}) },
    redirect: "follow", signal: AbortSignal.timeout(isList ? 10000 : 20000),
  });
  try {
    let r = await ask();
    // Refused: the cookie has run out. Fetch the master again for a new one, once.
    if (r.status === 403 && s.master) {
      r.body?.cancel().catch(() => {});
      const m = await fetchMaster(s);
      m.body?.cancel().catch(() => {});
      r = await ask();
    }
    const c = cookieFrom(r);
    if (c) s.cookie = c;
    if (r.ok) s.at = Date.now();   // watched, so kept
    if (!r.ok && r.status !== 206) {
      r.body?.cancel().catch(() => {});
      res.set("Cache-Control", "no-store");
      return res.status(r.status).send(`Hotstar answered ${r.status}`);
    }
    if (isList) {
      const body = await r.text();
      res.set("Content-Type", "application/vnd.apple.mpegurl");
      res.set("Cache-Control", "no-store");
      return res.send(rewrite(body, r.url || target, req.params.sid));
    }
    // A segment never changes once it is out: the same for every viewer, cacheable at the edge.
    res.status(r.status);
    for (const h of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      const v = r.headers.get(h);
      if (v) res.set(h, v);
    }
    res.set("Cache-Control", "public, max-age=300, s-maxage=600");
    Readable.fromWeb(r.body).on("error", () => res.destroy()).pipe(res);
  } catch (e) {
    res.set("Cache-Control", "no-store");
    res.status(502).send(`Hotstar is not answering: ${e.message}`);
  }
});

// Sessions nobody has asked for in a while are forgotten.
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > SESSION_TTL) sessions.delete(k);
}, 30 * 60e3).unref?.();

export default router;
