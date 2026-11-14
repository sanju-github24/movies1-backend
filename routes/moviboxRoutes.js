// =====================================================================
// MoviBox — every language's streams for one title, for our own use
//
//   GET /?tmdb=<id>[&type=movie|tv][&se=1&ep=1]
//   GET /?title=<name>[&year=2026][&type=movie|tv][&se=&ep=]
//     { title, year, matched: { title, detailPath }, languages: [{
//         language, code, original, subjectId, detailPath,
//         mpd: { url, resolutions, codec, headers } | null,
//         mp4: [{ url, resolution, size, codec, headers }] }] }
//
// Not shown on the site: it is a lookup for finding a title's files, e.g.
// to paste into anchor-ingest. MoviBox posts each language of a film as its
// own title (Original Audio, Hindi dub, Tamil dub…), all listed on any one of
// them, and each with its own streams:
//   • a DASH manifest (HEVC 1080/720/480, one audio track, no DRM), which the
//     CDN serves only with the header X-MB-Token (its "signCookie") and
//     movibox.net as the Referer — on the manifest and every segment;
//   • MP4 files (h264), which need only the Referer.
// The links are signed and run out, so they are fetched when asked for.
// Every reply here lists the headers each link needs.
//
// The site's web client works without an account: its first reply hands out
// a guest token in an x-user header, used as a Bearer from then on; before
// that it sends X-Client-Token, the time and an MD5 of it reversed. The play
// request answers only with the title's own watch page as the Referer.
// =====================================================================

import express from 'express';
import crypto from 'crypto';
import { TMDB_API_KEY } from './tmdbRoutes.js';
import { domainOf } from '../utils/siteDomains.js';

const router = express.Router();

/* MoviBox's web domain moves when it is blocked; the admin can change it on
   Admin → Source domains (site "movibox"), and it is read here each call. */
const BASE = () => domainOf('movibox');
const API = () => `${BASE()}/wefeed-h5api-bff`;
const HOST = () => { try { return new URL(BASE()).host; } catch { return 'movibox.net'; } };
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const REFERER = () => `${BASE()}/`;

const clientToken = () => {
  const t = Math.floor(Date.now() / 1000);
  return `${t},${crypto.createHash('md5').update(String(t).split('').reverse().join('')).digest('hex')}`;
};

let guest = { token: '', at: 0 };
async function mbOnce(path, { method = 'GET', body, referer = REFERER() } = {}) {
  const headers = {
    Accept: 'application/json', 'content-type': 'application/json',
    'X-Client-Info': JSON.stringify({ timezone: 'Asia/Kolkata' }), 'X-Request-Lang': 'en',
    'User-Agent': UA, Origin: BASE(), Referer: referer,
    ...(guest.token && Date.now() - guest.at < 6 * 3600e3 ? { Authorization: `Bearer ${guest.token}` } : { 'X-Client-Token': clientToken() }),
  };
  const res = await fetch(API() + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const user = res.headers.get('x-user');
  if (user) { try { const t = JSON.parse(user).token; if (t) guest = { token: t, at: Date.now() }; } catch { /* keep the old one */ } }
  const json = await res.json().catch(() => null);
  /* A guest token MoviBox has stopped honouring ("invalid token") is dropped
     and a fresh one fetched, once — before this, every lookup failed until
     the old token was six hours old. */
  if (json && json.code !== 0 && /token/i.test(String(json.message || '')) && guest.token && !mbOnce.retrying) {
    guest = { token: '', at: 0 };
    mbOnce.retrying = true;
    try { await mbOnce(`/home?host=${HOST()}`).catch(() => { }); return await mbOnce(path, { method, body, referer }); }
    finally { mbOnce.retrying = false; }
  }
  if (!json || json.code !== 0) throw new Error(`MoviBox ${path.split('?')[0]}: ${json?.message || res.status}`);
  return json.data;
}
/* AnchorMB's call (m3u8-player/api/movibox.js), as it makes it: the site
   resets connections that come too close together and turns down a search
   sent before it has handed out a guest token, so every call gets three
   tries, further apart each time, with the guest token fetched first. One
   unlucky reset used to mean "no such title". */
async function mb(path, opts = {}) {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      if (!guest.token && !path.startsWith('/home')) await mbOnce(`/home?host=${HOST()}`).catch(() => { });
      return await mbOnce(path, opts);
    } catch (e) {
      last = e;
      if (i < 2) await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
    }
  }
  throw last;
}
// A guest token first: search refuses without one.
const ensureGuest = async () => { if (!guest.token) await mbOnce(`/home?host=${HOST()}`).catch(() => { }); };

