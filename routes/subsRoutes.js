// =====================================================================
// Subtitles, searched online — for AnchorHD's "Search subtitles online"
//
//   GET /search?tmdb=&imdb=&type=movie|tv&season=&episode=&lang=EN,HI
//        { subs: [{ id, release, lang, language, hi, author, pack }] }
//   GET /file?id=&season=&episode=
//        the subtitle itself as WebVTT (text/vtt), ready for a <track>
//
// From SubDL (api.subdl.com), with our key in SUBDL_API_KEY — kept here,
// never sent to the browser. A result is a ZIP on dl.subdl.com holding one
// .srt, or for a series often the whole season's; the file for the asked
// episode is picked out by its SxxEyy, unzipped, and turned into VTT.
// =====================================================================

import express from 'express';
import { inflateRawSync } from 'node:zlib';

const router = express.Router();

const KEY = process.env.SUBDL_API_KEY || '';
const API = 'https://api.subdl.com/api/v1/subtitles';
const DL = 'https://dl.subdl.com';

const cache = new Map();   // key → { at, value }
const remember = async (key, ttl, make) => {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    const value = await make();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 800) cache.delete(cache.keys().next().value);
    return value;
};

// "/subtitle/3467330-8390389.zip?api_key=…" → "3467330-8390389"
const idOf = (url) => (String(url || '').match(/\/subtitle\/(\d+-\d+)\.zip/) || [])[1] || '';

router.get('/search', async (req, res) => {
    if (!KEY) return res.status(503).json({ error: 'Online subtitles are not set up', subs: [] });
    const tmdb = /^\d{1,9}$/.test(String(req.query.tmdb || '')) ? String(req.query.tmdb) : '';
    const imdb = /^tt\d{5,10}$/.test(String(req.query.imdb || '')) ? String(req.query.imdb) : '';
    if (!tmdb && !imdb) return res.status(400).json({ error: 'tmdb or imdb is required', subs: [] });
    const tv = req.query.type === 'tv';
    const season = tv ? Math.max(1, parseInt(req.query.season, 10) || 1) : 0;
    const episode = tv ? Math.max(1, parseInt(req.query.episode, 10) || 1) : 0;
    const lang = String(req.query.lang || '').toUpperCase().split(',').filter((l) => /^[A-Z_]{2,6}$/.test(l)).slice(0, 8).join(',');

    const q = new URLSearchParams({ api_key: KEY, type: tv ? 'tv' : 'movie', subs_per_page: '30' });
    if (tmdb) q.set('tmdb_id', tmdb); else q.set('imdb_id', imdb);
    if (tv) { q.set('season_number', String(season)); q.set('episode_number', String(episode)); }
    if (lang) q.set('languages', lang);
    try {
        const value = await remember(`s:${q}`, 6 * 3600e3, async () => {
            const r = await fetch(`${API}?${q}`, { signal: AbortSignal.timeout(15000) });
            const d = await r.json().catch(() => ({}));
            if (!d.status) return { subs: [] };   // nothing for this title
            const seen = new Set();
            const subs = (d.subtitles || []).map((s) => ({
                id: idOf(s.url),
                release: String(s.release_name || s.name || '').slice(0, 160),
                lang: String(s.language || '').toUpperCase(),
                language: s.lang || s.language || '',
                hi: !!s.hi,
                author: s.author || '',
                pack: !!s.full_season || (tv && s.episode == null),
            })).filter((s) => s.id && !seen.has(s.id) && seen.add(s.id));
            // This episode's own files before season packs.
            subs.sort((a, b) => Number(a.pack) - Number(b.pack));
            return { subs };
        });
        res.json(value);
    } catch (e) {
        res.status(502).json({ error: 'SubDL is not answering right now', subs: [] });
    }
});

/* ── The file ────────────────────────────────────────────────────────── */

