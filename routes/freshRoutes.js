// =====================================================================
// Fresh titles — what has just come out, for the home page's rows
//
//   GET /   { updatedAt, items: [{ tmdb_id, content_type, title, year, slug,
//             poster, cover_poster, description, imdb_rating, genres,
//             languages, print, first_seen }] }
//
// Uploads are no longer kept up with title by title, so the home page learns
// what is new from 1TamilMV's front page — its list of the latest releases —
// and shows those titles from TMDB: name, art, genres, rating. Nothing is
// saved anywhere; the list lives in memory and is read again every hour.
//
// A title appears only when TMDB has it by exactly that name (and, for a
// film, that year): a near miss would put the wrong poster on the page.
// =====================================================================

import express from 'express';
import { TMDB_API_KEY } from './tmdbRoutes.js';

const router = express.Router();

const SOURCE = (process.env.TAMILMV_BASE || 'https://www.1tamilmv.capital').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p/';
const EVERY = 60 * 60e3;
const MAX_POSTS = 150;

const LANGS = { tamil: 'Tamil', telugu: 'Telugu', hindi: 'Hindi', malayalam: 'Malayalam', kannada: 'Kannada',
  eng: 'English', english: 'English', bengali: 'Bengali', marathi: 'Marathi', punjabi: 'Punjabi', gujarati: 'Gujarati' };

/* The print as 1TamilMV writes it in the release's name, most specific
   first ("hq-predvd" before "predvd", "true-web-dl" before "web-dl"). */
const PRINTS = [
  ['true-web-dl', 'TRUE WEB-DL'], ['web-dl', 'WEB-DL'], ['webrip', 'WEBRip'],
  ['bluray', 'BluRay'], ['bdrip', 'BDRip'], ['hdrip', 'HDRip'], ['hdtv', 'HDTV'],
  ['hq-predvd', 'HQ PreDVD'], ['predvd', 'PreDVD'], ['hq-hdtc', 'HQ HDTC'], ['hdtc', 'HDTC'],
  ['pre-hd', 'PreHD'], ['hdts', 'HDTS'], ['hdcam', 'HDCAM'], ['dvdscr', 'DVDScr'], ['dvdrip', 'DVDRip'],
];
const printOf = (rest) => (PRINTS.find(([k]) => new RegExp(`(^|-)${k}(-|$)`).test(rest)) || [, ''])[1];
const CLEAN_PRINT = /WEB|BluRay|BDRip|HDRip|HDTV|DVDRip/;

const norm = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').normalize('NFKD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const slugify = (s) => norm(s).replace(/ /g, '-');

/* ── 1. The front page's posts ──────────────────────────────────────────
   Each release is a link to its topic, and the topic's address spells it
   out: /topic/200127-jailer-2-rave-2026-tamil-true-web-dl-1080p-… The text
   of the link is often only "[1080p & 720p …]", so the address is read. */
/* The page has two lists: "Top releases this week", a weekly pick that
   repeats titles posted days ago, and "Recently added", the real order. So
   the order on the page is not the order of release; the topic number is —
   the forum numbers topics as they are posted — and a title listed again
   in the weekly pick is not new. A post in that pick is marked, for the
   home page's Trending row. */
function readPosts(html) {
  const lower = html.toLowerCase();
  const topAt = lower.indexOf('top releases this week');
  const recentAt = lower.indexOf('recently added');
  const inTop = (at) => topAt >= 0 && at > topAt && (recentAt < 0 || recentAt < topAt || at < recentAt);
  const posts = [], byId = new Map();
  for (const m of html.matchAll(/href="([^"]*?\/forums\/topic\/(\d+)-([^"/]+)\/?)"/g)) {
    const [, href, id, raw] = m;
    if (byId.has(id)) { if (inTop(m.index)) byId.get(id).topWeek = true; continue; }
    let slug = raw;
    try { slug = decodeURIComponent(raw); } catch { /* leave it */ }
    slug = slug.replace(/ /g, '-').toLowerCase();
    const mm = slug.match(/^(.+?)-((?:19|20)\d{2})(?:-|$)(.*)$/);
    if (!mm) continue;
    const [, name, year, rest] = mm;
    // Not a title to recommend: a daily reality-show episode.
    if (/^bigg-?boss(-|$)/.test(name)) continue;
    const series = /(^|-)s\d{1,3}(-|$)|(^|-)ep?-?\d{1,3}(-|$)|(^|-)season(-|$)|(^|-)day-\d+/.test(rest);
    const langs = [...new Set((rest.match(/tamil|telugu|hindi|malayalam|kannada|english|eng|bengali|marathi|punjabi|gujarati/g) || []).map((l) => LANGS[l]))];
    const print = printOf(rest);
    const post = { id: Number(id), href: href.replace(/&amp;/g, '&'), name: name.replace(/-/g, ' ').trim(), year: Number(year), series, langs, print, topWeek: inTop(m.index) };
    byId.set(id, post);
    posts.push(post);
    if (posts.length >= MAX_POSTS) break;
  }
  // Newest post first, whichever list it sat in.
  return posts.sort((a, b) => b.id - a.id);
}

// One retry: a dropped connection should not empty the list for an hour.
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts()); }
  catch { await new Promise((r) => setTimeout(r, 1500)); return fetch(url, opts()); }
}

