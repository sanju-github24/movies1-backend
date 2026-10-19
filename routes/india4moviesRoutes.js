// =====================================================================
// India4Movies — download sources, and the last fallback for AnchorHD
//
//   GET /files?q=&year=   the title's posts, one per language:
//        { posts: [{ title, url, lang, print, watch, files: [{ label, quality, size, info, url, code, playable }] }] }
//   GET /servers?code=    one file's download servers, asked for when it is opened:
//        { name, servers: [{ name, url }] }
//   GET /play?v=          the file itself, for a player: a redirect to it
//
// The site is WordPress, so its own REST search answers JSON. A film is
// posted once per language ("Jailer 2 (2026) … HDTC [Tamil (DD2.0)]").
//
// Newer posts put every file on MultiCloudLinks: a "Watch Online" button
// (player.php?v=<code>) and one /view/<code> page per quality. Any code
// opens in the player, which plays the MKV straight off its CDN — with CORS
// and ranges, so our player can play it too. Its link carries a token that
// runs out in a few hours, so it is read from the player page at play time.
// The ".m3u" the player offers for VLC is that same link in a playlist.
// Older posts link a file host's page (full4drive…) and are download only.
// =====================================================================

import express from 'express';
import * as cheerio from 'cheerio';

const router = express.Router();

const BASE = (process.env.I4M_BASE || 'https://go6.india4movies.net').replace(/\/$/, '');
const MCL = (process.env.I4M_MCL || 'https://new3.multicloudlinks.com').replace(/\/$/, '');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const cache = new Map();   // key → { at, value }
const remember = async (key, ttl, make) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await make();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
};