const norm = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/&/g, ' and ')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const yearOf = (s) => Number(String(s || '').slice(0, 4)) || 0;

async function tmdbTitle(id, type) {
  const kinds = type ? [type] : ['movie', 'tv'];
  for (const k of kinds) {
    const r = await fetch(`https://api.themoviedb.org/3/${k}/${id}?api_key=${TMDB_API_KEY}&append_to_response=alternative_titles`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) continue;
    const d = await r.json();
    /* The names MoviBox may use, as AnchorMB's lookup looks for them: TMDB's
       title, its original when in Latin letters, the alternative titles it
       lists for India, the US and the UK, and the title without a subtitle —
       TMDB's "Khalifa: The Ruler" is MoviBox's "Khalifa". */
    const main = d.title || d.name || '';
    const alts = (d.alternative_titles?.titles || d.alternative_titles?.results || [])
      .filter((a) => ['IN', 'US', 'GB'].includes(a.iso_3166_1)).map((a) => a.title);
    const latin = (t) => /^[\x00-\x7F\u00C0-\u024F]+$/.test(String(t || ''));
    const names = [main, d.original_title || d.original_name, ...alts, main.split(/:\s/)[0]].filter((t) => t && latin(t));
    return {
      type: k, titles: [...new Set(names)].slice(0, 6),
      year: yearOf(d.release_date || d.first_air_date), lastYear: yearOf(d.last_air_date)
    };
  }
  throw new Error('TMDB has no title with that id');
}

/* Manual overrides for titles MoviBox lists under a different name than
   TMDB's. Keyed by TMDB id (string). Each value is the detailPath and
   subjectId taken straight from a working MoviBox URL. When a match is
   here the search is skipped entirely — no risk of hitting the wrong one.
   Keep in sync with m3u8-player/api/movibox.js's MB_OVERRIDES. */
const MB_OVERRIDES = {
  // "Student of the Year: After Dark" (TMDB TV 334412) → "Student of the Year 3" (MoviBox)
  "334412": { detailPath: "student-of-the-year-3-Ol6BuNQgDga", subjectId: "8618161652330021112", title: "Student of the Year 3" },
};

/* The MoviBox title that is this one — found exactly as AnchorMB finds it
   (m3u8-player/api/movibox.js), so the two servers never disagree.

   Names are compared with the spaces and doubled letters gone and a trailing
   season tag dropped ("Panchayat S4", "Love S1-S3"), so spellings of one
   Indian title meet: "TamilRockerz" is MoviBox's "Tamil Rockerz", "The
   Rajasaab" its "The Raja Saab", "Bāhubali" its "Baahubali". It is searched
   under each name as written, with CamelCase split into words, and as plain
   letters — their search does not see "ā" as "a".

   A film must be the same year give or take one. A series is listed once a
   season with that season's date, so its year only breaks a tie: the nearest
   year first, then one inside its run, and failing both the first listing of
   that name — which is how a series is found whichever season is listed. */
const stripSeason = (s) => String(s || '').toLowerCase().replace(/\s+s\d+(\s*-\s*s?\d+)?\s*$/, '');
const compact = (s) => norm(stripSeason(s)).replace(/ /g, '').replace(/(.)\1+/g, '$1');
const splitWords = (s) => String(s || '').replace(/([a-z])([A-Z])/g, '$1 $2');

