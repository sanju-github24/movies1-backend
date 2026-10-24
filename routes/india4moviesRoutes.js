// =====================================================================
// India4Movies — download sources, and the last fallback for AnchorHD
//
//   GET /files?q=&year=&type=movie|tv|any   the title's posts, one per language:
//        { posts: [{ title, url, lang, print, season, watch, watchEpisodes,
//                    files: [{ label, quality, size, info, url, code, playable, episodes }] }] }
//        A series (type=tv) has its episodes: watchEpisodes and each file's
//        episodes are [{ ep, code }], every code one episode's file.
//   GET /servers?code=    one file's download servers, asked for when it is opened
//               ?url=     (or an older post's full4drive or HubCloud link):
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
//
// A series post's buttons lead to a list instead — "Episode 1 - Watch
// Online", "Episode 2"… and a Batch/Zip — one per quality, each episode
// with its own code, which the player opens like any other.
// =====================================================================

import express from 'express';
import * as cheerio from 'cheerio';
import { hdhubServers } from './hdhubRoutes.js';
import { titleNames } from '../utils/titleNames.js';
import { domainOf } from '../utils/siteDomains.js';

const router = express.Router();

/* The domain moves; the admin sets the new one on Admin → Source domains. */
const base = () => domainOf('i4m');
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
    const ask = () => fetch(url, {
        headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html', Referer: `${base()}/` },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
    });
    // One retry: the site drops a connection now and then.
    const res = await ask().catch(async () => { await new Promise((r) => setTimeout(r, 1500)); return ask(); });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return as === 'json' ? res.json() : res.text();
}

/* MultiCloudLinks answers one request at a time: asked several at once, all
   but one get a 17-byte page instead of theirs. So its pages are fetched in
   turn, and one that comes back that short is asked again. */