/* ── 2. TMDB, matched exactly ─────────────────────────────────────────── */
async function tmdb(path, params = {}) {
  const u = new URL(TMDB + path);
  u.searchParams.set('api_key', TMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') u.searchParams.set(k, v);
  const r = await fetchRetry(u, () => ({ signal: AbortSignal.timeout(12000) }));
  if (!r.ok) throw new Error(`TMDB ${r.status}`);
  return r.json();
}

let genreNames = null;   // id → name, movies and TV together
async function genres() {
  if (genreNames) return genreNames;
  const [m, t] = await Promise.all([tmdb('/genre/movie/list'), tmdb('/genre/tv/list')]);
  genreNames = new Map([...(m.genres || []), ...(t.genres || [])].map((g) => [g.id, g.name]));
  return genreNames;
}

const matches = new Map();   // "series|name|year" → TMDB result, or null for no clean match
async function matchTitle(p) {
  const key = `${p.series ? 'tv' : 'movie'}|${norm(p.name)}|${p.year}`;
  if (matches.has(key)) return matches.get(key);
  const want = norm(p.name);
  const same = (r) => norm(r.title || r.name) === want || norm(r.original_title || r.original_name) === want;
  const yearOf = (r) => Number(String(r.release_date || r.first_air_date || '').slice(0, 4)) || 0;
  let hit = null;
  if (p.series) {
    // A season is dated by the season, not by when the show began, so the
    // year only breaks ties between shows of the same name.
    const { results = [] } = await tmdb('/search/tv', { query: p.name });
    const named = results.filter(same);
    hit = named.find((r) => yearOf(r) === p.year) || named.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0] || null;
  } else {
    const { results = [] } = await tmdb('/search/movie', { query: p.name, year: p.year });
    hit = results.filter(same).find((r) => Math.abs(yearOf(r) - p.year) <= 1) || null;
    if (!hit) {
      const { results: any = [] } = await tmdb('/search/movie', { query: p.name });
      hit = any.filter(same).find((r) => Math.abs(yearOf(r) - p.year) <= 1) || null;
    }
  }
  let value = hit ? { ...hit, media_type: p.series ? 'tv' : 'movie' } : null;
  /* The title logo, for the hero: English first, then one with no text, then
     the title's own language — many Indian films have only that. Asked once
     per title; the match is kept. */
  if (value) {
    try {
      const im = await tmdb(`/${value.media_type}/${value.id}/images`, { include_image_language: 'en,null,hi,kn,ta,te,ml,bn,mr' });
      const logos = im.logos || [];
      const logo = logos.find((l) => l.iso_639_1 === 'en') || logos.find((l) => !l.iso_639_1)
        || logos.find((l) => l.iso_639_1 === value.original_language) || logos[0];
      value = { ...value, logo_path: logo?.file_path || null };
    } catch { /* a missing logo leaves the title as text */ }
  }
  matches.set(key, value);
  if (matches.size > 3000) matches.delete(matches.keys().next().value);
  return value;
}

/* ── 3. The list ──────────────────────────────────────────────────────── */
const firstSeen = new Map();   // "tv:123" → when this server first saw it, or its newest post
const newestPost = new Map();  // "tv:123" → the highest topic number seen for it
let state = { updatedAt: null, items: [], error: null };
let running = null;

