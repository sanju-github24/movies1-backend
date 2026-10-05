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

const router = express.Router();

const BASE = (process.env.HDHUB_BASE || 'https://new1.hdhub4u.free').replace(/\/$/, '');
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
        headers: { 'User-Agent': UA, Accept: as === 'json' ? 'application/json' : 'text/html', Referer: `${BASE}/` },
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

/* Posts are listed under an old domain that no longer answers; the paths
   carry over to the current one. */
const onBase = (link) => { try { const u = new URL(link); return `${BASE}${u.pathname}${u.search}`; } catch { return link; } };

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
    $('h2, h3, h4, h5').each((_, h) => {
        const label = clean($(h).text());
        if (!QUALITY.test(label) || /watch|player|trailer/i.test(label)) return;
        const href = $(h).find('a[href]').first().attr('href');
        if (!href || !/^https?:/i.test(href)) return;
        found.push({ label, href });
    });

    // A few at a time: each wait page is two requests to resolve.
    const files = [];
    for (let i = 0; i < found.length; i += 4) {
        const batch = await Promise.all(found.slice(i, i + 4).map(async ({ label, href }) => {
            const link = await direct(href);
            const q = (label.match(/\b(480|540|720|1080|2160)p\b/i) || [])[0] || (/\b4k\b/i.test(label) ? '2160p' : '');
            return {
                label,
                quality: q,
                size: (label.match(/([\d.]+\s*[GM]B)/i) || [])[1] || '',
                series: /episode|season|\bS\d{2}\b|\bE\d{2}\b/i.test(label),
                kind: kindOf(link),
                links: [{ name: kindOf(link), url: link }],
            };
        }));
        files.push(...batch);
    }
    return files;
}

export async function hdhubFiles(q, year = '', imdb = '') {
    return remember(`f:${imdb}|${q.toLowerCase()}|${year}`, 6 * 3600e3, async () => {
        const doc = await findPost(q, year, imdb);
        if (!doc) return { post: null, files: [] };
        const url = onBase(doc.permalink);
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
        const next = (page1.match(/var\s+url\s*=\s*'([^']+)'/) || [])[1];
        if (!next) return { name: '', size: '', servers: [] };
        const $ = cheerio.load(await get(next));
        const found = [];
        $('a[href]').each((_, a) => {
            const m = clean($(a).text()).match(/download\s*\[\s*([^\]]+?)\s*\]/i);
            const href = $(a).attr('href');
            if (m && /^https?:/i.test(href)) found.push({ name: m[1].replace(/server/ig, ' ').replace(/\s*:\s*/, ' ').replace(/\s+/g, ' ').trim(), url: href });
        });
        const servers = (await Promise.all(found.map(async (x) => ({ ...x, url: await finalUrl(x.name, x.url) })))).filter((x) => x.url);
        return {
            name: clean($('title').text()),
            size: textAfter($, /File Size\s*([\d.]+\s*[GMK]B)/i),
            servers,
        };
    });
}

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