let mclQueue = Promise.resolve();
function getMcl(url) {
    const turn = mclQueue.then(async () => {
        let html = await get(url);
        if (html.length < 500) { await new Promise((r) => setTimeout(r, 1000)); html = await get(url); }
        return html;
    });
    mclQueue = turn.catch(() => {});
    return turn;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const text = (html) => clean(cheerio.load(`<i>${html}</i>`)('i').text());
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// "Jailer 2 (2026) 1080p | 720p | 480p HDTC [Tamil (DD2.0)]" → "jailer 2"
const nameOf = (t) => norm(String(t || '').split(/\((?:19|20)\d{2}|\b(?:480|720|1080|2160)p\b|season|\bS\d{2}\b/i)[0]);

// "[Hindi + Multi Audio (DD2.0)]" → "Hindi + Multi Audio"
const langOf = (title) => {
    const groups = [...title.matchAll(/\[([^\]]+)\]/g)].map((m) => clean(m[1].replace(/\(.*?\)/g, ' ')));
    return groups.reverse().find((g) => /^[a-z][a-z +&,]*$/i.test(g) && !/x26|hevc/i.test(g)) || '';
};
const PRINT = /\b(WEB-?HDRip|WEB-?DL|WEB-?Rip|HDRip|Blu-?Ray|BDRip|HDTV|PreDVD|Pre-?HD|HDTC|HDTS|HDCAM|CAMRip|DVDScr|DVDRip)\b/i;
const printOf = (s) => (String(s).match(PRINT) || [])[1] || '';

/* The posts that are this title, newest first: a WEB-DL beats the cam print
   it replaced. A series is searched with "season" too — by its name alone,
   a short one ("Love") is lost among the films that share the word — and
   its year is the season's, not the show's, so it is not held to one. */
const seasonOf = (t) => Number((String(t).match(/\bSeason\s*(\d{1,3})/i) || [])[1]) || 0;
/* A title with a second name — "Fakes (Farzi)" — is looked for by each:
   the post may be under either ("Farzi – Season 1", at a "fakes-…" address). */
/* A post can be titled by one name and addressed by another — "Farzi –
   Season 1" at /fakes-full-season-1-web-series-download-2/ — so its
   address counts too: a name, then nothing but the usual words after it. */
const slugIs = (url, wants) => {
    let slug = '';
    try { slug = new URL(url).pathname.replace(/^\/|\/$/g, '').replace(/-/g, ' ').toLowerCase(); } catch { return false; }
    const rest = /^(?:(?:full|season|s\d{1,2}|\d{1,4}|web|series|movie|download|tamil|telugu|hindi|malayalam|kannada|english|dubbed|hd|hdrip|webrip|watch|online)\s*)*$/;
    // …but a number straight after the name is a sequel ("jailer 2 2026"), not this title.
    return [...wants].some((w) => slug.startsWith(`${w} `) && !/^\d{1,2}\b/.test(slug.slice(w.length + 1))
        && rest.test(slug.slice(w.length + 1)));
};
async function findPosts(q, year, tv = false) {
    const terms = titleNames(q).filter((x) => nameOf(x));
    const wants = new Set(terms.map(nameOf));
    if (!wants.size) return [];
    const search = async (term) => {
        const url = new URL(`${base()}/wp-json/wp/v2/posts`);
        Object.entries({ search: term, per_page: '20', _fields: 'link,title,date' }).forEach(([k, v]) => url.searchParams.set(k, v));
        return get(url.href, 'json');
    };
    /* Either search may be dropped; only both failing is a failure (and is
       not remembered, so the next viewer asks again). */
    const asked = await Promise.allSettled(terms.flatMap((t) => (tv ? [search(`${t} season`), search(t)] : [search(t)])));
    if (asked.every((x) => x.status === 'rejected')) throw asked[0].reason;
    const found = asked.flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
    const seen = new Set();
    return found
        .map((p) => ({ title: text(p.title?.rendered), url: p.link }))
        .filter((p) => {
            if (seen.has(p.url) || !(wants.has(nameOf(p.title)) || slugIs(p.url, wants))) return false;
            seen.add(p.url);
            const series = !!seasonOf(p.title);
            if (tv !== 'any' && !!tv !== series) return false;   // a film is not its series
            const y = (p.title.match(/\(((?:19|20)\d{2})\)/) || [])[1];
            return series || !year || !y || y === String(year);
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

/* A series' list page: its episodes, each with its own code. The Batch/Zip
   is left out — it is the whole season, not something to play. */
async function episodeList(code) {
    const $ = cheerio.load(await getMcl(`${MCL}/view/${code}`));
    const eps = [];
    $('a.premium-btn[href]').each((_, a) => {
        const ep = Number((clean($(a).text()).match(/\bEpisode\s*(\d{1,4})\b/i) || [])[1]);
        const c = codeOf($(a).attr('href') || '');
        if (ep && c && !eps.some((x) => x.ep === ep)) eps.push({ ep, code: c });
    });
    return eps;
}

async function seriesEpisodes(post) {
    const lists = await Promise.all([post.watch, ...post.files.map((f) => f.code)].map((c) => (c ? episodeList(c).catch(() => []) : [])));
    return {
        ...post,
        watchEpisodes: lists[0],
        files: post.files.map((f, i) => ({ ...f, episodes: lists[i + 1] })),
    };
}

export async function india4moviesFiles(q, year = '', tv = false) {
    // tv: true a series, false a film, 'any' either (a search box that cannot tell).
    return remember(`f:${tv === 'any' ? 'any' : tv ? 'tv' : 'movie'}|${q.toLowerCase()}|${year}`, 3 * 3600e3, async () => {
        const posts = await findPosts(q, year, tv);
        const read = await Promise.all(posts.map(async (p) => {
            try {
                const got = await postFiles(p.url);
                return seasonOf(p.title) ? await seriesEpisodes(got) : got;
            } catch (e) {
                console.warn(`⚠️ India4Movies post not read (${p.url}): ${e.message}`);
                return { watch: '', files: [] };
            }
        }));
        return {
            posts: posts.map((p, i) => ({ ...p, lang: langOf(p.title), print: printOf(p.title), season: seasonOf(p.title), ...read[i] }))
                .filter((p) => p.watch || p.files.length),
        };
    });
}

router.get('/files', async (req, res) => {
    const q = clean(req.query.q);
    const year = clean(req.query.year).slice(0, 4);
    if (!q) return res.status(400).json({ error: 'q is required', posts: [] });
    try {
        const type = req.query.type;
        res.json(await india4moviesFiles(q, year, type === 'tv' ? true : type === 'any' ? 'any' : false));
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
        const $ = cheerio.load(await getMcl(`${MCL}/view/${code}`));
        const servers = $('a.premium-btn[href]').map((_, a) => ({ name: clean($(a).text()), url: $(a).attr('href') })).get()
            .filter((s) => /^https:/i.test(s.url) && !/watch online/i.test(s.name) && !/player\.php/i.test(s.url));
        return { name: clean($('title').text()), servers };
    });
}

/* ── An older post's file ─────────────────────────────────────────────
   Its button is a full4drive page, whose Extralink button leads to a page
   of mirrors; of those only Direct Download works, and it is a plain GET
   (/s/<code>/download/?driveIndex=0) that redirects to the file itself on
   a Cloudflare worker — an MKV with CORS and ranges, named after
   1Full4Movies. Followed here, so the viewer gets the file in one tap.
   The worker's host changes from one ask to the next; its path does not. */
const FULL4DRIVE = /^https:\/\/(?:[a-z0-9-]+\.)?full4drive\.[a-z]+\/file\/[A-Za-z0-9]+\/?$/i;
export async function full4driveServers(link) {
    return remember(`x:${link}`, 20 * 60e3, async () => {
        const html = await get(link);
        const name = clean((html.match(/<b>Name:<\/b>\s*([^<]+)/i) || [])[1]);
        const size = clean((html.match(/<b>Size:<\/b>\s*([^<]+)/i) || [])[1]);
        const xl = (html.match(/https:\/\/[a-z0-9.-]*extralink\.[a-z]+\/s\/([A-Za-z0-9]+)/i) || []);
        if (!xl[0]) {
            /* Older still: no Extralink, but a HubCloud copy, whose servers
               HDHub4u's route already knows how to follow. */
            const hub = (html.match(/https:\/\/[a-z0-9.-]*hubcloud\.[a-z]+\/drive\/[A-Za-z0-9]+/i) || [])[0];
            const got = hub ? await hdhubServers(hub).catch(() => null) : null;
            return { name, size, servers: got?.servers || [] };
        }
        const res = await fetch(`${new URL(xl[0]).origin}/s/${xl[1]}/download/?driveIndex=0`, {
            headers: { 'User-Agent': UA, Referer: `${xl[0]}/` }, redirect: 'manual', signal: AbortSignal.timeout(15000),
        });
        res.body?.cancel();
        const file = res.headers.get('location') || '';
        return { name, size, servers: /^https:/i.test(file) ? [{ name: 'Direct Download', url: file }] : [] };
    });
}

// An older post's other copy of a file, beside its full4drive one.
const HUBCLOUD = /^https:\/\/(?:[a-z0-9-]+\.)?hubcloud\.[a-z]+\/(?:drive|video)\/[A-Za-z0-9_-]+\/?$/i;

router.get('/servers', async (req, res) => {
    const code = clean(req.query.code);
    const url = clean(req.query.url);
    if (!CODE.test(code) && !FULL4DRIVE.test(url) && !HUBCLOUD.test(url)) {
        return res.status(400).json({ error: 'Not a MultiCloudLinks, full4drive or HubCloud file', servers: [] });
    }
    try {
        res.json(code ? await india4moviesServers(code)
            : FULL4DRIVE.test(url) ? await full4driveServers(url)
            // HubCloud is slow at times: one more try before giving up.
            : await hdhubServers(url).catch(() => hdhubServers(url)));
    } catch (e) {
        console.error(`❌ India4Movies servers failed for ${code || url}: ${e.message}`);
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
            const html = await getMcl(`${MCL}/player.php/?v=${code}`);
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