async function refresh() {
  if (running) return running;
  running = (async () => {
    const res = await fetchRetry(SOURCE + '/', () => ({ headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }));
    if (!res.ok) throw new Error(`1TamilMV answered ${res.status}`);
    const posts = readPosts(await res.text());
    if (!posts.length) throw new Error('no releases found on the front page');
    const names = await genres();

    const found = [];
    for (let i = 0; i < posts.length; i += 6) {
      const batch = await Promise.all(posts.slice(i, i + 6).map(async (p) => {
        try { return { p, t: await matchTitle(p) }; } catch { return { p, t: null }; }
      }));
      found.push(...batch);
    }

    // One entry per title; its language versions are separate posts.
    const now = Date.now();
    const byId = new Map();
    found.forEach(({ p, t }, i) => {
      if (!t) return;
      /* Reality, talk and news shows are left out: a daily Bigg Boss episode
         is not a title to recommend, and a same-named talk show is the
         likeliest wrong match for a new series. */
      if ((t.genre_ids || []).some((g) => [10763, 10764, 10767].includes(g))) return;
      const key = `${t.media_type}:${t.id}`;
      const have = byId.get(key);
      if (have) {
        have.languages = [...new Set([...have.languages, ...p.langs])];
        if (have.topics.length < 8) have.topics.push(p.href);
        // The best print any of its posts has.
        if ((CLEAN_PRINT.test(p.print) && !CLEAN_PRINT.test(have.print)) || !have.print) have.print = p.print;
        if (p.topWeek) have.top_week = true;
        return;
      }
      /* Front-page order is newest first; a title seen before keeps its time.
         A series posted episode by episode is still one title — its posts
         merge here — but a new episode (a newer topic than any seen for it)
         moves it back to the front. */
      if (!firstSeen.has(key) || p.id > (newestPost.get(key) || 0) && newestPost.has(key)) firstSeen.set(key, now - i * 60e3);
      newestPost.set(key, Math.max(p.id, newestPost.get(key) || 0));
      const title = t.title || t.name;
      const year = String(t.release_date || t.first_air_date || p.year).slice(0, 4);
      byId.set(key, {
        id: `fresh-${t.media_type}-${t.id}`,
        tmdb_id: t.id,
        content_type: t.media_type,
        title,
        year,
        slug: `${slugify(title)}-${year}`,
        poster: t.poster_path ? `${IMG}w500${t.poster_path}` : null,
        cover_poster: t.backdrop_path ? `${IMG}w1280${t.backdrop_path}` : null,
        title_logo: t.logo_path ? `${IMG}w500${t.logo_path}` : null,
        description: t.overview || '',
        imdb_rating: t.vote_average ? Number(t.vote_average).toFixed(1) : '',
        genres: [...new Set((t.genre_ids || []).map((g) => names.get(g)).filter(Boolean))],
        original_language: t.original_language || '',
        languages: p.langs,
        print: p.print,
        top_week: !!p.topWeek,
        topics: [p.href],
        first_seen: new Date(firstSeen.get(key)).toISOString(),
      });
    });
    const items = [...byId.values()].filter((x) => x.poster);
    state = { updatedAt: new Date(now).toISOString(), items, error: null };
    console.log(`🆕 Fresh titles: ${items.length} matched from ${posts.length} releases`);
    return state;
  })().catch((e) => {
    state = { ...state, error: e.message };
    console.warn(`⚠️ Fresh titles not refreshed: ${e.message}`);
    return state;
  }).finally(() => { running = null; });
  return running;
}

// Read on start (once the server has settled) and every hour after.
setTimeout(refresh, 20_000).unref?.();
setInterval(refresh, EVERY).unref?.();

router.get('/', async (req, res) => {
  // A server that has just started waits for its first read rather than
  // answering with nothing.
  if (!state.updatedAt) await refresh();
  res.set('Cache-Control', 'public, max-age=600');
  res.json({ updatedAt: state.updatedAt, items: state.items.map(({ topics, ...rest }) => ({ ...rest, has_files: topics.length > 0 })) });
});

/* ── 4. A title's files ─────────────────────────────────────────────────
   Each release's post lists its files one after another: the .torrent
   attachment (named after the file, size included), then MAGNET, then —
   on most posts, not all — DIRECT LINK, a page that leads to the file.

   GET /files?tmdb=movie:123
     { files: [{ name, quality, size, magnet, direct }] }   direct is a key for /direct, or null
   GET /direct?key=…
     { url, name, expires }

   The direct link is followed only when asked: what it leads to carries a
   token that runs out in a few hours. Only links read from a post here are
   followed, so /direct is not a general-purpose redirect follower. */