// The entries of a ZIP, read from its central directory: { name, data }.
function unzip(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip');
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    const out = [];
    for (let n = 0; n < count && buf.readUInt32LE(p) === 0x02014b50; n++) {
        const method = buf.readUInt16LE(p + 10);
        const size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
        p += 46 + nameLen + extraLen + commentLen;
        if (!/\.(srt|vtt|ass|ssa)$/i.test(name)) continue;
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const raw = buf.slice(start, start + size);
        if (method === 0) out.push({ name, data: raw });
        else if (method === 8) { try { out.push({ name, data: inflateRawSync(raw) }); } catch { /* skip */ } }
    }
    return out;
}

// Text in UTF-8, or — when it is not — the Windows code page most subtitles use.
function text(buf) {
    if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString('utf8');
    if (buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString('utf16le');
    const s = buf.toString('utf8');
    return s.includes('�') ? new TextDecoder('windows-1252').decode(buf) : s;
}

const toVtt = (s) => 'WEBVTT\n\n' + s.replace(/\r\n?/g, '\n')
    .replace(/^﻿/, '')
    .replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')   // SRT times → VTT
    .replace(/\{\\[^}]*\}/g, '')                          // stray ASS tags
    .trim() + '\n';

// ASS/SSA dialogue lines → VTT cues.
function assToVtt(s) {
    const t = (x) => { const [h, m, sec] = x.split(':'); const [a, b = '0'] = sec.split('.'); return `${h.padStart(2, '0')}:${m}:${a.padStart(2, '0')}.${(b + '00').slice(0, 3)}`; };
    const cues = s.split(/\r?\n/).filter((l) => l.startsWith('Dialogue:')).map((l) => {
        const parts = l.slice(9).split(',');
        const body = parts.slice(9).join(',').replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').trim();
        return body ? `${t(parts[1].trim())} --> ${t(parts[2].trim())}\n${body}` : '';
    }).filter(Boolean);
    return 'WEBVTT\n\n' + cues.join('\n\n') + '\n';
}

// From a season's pack, this episode's file.
const isEpisode = (name, season, episode) => {
    const n = name.toLowerCase();
    const re = [
        new RegExp(`s0*${season}[ ._-]*e0*${episode}(?!\\d)`),
        new RegExp(`(?<!\\d)0*${season}x0*${episode}(?!\\d)`),
        new RegExp(`(?:episode|ep)[ ._-]*0*${episode}(?!\\d)`),
        new RegExp(`(?<!\\d)${season}${String(episode).padStart(2, '0')}(?!\\d)`),   // "102"
    ];
    // A pack's own numbering: "02 Cat's in the Bag.srt" — a number leading the file's name.
    const base = n.split('/').pop();
    return re.some((r) => r.test(n)) || new RegExp(`^0*${episode}(?!\\d)[ ._-]`).test(base);
};

router.get('/file', async (req, res) => {
    if (!KEY) return res.status(503).send('Online subtitles are not set up');
    const id = String(req.query.id || '');
    if (!/^\d+-\d+$/.test(id)) return res.status(400).send('id is required');
    const season = parseInt(req.query.season, 10) || 0;
    const episode = parseInt(req.query.episode, 10) || 0;
    try {
        const vtt = await remember(`f:${id}:${season}x${episode}`, 24 * 3600e3, async () => {
            const r = await fetch(`${DL}/subtitle/${id}.zip?api_key=${encodeURIComponent(KEY)}`, { signal: AbortSignal.timeout(20000) });
            if (!r.ok) throw new Error(`SubDL answered ${r.status}`);
            const files = unzip(Buffer.from(await r.arrayBuffer()));
            if (!files.length) throw new Error('No subtitle in that download');
            const pick = (episode && files.length > 1 && files.find((f) => isEpisode(f.name, season, episode)))
                || files.sort((a, b) => b.data.length - a.data.length)[0];
            const body = text(pick.data);
            return /\.(ass|ssa)$/i.test(pick.name) ? assToVtt(body) : /^\s*WEBVTT/.test(body) ? body : toVtt(body);
        });
        res.set('Content-Type', 'text/vtt; charset=utf-8');
        res.set('Access-Control-Allow-Origin', '*');
        res.set('Cache-Control', 'public, max-age=86400');
        res.send(vtt);
    } catch (e) {
        res.status(502).send(e.message || 'That subtitle could not be fetched');
    }
});

export default router;
