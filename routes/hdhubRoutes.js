// =====================================================================
// HDHub4u — more download sources for the download page
//
//   GET /files?q=&year=&imdb=   the matching post and its files:
//        { post: { title, url } | null, files: [{ label, quality, size, links: [{ name, url }] }] }
//   GET /servers?url=           one file's download servers, asked for when it is opened:
//        { name, size, servers: [{ name, url }] }
//
// Search is the site's own search index (Typesense behind search.pingora.fyi),
// which answers JSON and knows each post's IMDb id, so a title is matched
// exactly when we have one. A post lists each file as a heading
// ("720p HEVC [1.2GB]") wrapping its link.
//
// Some of those links go to a "please wait 10 seconds" page (greenmotors…)
// rather than to the file. The wait is only in the browser: the page carries
// its destination with it, encoded, and goes there when the count ends. That
// destination is a page listing the file's mirrors, so both steps are done
// here, once, and the viewer gets the HubDrive link straight away.
// =====================================================================

import express from 'express';
import * as cheerio from 'cheerio';
import { titleNames } from '../utils/titleNames.js';
import { overrideOf, defaultBase } from '../utils/siteDomains.js';

const router = express.Router();

/* The site moves from one domain to the next (new1.hdhub4u.free, gone;
   new8.hdhub4u.cl …), and its search keeps handing out links on old ones.
   Its own landing page asks a lookup for the domain of the day — {c:
   base64 "https://new8.hdhub4u.cl/?utm=…"} — and so does this, hourly,
   keeping the last answer (or HDHUB_BASE) when the lookup is down.
   A domain set by the admin (Admin → Source domains) wins over both. */
