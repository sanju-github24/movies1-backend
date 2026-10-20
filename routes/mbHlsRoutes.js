// =====================================================================
// MoviBox as one multi-audio HLS stream, played straight off its CDN
//
//   GET /title?tmdb=<id>&type=movie|tv[&se=&ep=]   (or ?title=&year=)
//        { streams: [{ url, languages: [{ name, code }], height }] }
//   GET /<key>/master.m3u8                         every language as an audio track
//   GET /<key>/v/<rep>.m3u8   GET /<key>/a/<n>.m3u8  one quality / one language
//
// MoviBox posts a title once per language (Original, Hindi dub, Tamil dub…),
// each as DASH: HEVC 1080/720/480 and one AAC track, in a folder on
// sacdn.hakunaymatata.com. Its TV app's API (tv.aoneroom.com, wefeed-tv-bff)
// hands out each folder with a CloudFront signature as cookies — Policy,
// Signature, Key-Pair-Id, good for the whole folder for about a week — and
// CloudFront takes the same three as query parameters. Written into the
// URLs, the manifest and every segment load in a viewer's browser straight
// from MoviBox (CORS *, no Referer wanted): nothing but these playlists
// passes through here.
//
// Languages are combined where they are the same cut: versions whose running
// time agrees (within a second and a half) share the video of one of them
// and each add an audio track, so switching language does not reload. A
// version cut differently — Coolie's Hindi and Tamil dubs are 3½ minutes
// shorter than its original — would drift out of sync laid over that video,
// so it becomes a stream of its own, with any others of its length.
//
// The TV API signs every request (x-tr-signature: HMAC-MD5 over the method,
// headers, time, body hash and sorted path) with a key from its app, as
// documented publicly (github.com/solo12345689/moviebox-internal-api). If
// MoviBox changes it, this stops answering and AnchorHD moves on.
// =====================================================================

import express from 'express';
import crypto from 'crypto';
import { moviboxDubs } from './moviboxRoutes.js';

const router = express.Router();

const TV = 'https://tv.aoneroom.com';
const HOST_Q = 'api6.aoneroom.com';
const KEY = Buffer.from(process.env.MB_TV_SECRET || '76iRl07s0xSN9jqmEWAt79EBJZulIQIsV64FZr2O', 'base64');
const DEVICE = crypto.randomBytes(8).toString('hex');   // one per process, as an app install would have

