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
function readPosts(html) {
  const posts = [], seen = new Set();
  for (const m of html.matchAll(/href="[^"]*?\/forums\/topic\/(\d+)-([^"/]+)\/?"/g)) {
    const [, id, raw] = m;
    if (seen.has(id)) continue;
    seen.add(id);
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
    posts.push({ id: Number(id), name: name.replace(/-/g, ' ').trim(), year: Number(year), series, langs, print });
    if (posts.length >= MAX_POSTS) break;
  }
  return posts;
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
  const value = hit ? { ...hit, media_type: p.series ? 'tv' : 'movie' } : null;
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
        // The best print any of its posts has.
        if ((CLEAN_PRINT.test(p.print) && !CLEAN_PRINT.test(have.print)) || !have.print) have.print = p.print;
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
        description: t.overview || '',
        imdb_rating: t.vote_average ? Number(t.vote_average).toFixed(1) : '',
        genres: [...new Set((t.genre_ids || []).map((g) => names.get(g)).filter(Boolean))],
        original_language: t.original_language || '',
        languages: p.langs,
        print: p.print,
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
  res.json({ updatedAt: state.updatedAt, items: state.items });
});

export default router;
