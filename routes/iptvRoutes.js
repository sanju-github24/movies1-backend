// =====================================================================
// Open IPTV channels — read from the darkbyteprojects/iptv_png repo
//
//   GET /channels            all open HLS channels, grouped by category
//        { updatedAt, count, channels: [{ name, logo, category, provider,
//                                          streams: [{ label, url }] }] }
//   GET /channels?category=Sports   just one category
//
// The repo publishes several "providers", each a set of channel lists. Many
// of its streams are DRM-encrypted DASH (cenc.mpd) with ClearKey decryption
// keys — those are deliberately NOT served here. ONLY plain HLS (.m3u8)
// streams that carry no decryption key are kept: open feeds, the same kind as
// our existing live-TV sources.
//
// Files are discovered through the GitHub tree API each refresh, so a provider
// or category the repo adds later is picked up on its own; the result is cached
// for 30 minutes, so the channel list tracks the repo without a redeploy.
// =====================================================================

import express from 'express';

const router = express.Router();

const OWNER = 'darkbyteprojects';
const REPO = 'iptv_png';
const BRANCH = 'main';
const RAW = `https://raw.githubusercontent.com/${OWNER}/${REPO}/${BRANCH}/`;
const TREE = `https://api.github.com/repos/${OWNER}/${REPO}/git/trees/${BRANCH}?recursive=1`;
const UA = 'Mozilla/5.0 (compatible; AnchorMovies/1.0)';

let cache = { at: 0, data: null };
let inflight = null;

async function getJson(url) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`${url.split('/').slice(-1)[0]} ${r.status}`);
    return r.json();
}

/* The files that hold channel lists: a provider's channels.json /
   sports_channels.json, and every file under a categories/ folder. */
async function channelFiles() {
    const tree = await getJson(TREE).catch(() => null);
    const paths = (tree?.tree || []).map((t) => t.path).filter((p) => p && p.endsWith('.json'));
    return paths.filter((p) =>
        /(^|\/)(channels|sports_channels)\.json$/i.test(p) || /\/categories\/[^/]+\.json$/i.test(p));
}

const str = (v) => (v == null ? '' : String(v));
/* A stream carries a decryption key (so it is DRM — skip it) when any of these
   fields is set. An empty string / null means no key. */
const hasKey = (st) => ['api', 'drm_key', 'key', 'clearkey', 'tokenApi', 'token_api', 'drm_scheme', 'license', 'licenseUrl']
    .some((k) => { const v = st[k]; return (typeof v === 'string' && v.trim()) || (v && typeof v === 'object' && Object.keys(v).length); });
/* Open = a plain HLS link with no key, not DASH, not Common Encryption. */
const isOpen = (st) => {
    const link = str(st.link || st.url);
    return /\.m3u8(\?|$)/i.test(link) && !/\.mpd(\?|$)/i.test(link) && !/cenc/i.test(link) && !hasKey(st);
};

const categoryFromPath = (path) => {
    const m = path.match(/\/categories\/([^/]+)\.json$/i);
    if (m) return m[1].replace(/_/g, ' ');
    if (/sports_channels\.json$/i.test(path)) return 'Sports';
    return '';
};
const titleCase = (s) => str(s).replace(/\b\w/g, (c) => c.toUpperCase()).trim();

function channelsFromFile(json, path) {
    const items = Array.isArray(json) ? json : (json?.channels || []);
    const provider = (path.match(/^(provider_\d+)/) || [])[1] || 'provider';
    const fileCat = categoryFromPath(path);
    const out = [];
    for (const it of items) {
        if (!it || typeof it !== 'object') continue;
        if (it.visible === false || it.publish === '0') continue;
        const streams = it.streams || it.formats || [];
        if (!Array.isArray(streams)) continue;
        const open = [];
        const seen = new Set();
        for (const st of streams) {
            if (!st || typeof st !== 'object' || !isOpen(st)) continue;
            const url = str(st.link || st.url);
            if (seen.has(url)) continue;
            seen.add(url);
            open.push({ label: str(st.name || st.title || `Link ${open.length + 1}`), url });
        }
        if (!open.length) continue;
        out.push({
            name: titleCase(it.name || it.title || 'Channel'),
            logo: str(it.logo || it.image || ''),
            category: titleCase(it.cat || fileCat || 'General'),
            provider,
            streams: open,
        });
    }
    return out;
}

async function build() {
    const files = await channelFiles();
    const lists = await Promise.all(files.map(async (p) => {
        try { return channelsFromFile(await getJson(RAW + p), p); }
        catch { return []; }
    }));
    // One channel per name+category; merge each title's open stream links.
    const byKey = new Map();
    for (const ch of lists.flat()) {
        const key = `${ch.name.toLowerCase()}|${ch.category.toLowerCase()}`;
        const cur = byKey.get(key);
        if (!cur) { byKey.set(key, { ...ch, streams: [...ch.streams] }); continue; }
        const urls = new Set(cur.streams.map((s) => s.url));
        for (const s of ch.streams) if (!urls.has(s.url)) { cur.streams.push(s); urls.add(s.url); }
        if (!cur.logo && ch.logo) cur.logo = ch.logo;
    }
    const channels = [...byKey.values()].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return { updatedAt: new Date().toISOString(), count: channels.length, channels };
}

async function getChannels(force = false) {
    if (!force && cache.data && Date.now() - cache.at < 30 * 60e3) return cache.data;
    if (inflight) return inflight;
    inflight = build().then((data) => { cache = { at: Date.now(), data }; return data; }).finally(() => { inflight = null; });
    // If a refresh fails, keep serving the last good list rather than erroring.
    try { return await inflight; } catch (e) { if (cache.data) return cache.data; throw e; }
}

router.get('/channels', async (req, res) => {
    try {
        const data = await getChannels();
        const cat = String(req.query.category || '').trim().toLowerCase();
        if (cat) {
            const channels = data.channels.filter((c) => c.category.toLowerCase() === cat);
            return res.json({ ...data, count: channels.length, channels });
        }
        res.set('Cache-Control', 'public, max-age=0, s-maxage=1800, stale-while-revalidate=3600');
        res.json(data);
    } catch (e) {
        res.status(502).json({ success: false, message: e.message, channels: [] });
    }
});

/* The categories available, with a channel count each — for a tab/menu. */
router.get('/categories', async (_req, res) => {
    try {
        const data = await getChannels();
        const counts = {};
        for (const c of data.channels) counts[c.category] = (counts[c.category] || 0) + 1;
        res.json({ updatedAt: data.updatedAt, categories: Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count) });
    } catch (e) {
        res.status(502).json({ success: false, message: e.message, categories: [] });
    }
});

export default router;