async function findSubject(titles, year, type, lastYear = 0, tmdbId = '') {
  // Check manual overrides first.
  const ov = MB_OVERRIDES[String(tmdbId)];
  if (ov) return { detailPath: ov.detailPath, subjectId: ov.subjectId, title: ov.title };
  await ensureGuest();
  const want = new Set(titles.map(compact).filter(Boolean));
  const kinds = type === 'tv' ? 2 : 1;
  // AnchorMB's first four searches; then the subtitle-less name (TMDB's "Khalifa: The Ruler" is MoviBox's "Khalifa").
  const keywords = [...new Set(titles.flatMap((t) => [splitWords(t), t, norm(splitWords(t))]))].slice(0, 4);
  for (const t of titles) {
    const bare = t.split(/:\s/)[0];
    if (bare !== t) for (const k of [splitWords(bare), bare]) if (k && !keywords.includes(k)) keywords.push(k);
  }
  for (const keyword of keywords.slice(0, 6)) {
    const d = await mb('/subject/search', { method: 'POST', body: { keyword, page: 1, perPage: 20, subjectType: kinds } });
    const same = (d.items || []).filter((x) => want.has(compact(x.title)));
    const near = (x) => year && Math.abs(yearOf(x.releaseDate) - year) <= 1;
    const inRun = (x) => year && yearOf(x.releaseDate) >= year - 1 && yearOf(x.releaseDate) <= Math.max(year, lastYear || 0) + 1;
    const hit = type === 'tv'
      ? (same.find(near) || same.find(inRun) || same[0])
      : same.find((x) => !year || near(x));
    if (hit) return hit;
  }
  return null;
}

