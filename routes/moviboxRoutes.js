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

const router = express.Router();

const BASE = 'https://movibox.net';
const API = `${BASE}/wefeed-h5api-bff`;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const REFERER = `${BASE}/`;

const clientToken = () => {
  const t = Math.floor(Date.now() / 1000);
  return `${t},${crypto.createHash('md5').update(String(t).split('').reverse().join('')).digest('hex')}`;
};

let guest = { token: '', at: 0 };
async function mb(path, { method = 'GET', body, referer = REFERER } = {}) {
  const headers = {
    Accept: 'application/json', 'content-type': 'application/json',
    'X-Client-Info': JSON.stringify({ timezone: 'Asia/Kolkata' }), 'X-Request-Lang': 'en',
    'User-Agent': UA, Origin: BASE, Referer: referer,
    ...(guest.token && Date.now() - guest.at < 6 * 3600e3 ? { Authorization: `Bearer ${guest.token}` } : { 'X-Client-Token': clientToken() }),
  };
  const res = await fetch(API + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const user = res.headers.get('x-user');
  if (user) { try { const t = JSON.parse(user).token; if (t) guest = { token: t, at: Date.now() }; } catch { /* keep the old one */ } }
  const json = await res.json().catch(() => null);
  if (!json || json.code !== 0) throw new Error(`MoviBox ${path.split('?')[0]}: ${json?.message || res.status}`);
  return json.data;
}
// A guest token first: search refuses without one.
const ensureGuest = async () => { if (!guest.token) await mb('/home?host=movibox.net').catch(() => {}); };

const norm = (s) => String(s || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/&/g, ' and ')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const yearOf = (s) => Number(String(s || '').slice(0, 4)) || 0;

async function tmdbTitle(id, type) {
  const kinds = type ? [type] : ['movie', 'tv'];
  for (const k of kinds) {
    const r = await fetch(`https://api.themoviedb.org/3/${k}/${id}?api_key=${TMDB_API_KEY}`, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) continue;
    const d = await r.json();
    return { type: k, titles: [d.title || d.name, d.original_title || d.original_name].filter(Boolean),
      year: yearOf(d.release_date || d.first_air_date) };
  }
  throw new Error('TMDB has no title with that id');
}

/* The MoviBox title that is this one: the same name (any language's version
   — they all list the others) and, for a film, the same year give or take one. */
async function findSubject(titles, year, type) {
  await ensureGuest();
  const want = titles.map(norm).filter(Boolean);
  const subjectType = type === 'tv' ? 2 : 1;
  for (const t of titles) {
    const d = await mb('/subject/search', { method: 'POST', body: { keyword: t, page: 1, perPage: 20, subjectType } });
    const hit = (d.items || []).find((x) => want.includes(norm(x.title))
      && (!year || type === 'tv' || Math.abs(yearOf(x.releaseDate) - year) <= 1));
    if (hit) return hit;
  }
  return null;
}

async function streamsFor(dub, se, ep) {
  const watchPage = `${BASE}/movies/${dub.detailPath}?id=${dub.subjectId}&type=/movie/detail&detailSe=${se || ''}&detailEp=${ep || ''}&lang=en`;
  const d = await mb(`/subject/play?subjectId=${dub.subjectId}&se=${se || 0}&ep=${ep || 0}&detailPath=${dub.detailPath}&streamSignType=1`, { referer: watchPage });
  const dash = (d.dash || [])[0];
  const signed = (x) => ({ Referer: REFERER, ...(x?.signHeaderKey && x?.signCookie ? { [x.signHeaderKey]: x.signCookie } : {}) });
  return {
    available: !!d.hasResource,
    mpd: dash ? { url: dash.url, resolutions: dash.resolutions, codec: dash.codecName, size: Number(dash.size) || null, headers: signed(dash) } : null,
    mp4: (d.streams || []).map((s) => ({ url: s.url, resolution: `${s.resolutions}p`, size: Number(s.size) || null, codec: s.codecName, headers: signed(s) }))
      .sort((a, b) => parseInt(b.resolution, 10) - parseInt(a.resolution, 10)),
  };
}

const cache = new Map();   // key → { at, value }

router.get('/', async (req, res) => {
  // Optional lock: with MOVIBOX_KEY set, the key must come with the request.
  if (process.env.MOVIBOX_KEY && req.query.key !== process.env.MOVIBOX_KEY && req.get('x-key') !== process.env.MOVIBOX_KEY) {
    return res.status(401).json({ error: 'key required' });
  }
  const type = req.query.type === 'tv' ? 'tv' : req.query.type === 'movie' ? 'movie' : '';
  const se = Number(req.query.se) || 0, ep = Number(req.query.ep) || 0;
  try {
    let titles, year = Number(req.query.year) || 0, kind = type;
    if (req.query.tmdb) ({ titles, year, type: kind } = await tmdbTitle(String(req.query.tmdb).replace(/\D/g, ''), type));
    else if (req.query.title) titles = [String(req.query.title).slice(0, 200)];
    else return res.status(400).json({ error: 'tmdb or title is required' });

    const key = `${titles[0]}|${year}|${kind}|${se}|${ep}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 20 * 60e3) return res.json(hit.value);

    const subject = await findSubject(titles, year, kind || 'movie');
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
    const value = { title: titles[0], year, type: kind || 'movie', se: se || undefined, ep: ep || undefined,
      matched: { title: subject.title, detailPath: subject.detailPath, releaseDate: subject.releaseDate }, languages };
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    res.json(value);
  } catch (e) {
    console.error(`❌ MoviBox lookup failed: ${e.message}`);
    res.status(502).json({ error: e.message });
  }
});

export default router;
