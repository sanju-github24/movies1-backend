// =====================================================================
// BollyFlix — download sources for the download page
//
//   GET /search?q=        posts for a title: { results: [{ title, year, url, poster }] }
//   GET /post?url=        one post's files: { title, files: [{ label, quality, size, links: [{ name, url }] }] }
//
// The site is plain WordPress HTML: a search lists posts as <article>s, and a
// post lists each file as an <h5> heading ("… 720p (10bit) [560MB]") followed
// by its buttons (a.dl). Its domain moves often, so it is a setting, and the
// answers are kept a while so the page does not ask on every visit.
// =====================================================================

import express from 'express';
import * as cheerio from 'cheerio';

const router = express.Router();

const BASE = (process.env.BOLLYFLIX_BASE || 'https://new.bollyflix.vote').replace(/\/$/, '');
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

async function page(url) {
    const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`BollyFlix answered ${res.status}`);
    return res.text();
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
// "Download Hanging Up (2000) Dual Audio {Hindi-English} Movie 480p | …" → the readable part
const tidyTitle = (t) => clean(t).replace(/^download\s+/i, '');

export async function searchBollyflix(q) {
    return remember(`s:${q.toLowerCase()}`, 30 * 60e3, async () => {
        const $ = cheerio.load(await page(`${BASE}/search/${encodeURIComponent(q)}`));
        const results = [];
        $('article').each((_, el) => {
            const a = $(el).find('h2 a, .title a').first();
            const url = a.attr('href') || $(el).find('a').first().attr('href');
            const title = tidyTitle(a.text() || $(el).find('a').first().attr('title'));
            if (!url || !title) return;
            results.push({
                title,
                year: (title.match(/\((19|20)\d{2}\)/) || [])[0]?.slice(1, 5) || '',
                url,
                poster: $(el).find('img').first().attr('src') || '',
            });
        });
        return results;
    });
}

/* The files on a post: each heading that names a quality, with the buttons
   that follow it up to the next heading. */
export async function getBollyflixPost(url) {
    return remember(`p:${url}`, 6 * 3600e3, async () => {
        const $ = cheerio.load(await page(url));
        const files = [];
        $('h3, h4, h5, h6').each((_, h) => {
            const label = clean($(h).text());
            if (!/\b(480|540|720|1080|2160)p\b|\b4k\b/i.test(label)) return;
            const links = [];
            let node = $(h).next();
            for (let i = 0; i < 4 && node.length && !/^h[1-6]$/i.test(node[0].tagName); i++, node = node.next()) {
                node.find('a').each((__, a) => {
                    const href = $(a).attr('href');
                    const name = clean($(a).text()).replace(/^[^\w]+/u, '') || 'Download';
                    if (href && /^https?:/i.test(href) && !href.includes(new URL(BASE).host)) links.push({ name, url: href });
                });
            }
            if (!links.length) return;
            files.push({
                label,
                quality: (label.match(/\b(480|540|720|1080|2160)p\b/i) || [])[0] || (/\b4k\b/i.test(label) ? '2160p' : ''),
                size: (label.match(/\[([\d.]+\s*[GM]B)\]/i) || [])[1] || '',
                links,
            });
        });
        return { title: tidyTitle($('h1').first().text() || $('title').text()), url, files };
    });
}

router.get('/search', async (req, res) => {
    const q = clean(req.query.q || req.query.query);
    if (!q) return res.status(400).json({ error: 'q is required' });
    try {
        res.json({ results: await searchBollyflix(q) });
    } catch (e) {
        console.error(`❌ BollyFlix search failed for "${q}": ${e.message}`);
        res.status(502).json({ error: 'BollyFlix is not answering right now', results: [] });
    }
});

router.get('/post', async (req, res) => {
    const url = clean(req.query.url);
    // Only its own posts: this is not a general-purpose fetcher.
    let ok = false;
    try { ok = new URL(url).host === new URL(BASE).host; } catch { ok = false; }
    if (!ok) return res.status(400).json({ error: 'Not a BollyFlix post' });
    try {
        res.json(await getBollyflixPost(url));
    } catch (e) {
        console.error(`❌ BollyFlix post failed for ${url}: ${e.message}`);
        res.status(502).json({ error: 'BollyFlix is not answering right now', files: [] });
    }
});

export default router;