const isNotice = (u) => /index_4\d\d\.m3u8/i.test(u || '')
  || /notice|warning|flonub\.com.*index_/i.test(u || '')
  || /55518dd33236404e200a606811ea4da4/i.test(u || '')
  || /(?:^|\.)aoneroom\.com\/other\//i.test(u || '')
  || (/macdn\.aoneroom\.com/i.test(u || '') && /\/other\//i.test(u || ''))
  || /\/other\/\d{4}\/\d{2}\/\d{2}\/.*\.mp4/i.test(u || '');

export async function streamsFor(dub, se, ep) {
  const watchPage = `${BASE()}/movies/${dub.detailPath}?id=${dub.subjectId}&type=/movie/detail&detailSe=${se || ''}&detailEp=${ep || ''}&lang=en`;
  const d = await mb(`/subject/play?subjectId=${dub.subjectId}&se=${se || 0}&ep=${ep || 0}&detailPath=${dub.detailPath}&streamSignType=1`, { referer: watchPage });
  const dash = (d.dash || [])[0];
  const signed = (x) => ({ Referer: REFERER(), ...(x?.signHeaderKey && x?.signCookie ? { [x.signHeaderKey]: x.signCookie } : {}) });
  return {
    available: !!d.hasResource,
    mpd: dash && !isNotice(dash.url) ? { url: dash.url, resolutions: dash.resolutions, codec: dash.codecName, size: Number(dash.size) || null, headers: signed(dash) } : null,
    mp4: (d.streams || []).filter((s) => !isNotice(s.url)
      && (!s.duration && !s.durationSecond ? true : (Number(s.duration || s.durationSecond) >= 30))
      && (!s.size || Number(s.size) >= 10 * 1024 * 1024))
      .map((s) => ({ url: s.url, resolution: `${s.resolutions}p`, size: Number(s.size) || null, codec: s.codecName, headers: signed(s) }))
      .sort((a, b) => parseInt(b.resolution, 10) - parseInt(a.resolution, 10)),
  };
}

const cache = new Map();   // key → { at, value }

/* A title's language versions on MoviBox, without their streams: the
   subject ids the TV app's API plays (see mbHlsRoutes.js). By TMDB id, or by
   title and year. Kept for an hour — the list changes only when MoviBox adds
   a dub. */
const dubsCache = new Map();   // key → { at, value }
export async function moviboxDubs({ tmdb, title, year = 0, type = '' }) {
  let titles, kind = type, lastYear = 0;
  if (tmdb) ({ titles, year, type: kind, lastYear } = await tmdbTitle(String(tmdb).replace(/\D/g, ''), type));
  else if (title) titles = [String(title).slice(0, 200)];
  else throw new Error('tmdb or title is required');
  const key = `${titles[0]}|${year}|${kind}`;
  const hit = dubsCache.get(key);
  if (hit && Date.now() - hit.at < 3600e3) return hit.value;
  const subject = await findSubject(titles, year, kind || 'movie', lastYear, tmdb);
  if (!subject) return null;
  const detail = await mb(`/detail?detailPath=${subject.detailPath}`);
  const dubs = detail?.subject?.dubs || detail?.dubs || [];
  const versions = (dubs.length ? dubs : [{ subjectId: subject.subjectId, detailPath: subject.detailPath, lanName: 'Original', lanCode: '', original: true }])
    .map((d) => ({ subjectId: String(d.subjectId), detailPath: d.detailPath || subject.detailPath, language: d.lanName || '', code: d.lanCode || '', original: !!d.original }));
  const value = { title: subject.title, year, type: kind || 'movie', versions };
  dubsCache.set(key, { at: Date.now(), value });
  if (dubsCache.size > 500) dubsCache.delete(dubsCache.keys().next().value);
  return value;
}

router.get('/', async (req, res) => {
  // Optional lock: with MOVIBOX_KEY set, the key must come with the request.
  if (process.env.MOVIBOX_KEY && req.query.key !== process.env.MOVIBOX_KEY && req.get('x-key') !== process.env.MOVIBOX_KEY) {
    return res.status(401).json({ error: 'key required' });
  }
  const type = req.query.type === 'tv' ? 'tv' : req.query.type === 'movie' ? 'movie' : '';
  const se = Number(req.query.se) || 0, ep = Number(req.query.ep) || 0;
  try {
    let titles, year = Number(req.query.year) || 0, kind = type, lastYear = 0;
    if (req.query.tmdb) ({ titles, year, type: kind, lastYear } = await tmdbTitle(String(req.query.tmdb).replace(/\D/g, ''), type));
    else if (req.query.title) titles = [String(req.query.title).slice(0, 200)];
    else return res.status(400).json({ error: 'tmdb or title is required' });

    const key = `${titles[0]}|${year}|${kind}|${se}|${ep}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 20 * 60e3) return res.json(hit.value);

    const subject = await findSubject(titles, year, kind || 'movie', lastYear, req.query.tmdb || '');
    if (!subject) return res.status(404).json({ error: 'MoviBox has no title by that name', title: titles[0], year });

    const detail = await mb(`/detail?detailPath=${subject.detailPath}`);
    const dubs = detail?.subject?.dubs || detail?.dubs || [];
    const versions = dubs.length ? dubs : [{ subjectId: subject.subjectId, detailPath: subject.detailPath, lanName: 'Original', lanCode: '', original: true }];
    const languages = [];
    for (const dub of versions) {   // one at a time: the site resets connections that come too fast
      try {
        languages.push({ language: dub.lanName, code: dub.lanCode, original: !!dub.original, subjectId: dub.subjectId, detailPath: dub.detailPath, ...(await streamsFor(dub, se, ep)) });
      } catch (e) {
        languages.push({ language: dub.lanName, code: dub.lanCode, original: !!dub.original, subjectId: dub.subjectId, detailPath: dub.detailPath, error: e.message });
      }
    }
    const value = {
      title: titles[0], year, type: kind || 'movie', se: se || undefined, ep: ep || undefined,
      matched: { title: subject.title, detailPath: subject.detailPath, releaseDate: subject.releaseDate }, languages
    };
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    res.json(value);
  } catch (e) {
    console.error(`❌ MoviBox lookup failed: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

export default router;