let BASE = defaultBase('hdhub');
const HOST_LOOKUPS = ['https://dns.pingora.fyi/v2/host', 'https://h4.suncdn.org/host/'];
let baseAt = 0;
const baseNow = () => overrideOf('hdhub')?.base || BASE;
export async function currentBase() {
    if (overrideOf('hdhub')) return overrideOf('hdhub').base;
    if (Date.now() - baseAt < 3600e3) return BASE;
    baseAt = Date.now();
    for (const url of HOST_LOOKUPS) {
        try {
            const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(8000) });
            const c = res.ok ? Buffer.from(String((await res.json()).c || ''), 'base64').toString() : '';
            if (/^https:\/\/[a-z0-9.-]*hdhub4u\.[a-z]+/i.test(c)) { BASE = new URL(c).origin; break; }
        } catch { /* the next lookup */ }
    }
    return BASE;
}
const SEARCH = process.env.HDHUB_SEARCH || 'https://search.pingora.fyi/collections/post/documents/search';
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
        headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html', Referer: `${baseNow()}/` },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return as === 'json' ? res.json() : res.text();
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\[.*?\]|\{.*?\}/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
// "Dhurandhar (2025) DS4K WEB-DL [Hindi DD5.1] 4K …" → "dhurandhar"
const nameOf = (t) => norm(String(t || '').split(/\((?:19|20)\d{2}|season|\bS\d{2}\b/i)[0]);

/* The post that is this title. By IMDb id when we know it — newest first, so
   a WEB-DL beats the cam print it replaced — or else by name and year. */
async function findPost(q, year, imdb) {
    const url = new URL(SEARCH);
    Object.entries({
        q: imdb || q, query_by: 'post_title,category,stars,director,imdb_id', query_by_weights: '4,2,2,2,4',
        sort_by: 'sort_by_date:desc', limit: '15', highlight_fields: 'none', use_cache: 'true', page: '1',
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const hits = ((await get(url.href, 'json')).hits || []).map((h) => h.document).filter((d) => d?.permalink);

    if (imdb) {
        const exact = hits.find((d) => d.imdb_id === imdb);
        if (exact) return exact;
        if (!q) return null;
        return findPost(q, year, '');
    }
    const want = nameOf(q);
    if (!want) return null;
    const scored = hits.map((d) => {
        const have = nameOf(d.post_title);
        const y = (d.post_title.match(/\(((?:19|20)\d{2})/) || [])[1];
        let score = have === want ? 3 : 0;
        if (score && year && y) score += String(y) === String(year) ? 2 : -2;
        return { d, score };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
    return scored[0]?.d || null;
}

// A post's path, on the current domain: the one in its link may be long gone.
const onBase = async (link) => {
    try { const u = new URL(link); return `${await currentBase()}${u.pathname}${u.search}`; } catch { return link; }
};

const FILE_HOSTS = /(^|\.)(hubdrive|hubcloud|hubcdn)\./i;
const hostName = (link) => { try { return new URL(link).host; } catch { return ''; } };
const kindOf = (link) => {
    const h = hostName(link);
    if (/hubdrive/i.test(h)) return 'HubDrive';
    if (/hubcloud/i.test(h)) return 'HubCloud';
    if (/hubcdn/i.test(h)) return 'HubCDN';
    return 'Download';
};

const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));

/* A wait page's destination. It stores s('o', '<encoded>') for its next page
   to read: base64, base64 again, rot13, then base64 JSON whose "o" is the
   destination in base64 once more. */
function waitPageTarget(html) {
    const m = html.match(/s\(\s*['"]o['"]\s*,\s*['"]([A-Za-z0-9+/=]+)['"]/);
    if (!m) return '';
    const data = JSON.parse(b64(rot13(b64(b64(m[1])))));
    return data.o ? b64(data.o) : '';
}

/* A link straight to the file: the wait page skipped, then the mirror list
   it leads to read for the HubDrive copy (or the next best). Falls back to
   the link as given, which still works, just with its wait. */
async function direct(link) {
    if (FILE_HOSTS.test(hostName(link))) return link;
    return remember(`d:${link}`, 24 * 3600e3, async () => {
        try {
            const target = waitPageTarget(await get(link));
            if (!target) return link;
            if (FILE_HOSTS.test(hostName(target))) return target;
            const $ = cheerio.load(await get(target));
            const hrefs = $('a[href]').map((_, a) => $(a).attr('href')).get().filter((h) => FILE_HOSTS.test(hostName(h)));
            return hrefs.find((h) => /hubdrive/i.test(h)) || hrefs.find((h) => /hubcloud/i.test(h)) || hrefs[0] || link;
        } catch (e) {
            console.warn(`⚠️ HDHub4u wait page not followed (${hostName(link)}): ${e.message}`);
            return link;
        }
    });
}

const QUALITY = /\b(480|540|720|1080|2160)p\b|\b4k\b/i;

async function postFiles(url) {
    const $ = cheerio.load(await get(url));
    const found = [];
    /* A series post lists each episode under its own heading — "EPiSODE 1",
       then "720p – Drive | Instant | WATCH", "1080p – Drive | Instant" — so
       a quality line after one is that episode's file. Its WATCH link is the
       site's player, not a file, and is left out (the Drive link comes first). */
    let episode = 0;
    $('h2, h3, h4, h5').each((_, h) => {
        const label = clean($(h).text());
        const ep = label.match(/^\W*episode\s*0*(\d{1,4})\W*$/i);
        if (ep) { episode = Number(ep[1]); return; }
        if (/^h2$/i.test(h.tagName) && !QUALITY.test(label)) episode = 0;
        if (!QUALITY.test(label) || /player|trailer/i.test(label)) return;
        if (/watch/i.test(label) && !episode) return;
        const href = $(h).find('a[href]').filter((_, a) => !/watch/i.test($(a).text())).first().attr('href');
        if (!href || !/^https?:/i.test(href)) return;
        found.push({ label: label.replace(/\|?\s*watch\s*$/i, '').trim(), href, episode });
    });

    // A few at a time: each wait page is two requests to resolve.
    const files = [];
    for (let i = 0; i < found.length; i += 4) {
        const batch = await Promise.all(found.slice(i, i + 4).map(async ({ label, href, episode }) => {
            const link = await direct(href);
            const q = (label.match(/\b(480|540|720|1080|2160)p\b/i) || [])[0] || (/\b4k\b/i.test(label) ? '2160p' : '');
            return {
                label,
                quality: q,
                size: (label.match(/([\d.]+\s*[GM]B)/i) || [])[1] || '',
                series: !!episode || /episode|season|\bS\d{2}\b|\bE\d{2}\b/i.test(label),
                episode,
                kind: kindOf(link),
                links: [{ name: kindOf(link), url: link }],
            };
        }));
        files.push(...batch);
    }
    return files;
}

export async function hdhubFiles(q, year = '', imdb = '') {
    return remember(`f2:${imdb}|${q.toLowerCase()}|${year}`, 6 * 3600e3, async () => {
        // By IMDb id, else by each name the title goes by ("Fakes (Farzi)").
        let doc = await findPost(q, year, imdb);
        for (const name of titleNames(q)) {
            if (doc || name === q) break;
            doc = await findPost(name, year, '');
        }
        if (!doc) return { post: null, files: [] };
        const url = await onBase(doc.permalink);
        return { post: { title: clean(doc.post_title), url }, files: await postFiles(url) };
    });
}

router.get('/files', async (req, res) => {
    const q = clean(req.query.q);
    const year = clean(req.query.year).slice(0, 4);
    const imdb = /^tt\d+$/.test(clean(req.query.imdb)) ? clean(req.query.imdb) : '';
    if (!q && !imdb) return res.status(400).json({ error: 'q or imdb is required' });
    try {
        res.json(await hdhubFiles(q, year, imdb));
    } catch (e) {
        console.error(`❌ HDHub4u failed for "${imdb || q}": ${e.message}`);
        res.status(502).json({ error: 'HDHub4u is not answering right now', post: null, files: [] });
    }
});

/* ── One file's servers ──────────────────────────────────────────────
   HubDrive's page links its HubCloud copy; HubCloud's page sends its
   button to a page listing the servers (10Gbps, PixelDrain, Buzz,
   ZipDisk…), each the file itself or one hop from it. Followed here so the
   viewer picks a server and gets the file, not three pages of buttons. The
   links carry tokens that run out, so they are fetched on opening and kept
   only briefly. */

const textAfter = ($, re) => clean($('body').text().match(re)?.[1] || '');

async function hubcloudPage(link) {
    const h = hostName(link);
    if (/hubcloud/i.test(h)) return link;
    if (!/hubdrive/i.test(h)) return '';
    const $ = cheerio.load(await get(link));
    return $('a[href*="hubcloud"]').map((_, a) => $(a).attr('href')).get().find((x) => /\/drive\//.test(x)) || '';
}

/* The 10Gbps button bounces through a worker to a page whose ?link= is the
   file on Google's download servers. Anything else is left as it is. */
async function finalUrl(name, url) {
    try {
        if (/10\s*gbps/i.test(name)) {
            const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
            res.body?.cancel();
            const link = new URL(res.url).searchParams.get('link');
            return link && /^https:/.test(link) ? link : url;
        }
        const pd = url.match(/pixeldrain\.[a-z]+\/(?:u|api\/file)\/([A-Za-z0-9]+)/);
        if (pd) {
            // Its mirror is often gone already; then it is left out.
            const info = await fetch(`https://pixeldrain.dev/api/file/${pd[1]}/info`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null);
            return info?.success === false ? '' : `https://pixeldrain.dev/api/file/${pd[1]}?download`;
        }
    } catch (e) {
        console.warn(`⚠️ HDHub4u server not followed (${name}): ${e.message}`);
    }
    return url;
}

export async function hdhubServers(link) {
    return remember(`v:${link}`, 20 * 60e3, async () => {
        /* HubCDN is one file and no list: its page redirects through an ad
           host whose ?r= is, in base64, a page whose ?link= is the file. */
        if (/hubcdn/i.test(hostName(link))) {
            const html = await get(link);
            const r = (html.match(/[?&]r=([A-Za-z0-9+/=]+)/) || [])[1];
            const file = r ? new URL(b64(r)).searchParams.get('link') : '';
            return { name: '', size: '', servers: file && /^https:/.test(file) ? [{ name: 'Direct', url: file }] : [] };
        }
        const cloud = await hubcloudPage(link);
        if (!cloud) return { name: '', size: '', servers: [] };
        const page1 = await get(cloud);
        // A /drive/ page sets it in a script; a /video/ page links it.
        const next = (page1.match(/var\s+url\s*=\s*'([^']+)'/) || [])[1]
            || (page1.match(/href="(https:\/\/[^"]+\/hubcloud\.php\?[^"]+)"/) || [])[1]?.replace(/&amp;/g, '&');
        if (!next) return { name: '', size: '', servers: [] };
        const $ = cheerio.load(await get(next));
        const found = [];
        $('a[href]').each((_, a) => {
            const label = clean($(a).text());
            const m = label.match(/download\s*\[\s*([^\]]+?)\s*\]/i);
            const href = $(a).attr('href');
            if (m && /^https?:/i.test(href)) found.push({ name: m[1].replace(/server/ig, ' ').replace(/\s*:\s*/, ' ').replace(/\s+/g, ' ').trim(), url: href });
            // Some pages (a /video/ one) offer one button, the file itself: "Download File [576 MB]".
            else if (/^download file\b/i.test(label) && /^https:/i.test(href)) found.push({ name: 'Direct', url: href });
        });
        const servers = (await Promise.all(found.map(async (x) => ({ ...x, url: await finalUrl(x.name, x.url) })))).filter((x) => x.url);
        return {
            name: clean($('title').text()),
            size: textAfter($, /File Size\s*([\d.]+\s*[GMK]B)/i),
            servers,
        };
    });
}

/* ── Play a file where it lies ───────────────────────────────────────
   GET /play?link=<HubDrive / HubCloud / HubCDN page>  → 302 to the file.
   AnchorHD plays HDHub4u's MKVs straight off their file servers (through the
   download relay, which picks the audio language). The servers' links carry
   tokens that last hours, so the player is given this address instead, and
   the file's current link is looked up each time it is opened.
     Measured on one file (418, 720p), 2026-10-24, 15 MB at two offsets:
       FSLv2 (R2)       2.9–3.3 MB/s, steady, byte ranges   ← the one to play
       FSL   (R2)       2.0 then 0.37 MB/s — the film's own rate, so it stalls
       10Gbps (Google)  fast, but answers a range with the WHOLE file (200):
                        every seek restarts the download from the start
       Buzz             403
   So by name first, host second; Google only when nothing else has it. */
const PLAY_ORDER = [
    (s) => /fsl\s*v2/i.test(s.name),
    (s) => /^fsl\b/i.test(s.name) || /cloudflarestorage\.com|r2\.dev/i.test(hostName(s.url)),
    (s) => /pixeldrain\./i.test(hostName(s.url)),
    (s) => /direct/i.test(s.name),
    (s) => /googleusercontent\.com/i.test(hostName(s.url)),
];
/* The server to stream from, of a file's servers; null when none will do.
   Also used by India4Movies for its older posts' HubCloud copies. A
   workers.dev "Direct" copy is left out: its link is tied to whoever asked
   (403 from anywhere else) and Jio's DNS does not resolve it. */
export function playableServer(servers = []) {
    const usable = servers.filter((s) => !/buzz|fuckingfast|amazonserver\.workers\.dev/i.test(`${s.name} ${hostName(s.url)}`));
    return PLAY_ORDER.map((ok) => usable.find(ok)).find(Boolean) || null;
}
router.get('/play', async (req, res) => {
    const link = clean(req.query.link);
    if (!/^https:/.test(link) || !FILE_HOSTS.test(hostName(link))) return res.status(400).json({ error: 'Not a HubDrive, HubCloud or HubCDN link' });
    try {
        const { servers } = await hdhubServers(link);
        const pick = playableServer(servers);
        if (!pick) return res.status(404).json({ error: 'No server has this file right now' });
        res.set('Cache-Control', 'no-store');
        res.redirect(302, pick.url);
    } catch (e) {
        console.error(`❌ HDHub4u play failed for ${link}: ${e.message}`);
        res.status(502).json({ error: 'The file host is not answering right now' });
    }
});

router.get('/servers', async (req, res) => {
    const url = clean(req.query.url);
    // Only the file hosts' own pages: this is not a general-purpose fetcher.
    if (!FILE_HOSTS.test(hostName(url)) || !/^https:/.test(url)) return res.status(400).json({ error: 'Not a HubDrive or HubCloud link', servers: [] });
    try {
        res.json(await hdhubServers(url));
    } catch (e) {
        console.error(`❌ HDHub4u servers failed for ${url}: ${e.message}`);
        res.status(502).json({ error: 'The file host is not answering right now', servers: [] });
    }
});

export default router;
