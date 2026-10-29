// =====================================================================
// 1TamilBlasters — direct downloads, and a playable source for AnchorHD
//
//   GET /files?title=&year=&season=&episode=
//        the title's files, each a DIRECT .mkv (no magnet):
//        { post, files: [{ name, quality, size, season, episode, url }] }
//        episode filters to one when given.
//   GET /play?u=<file url>   → 302 to the file (what the player opens)
//
// The forum (1TamilMV, /api/fresh) posts these releases magnet-only. Its
// sister blog 1TamilBlasters posts the SAME releases with direct links: each
// quality is a WordPress "download" button carrying a `data-file` filename,
// and an inline script turns it into `<phpBase><file>` — a PHP endpoint that
// 302s to a signed, range-supporting .mkv served as an attachment. So the
// files play in AnchorHD (real MKV, Accept-Ranges) and download cleanly.
//
// The blog is WordPress, so its REST search finds the post; the php base and
// the file names are read from the post's own script, so they are always
// current. The blog domain moves; the admin sets it on Admin → Source
// domains (site "tblasters").
// =====================================================================

import express from 'express';
import { domainOf } from '../utils/siteDomains.js';
import { searchTopics } from './freshRoutes.js';

const router = express.Router();

const base = () => domainOf('tblasters');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const cache = new Map();
const remember = async (key, ttl, make) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await make();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
};

async function get(url, as = 'text') {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${url.split('?')[0]} answered ${r.status}`);
    return as === 'json' ? r.json() : r.text();
}

const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
/* TMDB's per-language suffix ("Celebrity Master Chef - Tamil") is not on the blog's post. */
const stripLang = (s) => String(s || '').replace(/\s*[-–:]\s*(tamil|telugu|hindi|malayalam|kannada|english|bengali|marathi|punjabi|gujarati|odia|urdu)\s*$/i, '').trim();
const decode = (s) => String(s || '').replace(/&#0?38;|&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&#8211;|&#8212;/g, '-').replace(/&quot;/g, '"').replace(/<[^>]+>/g, '').trim();

/* Finding the post WITHOUT the blog's search, which sits behind a Cloudflare
   challenge (for every IP, not just ours). The blog is the sister site of the
   1TamilMV forum: the forum's search works (/api/fresh → searchTopics), its
   topic URL carries the release slug, and the blog reuses that same slug for
   its post — "…/forums/topic/39318-celebrity-master-chef-2026-s01-ep-01-02-tamil/"
   ↔ "{blog}/celebrity-master-chef-2026-s01-ep-01-02-tamil/", a DIRECT post page
   that loads fine. So the release is found on the forum and the post fetched by
   its own URL; the challenged search is never touched. */
const slugOfTopic = (href) => (String(href).match(/\/topic\/\d+-([^/?#]+)/) || [])[1] || '';
async function findPosts(title, year, series) {
    const topics = await searchTopics(title, year, series).catch(() => []);
    const slugs = [...new Set(topics.map(slugOfTopic).filter(Boolean))].slice(0, 6);
    // The blog sometimes adds a "-2" to a repeated slug; try the bare one first.
    return slugs.flatMap((slug) => [`${base()}/${slug}/`, `${base()}/${slug}-2/`])
        .map((link) => ({ link, title: slug2title(link) }));
}
const slug2title = (url) => { try { return decodeURIComponent(new URL(url).pathname.replace(/\/+$/, '').split('/').pop() || '').replace(/-/g, ' '); } catch { return ''; } };

const QUALITY = (name) => (name.match(/\b(2160|1080|720|480|360)p\b/i) || [])[0] || (/\b4k\b/i.test(name) ? '2160p' : '');
/* Episode from the file name: "S01E04", "S01 EP04", "EP01", "Day 00". */
function epOf(name) {
    const se = name.match(/S0*(\d{1,2})[ _.-]*E(?:P)?0*(\d{1,3})/i);
    if (se) return { season: Number(se[1]), episode: Number(se[2]) };
    const ep = name.match(/\bEP?0*(\d{1,3})\b/i);
    if (ep) return { season: 1, episode: Number(ep[1]) };
    return { season: null, episode: null };
}

/* A post's direct files: the php base from its script + each download button's
   data-file. An embed list (luluvido etc.) is kept as a play fallback. */
async function postFiles(url) {
    const html = await get(url);
    const phpBase = (html.match(/const\s+downloadLink\s*=\s*"([^"]+)"\s*\+\s*button\.dataset\.file/) || [])[1]
        || (html.match(/downloadLink\s*=\s*"([^"]+\.php\?file=)"/) || [])[1] || null;
    const files = [];
    if (phpBase) {
        const seen = new Set();
        for (const m of html.matchAll(/class="downloadBtn"[^>]*data-file="([^"]+)"/g)) {
            const name = decode(m[1]);
            if (!name || seen.has(name)) continue;
            seen.add(name);
            files.push({ name, quality: QUALITY(name), size: (name.match(/([\d.]+\s*[GM]B)\b/i) || [])[1] || '', ...epOf(name), url: `${phpBase}${encodeURIComponent(name)}` });
        }
    }
    const embeds = [...html.matchAll(/<iframe[^>]+src="(https?:\/\/[^"]+)"/g)].map((m) => m[1])
        .filter((u) => /luluvido|streamwish|filemoon|vidhide|dood|mixdrop|vtube|streamtape/i.test(u));
    return { files, embeds };
}

export async function tblastersFiles(title, year = '', season = null, episode = null, series = null) {
    const isTv = series == null ? !!(season || episode) : !!series;
    return remember(`f:${isTv ? 'tv' : 'mv'}|${norm(stripLang(title))}|${year}`, 2 * 3600e3, async () => {
        const posts = await findPosts(title, year, isTv);
        const all = [];
        let post = null;
        for (const p of posts) {
            try {
                const got = await postFiles(p.link);
                if (got.files.length || got.embeds.length) { post = post || p.title; all.push({ ...p, ...got }); }
            } catch { /* skip a post that does not read */ }
        }
        // One list of files across the matched posts, de-duplicated by name.
        const seen = new Set();
        const files = all.flatMap((p) => p.files).filter((f) => !seen.has(f.name) && seen.add(f.name));
        const embeds = [...new Set(all.flatMap((p) => p.embeds))];
        return { post, files, embeds };
    }).then((d) => {
        if (!episode) return d;
        const n = Number(episode);
        const match = d.files.filter((f) => f.episode === n && (!season || f.season === Number(season)));
        return { ...d, files: match.length ? match : d.files };
    });
}

router.get('/files', async (req, res) => {
    try {
        const title = String(req.query.title || '').slice(0, 200);
        if (!title) return res.status(400).json({ success: false, message: 'title is required' });
        const d = await tblastersFiles(title, String(req.query.year || ''), req.query.season || null, req.query.episode || null, req.query.type === 'tv' ? true : req.query.type === 'movie' ? false : null);
        res.json({ success: true, ...d });
    } catch (e) {
        res.status(502).json({ success: false, message: e.message, files: [] });
    }
});

/* The player/browser opens this; it 302s to the file (the php endpoint signs
   a fresh link each time), so nothing heavy passes through us. */
router.get('/play', (req, res) => {
    const u = String(req.query.u || '');
    try {
        const h = new URL(u).hostname;
        if (!/\.php($|\?)/.test(u) && !/top|xyz|com|net|click|blog/.test(h)) throw new Error('bad');
    } catch { return res.status(400).json({ success: false, message: 'bad url' }); }
    res.redirect(302, u);
});

export default router;