async function get(url, as = 'text') {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html', Referer: `${BASE}/` },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return as === 'json' ? res.json() : res.text();
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const text = (html) => clean(cheerio.load(`<i>${html}</i>`)('i').text());
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// "Jailer 2 (2026) 1080p | 720p | 480p HDTC [Tamil (DD2.0)]" → "jailer 2"
const nameOf = (t) => norm(String(t || '').split(/\((?:19|20)\d{2}|\b(?:480|720|1080|2160)p\b|season|\bS\d{2}\b/i)[0]);

// "[Hindi + Multi Audio (DD2.0)]" → "Hindi + Multi Audio"
const langOf = (title) => {
    const groups = [...title.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].replace(/\(.*?\)/g, '').trim());
    return groups.reverse().find((g) => /^[a-z][a-z +&,]*$/i.test(g) && !/x26|hevc/i.test(g)) || '';
};
const PRINT = /\b(WEB-?HDRip|WEB-?DL|WEB-?Rip|HDRip|Blu-?Ray|BDRip|HDTV|PreDVD|Pre-?HD|HDTC|HDTS|HDCAM|CAMRip|DVDScr|DVDRip)\b/i;
const printOf = (s) => (String(s).match(PRINT) || [])[1] || '';

/* The posts that are this title, newest first: a WEB-DL beats the cam print
   it replaced. */
async function findPosts(q, year) {
    const url = new URL(`${BASE}/wp-json/wp/v2/posts`);
    Object.entries({ search: q, per_page: '20', _fields: 'link,title,date' }).forEach(([k, v]) => url.searchParams.set(k, v));
    const want = nameOf(q);
    if (!want) return [];
    return (await get(url.href, 'json'))
        .map((p) => ({ title: text(p.title?.rendered), url: p.link }))
        .filter((p) => {
            if (nameOf(p.title) !== want) return false;
            const y = (p.title.match(/\(((?:19|20)\d{2})\)/) || [])[1];
            return !year || !y || y === String(year);
        })
        .slice(0, 8);
}

const FILE_HOSTS = /(^|\.)(multicloudlinks\.com|full4drive\.[a-z]+|gdflix\.[a-z]+|filepress\.[a-z]+|hubcloud\.[a-z]+|pixeldrain\.[a-z]+|vikingfile\.[a-z]+|filebee\.[a-z]+)$/i;
const hostName = (link) => { try { return new URL(link).host; } catch { return ''; } };
const QUALITY = /\b(480|540|720|1080|2160)p\b/gi;
const SIZE = /([\d.]+\s*[GM]B)\b/gi;
const last = (s, re) => { const all = String(s).match(re); return all ? all[all.length - 1] : ''; };
const codeOf = (link) => {
    if (!/multicloudlinks\.com$/i.test(hostName(link))) return '';
    return (link.match(/\/view\/([A-Za-z0-9]+)/) || link.match(/[?&]v=([A-Za-z0-9]+)/) || [])[1] || '';
};
/* What a browser plays: x264 and AAC. HEVC plays on few devices, AC3 plays
   silent, and an "Untouch" remux is tens of gigabytes. */
const browserSafe = (s) => /x264|h\.?264|\bavc\b/i.test(s) && /\baac\b/i.test(s)
    && !/hevc|x265|h\.?265|10\s*bit|\bac-?3\b|untouch/i.test(s);

/* A post's files, in the order it lists them. Each button is read with the
   text since the button before it — the line that names its language,
   codecs and size ("Download Now | Kannada | HDTC x264 DD2.0 AAC"), or on
   older posts "{Size: 450 MB] … x264". */
async function postFiles(url) {
    const html = await get(url);
    const $ = cheerio.load(html);
    const body = $('.entry-content').first();
    const root = body.length ? body : $('body');
    let watch = '';
    const files = [];
    let context = '';
    const walk = (node) => {
        for (const el of node.contents().toArray()) {
            if (el.type === 'text') { context += ` ${el.data}`; continue; }
            if (el.type !== 'tag' || /^(script|style)$/i.test(el.name)) continue;
            const href = el.name === 'a' ? $(el).attr('href') || '' : '';
            if (!href || !/^https:/i.test(href) || !FILE_HOSTS.test(hostName(href))) { walk($(el)); continue; }
            const label = clean($(el).text()).replace(/^[^\w[]+/u, '');
            const before = clean(context).slice(-300);
            context = '';
            const code = codeOf(href);
            if (/player\.php/i.test(href) || /watch/i.test(label)) { if (code && !watch) watch = code; continue; }
            // "… | HDTC x264 DD2.0 AAC HC-ESubs", or "… WEB-HDRip x264 ESubs {Size…"
            const info = clean(last(before, /(?:[\w-]+\s+)?\b(?:x26[45]|HEVC|H\.?26[45])\b[^|{}[\]<>:()]*/gi));
            /* A second button for the same file ("Instant-Download" after
               "Direct-Download") names nothing itself: it is the one before. */
            const prev = files[files.length - 1];
            const quality = last(label, QUALITY) || last(before, QUALITY);
            files.push({
                label,
                quality: quality || prev?.quality || '',
                size: last(label, SIZE) || last(before, SIZE) || (quality ? '' : prev?.size || ''),
                info: info || (quality ? '' : prev?.info || ''),
                url: href,
                code,
                playable: !!code && browserSafe(`${info} ${label}`),
            });
        }
    };
    walk(root);
    return { watch, files };
}

export async function india4moviesFiles(q, year = '') {
    return remember(`f:${q.toLowerCase()}|${year}`, 3 * 3600e3, async () => {
        const posts = await findPosts(q, year);
        const read = await Promise.all(posts.map((p) => postFiles(p.url).catch((e) => {
            console.warn(`⚠️ India4Movies post not read (${p.url}): ${e.message}`);
            return { watch: '', files: [] };
        })));
        return {
            posts: posts.map((p, i) => ({ ...p, lang: langOf(p.title), print: printOf(p.title), ...read[i] }))
                .filter((p) => p.watch || p.files.length),
        };
    });
}

router.get('/files', async (req, res) => {
    const q = clean(req.query.q);
    const year = clean(req.query.year).slice(0, 4);
    if (!q) return res.status(400).json({ error: 'q is required', posts: [] });
    try {
        res.json(await india4moviesFiles(q, year));
    } catch (e) {
        console.error(`❌ India4Movies failed for "${q}": ${e.message}`);
        res.status(502).json({ error: 'India4Movies is not answering right now', posts: [] });
    }
});

const CODE = /^[A-Za-z0-9]{4,16}$/;

/* ── One file's servers ──────────────────────────────────────────────
   Its /view/ page: Turbo (R2, the file itself), the mirrors (VikingFile,
   PixelDrain, FilePress, GDFlix) and Instant. The links carry tokens that
   run out, so they are read on opening and kept only briefly. */
export async function india4moviesServers(code) {
    return remember(`v:${code}`, 20 * 60e3, async () => {
        const $ = cheerio.load(await get(`${MCL}/view/${code}`));
        const servers = $('a.premium-btn[href]').map((_, a) => ({ name: clean($(a).text()), url: $(a).attr('href') })).get()
            .filter((s) => /^https:/i.test(s.url) && !/watch online/i.test(s.name) && !/player\.php/i.test(s.url));
        return { name: clean($('title').text()), servers };
    });
}

router.get('/servers', async (req, res) => {
    const code = clean(req.query.code);
    if (!CODE.test(code)) return res.status(400).json({ error: 'Not a MultiCloudLinks file', servers: [] });
    try {
        res.json(await india4moviesServers(code));
    } catch (e) {
        console.error(`❌ India4Movies servers failed for ${code}: ${e.message}`);
        res.status(502).json({ error: 'The file host is not answering right now', servers: [] });
    }
});

/* ── The file, for a player ───────────────────────────────────────────
   The player page names the stream (streamSrc); followed when the video
   element asks, since its link lasts hours, not days. */
const playCache = new Map();   // code → { at, url }
router.get('/play', async (req, res) => {
    const code = clean(req.query.v);
    if (!CODE.test(code)) return res.status(400).send('Not a MultiCloudLinks file');
    try {
        const hit = playCache.get(code);
        let url = hit && Date.now() - hit.at < 30 * 60e3 ? hit.url : '';
        if (!url) {
            const html = await get(`${MCL}/player.php/?v=${code}`);
            url = (html.match(/const\s+streamSrc\s*=\s*"(https:[^"]+)"/) || [])[1] || '';
            if (!url) throw new Error('no stream on the player page');
            playCache.set(code, { at: Date.now(), url });
            if (playCache.size > 500) playCache.delete(playCache.keys().next().value);
        }
        res.set('Cache-Control', 'no-store');
        res.redirect(302, url);
    } catch (e) {
        console.warn(`⚠️ India4Movies play link not followed (${code}): ${e.message}`);
        res.status(502).send('The file host is not answering right now');
    }
});

export default router;