// ── The TV app's API ───────────────────────────────────────────────────
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const encQuery = (p) => Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]))}`).join('&');
const sortedQuery = (q) => q.split('&').filter(Boolean).map((x) => {
    const i = x.indexOf('=');
    return [decodeURIComponent(x.slice(0, i)), decodeURIComponent(x.slice(i + 1))];
}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');

let tvToken = '', tvTokenExp = 0;
async function tv(path, { method = 'GET', params = {}, data } = {}) {
    const q = encQuery({ host: HOST_Q, ...params });
    const body = data !== undefined ? JSON.stringify(data) : '';
    const ts = Date.now();
    const toSign = [method, 'application/json', 'application/json', body ? String(Buffer.byteLength(body)) : '',
        String(ts), body ? md5(body) : '', `${path}?${sortedQuery(q)}`].join('\n');
    const t = String(Date.now());
    const headers = {
        'User-Agent': 'okhttp/4.12.0', Accept: 'application/json', 'Content-Type': 'application/json',
        'x-tr-signature': `${ts}|1|${crypto.createHmac('md5', KEY).update(toSign).digest('base64')}`,
        'X-Client-Token': `${t},${md5(t.split('').reverse().join(''))}`,
        'X-Client-Info': JSON.stringify({
            package_name: 'com.movieboxtv.app', version_name: '1.1.9.0820.03', version_code: 1010908203,
            os: 'android', os_version: '14', device_id: DEVICE, brand: 'samsung', model: 'SM-S918B',
            system_language: 'en', net: 'wifi', region: 'IN', timezone: 'Asia/Kolkata', sp_code: 'IN',
        }),
        'X-Client-Status': '1',
        ...(tvToken ? { Authorization: `Bearer ${tvToken}` } : {}),
    };
    const r = await fetch(`${TV}${path}?${q}`, { method, headers, body: method === 'GET' ? undefined : body, signal: AbortSignal.timeout(20000) });
    return r.json().catch(() => ({ code: r.status }));
}
async function ensureToken() {
    if (tvToken && Date.now() < tvTokenExp - 60e3) return;
    tvToken = '';
    const d = await tv('/wefeed-tv-bff/user/visitor-login', { method: 'POST', data: {} });
    if (d.code !== 0 || !d.data?.token) throw new Error(`MoviBox TV login: ${d.message || d.code}`);
    tvToken = d.data.token;
    try { tvTokenExp = JSON.parse(Buffer.from(tvToken.split('.')[1], 'base64url').toString()).exp * 1000; }
    catch { tvTokenExp = Date.now() + 6 * 3600e3; }
}

/* One language version's signed DASH folder: { base, q, expMs }, or null
   when the TV API has no DASH for it (some dubs are MP4 only). */
const folders = new Map();   // "subjectId|se|ep" → { at, value }
async function signedFolder(subjectId, se, ep) {
    const k = `${subjectId}|${se}|${ep}`;
    const hit = folders.get(k);
    if (hit && (!hit.value || Date.now() < hit.value.expMs - 3600e3) && Date.now() - hit.at < 24 * 3600e3) return hit.value;
    await ensureToken();
    let d = await tv('/wefeed-tv-bff/subject/play-info/v2', { params: { subjectId, vipLevel: '2', ...(se ? { se, ep } : {}) } });
    if (d.code === 401 || /jwt|token/i.test(String(d.message || ''))) { tvToken = ''; await ensureToken(); d = await tv('/wefeed-tv-bff/subject/play-info/v2', { params: { subjectId, vipLevel: '2', ...(se ? { se, ep } : {}) } }); }
    const s = (d.data?.streams || []).find((x) => /\.mpd(\?|$)/.test(x.url || '') && x.signCookie);
    let value = null;
    if (s) {
        const c = Object.fromEntries(String(s.signCookie).split(';').map((x) => x.trim()).filter(Boolean)
            .map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
        if (c['CloudFront-Policy'] && c['CloudFront-Signature'] && c['CloudFront-Key-Pair-Id']) {
            let expMs = Date.now() + 24 * 3600e3;
            try {
                const pol = JSON.parse(Buffer.from(c['CloudFront-Policy'].replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'), 'base64').toString());
                expMs = pol.Statement[0].Condition.DateLessThan['AWS:EpochTime'] * 1000;
            } catch { /* a day, then */ }
            value = {
                mpd: s.url,
                base: s.url.replace(/[^/]+$/, ''),
                q: `Policy=${c['CloudFront-Policy']}&Signature=${c['CloudFront-Signature']}&Key-Pair-Id=${c['CloudFront-Key-Pair-Id']}`,
                expMs,
            };
        }
    }
    folders.set(k, { at: Date.now(), value });
    if (folders.size > 3000) folders.delete(folders.keys().next().value);
    return value;
}

// ── DASH → segment lists ───────────────────────────────────────────────
const attr = (s, name) => (s.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const isoSeconds = (d) => {
    const m = /PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?/.exec(d || '');
    return m ? (Number(m[1] || 0) * 3600 + Number(m[2] || 0) * 60 + Number(m[3] || 0)) : 0;
};
const fill = (tpl, id, n, t) => tpl.replace(/\$RepresentationID\$/g, id)
    .replace(/\$Number(?:%0(\d+)d)?\$/g, (_, w) => String(n).padStart(Number(w || 0), '0'))
    .replace(/\$Time\$/g, String(t));

/* The two shapes MoviBox writes: a fixed segment duration, or a timeline of
   each segment's length. Each Representation carries its own template. */
function parseMpd(xml) {
    const total = isoSeconds(attr(xml, 'mediaPresentationDuration'));
    const reps = [];
    for (const set of xml.matchAll(/<AdaptationSet([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
        const setHead = set[1];
        for (const rep of set[2].matchAll(/<Representation([^>]*)>([\s\S]*?)<\/Representation>/g)) {
            const head = rep[1], inner = rep[2];
            const type = (attr(setHead, 'contentType') || attr(head, 'mimeType') || '').split('/')[0];
            const tpl = (inner.match(/<SegmentTemplate([^>]*)>/) || [])[1];
            if (!tpl || !/^(video|audio)$/.test(type)) continue;
            const id = attr(head, 'id');
            const ts = Number(attr(tpl, 'timescale') || 1);
            const start = Number(attr(tpl, 'startNumber') || 1);
            const media = attr(tpl, 'media'), init = attr(tpl, 'initialization');
            const segs = [];
            const tl = (inner.match(/<SegmentTimeline>([\s\S]*?)<\/SegmentTimeline>/) || [])[1];
            if (tl) {
                let t = 0, n = start;
                for (const s of tl.matchAll(/<S\s([^>]*?)\/?>/g)) {
                    if (attr(s[1], 't') !== undefined) t = Number(attr(s[1], 't'));
                    const d = Number(attr(s[1], 'd')), r = Number(attr(s[1], 'r') || 0);
                    for (let i = 0; i <= r; i++) { segs.push({ uri: fill(media, id, n++, t), dur: d / ts }); t += d; }
                }
            } else {
                const d = Number(attr(tpl, 'duration')) / ts;
                const count = Math.ceil(total / d - 1e-6);
                for (let i = 0; i < count; i++) segs.push({ uri: fill(media, id, start + i, i * d * ts), dur: Math.min(d, total - i * d) });
            }
            reps.push({
                type, id, segs, start,
                init: init ? fill(init, id, start, 0) : '',
                codecs: attr(head, 'codecs') || '', bandwidth: Number(attr(head, 'bandwidth') || 0),
                width: Number(attr(head, 'width') || 0), height: Number(attr(head, 'height') || 0),
                lang: attr(setHead, 'lang') || '',
                channels: Number((inner.match(/AudioChannelConfiguration[^>]*value="(\d+)"/) || [])[1] || 2),
            });
        }
    }
    return { total, video: reps.filter((r) => r.type === 'video').sort((a, b) => b.height - a.height), audio: reps.filter((r) => r.type === 'audio') };
}

// ── Titles → streams ───────────────────────────────────────────────────
const LANG = { hin: 'Hindi', tam: 'Tamil', tel: 'Telugu', kan: 'Kannada', mal: 'Malayalam', eng: 'English', ben: 'Bengali',
    mar: 'Marathi', pan: 'Punjabi', guj: 'Gujarati', urd: 'Urdu', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', zho: 'Chinese',
    spa: 'Spanish', fre: 'French', fra: 'French', rus: 'Russian', ara: 'Arabic', ind: 'Indonesian', tha: 'Thai' };
const nameFrom = (version, mpdLang) => {
    const own = String(version.language || '').replace(/\s*dub$/i, '').trim();
    if (own && !/^original/i.test(own)) return own;
    return LANG[mpdLang] || (mpdLang && mpdLang !== 'und' ? mpdLang : 'Original');
};

const streams = new Map();   // key → { at, expMs, members: [{ name, code, base, q, mpd }] }
const titles = new Map();    // title key → { at, expMs, value }
const SAME_CUT = 1.5;        // seconds

async function mapLimit(list, n, fn) {
    const out = new Array(list.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
        while (i < list.length) { const k = i++; out[k] = await fn(list[k]).catch(() => null); }
    }));
    return out;
}

async function buildTitle({ tmdb, title, year, type, se, ep }) {
    const dubs = await moviboxDubs({ tmdb, title, year, type });
    if (!dubs) return { streams: [] };
    // A subtitled copy ("Arabic sub") has the original's audio: nothing to add.
    const versions = dubs.versions.filter((v) => !/\bsub\b/i.test(v.language));
    const read = await mapLimit(versions, 3, async (v) => {
        const f = await signedFolder(v.subjectId, se, ep);
        if (!f) return null;
        const r = await fetch(`${f.mpd}?${f.q}`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) return null;
        const mpd = parseMpd(await r.text());
        if (!mpd.video.length || !mpd.audio.length) return null;
        return { v, f, mpd, name: nameFrom(v, mpd.audio[0].lang), code: mpd.audio[0].lang || v.code || 'und' };
    });
    const ok = read.filter(Boolean);
    // Same cut, same stream. The original leads its group; else the best video.
    const groups = [];
    for (const m of ok.sort((a, b) => Number(b.v.original) - Number(a.v.original) || b.mpd.video[0].height - a.mpd.video[0].height)) {
        const g = groups.find((x) => Math.abs(x[0].mpd.total - m.mpd.total) <= SAME_CUT);
        if (g) { if (!g.some((x) => x.name === m.name)) g.push(m); } else groups.push([m]);
    }
    const out = groups.map((g) => {
        const key = md5(g.map((m) => `${m.v.subjectId}|${se}|${ep}`).join(',')).slice(0, 16);
        const expMs = Math.min(...g.map((m) => m.f.expMs));
        streams.set(key, { at: Date.now(), expMs, members: g.map((m) => ({ name: m.name, code: m.code, base: m.f.base, q: m.f.q, mpd: m.mpd })) });
        return { url: `/api/mbhls/${key}/master.m3u8`, languages: g.map((m) => ({ name: m.name, code: m.code })), height: g[0].mpd.video[0].height, codecs: g[0].mpd.video[0].codecs };
    });
    if (streams.size > 2000) streams.delete(streams.keys().next().value);
    return { title: dubs.title, streams: out, expMs: Math.min(...ok.map((m) => m.f.expMs), Date.now() + 24 * 3600e3) };
}

router.get('/title', async (req, res) => {
    const type = req.query.type === 'tv' ? 'tv' : 'movie';
    const se = type === 'tv' ? String(Math.max(1, parseInt(req.query.se, 10) || 1)) : '';
    const ep = type === 'tv' ? String(Math.max(1, parseInt(req.query.ep, 10) || 1)) : '';
    const tmdb = /^\d{1,9}$/.test(String(req.query.tmdb || '')) ? String(req.query.tmdb) : '';
    const title = String(req.query.title || '').slice(0, 200);
    if (!tmdb && !title) return res.status(400).json({ error: 'tmdb or title is required', streams: [] });
    const k = `${tmdb || title.toLowerCase()}|${req.query.year || ''}|${type}|${se}|${ep}`;
    const hit = titles.get(k);
    // Kept while the signatures hold (less an hour), and while its streams are still here.
    if (hit && Date.now() < hit.expMs - 3600e3 && Date.now() - hit.at < 12 * 3600e3
        && hit.value.streams.every((s) => streams.has(s.url.split('/')[3]))) return res.json(hit.value);
    try {
        const value = await buildTitle({ tmdb, title, year: Number(req.query.year) || 0, type, se, ep });
        titles.set(k, { at: Date.now(), expMs: value.expMs || Date.now() + 3600e3, value });
        if (titles.size > 1000) titles.delete(titles.keys().next().value);
        res.json(value);
    } catch (e) {
        res.status(502).json({ error: `MoviBox is not answering: ${e.message}`, streams: [] });
    }
});

// ── Playlists ──────────────────────────────────────────────────────────
function playlistHeaders(res) {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    // The same for every viewer until the signatures change: let Cloudflare keep it.
    res.set('Cache-Control', 'public, max-age=600, s-maxage=21600');
}
const live = (key, res) => {
    const s = streams.get(key);
    if (!s || Date.now() > s.expMs - 600e3) { res.status(410).send('Open the title again'); return null; }
    return s;
};
const iso2 = { hin: 'hi', tam: 'ta', tel: 'te', kan: 'kn', mal: 'ml', eng: 'en', ben: 'bn', mar: 'mr', pan: 'pa', guj: 'gu', urd: 'ur' };

router.get('/:key/master.m3u8', (req, res) => {
    const s = live(req.params.key, res); if (!s) return;
    const lead = s.members[0].mpd;
    const audBw = Math.max(...s.members.map((m) => m.mpd.audio[0].bandwidth || 128000));
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS'];
    s.members.forEach((m, i) => {
        const a = m.mpd.audio[0];
        lines.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="${m.name.replace(/"/g, '')}",LANGUAGE="${iso2[m.code] || m.code}",`
            + `DEFAULT=${i === 0 ? 'YES' : 'NO'},AUTOSELECT=YES,CHANNELS="${a.channels || 2}",URI="a/${i}.m3u8"`);
    });
    for (const v of lead.video) {
        lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${v.bandwidth + audBw},RESOLUTION=${v.width}x${v.height},CODECS="${v.codecs},${s.members[0].mpd.audio[0].codecs || 'mp4a.40.2'}",AUDIO="aud"`);
        lines.push(`v/${encodeURIComponent(v.id)}.m3u8`);
    }
    playlistHeaders(res);
    res.send(lines.join('\n') + '\n');
});

function mediaPlaylist(member, rep) {
    const abs = (u) => `${member.base}${u}?${member.q}`;
    const lines = ['#EXTM3U', '#EXT-X-VERSION:7', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...rep.segs.map((x) => x.dur)))}`,
        `#EXT-X-MEDIA-SEQUENCE:${rep.start}`, '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS'];
    if (rep.init) lines.push(`#EXT-X-MAP:URI="${abs(rep.init)}"`);
    for (const x of rep.segs) lines.push(`#EXTINF:${x.dur.toFixed(3)},`, abs(x.uri));
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n') + '\n';
}

router.get('/:key/v/:rep.m3u8', (req, res) => {
    const s = live(req.params.key, res); if (!s) return;
    const lead = s.members[0];
    const rep = lead.mpd.video.find((v) => v.id === req.params.rep);
    if (!rep) return res.status(404).send('No such quality');
    playlistHeaders(res);
    res.send(mediaPlaylist(lead, rep));
});

router.get('/:key/a/:n.m3u8', (req, res) => {
    const s = live(req.params.key, res); if (!s) return;
    const m = s.members[Number(req.params.n)];
    if (!m) return res.status(404).send('No such language');
    playlistHeaders(res);
    res.send(mediaPlaylist(m, m.mpd.audio[0]));
});

export default router;