const filesCache = new Map();   // topic href → { at, files }
const directPages = new Map();  // key → { page, name }
const cleanName = (n) => String(n || '').replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
  .replace(/^\s*www\.1tamilmv\.[a-z]+\s*-\s*/i, '').replace(/\.torrent$/i, '').trim();

async function topicFiles(href) {
  const hit = filesCache.get(href);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.files;
  const r = await fetchRetry(href, () => ({ headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }));
  if (!r.ok) throw new Error(`topic answered ${r.status}`);
  const html = await r.text();
  const files = [];
  const un = (h) => h.replace(/&amp;/g, '&');
  for (const m of html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)) {
    const link = un(m[1]);
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/attachment\.php/.test(link) && /\.(mkv|mp4|avi)/i.test(text)) {
      files.push({ name: cleanName(text), magnet: null, page: null });
    } else if (link.startsWith('magnet:')) {
      const last = files[files.length - 1];
      if (last && !last.magnet) last.magnet = link;
      else {
        const dn = decodeURIComponent((link.match(/[?&]dn=([^&]+)/) || [])[1] || '').replace(/\+/g, ' ');
        files.push({ name: cleanName(dn), magnet: link, page: null });
      }
    } else if (/^direct\s*link$/i.test(text) && /^https?:/.test(link)) {
      const last = files[files.length - 1];
      if (last && !last.page) last.page = link;
    }
  }
  filesCache.set(href, { at: Date.now(), files });
  if (filesCache.size > 300) filesCache.delete(filesCache.keys().next().value);
  return files;
}

/* A title not on the front page: the forum's own search, keeping only the
   posts that name exactly this title (and year, for a film) — a search for
   "Kantara" also finds its music album and a fifty-film pack. */
const searchCache = new Map();  // "type|title|year" → { at, topics }
async function searchTopics(title, year, series) {
  const key = `${series ? 'tv' : 'movie'}|${norm(title)}|${year || ''}`;
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 60 * 60e3) return hit.topics;
  const q = norm(title);
  if (!q) return [];
  const url = `${SOURCE}/index.php?/search/&q=${encodeURIComponent(q)}&type=forums_topic&search_and_or=and&sortby=newest`;
  const r = await fetchRetry(url, () => ({ headers: { 'User-Agent': UA, Accept: 'text/html' }, signal: AbortSignal.timeout(20000) }));
  if (!r.ok) throw new Error(`search answered ${r.status}`);
  const html = await r.text();
  const topics = [], seen = new Set();
  for (const m of html.matchAll(/href='([^']*?\/forums\/topic\/(\d+)-([^'\/&]+)\/?)[^']*'/g)) {
    const [, href, id, raw] = m;
    if (seen.has(id)) continue;
    seen.add(id);
    let slug = raw;
    try { slug = decodeURIComponent(raw); } catch { /* leave it */ }
    slug = slug.replace(/\u00a0/g, '-').toLowerCase();
    const mm = slug.match(/^(.+?)-((?:19|20)\d{2})(?:-|$)(.*)$/);
    if (!mm) continue;
    const [, name, y, rest] = mm;
    if (norm(name.replace(/-/g, ' ')) !== q) continue;
    if (!series && year && Math.abs(Number(y) - Number(year)) > 1) continue;
    if (/music|video-album|video-songs|songs|trailer|teaser/.test(rest)) continue;
    topics.push(href.replace(/&amp;/g, '&'));
    if (topics.length >= 12) break;
  }
  searchCache.set(key, { at: Date.now(), topics });
  if (searchCache.size > 1000) searchCache.delete(searchCache.keys().next().value);
  return topics;
}

