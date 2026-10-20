// =====================================================================
// Bingr's direct servers, for AnchorHD — asked from here, not the browser
//
//   GET /stream?srv=&t=movie|tv&id=<tmdb>&title=&year=&season=&episode=
//        { name, sources: [{ url, quality, language, isMP4 }], subtitles: [...] }
//
// bingr.one's player asks its API for a title by TMDB id, title and year
// (and SxE), one server at a time: POST api.bingr.one/api/stream
// { srv, t, id, query }. The API answers only bingr.one's own origin
// (anything else is "cors_blocked"), so a browser on our site cannot ask it;
// this does, as bingr.one. Without the title and year most servers find
// nothing — they match by name.
//
// The streams it hands back (proxy.streamrip.fun and others) also check the
// origin, and accept bingr.one's or none; AnchorHD plays them through our
// worker with bingr.one as the Referer.
// =====================================================================

import express from 'express';
import { TMDB_API_KEY } from './tmdbRoutes.js';

const router = express.Router();

const API = (process.env.BINGR_API || 'https://api.bingr.one/api').replace(/\/$/, '');
const HEADERS = {
    'Content-Type': 'application/json',
    Origin: 'https://bingr.one',
    Referer: 'https://bingr.one/',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

// The servers bingr offers (its "coming soon" ones left out), by its ids.
export const BINGR_SERVERS = {
    s40: 'Aphelion', s70: 'Polaris', s80: 'Moscow', s81: 'Novo',
    s62: 'Bastion', s30: 'Nova', s61: 'Corvus', s31: 'Orion',
};

/* The links carry tokens of their own, so an answer is kept briefly: long
   enough for the player's second look (the language menu fills in while the
   first stream plays), not so long that it hands out a dead link. */
const cache = new Map();   // key → { at, value }
const TTL = 10 * 60e3;

/* These servers match a title by its name, and a short one finds the wrong
   show: for the Tamil series "#Love" Bastion sent an English/German/Hindi/
   Portuguese/Spanish "Love". A real answer has the title's own language, or
   says "Original" / names none; one whose streams all name other languages
   is someone else's title, and is dropped. The language is TMDB's. */
const LANG_NAMES = { ta: 'tamil', te: 'telugu', hi: 'hindi', ml: 'malayalam', kn: 'kannada', en: 'english', bn: 'bengali',
    mr: 'marathi', pa: 'punjabi', gu: 'gujarati', ko: 'korean', ja: 'japanese', zh: 'chinese', cn: 'chinese', es: 'spanish',
    fr: 'french', de: 'german', it: 'italian', pt: 'portuguese', ru: 'russian', th: 'thai', tr: 'turkish', ar: 'arabic', id: 'indonesian' };
const origLangs = new Map();   // "tv:123" → "tamil" | ''
async function originalLanguage(t, id) {
    const k = `${t}:${id}`;
    if (origLangs.has(k)) return origLangs.get(k);
    let name = '';
    try {
        const r = await fetch(`https://api.themoviedb.org/3/${t}/${id}?api_key=${TMDB_API_KEY}`, { signal: AbortSignal.timeout(10000) });
        if (r.ok) name = LANG_NAMES[(await r.json()).original_language] || '';
    } catch { /* unknown: nothing is dropped */ }
    origLangs.set(k, name);
    if (origLangs.size > 5000) origLangs.delete(origLangs.keys().next().value);
    return name;
}
const looksLikeOtherTitle = (sources, orig) => {
    if (!orig || !sources.length) return false;
    const named = sources.map((s) => String(s.language || '').toLowerCase()).filter((l) => l && !/original|auto|^und$/.test(l));
    if (named.length < sources.length) return false;           // something says "Original" or names nothing
    return !named.some((l) => l.includes(orig));
};

async function ask(srv, t, id, query) {
    // Aphelion has its own path for an episode, as bingr's player asks it.
    const res = srv === 's40' && t === 'tv' && query.season && query.episode
        ? await fetch(`${API}/stream/aphelion-tv/${id}/${query.season}/${query.episode}`, { headers: HEADERS, signal: AbortSignal.timeout(40000) })
        : await fetch(`${API}/stream`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ srv, t, id, query }), signal: AbortSignal.timeout(40000) });
    // A server that has not got the title answers 500 "stream lookup failed": nothing, not an error.
    if (!res.ok) { res.body?.cancel().catch(() => {}); return { sources: [], subtitles: [] }; }
    const d = await res.json().catch(() => ({}));
    return {
        sources: (d.sources || []).filter((s) => s?.url && /^https:/.test(s.url)).map((s) => ({
            url: s.url, quality: s.quality || '', language: s.language || '', isMP4: !!s.isMP4,
        })),
        subtitles: (d.subtitles || []).filter((s) => s?.url).map((s) => ({ url: s.url, lang: s.lang || s.language || '', label: s.label || '' })),
    };
}

router.get('/stream', async (req, res) => {
    const srv = String(req.query.srv || '');
    const t = req.query.t === 'tv' ? 'tv' : 'movie';
    const id = String(req.query.id || '');
    if (!BINGR_SERVERS[srv]) return res.status(400).json({ error: 'Unknown server', sources: [] });
    if (!/^\d{1,9}$/.test(id)) return res.status(400).json({ error: 'A TMDB id is required', sources: [] });
    const query = {};
    const title = String(req.query.title || '').trim().slice(0, 200);
    const year = String(req.query.year || '').slice(0, 4);
    if (title) query.title = title;
    if (/^\d{4}$/.test(year)) query.year = year;
    if (t === 'tv') {
        query.season = Math.max(1, parseInt(req.query.season, 10) || 1);
        query.episode = Math.max(1, parseInt(req.query.episode, 10) || 1);
    }
    const key = JSON.stringify([srv, t, id, query]);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL) return res.json(hit.value);
    try {
        const [got, orig] = await Promise.all([ask(srv, t, id, query), originalLanguage(t, id)]);
        const value = looksLikeOtherTitle(got.sources, orig)
            ? { name: BINGR_SERVERS[srv], sources: [], subtitles: [], dropped: `another title (none in ${orig})` }
            : { name: BINGR_SERVERS[srv], ...got };
        cache.set(key, { at: Date.now(), value });
        if (cache.size > 1000) cache.delete(cache.keys().next().value);
        res.json(value);
    } catch (e) {
        res.status(502).json({ error: `${BINGR_SERVERS[srv]} is not answering right now`, sources: [] });
    }
});

export default router;
