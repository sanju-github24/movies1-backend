// =====================================================================
// Skip Intro / Next Episode — where a title's intro, recap and credits are
//
//   GET /segments?tmdb=&imdb=&type=movie|tv&season=&episode=
//        { intro: {start, end} | null, recap: {…} | null, credits: {start, end} | null }
//        Seconds. An end of null runs to the end of the video.
//
// Two community databases of real timings, asked together:
//   TheIntroDB  (api.theintrodb.org/v2/media, by TMDB id)  films and series;
//               intro, recap, credits, preview — lists of {start_ms, end_ms},
//               a start of null meaning the very beginning.
//   IntroDB     (api.introdb.app/segments, by IMDb id)      series only;
//               intro, recap, outro, each {start_ms, end_ms, submission_count}.
// TheIntroDB is taken first, IntroDB fills what it lacks. Both are free and
// keyless; TheIntroDB allows 30 asks in 10 seconds, so answers are kept.
// =====================================================================

import express from 'express';
import { TMDB_API_KEY } from './tmdbRoutes.js';

const router = express.Router();

const cache = new Map();   // key → { at, value }
const TTL = 12 * 3600e3;   // timings change only as people submit them
const MISS_TTL = 3600e3;   // a title with none yet is asked again sooner

async function getJson(url) {
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
        if (!res.ok) { res.body?.cancel().catch(() => {}); return null; }
        return await res.json();
    } catch { return null; }
}

const secs = (ms) => (ms == null ? null : Math.round(Number(ms)) / 1000);

// TheIntroDB's list → one span. An intro that starts "null" starts at 0.
const fromList = (list, startAtZero) => {
    const s = Array.isArray(list) ? list.find((x) => x && (x.start_ms != null || x.end_ms != null)) : null;
    if (!s) return null;
    const start = s.start_ms == null ? (startAtZero ? 0 : null) : secs(s.start_ms);
    const end = secs(s.end_ms);
    if (start == null) return null;
    if (end != null && end <= start) return null;
    return { start, end };
};
// IntroDB's single span.
const fromOne = (s) => {
    if (!s || s.start_ms == null) return null;
    const start = secs(s.start_ms), end = secs(s.end_ms);
    return end != null && end <= start ? null : { start, end };
};

/* IntroDB knows titles only by IMDb id. A page that has only the TMDB id
   (our own uploads usually) gets it looked up here, so IntroDB is asked too. */
const imdbOf = new Map();   // "tv:1396" → "tt0903747" | ''
async function imdbFor(tmdb, tv) {
    const k = `${tv ? 'tv' : 'movie'}:${tmdb}`;
    if (imdbOf.has(k)) return imdbOf.get(k);
    const d = await getJson(`https://api.themoviedb.org/3/${tv ? 'tv' : 'movie'}/${tmdb}/external_ids?api_key=${TMDB_API_KEY}`);
    const id = /^tt\d+$/.test(String(d?.imdb_id || '')) ? d.imdb_id : '';
    if (d) imdbOf.set(k, id);
    if (imdbOf.size > 5000) imdbOf.delete(imdbOf.keys().next().value);
    return id;
}

router.get('/segments', async (req, res) => {
    const tmdb = /^\d{1,9}$/.test(String(req.query.tmdb || '')) ? String(req.query.tmdb) : '';
    let imdb = /^tt\d{5,10}$/.test(String(req.query.imdb || '')) ? String(req.query.imdb) : '';
    const tv = req.query.type === 'tv';
    const season = tv ? Math.max(0, parseInt(req.query.season, 10) || 0) : 0;
    const episode = tv ? Math.max(0, parseInt(req.query.episode, 10) || 0) : 0;
    if (!tmdb && !imdb) return res.status(400).json({ error: 'tmdb or imdb is required' });
    if (tv && (!season || !episode)) return res.status(400).json({ error: 'season and episode are required for a series' });

    const key = [tmdb, imdb, tv ? `${season}x${episode}` : 'movie'].join('|');
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < (hit.value.found ? TTL : MISS_TTL)) return res.json(hit.value);

    if (!imdb && tmdb && tv) imdb = await imdbFor(tmdb, tv);
    const se = tv ? `&season=${season}&episode=${episode}` : '';
    const [tidb, idb] = await Promise.all([
        tmdb ? getJson(`https://api.theintrodb.org/v2/media?tmdb_id=${tmdb}${se}`) : null,
        imdb && tv ? getJson(`https://api.introdb.app/segments?imdb_id=${imdb}${se}`) : null,
    ]);

    const intro = fromList(tidb?.intro, true) || (idb?.no_intro ? null : fromOne(idb?.intro));
    const recap = fromList(tidb?.recap, true) || (idb?.no_recap ? null : fromOne(idb?.recap));
    const credits = fromList(tidb?.credits, false) || (idb?.no_outro ? null : fromOne(idb?.outro));
    const value = { intro, recap, credits, found: !!(intro || recap || credits) };

    cache.set(key, { at: Date.now(), value });
    if (cache.size > 5000) cache.delete(cache.keys().next().value);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(value);
});

export default router;