router.get('/files', async (req, res) => {
  const [type, id] = String(req.query.tmdb || '').split(':');
  const item = state.items.find((x) => x.content_type === type && String(x.tmdb_id) === id);
  const title = String(req.query.title || '').slice(0, 200);
  const year = String(req.query.year || '').slice(0, 4);
  try {
    /* A title from the front page knows the posts listed there; any other is
       searched for. Both are searched, in fact: a film is often posted once
       per language, and the front page shows only some of those posts. */
    const found = await searchTopics(item ? item.title : title, item ? item.year : year, type === 'tv').catch(() => []);
    // One per topic, whichever address it came by.
    const byTopic = new Map();
    for (const t of [...(item ? item.topics : []), ...found]) {
      const tid = (t.match(/\/topic\/(\d+)-/) || [])[1] || t;
      if (!byTopic.has(tid)) byTopic.set(tid, t);
    }
    const topics = [...byTopic.values()].slice(0, 12);
    if (!topics.length) return res.json({ files: [] });
    const lists = await Promise.all(topics.map((t) => topicFiles(t).catch(() => [])));
    /* Once each. A multi-language file is attached to every language's post
       — the same 4K file under the Tamil post and the Malayalam one — so a
       file is known by its torrent's hash, which is the same wherever it is
       posted, and by its name where it has no magnet. */
    const seen = new Set();
    const keyOf = (f) => ((f.magnet || '').match(/btih:([a-z0-9]+)/i) || [])[1]?.toLowerCase() || f.name.toLowerCase().replace(/\s+/g, ' ');
    const files = lists.flat().filter((f) => {
      if (!f.name) return false;
      const k = keyOf(f), n = f.name.toLowerCase().replace(/\s+/g, ' ');
      if (seen.has(k) || seen.has(n)) return false;
      seen.add(k); seen.add(n);
      return true;
    }).map((f) => {
      let key = null;
      if (f.page) {
        key = Buffer.from(f.page).toString('base64url');
        directPages.set(key, { page: f.page, name: f.name });
        if (directPages.size > 3000) directPages.delete(directPages.keys().next().value);
      }
      return {
        name: f.name,
        quality: (f.name.match(/\b(2160|1080|720|480|360)p\b/i) || [])[0] || (/\b4k\b/i.test(f.name) ? '2160p' : ''),
        size: (f.name.match(/([\d.]+\s*[GM]B)\b/i) || [])[1] || '',
        magnet: f.magnet,
        direct: key,
      };
    });
    res.json({ files });
  } catch (e) {
    res.status(502).json({ error: e.message, files: [] });
  }
});

/* The way to the file: the link's page redirects to a ten-second wait page
   whose button, under the same session, redirects to the file host's page,
   which links the file itself. The wait is only in the browser. Cookies are
   carried by hand: fetch keeps none between requests. */
async function followDirect(page) {
  const jar = new Map();   // host → cookie string
  const take = (url, r) => {
    const set = r.headers.getSetCookie?.() || [];
    if (!set.length) return;
    const host = new URL(url).host;
    const have = new Map((jar.get(host) || '').split('; ').filter(Boolean).map((c) => [c.split('=')[0], c]));
    set.forEach((c) => { const kv = c.split(';')[0]; have.set(kv.split('=')[0], kv); });
    jar.set(host, [...have.values()].join('; '));
  };
  const go = async (url, referer) => {
    let cur = url;
    for (let i = 0; i < 8; i++) {
      const cookie = jar.get(new URL(cur).host);
      const r = await fetch(cur, { redirect: 'manual', signal: AbortSignal.timeout(15000), headers: {
        'User-Agent': UA, Accept: 'text/html', ...(referer ? { Referer: referer } : {}), ...(cookie ? { Cookie: cookie } : {}) } });
      take(cur, r);
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) { referer = cur; cur = new URL(loc, cur).href; continue; }
      return { url: cur, html: await r.text() };
    }
    throw new Error('too many redirects');
  };
  const wait = await go(page);
  const out = (wait.html.match(/href="(https?:\/\/[^"]+\/out\?t=[^"]+)"/) || [])[1];
  if (!out) throw new Error('no way past the wait page');
  const host = await go(out.replace(/&amp;/g, '&'), wait.url);
  const file = (host.html.match(/href="(https?:\/\/[^"]+\/files\/[^"]+)"/) || [])[1];
  if (!file) throw new Error('no file on the host page');
  return file.replace(/&amp;/g, '&');
}

const directCache = new Map();  // key → { at, value }
router.get('/direct', async (req, res) => {
  const key = String(req.query.key || '');
  const known = directPages.get(key);
  if (!known) return res.status(404).json({ error: 'Open the title\'s downloads again — that link is not known here' });
  const hit = directCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60e3) return res.json(hit.value);
  try {
    const url = await followDirect(known.page);
    const exp = Number(new URL(url).searchParams.get('exp')) || 0;
    const value = { url, name: known.name, expires: exp ? new Date(exp * 1000).toISOString() : null };
    directCache.set(key, { at: Date.now(), value });
    res.json(value);
  } catch (e) {
    console.warn(`⚠️ Direct link not followed: ${e.message}`);
    res.status(502).json({ error: 'The file host is not answering right now' });
  }
});

export default router;
